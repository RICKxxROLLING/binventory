'use strict';

const $app = document.getElementById('app');
const state = { q: '', rack: '', selecting: false, selected: new Set() };

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent('/' + location.hash);
    throw new Error('Sign in required');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

let configP;
const getConfig = () => (configP ||= api('/config').catch(e => { configP = null; throw e; }));

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function locText(b) {
  return [b.rack && `Rack ${b.rack}`, b.shelf && `Shelf ${b.shelf}`, b.position && `Pos ${b.position}`].filter(Boolean).join(' · ') || 'No location';
}

function printLabels(ids) {
  window.open(`/labels.pdf?ids=${ids.join(',')}`, '_blank');
}

// Downscale photos on the phone before upload: faster over Wi-Fi, smaller on disk.
async function shrinkImage(file, max = 1800, quality = 0.84) {
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', quality));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file; // e.g. HEIC on a browser that can't decode it — upload the original
  }
}

async function uploadPhotos(binId, files) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('photos', await shrinkImage(f));
  return api(`/bins/${binId}/photos`, { method: 'POST', body: fd });
}

function lightbox(src) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="${esc(src)}" alt="">`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

const icons = {
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  box: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M2 4h20v4H2z"/><path d="M10 12h4"/></svg>',
  camera: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  print: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  spark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9zM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------- views ----------
async function viewList() {
  $app.innerHTML = `
    <div class="search">${icons.search}<input id="q" type="search" placeholder="Search bins and items…" value="${esc(state.q)}" autocomplete="off"></div>
    <div class="chips" id="chips"></div>
    <div class="list-head"><span id="count"></span><button class="link-btn" id="selToggle"></button></div>
    <div class="cards" id="cards"><div class="spinner">Loading…</div></div>
    <div class="fab-bar" id="fab"></div>`;

  const $q = document.getElementById('q');
  let timer;
  $q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $q.value.trim(); load(); }, 180); });
  document.getElementById('selToggle').onclick = () => { state.selecting = !state.selecting; state.selected.clear(); render(); };

  let bins = [];
  async function load() {
    bins = await api('/bins' + (state.q ? `?q=${encodeURIComponent(state.q)}` : ''));
    render();
  }

  function render() {
    const racks = [...new Set(bins.map(b => b.rack).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (state.rack && !racks.includes(state.rack)) state.rack = '';
    document.getElementById('chips').innerHTML = racks.length
      ? [`<button class="chip ${state.rack ? '' : 'on'}" data-rack="">All racks</button>`,
         ...racks.map(r => `<button class="chip ${state.rack === r ? 'on' : ''}" data-rack="${esc(r)}">Rack ${esc(r)}</button>`)].join('')
      : '';
    document.querySelectorAll('.chip').forEach(c => c.onclick = () => { state.rack = c.dataset.rack; render(); });

    const shown = bins.filter(b => !state.rack || b.rack === state.rack);
    document.getElementById('count').textContent = `${shown.length} bin${shown.length === 1 ? '' : 's'}`;
    document.getElementById('selToggle').textContent = state.selecting ? 'Cancel' : 'Select to print';
    document.getElementById('selToggle').style.visibility = bins.length ? 'visible' : 'hidden';

    const $cards = document.getElementById('cards');
    $cards.classList.toggle('selecting', state.selecting);
    if (!shown.length) {
      $cards.innerHTML = state.q
        ? `<div class="empty">No bins match “${esc(state.q)}”.</div>`
        : `<div class="empty">${icons.box}<h2>No bins yet</h2>Create your first bin, snap a photo of what's inside, and print a label.</div>`;
    } else {
      const hl = s => state.q ? esc(s).replace(new RegExp(`(${state.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<b>$1</b>') : esc(s);
      $cards.innerHTML = shown.map(b => `
        <a class="card ${state.selected.has(b.id) ? 'selected' : ''}" href="#/bin/${b.id}" data-id="${b.id}">
          <div class="thumb" style="${b.cover ? `background-image:url('/photos/${encodeURIComponent(b.cover)}')` : ''}">${b.cover ? '' : icons.box}</div>
          <div class="body">
            <div class="meta"><span class="loc">${esc(locText(b))}</span><span class="code">${esc(b.code)}</span></div>
            <div class="name">${esc(b.name || 'Untitled bin')}</div>
            ${b.matched_items ? `<div class="match">Contains: ${hl(b.matched_items)}</div>` : `<div class="desc">${esc(b.description) || `${b.item_count} item${b.item_count === 1 ? '' : 's'}`}</div>`}
          </div>
          <span class="tick"></span>
          <span class="check"></span>
        </a>`).join('');
      $cards.querySelectorAll('.card').forEach(card => card.addEventListener('click', e => {
        if (!state.selecting) return;
        e.preventDefault();
        const id = Number(card.dataset.id);
        state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
        render();
      }));
    }

    const fab = document.getElementById('fab');
    if (state.selecting) {
      const n = state.selected.size;
      fab.innerHTML = `
        <button class="btn" id="selAll">${n === shown.length ? 'Clear' : 'Select all'}</button>
        <button class="btn dark" id="printSel" ${n ? '' : 'disabled'}>${icons.print} Print ${n || ''} label${n === 1 ? '' : 's'}</button>`;
      document.getElementById('selAll').onclick = () => {
        if (n === shown.length) state.selected.clear(); else shown.forEach(b => state.selected.add(b.id));
        render();
      };
      document.getElementById('printSel').onclick = () => printLabels([...state.selected]);
    } else {
      fab.innerHTML = `<a class="btn primary" href="#/new">${icons.plus} New bin</a>`;
    }
  }

  await load();
}

let aiPoll;
async function viewBin(id) {
  clearTimeout(aiPoll);
  const [b, cfg] = await Promise.all([api(`/bins/${id}`), getConfig()]);
  const aiTags = new Set((b.ai_tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
  const aiBusy = b.ai_status === 'pending' || b.ai_status === 'running';
  const [hero, ...rest] = b.photos;
  const locs = [['RACK', b.rack], ['SHELF', b.shelf], ['POS', b.position]].filter(([, v]) => v);
  const totalQty = b.items.reduce((s, i) => s + i.qty, 0);

  $app.innerHTML = `
    <div class="detail">
      <div class="band">${(locs.length ? locs : [['LOCATION', 'Unassigned']]).map(([k, v]) => `<div><small>${k}</small><strong>${esc(v)}</strong></div>`).join('')}</div>
      <div class="code">${esc(b.code)}</div>
      <h1>${esc(b.name || 'Untitled bin')}</h1>
      ${b.description ? `<p class="desc">${esc(b.description)}</p>` : '<div style="height:12px"></div>'}

      <div class="section">
        <h3>Photos
          <span class="btn file-btn" style="min-height:36px;padding:6px 12px">${icons.camera} Add<input type="file" accept="image/*" multiple id="addPhoto"></span>
        </h3>
        ${b.photos.length ? `
          ${hero ? `<div class="gallery hero">${photoTile(hero)}</div>` : ''}
          ${rest.length ? `<div class="gallery" style="margin-top:8px">${rest.map(photoTile).join('')}</div>` : ''}`
        : '<div class="hint">No photos yet. Tap Add to snap the inside of the bin.</div>'}
      </div>

      <div class="section">
        <h3>Contents <span>${b.items.length} line${b.items.length === 1 ? '' : 's'} · ${totalQty} total</span></h3>
        ${b.items.length ? `<ul class="items">${b.items.map(i => `
          <li><span class="qty">×${i.qty}</span><span>${esc(i.name)}${i.notes ? `<span class="inote">${esc(i.notes)}</span>` : ''}</span></li>`).join('')}</ul>`
        : '<div class="hint">No items listed.</div>'}
      </div>

      ${cfg.ai.enabled && b.photos.length ? aiSection(b, aiBusy) : ''}

      ${b.notes ? `<div class="section"><h3>Notes</h3><div class="notes">${esc(b.notes)}</div></div>` : ''}
      ${b.tags ? `<div class="section"><h3>Tags</h3><div class="tags">${b.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<a class="tag ${aiTags.has(t.toLowerCase()) ? 'ai' : ''}" href="#/" data-tag="${esc(t)}" ${aiTags.has(t.toLowerCase()) ? 'title="Added by AI"' : ''}>${esc(t)}</a>`).join('')}</div></div>` : ''}

      <div class="section">
        <h3>Label</h3>
        <div class="qr-row">
          <img src="/api/bins/${b.id}/qr.svg" alt="QR code">
          <div><div class="code">${esc(b.code)}</div><div class="hint" style="word-break:break-all">${esc(b.url)}</div></div>
        </div>
      </div>

      <div class="timestamps">Created ${new Date(b.created_at + 'Z').toLocaleDateString()} · Updated ${new Date(b.updated_at + 'Z').toLocaleString()}</div>
    </div>
    <div class="fab-bar">
      <a class="btn" href="#/bin/${b.id}/edit">Edit</a>
      <button class="btn dark" id="print">${icons.print} Print label</button>
    </div>`;

  document.getElementById('print').onclick = () => printLabels([b.id]);
  document.querySelectorAll('.gallery img').forEach(img => img.onclick = () => lightbox(img.src));
  document.querySelectorAll('a.tag').forEach(t => t.onclick = () => { state.q = t.dataset.tag; });
  document.getElementById('addPhoto').onchange = async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
    await uploadPhotos(b.id, files);
    toast(cfg.ai.enabled && cfg.ai.auto ? 'Photos added · AI is looking at them…' : 'Photos added');
    viewBin(id);
  };

  const $analyze = document.getElementById('aiRun');
  if ($analyze) $analyze.onclick = async () => {
    $analyze.disabled = true;
    try { await api(`/bins/${b.id}/analyze`, { method: 'POST' }); viewBin(id); }
    catch (err) { toast('Error: ' + err.message); $analyze.disabled = false; }
  };
  const $addAi = document.getElementById('aiAdd');
  if ($addAi) $addAi.onclick = async () => {
    $addAi.disabled = true;
    await api(`/bins/${b.id}/ai-items`, { method: 'POST' });
    toast('Added to contents');
    viewBin(id);
  };

  // Refresh when the background analysis finishes (only while still on this bin)
  if (aiBusy) aiPoll = setTimeout(() => { if (location.hash === `#/bin/${id}`) viewBin(id); }, 3000);
}

