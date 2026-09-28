'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { DatabaseSync } = require('node:sqlite');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const BIN_PREFIX = process.env.BIN_PREFIX || 'BIN';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';

fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'binventory.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS bins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    rack        TEXT NOT NULL DEFAULT '',
    shelf       TEXT NOT NULL DEFAULT '',
    position    TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bin_id  INTEGER NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    qty     INTEGER NOT NULL DEFAULT 1,
    notes   TEXT NOT NULL DEFAULT '',
    sort    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bin_id     INTEGER NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_items_bin ON items(bin_id);
  CREATE INDEX IF NOT EXISTS idx_photos_bin ON photos(bin_id);
`);

const q = {
  listBins: db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM items i WHERE i.bin_id = b.id) AS item_count,
      (SELECT filename FROM photos p WHERE p.bin_id = b.id ORDER BY p.id LIMIT 1) AS cover
    FROM bins b
    ORDER BY b.rack COLLATE NOCASE, b.shelf COLLATE NOCASE, b.position COLLATE NOCASE, b.id`),
  searchBins: db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM items i WHERE i.bin_id = b.id) AS item_count,
      (SELECT filename FROM photos p WHERE p.bin_id = b.id ORDER BY p.id LIMIT 1) AS cover,
      (SELECT group_concat(i.name, ', ') FROM items i WHERE i.bin_id = b.id AND i.name LIKE :q) AS matched_items
    FROM bins b
    WHERE b.code LIKE :q OR b.name LIKE :q OR b.description LIKE :q OR b.notes LIKE :q
       OR b.tags LIKE :q OR b.rack LIKE :q OR b.shelf LIKE :q
       OR EXISTS (SELECT 1 FROM items i WHERE i.bin_id = b.id AND (i.name LIKE :q OR i.notes LIKE :q))
    ORDER BY b.rack COLLATE NOCASE, b.shelf COLLATE NOCASE, b.position COLLATE NOCASE, b.id`),
  getBin: db.prepare('SELECT * FROM bins WHERE id = ?'),
  getBinByCode: db.prepare('SELECT * FROM bins WHERE code = ? COLLATE NOCASE'),
  items: db.prepare('SELECT * FROM items WHERE bin_id = ? ORDER BY sort, id'),
  photos: db.prepare('SELECT * FROM photos WHERE bin_id = ? ORDER BY id'),
  insertBin: db.prepare(`INSERT INTO bins (name, description, rack, shelf, position, notes, tags)
    VALUES (:name, :description, :rack, :shelf, :position, :notes, :tags)`),
  setCode: db.prepare('UPDATE bins SET code = ? WHERE id = ?'),
  updateBin: db.prepare(`UPDATE bins SET name=:name, description=:description, rack=:rack, shelf=:shelf,
    position=:position, notes=:notes, tags=:tags, updated_at=datetime('now') WHERE id=:id`),
  touch: db.prepare(`UPDATE bins SET updated_at=datetime('now') WHERE id = ?`),
  deleteBin: db.prepare('DELETE FROM bins WHERE id = ?'),
  clearItems: db.prepare('DELETE FROM items WHERE bin_id = ?'),
  insertItem: db.prepare('INSERT INTO items (bin_id, name, qty, notes, sort) VALUES (?, ?, ?, ?, ?)'),
  insertPhoto: db.prepare('INSERT INTO photos (bin_id, filename) VALUES (?, ?)'),
  getPhoto: db.prepare('SELECT * FROM photos WHERE id = ?'),
  deletePhoto: db.prepare('DELETE FROM photos WHERE id = ?'),
  racks: db.prepare(`SELECT DISTINCT rack FROM bins WHERE rack <> '' ORDER BY rack COLLATE NOCASE`),
  shelves: db.prepare(`SELECT DISTINCT shelf FROM bins WHERE shelf <> '' ORDER BY shelf COLLATE NOCASE`),
};

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function fullBin(id) {
  const bin = q.getBin.get(id);
  if (!bin) return null;
  return { ...bin, items: q.items.all(id), photos: q.photos.all(id) };
}

function cleanBin(body) {
  const s = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
  return {
    name: s(body.name, 120),
    description: s(body.description, 500),
    rack: s(body.rack, 40),
    shelf: s(body.shelf, 40),
    position: s(body.position, 40),
    notes: s(body.notes, 5000),
    tags: s(body.tags, 300),
  };
}

function saveItems(binId, items) {
  if (!Array.isArray(items)) return;
  q.clearItems.run(binId);
  items.forEach((it, i) => {
    const name = String(it?.name ?? '').trim().slice(0, 200);
    if (!name) return;
    const qty = Math.max(0, Math.min(999999, parseInt(it.qty, 10) || 1));
    q.insertItem.run(binId, name, qty, String(it.notes ?? '').trim().slice(0, 500), i);
  });
}

function removePhotoFile(filename) {
  fs.rm(path.join(PHOTO_DIR, path.basename(filename)), { force: true }, () => {});
}

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Optional HTTP basic auth (phones remember it after first login)
if (AUTH_USER && AUTH_PASS) {
  const expected = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const hdr = req.headers.authorization || '';
    const given = Buffer.from(hdr.startsWith('Basic ') ? Buffer.from(hdr.slice(6), 'base64').toString() : '');
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Binventory"').status(401).send('Authentication required');
  });
}

app.get('/healthz', (_req, res) => res.send('ok'));
app.use('/photos', express.static(PHOTO_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));

function baseUrl(req) {
  return BASE_URL || `${req.protocol}://${req.get('host')}`;
}
function binUrl(req, bin) {
  return `${baseUrl(req)}/b/${encodeURIComponent(bin.code)}`;
}

