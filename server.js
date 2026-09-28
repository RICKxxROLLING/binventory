'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { DatabaseSync } = require('node:sqlite');
const { setupAuth } = require('./auth');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const BIN_PREFIX = process.env.BIN_PREFIX || 'BIN';
// Local AI (Ollama). Blank OLLAMA_URL = AI features off.
const OLLAMA_URL = (process.env.OLLAMA_URL || '').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';
const AI_AUTO = !/^(0|false|no|off)$/i.test(process.env.AI_AUTO || '');
const AI_MAX_PHOTOS = Math.max(1, parseInt(process.env.AI_MAX_PHOTOS || '4', 10) || 4);
// Ollama's default context is small; several photos (Qwen-VL uses ~1k tokens each) would get cut off.
const AI_NUM_CTX = Math.max(2048, parseInt(process.env.AI_NUM_CTX || '8192', 10) || 8192);

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

// Columns added after the first release
const binCols = new Set(db.prepare('PRAGMA table_info(bins)').all().map(c => c.name));
for (const col of ['ai_description', 'ai_tags', 'ai_keywords', 'ai_items', 'ai_status', 'ai_error']) {
  if (!binCols.has(col)) db.exec(`ALTER TABLE bins ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}

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
       OR b.tags LIKE :q OR b.rack LIKE :q OR b.shelf LIKE :q OR b.ai_keywords LIKE :q
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
  setAiStatus: db.prepare('UPDATE bins SET ai_status = ?, ai_error = ? WHERE id = ?'),
  applyAi: db.prepare(`UPDATE bins SET name=:name, description=:description, tags=:tags,
    ai_description=:ai_description, ai_tags=:ai_tags, ai_keywords=:ai_keywords, ai_items=:ai_items,
    ai_status='done', ai_error='', updated_at=datetime('now') WHERE id=:id`),
  aiQueued: db.prepare(`SELECT id FROM bins WHERE ai_status IN ('pending', 'running') ORDER BY id`),
  aiNeverRun: db.prepare(`SELECT b.id FROM bins b WHERE b.ai_status IN ('', 'error')
    AND EXISTS (SELECT 1 FROM photos p WHERE p.bin_id = b.id) ORDER BY b.id`),
  maxSort: db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM items WHERE bin_id = ?'),
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
  let aiItems = [];
  try { aiItems = JSON.parse(bin.ai_items || '[]'); } catch { /* ignore */ }
  return { ...bin, ai_items: aiItems, items: q.items.all(id), photos: q.photos.all(id) };
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

// ---------- local AI (Ollama vision model) ----------
const AI_PROMPT = `These photos show the contents of ONE storage bin in a home/garage inventory.
Catalogue what is in it. Reply with JSON:
- "name": a short title for the bin, 2-5 words (e.g. "Christmas lights", "Bike repair tools")
- "description": one sentence, at most 20 words, summarising the contents. It is printed on the bin's label.
- "tags": 3-10 short lowercase category words useful for searching (e.g. "electrical", "holiday", "tools", "cables", "camping")
- "items": the distinct objects you can identify (up to 25), each with a specific name (e.g. "HDMI cable", "Phillips screwdriver") and an approximate count as "qty"
Only include things you can actually see. Mention a brand or model only if it is legible.`;

const AI_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name', 'qty'] },
    },
  },
  required: ['name', 'description', 'tags', 'items'],
};

const splitTags = s => String(s || '').split(',').map(t => t.trim()).filter(Boolean);

function normalizeAi(r) {
  const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const tags = [...new Set((Array.isArray(r?.tags) ? r.tags : [])
    .map(t => str(t, 30).toLowerCase().replace(/^#/, '').replace(/,/g, ' ').trim()).filter(Boolean))].slice(0, 10);
  const seen = new Set();
  const items = (Array.isArray(r?.items) ? r.items : []).map(i => ({
    name: str(i?.name, 100),
    qty: Math.max(1, Math.min(9999, parseInt(i?.qty, 10) || 1)),
  })).filter(i => i.name && !seen.has(i.name.toLowerCase()) && seen.add(i.name.toLowerCase())).slice(0, 25);
  return { name: str(r?.name, 120), description: str(r?.description, 500), tags, items };
}

async function analyzePhotos(photos) {
  const images = photos
    .filter(p => /\.(jpe?g|png|webp)$/i.test(p.filename)) // Ollama can't decode HEIC etc.
    .slice(-AI_MAX_PHOTOS)
    .map(p => fs.readFileSync(path.join(PHOTO_DIR, path.basename(p.filename))).toString('base64'));
  if (!images.length) throw new Error('No photos in a format the model can read (JPEG/PNG/WebP)');
  // Streamed so slow CPU-only models don't hit fetch's response-header timeout.
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      format: AI_SCHEMA,
      options: { temperature: 0.1, num_ctx: AI_NUM_CTX },
      messages: [{ role: 'user', content: AI_PROMPT, images }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let content = '';
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    content += chunk.message?.content || '';
  }
  try { return normalizeAi(JSON.parse(content)); }
  catch { throw new Error('Model did not return valid JSON'); }
}

// Merge AI output into the bin without clobbering what the user typed:
// name/description are filled only if empty (or still the previous AI text),
// tags from the previous AI run are replaced, the user's own tags are kept.
function applyAi(id, r) {
  const bin = q.getBin.get(id);
  if (!bin) return;
  const oldAi = new Set(splitTags(bin.ai_tags).map(t => t.toLowerCase()));
  const tags = splitTags(bin.tags).filter(t => !oldAi.has(t.toLowerCase()));
  const have = new Set(tags.map(t => t.toLowerCase()));
  for (const t of r.tags) {
    if (have.has(t) || [...tags, t].join(', ').length > 300) continue;
    tags.push(t); have.add(t);
  }
  q.applyAi.run({
    id,
    name: bin.name || r.name,
    description: !bin.description || bin.description === bin.ai_description ? r.description : bin.description,
    tags: tags.join(', '),
    ai_description: r.description,
    ai_tags: r.tags.join(', '),
    ai_keywords: r.items.map(i => i.name).join(', '),
    ai_items: JSON.stringify(r.items),
  });
}

// One job at a time: vision models are heavy and usually share a single GPU/CPU.
const aiQueue = [];
let aiBusy = false;
function queueAnalysis(id) {
  if (!OLLAMA_URL) return;
  q.setAiStatus.run('pending', '', id);
  if (!aiQueue.includes(id)) aiQueue.push(id);
  drainAi();
}
async function drainAi() {
  if (aiBusy) return;
  aiBusy = true;
  while (aiQueue.length) {
    const id = aiQueue.shift();
    try {
      const photos = q.photos.all(id);
      if (!q.getBin.get(id)) continue;
      if (!photos.length) { q.setAiStatus.run('', '', id); continue; }
      q.setAiStatus.run('running', '', id);
      const started = Date.now();
      const result = await analyzePhotos(photos);
      applyAi(id, result);
      console.log(`AI: analyzed bin ${id} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      const msg = e.cause?.code === 'ECONNREFUSED' ? `Can't reach Ollama at ${OLLAMA_URL}` : e.message;
      console.error(`AI: bin ${id} failed: ${msg}`);
      if (q.getBin.get(id)) q.setAiStatus.run('error', String(msg).slice(0, 300), id);
    }
  }
  aiBusy = false;
}
// Resume anything that was queued when the container stopped
if (OLLAMA_URL) q.aiQueued.all().forEach(r => queueAnalysis(r.id));

