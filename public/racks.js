'use strict';
// Rack layout screen, bin size presets, spot suggestions and (re)organizing.
// Uses api/esc/icons/toast/printLabels/state from app.js (loaded after this file; only called at runtime).

const slotLabel = l => (l.rack ? `Rack ${l.rack} · Shelf ${l.shelf} · Pos ${l.position}` : 'Off the racks');
const sizeName = s => (s.dims ? `${s.name} (${s.dims})` : s.name);

// ---------- bottom sheet ----------
function sheet(title, html) {
  const el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="sheet-body">${html}</div></div>`;
  const close = () => { el.remove(); document.body.classList.remove('no-scroll'); };
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(el);
  document.body.classList.add('no-scroll');
  return { el, body: el.querySelector('.sheet-body'), close, set: h => { el.querySelector('.sheet-body').innerHTML = h; } };
}

// ---------- "which sizes may go here" editor ----------
function ruleEditor(allow, sizes, name) {
  const mode = allow === null ? 'any' : allow.length ? 'only' : 'off';
  return `
    <div class="rule" data-rule="${name}">
      <label class="radio"><input type="radio" name="${name}" value="any" ${mode === 'any' ? 'checked' : ''}> Any size</label>
      <label class="radio"><input type="radio" name="${name}" value="only" ${mode === 'only' ? 'checked' : ''}> Only these sizes</label>
      <div class="rule-sizes">${sizes.length ? sizes.map(s => `
        <label class="check"><input type="checkbox" value="${esc(s.name)}" ${allow?.includes(s.name) ? 'checked' : ''}> ${esc(sizeName(s))}</label>`).join('')
        : '<div class="hint" style="margin:0">No size presets yet. Add some under Bin sizes.</div>'}</div>
      <label class="radio"><input type="radio" name="${name}" value="off" ${mode === 'off' ? 'checked' : ''}> Don't use (keep empty)</label>
    </div>`;
}
function readRule(root, name) {
  const el = root.querySelector(`[data-rule="${name}"]`);
  const mode = el.querySelector(`input[name="${name}"]:checked`)?.value || 'any';
  if (mode === 'any') return null;
  if (mode === 'off') return [];
  const picked = [...el.querySelectorAll('.rule-sizes input:checked')].map(i => i.value);
  return picked.length ? picked : null;
}
function wireRule(root, name) {
  const el = root.querySelector(`[data-rule="${name}"]`);
  const sync = () => el.classList.toggle('only', el.querySelector(`input[name="${name}"]:checked`)?.value === 'only');
  el.querySelectorAll(`input[name="${name}"]`).forEach(r => r.onchange = sync);
  el.querySelectorAll('.rule-sizes input').forEach(c => c.onchange = () => { el.querySelector(`input[value="only"]`).checked = true; sync(); });
  sync();
}
const ruleText = allow => (allow === null ? '' : allow.length ? `Only ${allow.join(', ')}` : 'Not used');

// ---------- size presets ----------
function sizesSheet(layout, onSaved) {
  const rows = layout.sizes.map(s => ({ ...s, orig: s.name }));
  const sh = sheet('Bin sizes', '');
  const render = () => {
    sh.set(`
      <div class="hint" style="margin:0 0 12px">Presets you pick when creating a bin. List them smallest to largest. Racks, shelves and positions can then be limited to certain sizes.</div>
      <div id="sizeRows">${rows.map((s, i) => `
        <div class="size-row">
          <input type="text" data-i="${i}" data-k="name" value="${esc(s.name)}" placeholder="Name, e.g. 27 gal tote" aria-label="Size name">
          <input type="text" data-i="${i}" data-k="dims" value="${esc(s.dims)}" placeholder="Dimensions (optional)" aria-label="Dimensions">
          <button type="button" class="rm" data-up="${i}" aria-label="Move up" ${i ? '' : 'disabled'}>↑</button>
          <button type="button" class="rm" data-rm="${i}" aria-label="Remove">✕</button>
        </div>`).join('')}</div>
      <button type="button" class="btn" id="sizeAdd" style="margin-top:4px">${icons.plus} Add size</button>
      <div class="btn-row" style="margin-top:16px"><button class="btn primary" id="sizeSave">Save sizes</button></div>`);
    sh.body.querySelectorAll('input').forEach(inp => inp.oninput = () => { rows[inp.dataset.i][inp.dataset.k] = inp.value; });
    sh.body.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { rows.splice(b.dataset.rm, 1); render(); });
    sh.body.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; render(); });
    sh.body.querySelector('#sizeAdd').onclick = () => { rows.push({ name: '', dims: '', orig: null }); render(); sh.body.querySelector(`input[data-i="${rows.length - 1}"]`).focus(); };
    sh.body.querySelector('#sizeSave').onclick = async () => {
      const sizes = rows.filter(r => r.name.trim()).map(r => ({ name: r.name.trim(), dims: r.dims.trim() }));
      const renamedSizes = {};
      rows.forEach(r => { if (r.orig && r.name.trim() && r.orig !== r.name.trim()) renamedSizes[r.orig] = r.name.trim(); });
      // Keep existing size rules pointing at renamed sizes
      const rename = a => (Array.isArray(a) ? a.map(n => renamedSizes[n] || n) : a);
      const racks = layout.racks.map(r => ({ ...r, allow: rename(r.allow), shelves: r.shelves.map(s => ({
        ...s, allow: rename(s.allow), slots: Object.fromEntries(Object.entries(s.slots).map(([k, v]) => [k, { allow: rename(v.allow) }])) })) }));
      try {
        await api('/layout', { method: 'PUT', body: { sizes, racks, renamedSizes } });
        sh.close();
        toast('Sizes saved');
        onSaved();
      } catch (err) { toast('Error: ' + err.message); }
    };
  };
  render();
}

// Size picker for the bin form: preset chips + inline "new size"
function sizePicker(el, sizes, value, onChange) {
  const render = () => {
    el.innerHTML = `
      <div class="chips wrap">
        <button type="button" class="chip ${value ? '' : 'on'}" data-size="">Not set</button>
        ${sizes.map(s => `<button type="button" class="chip ${value === s.name ? 'on' : ''}" data-size="${esc(s.name)}" title="${esc(s.dims)}">${esc(s.name)}${s.dims ? ` <small>${esc(s.dims)}</small>` : ''}</button>`).join('')}
        <button type="button" class="chip add" id="newSizeBtn">${icons.plus} New size</button>
      </div>
      <div class="quick-add" id="newSizeForm" hidden>
        <input type="text" id="newSizeName" placeholder="Name, e.g. 12 qt clear">
        <input type="text" id="newSizeDims" placeholder="Dims (optional)" style="max-width:40%">
        <button type="button" class="btn" id="newSizeSave">Add</button>
      </div>`;
    el.querySelectorAll('[data-size]').forEach(c => c.onclick = () => { value = c.dataset.size; onChange(value); render(); });
    el.querySelector('#newSizeBtn').onclick = () => { el.querySelector('#newSizeForm').hidden = false; el.querySelector('#newSizeName').focus(); };
    const save = async () => {
      const name = el.querySelector('#newSizeName').value.trim();
      if (!name) return;
      sizes = await api('/sizes', { method: 'POST', body: { name, dims: el.querySelector('#newSizeDims').value } });
      value = sizes.find(s => s.name.toLowerCase() === name.toLowerCase())?.name || name;
      onChange(value);
      render();
    };
    el.querySelector('#newSizeSave').onclick = save;
    el.querySelectorAll('#newSizeForm input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  };
  render();
}

// ---------- suggestions ----------
// For a saved bin: pick moves it. For a draft (bin form): pick hands the spot back.
async function suggestSheet({ id, draft, onPick }) {
  const sh = sheet('Suggested spots', '<div class="spinner">Finding spots…</div>');
  let picks;
  try { picks = await api('/layout/suggest', { method: 'POST', body: { id, draft } }); }
  catch (err) { sh.set(`<div class="hint">${esc(err.message)}</div>`); return; }
  if (!picks.length) { sh.set('<div class="hint" style="margin:0">No free spot fits this bin. Free one up, or allow its size on more shelves in Layout.</div>'); return; }
  sh.set(`
    ${draft && !draft.size ? '<div class="hint" style="margin:0 0 10px">Tip: set the bin size so only spots it fits are suggested.</div>' : ''}
    <div class="picks">${picks.map((p, i) => `
      <div class="pick">
        <div class="loc">${esc(p.rack)}-${esc(p.shelf)}-${esc(p.position)}</div>
        <div class="pick-body">
          <b>${esc(slotLabel(p))}</b>${p.current ? ' <span class="hint">(current spot)</span>' : ''}
          <div class="hint" style="margin:2px 0 0">${p.near
            ? `Next to ${esc(p.near.code)} ${esc(p.near.name)}${p.near.shared.length ? ` · ${esc(p.near.shared.join(', '))}` : ''}`
            : 'Free spot that fits (no similar bins nearby yet)'}</div>
        </div>
        <button class="btn primary" data-pick="${i}">${id && !onPick ? 'Move here' : 'Use'}</button>
      </div>`).join('')}</div>`);
  sh.body.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => {
    const p = picks[b.dataset.pick];
    if (onPick) { onPick(p); sh.close(); return; }
    await api(`/bins/${id}/location`, { method: 'POST', body: p });
    sh.set(`<p style="margin-top:0">Moved to <b>${esc(slotLabel(p))}</b>. The printed label still shows the old spot.</p>
      <div class="btn-row"><button class="btn" data-close>Done</button><button class="btn dark" id="reprint">${icons.print} Print new label</button></div>`);
    sh.body.querySelector('#reprint').onclick = () => printLabels([id]);
    sh.el.addEventListener('click', e => { if (e.target.closest('[data-close]')) route(); });
  });
}

// ---------- plan + apply ----------
async function planSheet(mode, onDone) {
  const sh = sheet(mode === 'all' ? 'Reorganize everything' : 'Place unplaced bins', '<div class="spinner">Working out a plan…</div>');
  let plan;
  try { plan = await api('/layout/plan', { method: 'POST', body: { mode } }); }
  catch (err) { sh.set(`<div class="hint">${esc(err.message)}</div>`); return; }
  const { moves, noRoom, themes } = plan;
  if (!moves.length) {
    sh.set(`<p style="margin-top:0">${noRoom.length ? '' : 'Nothing to move: everything already has a good spot.'}</p>${noRoomHtml(noRoom)}`);
    return;
  }
  // Group by destination shelf
  const groups = new Map();
  for (const m of moves) {
    const k = m.to.rack ? `${m.to.rack}|${m.to.shelf}` : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b, undefined, { numeric: true }));
  sh.set(`
    <p style="margin-top:0">${mode === 'all'
      ? 'Similar bins are grouped onto the same shelves and racks, and every bin goes where its size is allowed.'
      : 'Bins without a valid spot go next to the most similar bins, where their size fits. Everything else stays put.'}
      <b>${moves.length} bin${moves.length === 1 ? '' : 's'}</b> will move.</p>
    ${keys.map(k => {
      const [rack, shelf] = k.split('|');
      const theme = themes[k.toLowerCase()] || [];
      return `<div class="plan-group">
        <h4>${k ? `Rack ${esc(rack)} · Shelf ${esc(shelf)}` : 'Off the racks (no room)'}${theme.length ? ` <span class="theme">${esc(theme.join(' · '))}</span>` : ''}</h4>
        ${groups.get(k).sort((a, b) => (+a.to.position || 0) - (+b.to.position || 0)).map(m => `
          <div class="plan-move"><span class="code">${esc(m.code)}</span> <span class="pm-name">${esc(m.name || 'Untitled bin')}</span>
            <span class="hint" style="margin:0">${m.from.rack ? `${esc(m.from.rack)}-${esc(m.from.shelf)}-${esc(m.from.position)}` : 'new'} → ${m.to.rack ? `<b>${esc(m.to.rack)}-${esc(m.to.shelf)}-${esc(m.to.position)}</b>` : '—'}</span></div>`).join('')}
      </div>`;
    }).join('')}
    ${noRoomHtml(noRoom)}
    <div class="btn-row" style="margin-top:14px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="apply">Move ${moves.length} bin${moves.length === 1 ? '' : 's'}</button></div>`);
  sh.body.querySelector('#apply').onclick = async e => {
    e.currentTarget.disabled = true;
    try {
      await api('/layout/apply', { method: 'POST', body: { moves: moves.map(m => ({ id: m.id, to: m.to })) } });
    } catch (err) { sh.set(`<div class="warn">${esc(err.message)}</div>`); return; }
    const ids = moves.filter(m => m.to.rack).map(m => m.id);
    sh.set(`<p style="margin-top:0">Done. ${moves.length} bin${moves.length === 1 ? '' : 's'} updated. Their printed labels still show the old spots.</p>
      <div class="btn-row"><button class="btn" data-close>Later</button>${ids.length ? `<button class="btn dark" id="reprint">${icons.print} Print ${ids.length} label${ids.length === 1 ? '' : 's'}</button>` : ''}</div>`);
    const rp = sh.body.querySelector('#reprint');
    if (rp) rp.onclick = () => printLabels(ids);
    onDone();
  };
}
function noRoomHtml(noRoom) {
  if (!noRoom.length) return '';
  return `<div class="warn" style="margin:12px 0 0"><b>No room for ${noRoom.length} bin${noRoom.length === 1 ? '' : 's'}:</b>
    ${noRoom.map(b => `${esc(b.code)} ${esc(b.name)}${b.size ? ` (${esc(b.size)})` : ''}`).join(', ')}.
    Add positions, or allow their size on more shelves.</div>`;
}

