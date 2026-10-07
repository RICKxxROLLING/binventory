'use strict';
// Scan station: a wall-mounted iPad + Bluetooth barcode scanner. The scanner acts as a keyboard and
// "types" the label's QR content followed by Enter; this page catches those keystrokes anywhere
// (no text box needs focus, so the on-screen keyboard never pops up) and shows that bin.
// Written for old Safari (iOS 12+): no optional chaining, no ?? / ||=, no object spread.

(function () {
  var params = new URLSearchParams(location.search);
  var IDLE_SECONDS = Math.max(10, parseInt(params.get('idle'), 10) || 90); // back to "ready" after this
  var RELOAD_HOURS = 6; // reload while idle now and then: picks up updates and clears any stuck state

  var view = document.getElementById('view');
  var idleTimer = null, timerBar = null;
  var loadedAt = Date.now();
  var recent = [];
  try { recent = JSON.parse(localStorage.getItem('scanRecent') || '[]'); } catch (e) { recent = []; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    return fetch('/api' + path, init).then(function (res) {
      if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent('/scan.html' + location.search); throw new Error('Sign in required'); }
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
      });
    });
  }

  // ---------- sound (unlocked by the first tap; scanning works without it) ----------
  var audio = null;
  function unlockAudio() {
    if (audio) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = new Ctx();
    var b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
    s.buffer = b; s.connect(audio.destination); s.start(0);
  }
  document.addEventListener('touchend', unlockAudio, false);
  document.addEventListener('click', unlockAudio, false);
  function beep(ok) {
    if (!audio) return;
    var o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 1320 : 220;
    o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.15;
    o.connect(g); g.connect(audio.destination);
    o.start(audio.currentTime);
    o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  }

  // ---------- keep the screen on where the browser supports it (iOS 16.4+) ----------
  function wake() {
    if (navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').catch(function () {});
  }
  document.addEventListener('visibilitychange', wake);
  wake();

  // ---------- connection + clock ----------
  function heartbeat() {
    api('/config').then(function () {
      document.getElementById('dot').className = 'dot';
      document.getElementById('conn').textContent = 'Connected';
    }).catch(function () {
      document.getElementById('dot').className = 'dot off';
      document.getElementById('conn').textContent = 'Offline';
    });
  }
  setInterval(heartbeat, 60000);
  heartbeat();
  function tick() {
    var d = new Date();
    document.getElementById('clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  setInterval(tick, 10000);
  tick();

  // ---------- screens ----------
  var boxSvg = '<svg viewBox="0 0 64 64"><path d="M12 24h40v26a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4z" fill="#111418"/><rect x="9" y="16" width="46" height="10" rx="3" fill="#111418"/><rect x="24" y="33" width="16" height="6" rx="3" fill="#f5a524"/></svg>';

  function showReady() {
    clearTimeout(idleTimer);
    if (Date.now() - loadedAt > RELOAD_HOURS * 3600e3) { location.reload(); return; }
    view.innerHTML =
      '<div class="ready">' +
        '<div class="icon">' + boxSvg + '</div>' +
        '<h1>Scan a bin label</h1>' +
        '<p>Point the scanner at the QR code on any bin.</p>' +
        '<button class="btn manual" id="manual">Type a bin code</button>' +
        (recent.length ? '<div class="recent"><h3>Recently scanned</h3>' + recent.map(function (r) {
          return '<a href="#" data-code="' + esc(r.code) + '"><span><b>' + esc(r.code) + '</b> ' + esc(r.name) + '</span><span>' + esc(r.loc) + '</span></a>';
        }).join('') + '</div>' : '') +
      '</div>';
    document.getElementById('manual').onclick = function () {
      var code = window.prompt('Bin code (e.g. BIN-0001)');
      if (code) handleScan(code);
    };
    Array.prototype.forEach.call(view.querySelectorAll('[data-code]'), function (a) {
      a.onclick = function (e) { e.preventDefault(); handleScan(a.getAttribute('data-code')); };
    });
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showReady, IDLE_SECONDS * 1000);
    if (timerBar) {
      timerBar.style.transition = 'none'; timerBar.style.webkitTransition = 'none';
      timerBar.style.width = '100%';
      void timerBar.offsetWidth; // restart the countdown bar
      timerBar.style.transition = 'width ' + IDLE_SECONDS + 's linear'; timerBar.style.webkitTransition = 'width ' + IDLE_SECONDS + 's linear';
      timerBar.style.width = '0%';
    }
  }
  // Touching the screen keeps the current bin up
  document.addEventListener('touchstart', function () { if (timerBar) armIdle(); }, false);

  function locText(b) {
    var parts = [];
    if (b.rack) parts.push('Rack ' + b.rack);
    if (b.shelf) parts.push('Shelf ' + b.shelf);
    if (b.position) parts.push('Pos ' + b.position);
    return parts.join(' · ') || 'No location';
  }
  function locShort(f) { return [f.rack, f.shelf, f.position].filter(Boolean).join('-'); }

  function showError(title, msg) {
    timerBar = null;
    view.innerHTML = '<div class="error"><h1>' + esc(title) + '</h1><p>' + esc(msg) + '</p><button class="btn" id="back">OK</button></div>';
    document.getElementById('back').onclick = showReady;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showReady, 8000);
  }

  function showBin(b, scan) {
    var locs = [['RACK', b.rack], ['SHELF', b.shelf], ['POS', b.position]].filter(function (x) { return x[1]; });
    if (!locs.length) locs = [['LOCATION', 'Unassigned']];
    var total = b.items.reduce(function (s, i) { return s + i.qty; }, 0);

    // Label check: fingerprinted labels are judged exactly, older ones by the print tracker
    var banner = '';
    if (scan.result === 'old') {
      banner = '<div class="banner warn"><b>This is an old label.</b> ' +
        (scan.printed ? 'It says ' + esc(locShort(scan.printed) || 'no location') + (scan.printed.name !== b.name ? ' “' + esc(scan.printed.name) + '”' : '') + '. ' : '') +
        'The bin belongs at <b>' + esc(locText(b)) + '</b>.' +
        '<div><button class="btn primary" id="printNew">Print new label</button></div></div>';
    } else if (scan.result === 'legacy' && b.label && b.label.state === 'changed') {
      banner = '<div class="banner warn"><b>This label is out of date</b> (the bin was moved, renamed or re-described).' +
        '<div><button class="btn primary" id="printNew">Print new label</button></div></div>';
    } else if (scan.result === 'current' && scan.verified) {
      banner = '<div class="banner ok">Label checked: it matches this bin.</div>';
    }

    view.innerHTML =
      '<div class="timer"><div id="timerBar"></div></div>' +
      banner +
      '<div class="band">' + locs.map(function (l) { return '<div><small>' + l[0] + '</small><strong>' + esc(l[1]) + '</strong></div>'; }).join('') + '</div>' +
      '<div class="head"><div class="text">' +
        '<div class="code">' + esc(b.code) + (b.size ? ' · ' + esc(b.size) : '') + '</div>' +
        '<h2>' + esc(b.name || 'Untitled bin') + '</h2>' +
        (b.description ? '<p class="desc">' + esc(b.description) + '</p>' : '') +
      '</div>' + (b.photos.length ? '<div class="photo" style="background-image:url(\'/photos/' + encodeURIComponent(b.photos[0].filename) + '\')"></div>' : '') + '</div>' +
      '<div class="card"><h3>Contents · ' + b.items.length + ' line' + (b.items.length === 1 ? '' : 's') + ' · ' + total + ' total</h3>' +
        (b.items.length ? '<ul class="items">' + b.items.map(function (i) { return '<li><b>×' + i.qty + '</b> ' + esc(i.name) + '</li>'; }).join('') + '</ul>' : '<div class="hint">No items listed.</div>') +
      '</div>' +
      (b.tags ? '<div class="card tags"><h3>Tags</h3>' + b.tags.split(',').map(function (t) { return t.trim() ? '<span>' + esc(t.trim()) + '</span>' : ''; }).join('') + '</div>' : '') +
      '<div class="actions"><button class="btn" id="done">Done</button><a class="btn" href="/#/bin/' + b.id + '">Open in Binventory</a></div>';

    timerBar = document.getElementById('timerBar');
    armIdle();
    document.getElementById('done').onclick = showReady;
    var p = document.getElementById('printNew');
    if (p) p.onclick = function () {
      window.open('/labels.pdf?ids=' + b.id, '_blank');
      p.parentNode.innerHTML = '<button class="btn primary" id="markDone">It printed: mark as done</button>';
      document.getElementById('markDone').onclick = function () {
        api('/labels/printed', { method: 'POST', body: { ids: [b.id] } }).then(function () {
          var bn = view.querySelector('.banner');
          if (bn) { bn.className = 'banner ok'; bn.innerHTML = 'New label recorded. Stick it on and throw the old one away.'; }
        });
      };
    };

    recent = [{ code: b.code, name: b.name, loc: locShort(b) }].concat(recent.filter(function (r) { return r.code !== b.code; })).slice(0, 5);
    try { localStorage.setItem('scanRecent', JSON.stringify(recent)); } catch (e) { /* private mode */ }
  }

  // Accepts a label URL (…/b/BIN-0001?l=1a2b3c4d), a bare bin code, or a URL with #/bin/<id>
  function handleScan(raw) {
    raw = String(raw).trim();
    if (!raw) return;
    var m = raw.match(/\/b\/([^?#\s\/]+)(?:\?(?:.*&)?l=([0-9a-fA-F]{8}))?/);
    var code = m ? decodeURIComponent(m[1]) : raw;
    var hash = m && m[2] ? m[2].toLowerCase() : '';
    view.innerHTML = '<div class="ready"><p>Looking up ' + esc(code) + '…</p></div>';
    api('/lookup/' + encodeURIComponent(code)).then(function (b) {
      return api('/bins/' + b.id + '/scan', { method: 'POST', body: { l: hash } })
        .catch(function () { return { result: 'legacy' }; })
        .then(function (scan) { beep(true); showBin(b, scan); });
    }).catch(function (err) {
      beep(false);
      showError('Not found', /No bin/.test(err.message) ? 'No bin with code “' + code + '”. Is this a Binventory label?' : err.message);
    });
  }

  // ---------- scanner input ----------
  // Collect characters typed in quick succession; Enter (or Tab) ends a scan. A pause longer than
  // GAP_MS starts over, so stray key presses don't pile up.
  var buf = '', last = 0, GAP_MS = 400;
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var now = Date.now();
    if (now - last > GAP_MS) buf = '';
    last = now;
    if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
      e.preventDefault();
      if (buf.length >= 3) handleScan(buf);
      buf = '';
      return;
    }
    if (e.key && e.key.length === 1) { buf += e.key; e.preventDefault(); }
  }, false);

  showReady();
})();
