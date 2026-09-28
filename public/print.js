'use strict';
// Print tracker: which labels are new, which are out of date (bin moved / renamed / re-described),
// and batch printing with a "did they print?" confirmation. Uses helpers from app.js/racks.js at runtime.

const LABEL_WHY = {
  location: c => `Moved ${c.from || 'unplaced'} → ${c.to || 'unplaced'}`,
  name: c => `Renamed from “${c.from}”`,
  description: () => 'Description changed',
};
const labelReasons = label => (label.state === 'new' ? ['Never printed'] : label.changes.map(c => LABEL_WHY[c.field](c)));

// Open the PDF, then ask whether it printed so the tracker only records labels that exist
function printLabels(ids) {
  ids = [...new Set(ids)];
  if (!ids.length) return;
  window.open(`/labels.pdf?ids=${ids.join(',')}`, '_blank');
  const n = ids.length;
  const sh = sheet('Did they print?', `
    <p style="margin-top:0">When ${n === 1 ? 'the label has' : `all ${n} labels have`} printed, mark ${n === 1 ? 'it' : 'them'} as printed so the print tracker knows ${n === 1 ? "it's" : "they're"} up to date.</p>
    <div class="btn-row"><button class="btn" data-close>Not yet</button><button class="btn primary" id="markPrinted">Yes, mark printed</button></div>`);
  sh.body.querySelector('#markPrinted').onclick = async () => {
    await api('/labels/printed', { method: 'POST', body: { ids } });
    sh.close();
    toast(`${n} label${n === 1 ? '' : 's'} marked as printed`);
    route();
  };
}

// Small label-state badge for cards and the bin page
function labelBadge(label) {
  if (!label || label.state === 'current') return '';
  return label.state === 'new'
    ? '<span class="lbl-badge new" title="Label never printed">New label</span>'
    : `<span class="lbl-badge changed" title="${esc(labelReasons(label).join('; '))}">Reprint</span>`;
}

// Top-bar dot: how many labels need printing
async function refreshPrintBadge() {
  try {
    const { counts } = await api('/print-queue');
    const n = counts.new + counts.changed;
    const el = document.getElementById('printBadge');
    if (el) { el.textContent = n > 99 ? '99+' : n; el.hidden = !n; }
  } catch { /* signed out etc. */ }
}