function aiSection(b, busy) {
  const have = new Set(b.items.map(i => i.name.toLowerCase()));
  const missing = b.ai_items.filter(i => !have.has(i.name.toLowerCase()));
  let body;
  if (busy) body = `<div class="ai-busy">${icons.spark} ${b.ai_status === 'running' ? 'Looking at the photos…' : 'Waiting for the AI…'}</div>`;
  else if (b.ai_status === 'error') body = `<div class="hint" style="margin:0">AI couldn't analyze this bin: ${esc(b.ai_error)}</div>`;
  else if (b.ai_items.length) body = `
    <div class="tags">${b.ai_items.map(i => `<span class="tag ai">${i.qty > 1 ? `${i.qty}× ` : ''}${esc(i.name)}</span>`).join('')}</div>
    ${missing.length ? `<button class="btn" id="aiAdd" style="margin-top:10px;min-height:36px">${icons.plus} Add ${missing.length} to contents</button>` : ''}`;
  else body = '<div class="hint" style="margin:0">Not analyzed yet.</div>';
  return `
    <div class="section">
      <h3>Spotted by AI
        ${busy ? '' : `<button class="btn" id="aiRun" style="min-height:36px;padding:6px 12px">${icons.spark} ${b.ai_status ? 'Re-analyze' : 'Analyze'}</button>`}
      </h3>
      ${body}
    </div>`;
}