// ---------- first-time setup ----------
function setupHtml() {
  return `
    <h2 style="margin-top:0">Set up your racks</h2>
    <p class="hint" style="margin:0 0 14px">Tell Binventory how your shelving is laid out. It will suggest where each bin should go, keep similar bins together, and respect which sizes fit where. You can fine-tune every rack, shelf and position afterwards.</p>
    <form class="form section" id="setup">
      <div class="grid3">
        <div class="field"><label>Racks</label><input type="number" name="racks" min="1" max="100" value="2" inputmode="numeric"></div>
        <div class="field"><label>Shelves each</label><input type="number" name="shelves" min="1" max="50" value="4" inputmode="numeric"></div>
        <div class="field"><label>Positions per shelf</label><input type="number" name="positions" min="1" max="50" value="3" inputmode="numeric"></div>
      </div>
      <div class="field"><label>Name racks</label>
        <div class="chips wrap"><label class="chip"><input type="radio" name="naming" value="letters" checked> A, B, C…</label><label class="chip"><input type="radio" name="naming" value="numbers"> 1, 2, 3…</label></div></div>
      <div class="field"><label>Shelf 1 is the</label>
        <div class="chips wrap"><label class="chip"><input type="radio" name="bottomUp" value="0" checked> Top shelf</label><label class="chip"><input type="radio" name="bottomUp" value="1"> Bottom shelf</label></div></div>
      <button class="btn primary" style="width:100%">Create layout</button>
    </form>`;
}
const rackName = (naming, i) => (naming === 'numbers' ? String(i + 1)
  : i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
const newId = () => 'r' + Math.random().toString(36).slice(2, 9);

// ---------- layout screen ----------
async function viewLayout() {
  const data = await api('/layout');
  const { layout, bins, unplaced, themes } = data;
  const save = async (next, msg) => {
    const y = window.scrollY;
    try {
      await api('/layout', { method: 'PUT', body: next });
      configP = null; // hasLayout may have changed
      if (msg) toast(msg);
      await viewLayout();
      window.scrollTo(0, y);
    } catch (err) { toast('Error: ' + err.message); }
  };

  if (!layout.racks.length) {
    $app.innerHTML = setupHtml() + `
      <div class="section"><h3>Bin sizes <button class="btn" id="editSizes" style="min-height:36px;padding:6px 12px">Edit</button></h3>
        <div class="tags">${layout.sizes.map(s => `<span class="tag">${esc(sizeName(s))}</span>`).join('')}</div></div>`;
    document.getElementById('editSizes').onclick = () => sizesSheet(layout, viewLayout);
    document.getElementById('setup').onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const n = Math.max(1, Math.min(100, +f.racks || 1));
      const racks = Array.from({ length: n }, (_, i) => ({
        id: newId(), name: rackName(f.naming, i), bottomUp: f.bottomUp === '1', allow: null,
        shelves: Array.from({ length: Math.max(1, Math.min(50, +f.shelves || 1)) }, () => ({ positions: Math.max(1, Math.min(50, +f.positions || 1)), allow: null, slots: {} })),
      }));
      save({ ...layout, racks }, 'Layout created');
    };
    return;
  }

  const byKey = new Map();
  for (const b of bins) {
    const k = `${b.rack.toLowerCase()}|${/^\d+$/.test(b.shelf) ? +b.shelf : b.shelf.toLowerCase()}|${/^\d+$/.test(b.position) ? +b.position : b.position.toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }
  const binById = new Map(bins.map(b => [b.id, b]));
  const sizeInitial = name => (name ? name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() : '');
  const total = layout.racks.reduce((n, r) => n + r.shelves.reduce((m, s) => m + s.positions, 0), 0);
  const used = bins.length - unplaced.length;

  $app.innerHTML = `
    <div class="layout-head">
      <h2>Racks</h2>
      <div class="hint" style="margin:0">${used} of ${total} positions filled · ${layout.racks.length} rack${layout.racks.length === 1 ? '' : 's'}</div>
    </div>
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn" id="placeBtn" ${unplaced.length ? '' : 'disabled'}>Place ${unplaced.length || ''} unplaced</button>
      <button class="btn" id="orgBtn" ${bins.length ? '' : 'disabled'}>Reorganize all</button>
    </div>
    ${layout.racks.map((r, ri) => {
      const order = r.shelves.map((_, i) => i);
      if (r.bottomUp) order.reverse();
      return `
      <div class="rack section">
        <h3><span>Rack ${esc(r.name)}${r.allow !== null ? ` <span class="rule-tag">${esc(ruleText(r.allow))}</span>` : ''}</span>
          <button class="btn" data-rack="${ri}" style="min-height:36px;padding:6px 12px">Edit</button></h3>
        <div class="shelves">${order.map(si => {
          const sh = r.shelves[si];
          const theme = themes[`${r.name.toLowerCase()}|${si + 1}`] || [];
          return `
          <div class="shelf">
            <button class="shelf-label" data-shelf="${ri}:${si}" aria-label="Edit shelf ${si + 1}"><b>${si + 1}</b>${sh.allow !== null ? `<small>${esc(sh.allow.length ? sh.allow.map(sizeInitial).join(' ') : 'off')}</small>` : ''}</button>
            <div class="cells" style="grid-template-columns:repeat(${sh.positions}, minmax(68px, 1fr))">${Array.from({ length: sh.positions }, (_, pi) => {
              const p = pi + 1;
              const here = byKey.get(`${r.name.toLowerCase()}|${si + 1}|${p}`) || [];
              const rule = sh.slots[p]?.allow ?? null;
              if (here.length) {
                const b = here[0];
                return `<a class="cell bin ${here.length > 1 ? 'clash' : ''}" href="#/bin/${b.id}" title="${esc(b.name)}">
                  <span class="c-code">${esc(b.code)}</span><span class="c-name">${esc(b.name || 'Untitled')}</span>
                  ${b.size ? `<span class="c-size">${esc(sizeInitial(b.size))}</span>` : ''}${here.length > 1 ? `<span class="c-clash">+${here.length - 1}</span>` : ''}</a>`;
              }
              return `<button class="cell empty ${rule && !rule.length ? 'off' : ''}" data-slot="${ri}:${si}:${p}" aria-label="Position ${p}">
                <span class="c-pos">${p}</span>${rule ? `<span class="c-rule">${rule.length ? esc(rule.map(sizeInitial).join(' ')) : '✕'}</span>` : ''}</button>`;
            }).join('')}</div>
          </div>
          ${theme.length ? `<div class="theme">${esc(theme.join(' · '))}</div>` : ''}`;
        }).join('')}</div>
      </div>`;
    }).join('')}
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn" id="addRack">${icons.plus} Add rack</button>
      <button class="btn" id="editSizes">Bin sizes (${layout.sizes.length})</button>
    </div>
    ${unplaced.length ? `
      <div class="section">
        <h3>Not on a rack <span>${unplaced.length}</span></h3>
        <ul class="items">${unplaced.map(u => { const b = binById.get(u.id); return `
          <li><span style="flex:1;min-width:0"><a href="#/bin/${b.id}"><b>${esc(b.code)}</b> ${esc(b.name || 'Untitled bin')}</a>
            <span class="inote">${esc(u.reason)}${b.size ? ` · ${esc(b.size)}` : ''}</span></span>
            <button class="btn" data-suggest="${b.id}" style="min-height:36px;padding:6px 12px">Suggest</button></li>`; }).join('')}</ul>
      </div>` : ''}
    <p class="hint">Tap a shelf number or an empty position to limit which bin sizes can go there, or to stop using it.
      Suggestions group bins by their tags, name and contents (including AI tags).</p>`;

  const clone = () => JSON.parse(JSON.stringify(layout));
  document.getElementById('placeBtn').onclick = () => planSheet('unplaced', viewLayout);
  document.getElementById('orgBtn').onclick = () => planSheet('all', viewLayout);
  document.getElementById('editSizes').onclick = () => sizesSheet(layout, viewLayout);
  document.querySelectorAll('[data-suggest]').forEach(b => b.onclick = () => suggestSheet({ id: +b.dataset.suggest }));

  document.getElementById('addRack').onclick = () => {
    const next = clone();
    const last = next.racks[next.racks.length - 1];
    const letters = next.racks.every(r => /^[A-Z]+$/.test(r.name));
    let i = next.racks.length, name;
    do { name = rackName(letters ? 'letters' : 'numbers', i++); } while (next.racks.some(r => r.name.toLowerCase() === name.toLowerCase()));
    next.racks.push({ id: newId(), name, bottomUp: last.bottomUp, allow: null, shelves: last.shelves.map(s => ({ positions: s.positions, allow: s.allow, slots: {} })) });
    save(next, `Added rack ${name}`);
  };

  // Rack editor
  document.querySelectorAll('[data-rack]').forEach(btn => btn.onclick = () => {
    const ri = +btn.dataset.rack;
    const r = layout.racks[ri];
    const binsOn = bins.filter(b => b.rack.toLowerCase() === r.name.toLowerCase()).length;
    const sh = sheet(`Rack ${r.name}`, `
      <form class="form" id="rackForm">
        <div class="grid3">
          <div class="field"><label>Name</label><input type="text" name="name" value="${esc(r.name)}" required></div>
          <div class="field"><label>Shelves</label><input type="number" name="shelves" min="1" max="50" value="${r.shelves.length}" inputmode="numeric"></div>
          <div class="field"><label>Positions each</label><input type="number" name="positions" min="1" max="50" placeholder="mixed" value="${new Set(r.shelves.map(s => s.positions)).size === 1 ? r.shelves[0].positions : ''}" inputmode="numeric"></div>
        </div>
        <div class="field"><label class="check" style="font-weight:400;color:var(--text)"><input type="checkbox" name="bottomUp" ${r.bottomUp ? 'checked' : ''}> Shelf 1 is the bottom shelf</label></div>
        <div class="field"><label>Bin sizes allowed on this rack</label>${ruleEditor(r.allow, layout.sizes, 'rackRule')}</div>
        <div class="btn-row"><button type="button" class="btn danger" id="delRack">Delete rack</button><button class="btn primary">Save</button></div>
      </form>`);
    wireRule(sh.body, 'rackRule');
    sh.body.querySelector('#rackForm').onsubmit = e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const next = clone();
      const nr = next.racks[ri];
      nr.name = String(f.get('name')).trim() || nr.name;
      nr.bottomUp = f.get('bottomUp') === 'on';
      nr.allow = readRule(sh.body, 'rackRule');
      const count = Math.max(1, Math.min(50, +f.get('shelves') || nr.shelves.length));
      while (nr.shelves.length < count) nr.shelves.push({ positions: nr.shelves[nr.shelves.length - 1].positions, allow: null, slots: {} });
      nr.shelves.length = count;
      const pos = +f.get('positions');
      if (pos) nr.shelves.forEach(s => { s.positions = Math.max(1, Math.min(50, pos)); });
      sh.close();
      save(next, 'Rack saved');
    };
    sh.body.querySelector('#delRack').onclick = () => {
      if (!confirm(`Delete rack ${r.name}?${binsOn ? ` Its ${binsOn} bin${binsOn === 1 ? '' : 's'} will show as not on a rack.` : ''}`)) return;
      const next = clone();
      next.racks.splice(ri, 1);
      sh.close();
      save(next, `Deleted rack ${r.name}`);
    };
  });

  // Shelf editor
  document.querySelectorAll('[data-shelf]').forEach(btn => btn.onclick = () => {
    const [ri, si] = btn.dataset.shelf.split(':').map(Number);
    const r = layout.racks[ri], s = r.shelves[si];
    const sh = sheet(`Rack ${r.name} · Shelf ${si + 1}`, `
      <form class="form" id="shelfForm">
        <div class="field"><label>Positions on this shelf</label><input type="number" name="positions" min="1" max="50" value="${s.positions}" inputmode="numeric"></div>
        <div class="field"><label>Bin sizes allowed on this shelf</label>${ruleEditor(s.allow, layout.sizes, 'shelfRule')}</div>
        ${r.allow !== null ? `<div class="hint">The rack already limits sizes: ${esc(ruleText(r.allow))}.</div>` : ''}
        <button class="btn primary" style="width:100%;margin-top:8px">Save</button>
      </form>`);
    wireRule(sh.body, 'shelfRule');
    sh.body.querySelector('#shelfForm').onsubmit = e => {
      e.preventDefault();
      const next = clone();
      const ns = next.racks[ri].shelves[si];
      ns.positions = Math.max(1, Math.min(50, +new FormData(e.target).get('positions') || ns.positions));
      ns.allow = readRule(sh.body, 'shelfRule');
      sh.close();
      save(next, 'Shelf saved');
    };
  });

  // Position editor (empty positions)
  document.querySelectorAll('[data-slot]').forEach(btn => btn.onclick = () => {
    const [ri, si, p] = btn.dataset.slot.split(':').map(Number);
    const r = layout.racks[ri], s = r.shelves[si];
    const sh = sheet(`Rack ${r.name} · Shelf ${si + 1} · Pos ${p}`, `
      <div class="field"><label class="lbl">Bin sizes allowed in this position</label>${ruleEditor(s.slots[p]?.allow ?? null, layout.sizes, 'slotRule')}</div>
      ${[ruleText(r.allow) && `Rack: ${ruleText(r.allow)}`, ruleText(s.allow) && `Shelf: ${ruleText(s.allow)}`].filter(Boolean).map(t => `<div class="hint">${esc(t)}</div>`).join('')}
      <button class="btn primary" id="slotSave" style="width:100%;margin-top:12px">Save</button>`);
    wireRule(sh.body, 'slotRule');
    sh.body.querySelector('#slotSave').onclick = () => {
      const next = clone();
      const ns = next.racks[ri].shelves[si];
      const allow = readRule(sh.body, 'slotRule');
      if (allow === null) delete ns.slots[p]; else ns.slots[p] = { allow };
      sh.close();
      save(next, 'Position saved');
    };
  });
}