// Short URL encoded into the QR code
app.get('/b/:code', (req, res) => {
  const bin = q.getBinByCode.get(req.params.code);
  if (!bin) return res.redirect('/#/');
  res.redirect(`/#/bin/${bin.id}`);
});

const api = express.Router();

api.get('/config', (req, res) => res.json({ baseUrl: baseUrl(req), prefix: BIN_PREFIX, baseUrlSet: !!BASE_URL }));

api.get('/bins', (req, res) => {
  const term = String(req.query.q || '').trim();
  const rows = term ? q.searchBins.all({ q: `%${term}%` }) : q.listBins.all();
  res.json(rows);
});

api.get('/locations', (_req, res) => {
  res.json({ racks: q.racks.all().map(r => r.rack), shelves: q.shelves.all().map(r => r.shelf) });
});

api.post('/bins', (req, res) => {
  const data = cleanBin(req.body);
  const id = tx(() => {
    const { lastInsertRowid } = q.insertBin.run(data);
    const newId = Number(lastInsertRowid);
    q.setCode.run(`${BIN_PREFIX}-${String(newId).padStart(4, '0')}`, newId);
    saveItems(newId, req.body.items);
    return newId;
  });
  res.status(201).json(fullBin(id));
});

api.get('/bins/:id', (req, res) => {
  const bin = fullBin(req.params.id);
  if (!bin) return res.status(404).json({ error: 'Not found' });
  bin.url = binUrl(req, bin);
  res.json(bin);
});

api.put('/bins/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!q.getBin.get(id)) return res.status(404).json({ error: 'Not found' });
  tx(() => {
    q.updateBin.run({ ...cleanBin(req.body), id });
    saveItems(id, req.body.items);
  });
  res.json(fullBin(id));
});