function photoTile(p) {
  return `<div class="ph"><img src="/photos/${encodeURIComponent(p.filename)}" loading="lazy" alt=""></div>`;
}

async function viewEdit(id) {
  const isNew = !id;
  const [b, locs, cfg] = await Promise.all([
    isNew ? { name: '', description: '', rack: '', shelf: '', position: '', notes: '', tags: '', items: [], photos: [] } : api(`/bins/${id}`),
    api('/locations'),
    getConfig(),
  ]);
  const aiAuto = cfg.ai.enabled && cfg.ai.auto;
  let items = b.items.map(i => ({ name: i.name, qty: i.qty, notes: i.notes }));
  let pending = [];

  $app.innerHTML = `
    <form class="form" id="form" autocomplete="off">
      <h2 style="margin:0 0 14px">${isNew ? 'New bin' : `Edit ${esc(b.code)}`}</h2>
      <div class="field">
        <label>Location</label>
        <div class="grid3">
          <input type="text" name="rack" placeholder="Rack" value="${esc(b.rack)}" list="racks">
          <input type="text" name="shelf" placeholder="Shelf" value="${esc(b.shelf)}" list="shelves">
          <input type="text" name="position" placeholder="Position" value="${esc(b.position)}">
        </div>
        <datalist id="racks">${locs.racks.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
        <datalist id="shelves">${locs.shelves.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
      </div>
      <div class="field"><label>Name</label><input type="text" name="name" placeholder="${aiAuto ? 'Leave blank to let AI name it from the photos' : 'e.g. Christmas lights'}" value="${esc(b.name)}" ${aiAuto ? '' : 'required'}></div>
      <div class="field"><label>General description (printed on label)</label><textarea name="description" rows="2" placeholder="${aiAuto ? 'Leave blank to let AI describe it from the photos' : 'e.g. Outdoor string lights, extension cords, timers'}">${esc(b.description)}</textarea></div>

      <div class="field">
        <label>Contents</label>
        <div id="items"></div>
        <div class="quick-add">
          <input type="text" id="newItem" placeholder="Add item, press Enter" enterkeyhint="done">
          <button type="button" class="btn" id="addItem">Add</button>
        </div>
        <div class="hint">Tip: paste a list (one per line, “3x Widget” or “Widget, 3”) to add many at once.</div>
      </div>

      <div class="field">
        <label>Photos</label>
        ${!isNew && b.photos.length ? `<div class="gallery" id="existing">${b.photos.map(p => `
          <div class="ph"><img src="/photos/${encodeURIComponent(p.filename)}" alt=""><button type="button" class="x" data-pid="${p.id}" aria-label="Delete photo">✕</button></div>`).join('')}</div>` : ''}
        <div class="pending-photos" id="pending"></div>
        <div class="btn-row" style="margin-top:8px">
          <span class="btn file-btn">${icons.camera} Take / choose photo<input type="file" accept="image/*" multiple id="photoIn"></span>
        </div>
      </div>

      <div class="field"><label>Notes</label><textarea name="notes" placeholder="Anything else worth knowing">${esc(b.notes)}</textarea></div>
      <div class="field"><label>Tags (comma separated)</label><input type="text" name="tags" placeholder="holiday, electrical" value="${esc(b.tags)}"></div>

      ${isNew ? '' : '<button type="button" class="btn danger" id="del" style="width:100%;margin-top:8px">Delete bin</button>'}
    </form>
    <div class="fab-bar">
      <a class="btn" href="${isNew ? '#/' : `#/bin/${id}`}">Cancel</a>
      <button class="btn primary" id="save">${isNew ? 'Create bin' : 'Save'}</button>
    </div>`;

  const $items = document.getElementById('items');
  function renderItems() {
    $items.innerHTML = items.map((it, i) => `
      <div class="item-row">
        <input type="number" min="0" inputmode="numeric" value="${it.qty}" data-i="${i}" data-k="qty" aria-label="Quantity">
        <input type="text" value="${esc(it.name)}" data-i="${i}" data-k="name" aria-label="Item">
        <button type="button" class="rm" data-rm="${i}" aria-label="Remove">✕</button>
      </div>`).join('');
    $items.querySelectorAll('input').forEach(inp => inp.oninput = () => { items[inp.dataset.i][inp.dataset.k] = inp.value; });
    $items.querySelectorAll('[data-rm]').forEach(btn => btn.onclick = () => { items.splice(btn.dataset.rm, 1); renderItems(); });
  }
  renderItems();

  function parseLine(line) {
    let m = line.match(/^\s*(\d+)\s*[x×]?\s+(.+)$/i);
    if (m) return { qty: +m[1], name: m[2].trim() };
    m = line.match(/^(.+?)[,\s]+[x×]?\s*(\d+)\s*$/i);
    if (m) return { qty: +m[2], name: m[1].trim() };
    return { qty: 1, name: line.trim() };
  }
  const $new = document.getElementById('newItem');
  function addFromInput(text) {
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    lines.forEach(l => items.push({ ...parseLine(l), notes: '' }));
    $new.value = '';
    renderItems();
  }
  $new.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFromInput($new.value); } });
  $new.addEventListener('paste', e => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n')) { e.preventDefault(); addFromInput(text); }
  });
  document.getElementById('addItem').onclick = () => { addFromInput($new.value); $new.focus(); };

  document.getElementById('photoIn').onchange = e => {
    pending.push(...e.target.files);
    e.target.value = '';
    document.getElementById('pending').innerHTML = pending.map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('');
  };
  document.querySelectorAll('#existing .x').forEach(btn => btn.onclick = async () => {
    if (!confirm('Delete this photo?')) return;
    await api(`/photos/${btn.dataset.pid}`, { method: 'DELETE' });
    btn.closest('.ph').remove();
  });

  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${b.code} and all its photos? This can't be undone.`)) return;
    await api(`/bins/${id}`, { method: 'DELETE' });
    toast('Bin deleted');
    location.hash = '#/';
  };

  const $form = document.getElementById('form');
  $form.onsubmit = e => { e.preventDefault(); document.getElementById('save').click(); };
  document.getElementById('save').onclick = async e => {
    if (!$form.reportValidity()) return;
    if ($new.value.trim()) addFromInput($new.value);
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const data = Object.fromEntries(new FormData($form));
      data.items = items;
      const saved = await api(isNew ? '/bins' : `/bins/${id}`, { method: isNew ? 'POST' : 'PUT', body: data });
      if (pending.length) { btn.textContent = 'Uploading photos…'; await uploadPhotos(saved.id, pending); }
      toast(isNew ? `Created ${saved.code}` : 'Saved');
      location.hash = `#/bin/${saved.id}`;
    } catch (err) {
      toast('Error: ' + err.message);
      btn.disabled = false;
      btn.textContent = isNew ? 'Create bin' : 'Save';
    }
  };
}