// ---------- app ----------
const app = express();
// Only believe X-Forwarded-For from proxies on the local network (Nginx Proxy Manager, SWAG,
// cloudflared...). Trusting it from anyone would let a remote client fake a LAN address.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));

const auth = setupAuth(app, { dataDir: DATA_DIR });
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

api.get('/config', (req, res) => res.json({
  baseUrl: baseUrl(req), prefix: BIN_PREFIX, baseUrlSet: !!BASE_URL,
  ai: { enabled: !!OLLAMA_URL, auto: AI_AUTO, model: OLLAMA_MODEL },
  auth: { enabled: auth.enabled, user: auth.user, days: auth.days },
}));

api.get('/ai/status', async (_req, res) => {
  if (!OLLAMA_URL) return res.json({ enabled: false });
  const out = { enabled: true, url: OLLAMA_URL, model: OLLAMA_MODEL, auto: AI_AUTO,
    queued: aiQueue.length + (aiBusy ? 1 : 0), unanalyzed: q.aiNeverRun.all().length };
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const { models = [] } = await r.json();
    const names = models.map(m => m.name);
    out.reachable = true;
    out.modelInstalled = names.includes(OLLAMA_MODEL) || names.includes(`${OLLAMA_MODEL}:latest`);
  } catch (e) {
    out.reachable = false;
    out.error = e.message;
  }
  res.json(out);
});

api.post('/ai/analyze-all', (_req, res) => {
  if (!OLLAMA_URL) return res.status(400).json({ error: 'AI is not configured (set OLLAMA_URL)' });
  const ids = q.aiNeverRun.all().map(r => r.id);
  ids.forEach(queueAnalysis);
  res.json({ queued: ids.length });
});

api.post('/bins/:id/analyze', (req, res) => {
  const id = Number(req.params.id);
  if (!OLLAMA_URL) return res.status(400).json({ error: 'AI is not configured (set OLLAMA_URL)' });
  if (!q.getBin.get(id)) return res.status(404).json({ error: 'Not found' });
  if (!q.photos.all(id).length) return res.status(400).json({ error: 'Add a photo first' });
  queueAnalysis(id);
  res.json(fullBin(id));
});

// Copy the objects the AI spotted into the bin's contents list (skipping ones already listed)
api.post('/bins/:id/ai-items', (req, res) => {
  const id = Number(req.params.id);
  const bin = fullBin(id);
  if (!bin) return res.status(404).json({ error: 'Not found' });
  const have = new Set(bin.items.map(i => i.name.toLowerCase()));
  tx(() => {
    let sort = q.maxSort.get(id).m;
    for (const it of bin.ai_items) {
      if (have.has(it.name.toLowerCase())) continue;
      q.insertItem.run(id, it.name, it.qty, '', ++sort);
      have.add(it.name.toLowerCase());
    }
    q.touch.run(id);
  });
  res.json(fullBin(id));
});

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
  if (AI_AUTO && req.files?.length) queueAnalysis(id);
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