api.delete('/bins/:id', (req, res) => {
  const id = Number(req.params.id);
  const photos = q.photos.all(id);
  q.deleteBin.run(id);
  photos.forEach(p => removePhotoFile(p.filename));
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

api.post('/bins/:id/photos', upload.array('photos', 20), (req, res) => {
  const id = Number(req.params.id);
  if (!q.getBin.get(id)) {
    (req.files || []).forEach(f => removePhotoFile(f.filename));
    return res.status(404).json({ error: 'Not found' });
  }
  (req.files || []).forEach(f => q.insertPhoto.run(id, f.filename));
  q.touch.run(id);
  res.json(q.photos.all(id));
});

api.delete('/photos/:id', (req, res) => {
  const photo = q.getPhoto.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  q.deletePhoto.run(photo.id);
  removePhotoFile(photo.filename);
  res.json({ ok: true });
});

api.get('/bins/:id/qr.svg', async (req, res) => {
  const bin = q.getBin.get(req.params.id);
  if (!bin) return res.status(404).end();
  const svg = await QRCode.toString(binUrl(req, bin), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

api.get('/export', (_req, res) => {
  const bins = q.listBins.all().map(b => fullBin(b.id));
  res.set('Content-Disposition', `attachment; filename="binventory-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), bins });
});

app.use('/api', api);

// ---------- 4x6 label PDF ----------
const W = 4 * 72, H = 6 * 72, M = 14;

function fitText(doc, text, { font, maxSize, minSize, width, height }) {
  doc.font(font);
  for (let size = maxSize; size >= minSize; size -= 1) {
    doc.fontSize(size);
    if (doc.heightOfString(text, { width }) <= height) return size;
  }
  return minSize;
}

function drawQR(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  doc.save().fillColor('#000');
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      // slight overdraw avoids hairline gaps on thermal printers
      if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.2, cell + 0.2);
    }
  }
  doc.fill().restore();
}

function drawLabel(doc, bin, url) {
  // Location band
  const bandH = 92;
  doc.rect(0, 0, W, bandH).fill('#000');
  const locs = [['RACK', bin.rack], ['SHELF', bin.shelf], ['POS', bin.position]].filter(([, v]) => v);
  if (!locs.length) locs.push(['LOCATION', 'UNASSIGNED']);
  const colW = (W - M * 2) / locs.length;
  locs.forEach(([label, value], i) => {
    const x = M + i * colW;
    if (i > 0) doc.moveTo(x - 4, 16).lineTo(x - 4, bandH - 12).lineWidth(1).strokeColor('#fff').stroke();
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text(label, x, 14, { width: colW - 8, characterSpacing: 1.5 });
    const size = fitText(doc, value, { font: 'Helvetica-Bold', maxSize: 44, minSize: 12, width: colW - 8, height: 54 });
    doc.fontSize(size).text(value, x, 28 + Math.max(0, (48 - size) / 2), { width: colW - 8, height: 58, ellipsis: true });
  });

  // Name
  let y = bandH + 12;
  const name = bin.name || 'Untitled bin';
  const nameSize = fitText(doc, name, { font: 'Helvetica-Bold', maxSize: 26, minSize: 14, width: W - M * 2, height: 62 });
  doc.fillColor('#000').fontSize(nameSize).text(name, M, y, { width: W - M * 2, height: 64, ellipsis: true });
  y = doc.y + 6;

  // Description
  // bottom-up: code text (16) + gap (4) + QR + caption (12)
  const qrSize = 166;
  const qrY = H - M - 16 - 4 - qrSize - 12;
  const descH = qrY - y - 10;
  if (bin.description && descH > 14) {
    const descSize = fitText(doc, bin.description, { font: 'Helvetica', maxSize: 14, minSize: 9, width: W - M * 2, height: descH });
    doc.fontSize(descSize).text(bin.description, M, y, { width: W - M * 2, height: descH, ellipsis: true });
  }

  // Divider
  doc.moveTo(M, qrY - 6).lineTo(W - M, qrY - 6).lineWidth(1.5).strokeColor('#000').stroke();

  // QR + code
  const qrX = (W - qrSize) / 2;
  drawQR(doc, url, qrX, qrY + 12, qrSize);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000')
    .text(bin.code, M, H - M - 14, { width: W - M * 2, align: 'center', characterSpacing: 2 });
  doc.font('Helvetica').fontSize(7)
    .text('SCAN FOR CONTENTS', M, qrY + 1, { width: W - M * 2, align: 'center', characterSpacing: 1 });
}

app.get('/labels.pdf', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const bins = ids.map(id => q.getBin.get(id)).filter(Boolean);
  if (!bins.length) return res.status(400).send('No bins selected');
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: 'Bin labels' } });
  res.type('application/pdf');
  res.set('Content-Disposition', `inline; filename="labels-${bins.map(b => b.code).join('_').slice(0, 80)}.pdf"`);
  doc.pipe(res);
  bins.forEach(bin => { doc.addPage(); drawLabel(doc, bin, binUrl(req, bin)); });
  doc.end();
});

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Binventory listening on :${PORT} (data: ${DATA_DIR})`);
  if (!BASE_URL) console.log('Tip: set BASE_URL (e.g. http://192.168.1.10:8080) so QR codes point at a reachable address.');
});