async function viewSettings() {
  const cfg = await api('/config');
  $app.innerHTML = `
    <h2 style="margin-top:0">Settings</h2>
    ${cfg.baseUrlSet ? '' : `<div class="warn"><b>BASE_URL isn't set.</b> QR codes currently point to <code>${esc(cfg.baseUrl)}</code> (whatever address you're using right now). Set the <code>BASE_URL</code> variable in the container so labels always point at an address phones can reach.</div>`}
    <div class="section">
      <h3>QR codes point to</h3>
      <div><code>${esc(cfg.baseUrl)}/b/${esc(cfg.prefix)}-0001</code></div>
    </div>
    <div class="section">
      <h3>Printing</h3>
      <div class="hint" style="margin:0">Labels are 4×6 in PDFs, one bin per page. Print at <b>100% / actual size</b> (not “fit to page”) on your thermal label printer. From a phone, open the PDF and use Share → Print.</div>
    </div>
    <div class="section">
      <h3>Security
        ${cfg.auth.enabled ? '<a class="btn" href="/logout" style="min-height:36px;padding:6px 12px">Sign out</a>' : ''}
      </h3>
      <div class="hint" style="margin:0">${cfg.auth.enabled
        ? `Signed in as <b>${esc(cfg.auth.user)}</b>. Login is required and sessions last ${cfg.auth.days} days per device (changing <code>AUTH_PASS</code> signs every device out).`
        : 'No login set, so only devices on your home network (or Tailscale) can open Binventory. To reach it from outside, set <code>AUTH_USER</code> and <code>AUTH_PASS</code> on the container.'}</div>
    </div>
    <div class="section" id="aiSettings">
      <h3>Local AI</h3>
      ${cfg.ai.enabled ? '<div class="hint" style="margin:0">Checking…</div>' : `<div class="hint" style="margin:0">Off. Run <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> (there's an Unraid app for it), pull a vision model such as <code>gemma3:4b</code>, then set the container's <code>OLLAMA_URL</code> variable (e.g. <code>http://192.168.1.10:11434</code>). New photos will then be described and tagged automatically.</div>`}
    </div>
    <div class="section">
      <h3>Backup</h3>
      <div class="hint" style="margin:0 0 10px">Your data lives in the container's <code>/data</code> folder (database + photos). You can also download everything as JSON.</div>
      <a class="btn" href="/api/export">Download JSON export</a>
    </div>
    <div class="section">
      <h3>Add to home screen</h3>
      <div class="hint" style="margin:0">On iPhone: Share → Add to Home Screen. On Android: ⋮ → Add to Home screen. It'll open like an app.</div>
    </div>`;
  if (cfg.ai.enabled) renderAiSettings();
}

async function renderAiSettings() {
  const $s = document.getElementById('aiSettings');
  if (!$s) return;
  const st = await api('/ai/status');
  let status;
  if (!st.reachable) status = `<div class="warn" style="margin:0"><b>Can't reach Ollama</b> at <code>${esc(st.url)}</code>. ${esc(st.error || '')}</div>`;
  else if (!st.modelInstalled) status = `<div class="warn" style="margin:0">Connected, but model <code>${esc(st.model)}</code> isn't installed. In the Ollama container run <code>ollama pull ${esc(st.model)}</code>.</div>`;
  else status = `<div class="hint" style="margin:0">Connected to <code>${esc(st.url)}</code> using <code>${esc(st.model)}</code>. ${st.auto ? 'New photos are analyzed automatically.' : 'Automatic analysis is off (AI_AUTO) — use Analyze on a bin.'}</div>`;
  $s.innerHTML = `
    <h3>Local AI</h3>
    ${status}
    ${st.queued ? `<div class="hint" style="margin:10px 0 0">${st.queued} bin${st.queued === 1 ? '' : 's'} in the queue…</div>` : ''}
    ${st.unanalyzed ? `<button class="btn" id="aiAll" style="margin-top:10px">${icons.spark} Analyze ${st.unanalyzed} bin${st.unanalyzed === 1 ? '' : 's'} with photos</button>` : ''}`;
  const $all = document.getElementById('aiAll');
  if ($all) $all.onclick = async () => {
    $all.disabled = true;
    const { queued } = await api('/ai/analyze-all', { method: 'POST' });
    toast(`Queued ${queued} bin${queued === 1 ? '' : 's'}`);
    renderAiSettings();
  };
}

// ---------- router ----------
async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  window.scrollTo(0, 0);
  let m;
  try {
    if (h === '/' || h === '') return await viewList();
    if (h === '/new') return await viewEdit(null);
    if (h === '/settings') return await viewSettings();
    if ((m = h.match(/^\/bin\/(\d+)\/edit$/))) return await viewEdit(Number(m[1]));
    if ((m = h.match(/^\/bin\/(\d+)$/))) { state.selecting = false; return await viewBin(Number(m[1])); }
    location.hash = '#/';
  } catch (err) {
    $app.innerHTML = `<div class="empty"><h2>Couldn't load that</h2>${esc(err.message)}<p><a class="btn" href="#/">Back to bins</a></p></div>`;
  }
}
window.addEventListener('hashchange', route);
route();