let printMode = 'changed'; // 'new' | 'changed' (new + changed) | 'all'
async function viewPrint() {
  const { bins, counts } = await api('/print-queue');
  const inMode = b => printMode === 'all' || b.label.state === 'new' || (printMode === 'changed' && b.label.state === 'changed');
  const excluded = new Set();

  $app.innerHTML = `
    <h2 style="margin:0 0 4px">Print tracker</h2>
    <div class="hint" style="margin:0 0 14px">Labels show the bin's location, name and description. When any of those change after printing, the label on the shelf is out of date.</div>
    <div class="stat-row">
      <div class="stat"><b>${counts.new}</b><span>new</span></div>
      <div class="stat"><b>${counts.changed}</b><span>out of date</span></div>
      <div class="stat"><b>${counts.current}</b><span>up to date</span></div>
    </div>
    <div class="chips wrap" style="margin:14px 0">
      <button class="chip" data-mode="new">New only (${counts.new})</button>
      <button class="chip" data-mode="changed">New + changed (${counts.new + counts.changed})</button>
      <button class="chip" data-mode="all">All (${bins.length})</button>
    </div>
    <div id="plist"></div>
    ${counts.new && counts.new === bins.length && bins.length > 1 ? `
      <div class="section"><h3>Printed labels before this update?</h3>
        <div class="hint" style="margin:0 0 10px">The tracker starts empty, so every bin shows as new. If your labels are already on the bins, mark them as printed once to start tracking changes from here.</div>
        <button class="btn" id="markAll">Mark all ${bins.length} as already printed</button></div>` : ''}
    <div class="fab-bar"><button class="btn dark" id="printGo">${icons.print} Print</button></div>`;

  const render = () => {
    document.querySelectorAll('[data-mode]').forEach(c => c.classList.toggle('on', c.dataset.mode === printMode));
    const list = bins.filter(inMode);
    const chosen = list.filter(b => !excluded.has(b.id));
    document.getElementById('plist').innerHTML = list.length ? `
      <div class="list-head"><span>${chosen.length} of ${list.length} selected</span>
        <button class="link-btn" id="toggleAll">${chosen.length === list.length ? 'Select none' : 'Select all'}</button></div>
      <div class="cards">${list.map(b => `
        <label class="card plabel ${excluded.has(b.id) ? '' : 'selected'}">
          <input type="checkbox" data-id="${b.id}" ${excluded.has(b.id) ? '' : 'checked'}>
          <div class="body">
            <div class="meta"><span class="loc">${esc(locText(b))}</span><span class="code">${esc(b.code)}</span>${labelBadge(b.label)}</div>
            <div class="name">${esc(b.name || 'Untitled bin')}</div>
            <div class="desc">${b.label.state === 'current'
              ? `Printed ${b.label.printedAt ? new Date(b.label.printedAt + 'Z').toLocaleDateString() : ''}`
              : esc(labelReasons(b.label).join(' · '))}</div>
          </div>
          <a class="plink" href="#/bin/${b.id}" aria-label="Open ${esc(b.code)}">›</a>
        </label>`).join('')}</div>`
      : `<div class="empty"><h2>All caught up</h2>${printMode === 'new' ? 'No bins are waiting for a first label.' : 'Every label on the shelves matches its bin.'}</div>`;
    document.querySelectorAll('#plist input[type=checkbox]').forEach(cb => cb.onchange = () => {
      cb.checked ? excluded.delete(+cb.dataset.id) : excluded.add(+cb.dataset.id);
      render();
    });
    const ta = document.getElementById('toggleAll');
    if (ta) ta.onclick = () => { if (chosen.length === list.length) list.forEach(b => excluded.add(b.id)); else excluded.clear(); render(); };
    const go = document.getElementById('printGo');
    go.disabled = !chosen.length;
    go.innerHTML = `${icons.print} Print ${chosen.length || ''} label${chosen.length === 1 ? '' : 's'}`;
    go.onclick = () => printLabels(chosen.map(b => b.id));
  };
  document.querySelectorAll('[data-mode]').forEach(c => c.onclick = () => { printMode = c.dataset.mode; excluded.clear(); render(); });
  const markAll = document.getElementById('markAll');
  if (markAll) markAll.onclick = async () => {
    if (!confirm(`Mark all ${bins.length} labels as printed? Only do this if the labels on your bins are current.`)) return;
    await api('/labels/printed', { method: 'POST', body: { ids: bins.map(b => b.id) } });
    toast('Tracking changes from now on');
    route();
  };
  render();
}

// Someone scanned this bin's QR code. The code never changes, so we can't tell which physical label
// it was, but if the last confirmed print no longer matches the bin, the label they're holding is stale.
function scanPrompt(b) {
  const done = async msg => {
    await api('/labels/printed', { method: 'POST', body: { ids: [b.id] } });
    sh.close();
    toast(msg);
    route();
  };
  let sh;
  if (b.label.state === 'changed') {
    const moved = b.label.changes.find(c => c.field === 'location');
    sh = sheet('This label is out of date', `
      <p style="margin-top:0">The label on this bin no longer matches it:</p>
      <ul class="scan-why">${labelReasons(b.label).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      ${moved ? `<div class="warn" style="margin:0 0 12px">This bin now belongs at <b>${esc(locText(b))}</b>${moved.from ? `, not ${esc(moved.from)}` : ''}.</div>` : ''}
      <div class="btn-row" style="flex-direction:column">
        <button class="btn primary" id="scanPrint">${icons.print} Print new label</button>
        <button class="btn" id="scanDone">I've already put the new label on</button>
        <button class="btn" data-close>Not now</button>
      </div>`);
    sh.body.querySelector('#scanDone').onclick = () => done('Label marked as up to date');
  } else {
    // Printed before the tracker existed (or never confirmed): let them vouch for it
    sh = sheet('Is this label current?', `
      <p style="margin-top:0">Binventory has no record of this label being printed. Check that it shows:</p>
      <div class="scan-check"><span class="loc">${esc(locText(b))}</span><b>${esc(b.name || 'Untitled bin')}</b>${b.description ? `<span class="hint" style="margin:0">${esc(b.description)}</span>` : ''}</div>
      <div class="btn-row" style="flex-direction:column">
        <button class="btn primary" id="scanDone">Yes, it matches</button>
        <button class="btn" id="scanPrint">${icons.print} No, print a new one</button>
        <button class="btn" data-close>Not now</button>
      </div>`);
    sh.body.querySelector('#scanDone').onclick = () => done('Label marked as current');
  }
  sh.body.querySelector('#scanPrint').onclick = () => { sh.close(); printLabels([b.id]); };
}
