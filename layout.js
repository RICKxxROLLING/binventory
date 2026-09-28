'use strict';

// Rack layout, bin size presets and placement suggestions.
//
// A layout is { sizes: [{ name, dims }], racks: [{ id, name, bottomUp, allow, shelves: [{ positions, allow, slots: { "<pos>": { allow } } }] }] }.
// `allow` at any level is null (any size) or a list of size names; the effective rule for a
// position is the intersection of rack, shelf and position rules. [] means "don't use".
// Bins sit in slots through their rack/shelf/position text, so the layout never owns bin data.

const DEFAULT_SIZES = [
  { name: 'Small', dims: '' },
  { name: 'Medium', dims: '' },
  { name: 'Large', dims: '' },
];

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const normNum = v => { const s = str(v, 40); return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toLowerCase(); };
const slotKey = (rack, shelf, pos) => `${str(rack, 40).toLowerCase()}|${normNum(shelf)}|${normNum(pos)}`;
const binKey = b => slotKey(b.rack, b.shelf, b.position);

function normalizeLayout(raw) {
  const sizes = [];
  for (const s of Array.isArray(raw?.sizes) ? raw.sizes : DEFAULT_SIZES) {
    const name = str(typeof s === 'string' ? s : s?.name, 40);
    if (name && !sizes.some(x => x.name.toLowerCase() === name.toLowerCase())) sizes.push({ name, dims: str(s?.dims, 60) });
  }
  const names = sizes.slice(0, 20).map(s => s.name);
  // A rule that only listed sizes which were since deleted falls back to "any" rather than locking the spot.
  const cleanAllow = a => {
    if (!Array.isArray(a)) return null;
    if (!a.length) return [];
    const kept = [...new Set(a.map(s => str(s, 40)).filter(s => names.includes(s)))];
    return kept.length ? kept : null;
  };
  const seen = new Set();
  const racks = [];
  for (const [i, r] of (Array.isArray(raw?.racks) ? raw.racks : []).slice(0, 100).entries()) {
    const name = str(r?.name, 40) || String(i + 1);
    if (seen.has(name.toLowerCase())) throw Object.assign(new Error(`Two racks are named "${name}"`), { status: 400 });
    seen.add(name.toLowerCase());
    const shelves = (Array.isArray(r?.shelves) ? r.shelves : []).slice(0, 50).map(sh => {
      const positions = clampInt(sh?.positions, 1, 50, 4);
      const slots = {};
      for (const [k, v] of Object.entries(sh?.slots || {})) {
        const p = parseInt(k, 10);
        const allow = cleanAllow(v?.allow);
        if (p >= 1 && p <= positions && allow) slots[p] = { allow };
      }
      return { positions, allow: cleanAllow(sh?.allow), slots };
    });
    if (!shelves.length) continue;
    racks.push({ id: str(r?.id, 40) || `r${Date.now().toString(36)}${i}`, name, bottomUp: !!r?.bottomUp, allow: cleanAllow(r?.allow), shelves });
  }
  return { sizes: sizes.slice(0, 20), racks };
}

function intersect(...rules) {
  let out = null;
  for (const r of rules) {
    if (!Array.isArray(r)) continue;
    out = out === null ? [...r] : out.filter(s => r.includes(s));
  }
  return out;
}

function listSlots(layout) {
  const out = [];
  for (const r of layout.racks) {
    r.shelves.forEach((sh, si) => {
      for (let p = 1; p <= sh.positions; p++) {
        out.push({
          rack: r.name, shelf: String(si + 1), position: String(p),
          key: slotKey(r.name, si + 1, p),
          allow: intersect(r.allow, sh.allow, sh.slots[p]?.allow),
          shelfKey: `${r.name.toLowerCase()}|${si + 1}`, rackKey: r.name.toLowerCase(), p,
          index: out.length,
        });
      }
    });
  }
  return out;
}

// A bin with no size (or a size that's no longer a preset) fits anywhere that's in use.
function fits(slot, size, sizeNames) {
  if (slot.allow === null) return true;
  if (!slot.allow.length) return false;
  return !sizeNames.includes(size) || slot.allow.includes(size);
}

// ---------- content similarity ----------
const STOP = new Set(('and the for with from into misc stuff things thing assorted various other extra spare spares '
  + 'box boxes bin bins tote totes container set sets pack kit kits lot lots item items old new used small large big').split(' '));
const splitTags = s => String(s || '').split(',').map(t => t.trim()).filter(Boolean);

function termVector(bin, display) {
  const v = new Map();
  const add = (text, w) => {
    for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
      const t = raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
      v.set(t, (v.get(t) || 0) + w);
      if (display && !display.has(t)) display.set(t, raw);
    }
  };
  splitTags(bin.tags).forEach(t => add(t, 3));
  add(bin.name, 2);
  (bin.items || []).forEach(i => add(i.name, 1));
  add(bin.ai_keywords, 1);
  add(bin.description, 0.5);
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  return { v, norm: Math.sqrt(norm) };
}

function similarity(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [small, big] = a.v.size < b.v.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small.v) { const o = big.v.get(t); if (o) dot += w * o; }
  return dot / (a.norm * b.norm);
}

// Words shared by the bins in a group (e.g. a shelf), most common first.
function themeOf(vecs, display, max = 3) {
  if (vecs.length < 2) return [];
  const count = new Map();
  for (const x of vecs) for (const [t, w] of x.v) if (w >= 1) count.set(t, (count.get(t) || 0) + 1);
  return [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max).map(([t]) => display.get(t) || t);
}

function sharedWords(a, b, display, max = 3) {
  return [...a.v.keys()].filter(t => b.v.has(t))
    .sort((x, y) => b.v.get(y) * a.v.get(y) - b.v.get(x) * a.v.get(x)).slice(0, max).map(t => display.get(t) || t);
}

// Order bins so similar ones sit next to each other (greedy nearest-neighbour chain,
// looking back a few steps so one odd bin doesn't break a group).
function chainOrder(bins, vecs) {
  const n = bins.length;
  if (n < 2) return { order: bins.map((_, i) => i), links: [0] };
  const sim = bins.map((_, i) => bins.map((__, j) => (i === j ? 0 : similarity(vecs[i], vecs[j]))));
  const left = new Set(bins.map((_, i) => i));
  // Start at the most isolated bin so groups get laid out end to end
  let start = 0, low = Infinity;
  for (const i of left) { const s = sim[i].reduce((a, b) => a + b, 0); if (s < low) { low = s; start = i; } }
  const out = [start];
  const links = [0];
  left.delete(start);
  while (left.size) {
    let best = -1, bestScore = -1;
    for (const j of left) {
      const k = out.length;
      const s = Math.max(sim[out[k - 1]][j], k > 1 ? 0.7 * sim[out[k - 2]][j] : 0, k > 2 ? 0.5 * sim[out[k - 3]][j] : 0);
      if (s > bestScore) { bestScore = s; best = j; }
    }
    out.push(best);
    links.push(bestScore);
    left.delete(best);
  }
  return { order: out, links };
}

// Split the chain into groups of related bins wherever the link to the previous bin is weak
function chainGroups(bins, vecs, threshold = 0.15) {
  const { order, links } = chainOrder(bins, vecs);
  const groups = [];
  order.forEach((i, k) => {
    if (!groups.length || links[k] < threshold) groups.push([]);
    groups[groups.length - 1].push(i);
  });
  return groups;
}

// ---------- occupancy ----------
function occupancy(layout, bins) {
  const slots = listSlots(layout);
  const byKey = new Map(slots.map(s => [s.key, s]));
  const inSlot = new Map();
  const unplaced = [];
  for (const b of bins) {
    const slot = byKey.get(binKey(b));
    if (!slot) { unplaced.push({ id: b.id, reason: b.rack || b.shelf || b.position ? 'not in layout' : 'no location' }); continue; }
    if (!inSlot.has(slot.key)) inSlot.set(slot.key, []);
    inSlot.get(slot.key).push(b);
  }
  // Two or more bins recorded in the same spot: everyone after the first needs a new home
  const conflicts = [];
  for (const list of inSlot.values()) list.slice(1).forEach(b => conflicts.push({ id: b.id, reason: `shares ${b.rack}-${b.shelf}-${b.position} with ${list[0].code}` }));
  return { slots, byKey, inSlot, unplaced, conflicts };
}

// Shelf "themes" for the layout view
function shelfThemes(layout, bins) {
  const display = new Map();
  const { slots, inSlot } = occupancy(layout, bins);
  const groups = new Map();
  for (const s of slots) for (const b of inSlot.get(s.key) || []) {
    if (!groups.has(s.shelfKey)) groups.set(s.shelfKey, []);
    groups.get(s.shelfKey).push(termVector(b, display));
  }
  const out = {};
  for (const [k, vecs] of groups) out[k] = themeOf(vecs, display);
  return out;
}

// ---------- suggestions for one bin ----------
function suggest(layout, bins, target, limit = 3) {
  const sizeNames = layout.sizes.map(s => s.name);
  const display = new Map();
  const tv = termVector(target, display);
  const others = bins.filter(b => b.id !== target.id);
  const { slots, inSlot } = occupancy(layout, others);
  const vec = new Map(others.map(b => [b.id, termVector(b, display)]));
  const byShelf = new Map(), byRack = new Map();
  for (const s of slots) for (const b of inSlot.get(s.key) || []) {
    for (const [m, k] of [[byShelf, s.shelfKey], [byRack, s.rackKey]]) { if (!m.has(k)) m.set(k, []); m.get(k).push({ b, p: s.p, shelfKey: s.shelfKey }); }
  }
  const curKey = target.id ? binKey(target) : null;
  const cands = [];
  for (const s of slots) {
    if (inSlot.has(s.key) || !fits(s, target.size, sizeNames)) continue;
    let score = 0, near = null, nearSim = 0;
    const consider = (list, weight, adjacentOnly) => {
      for (const { b, p, shelfKey } of list || []) {
        if (adjacentOnly && (shelfKey !== s.shelfKey || Math.abs(p - s.p) !== 1)) continue;
        const sim = similarity(tv, vec.get(b.id));
        score = Math.max(score, sim * weight);
        if (sim > nearSim) { nearSim = sim; near = b; }
      }
    };
    consider(byShelf.get(s.shelfKey), 1);
    consider(byRack.get(s.rackKey), 0.5);
    consider(byShelf.get(s.shelfKey), 1.15, true); // right next to a similar bin is best
    // Don't use up spots reserved for particular sizes when a general one will do
    const spare = s.allow === null ? sizeNames.length : s.allow.length;
    score -= 0.02 * Math.max(0, spare - 1) / Math.max(1, sizeNames.length);
    if (s.key === curKey) score += 0.05;
    cands.push({ s, score, near, nearSim });
  }
  cands.sort((a, b) => b.score - a.score || a.s.index - b.s.index);
  // Spread the picks across shelves so the options are actually different
  const picked = [], shelves = new Set();
  for (const c of cands) {
    if (picked.length >= limit) break;
    if (!shelves.has(c.s.shelfKey)) { picked.push(c); shelves.add(c.s.shelfKey); }
  }
  for (const c of cands) if (picked.length < limit && !picked.includes(c)) picked.push(c);
  picked.sort((a, b) => b.score - a.score || a.s.index - b.s.index);
  return picked.map(({ s, near, nearSim }) => ({
    rack: s.rack, shelf: s.shelf, position: s.position,
    current: s.key === curKey,
    near: near && nearSim > 0.05 ? { id: near.id, code: near.code, name: near.name, shared: sharedWords(tv, vec.get(near.id), display) } : null,
  }));
}

// ---------- plan a (re)arrangement ----------
// mode 'unplaced': bins already in a valid spot stay; the rest are placed next to similar bins.
// mode 'all': every bin is re-laid out so similar bins share shelves and racks.
function plan(layout, bins, mode) {
  const sizeNames = layout.sizes.map(s => s.name);
  const display = new Map();
  const { slots, byKey } = occupancy(layout, []);
  const taken = new Map(); // slot key -> bin
  const toPlace = [];
  const current = new Map(bins.map(b => [b.id, byKey.get(binKey(b)) || null]));

  if (mode === 'unplaced') {
    for (const b of bins) {
      const s = current.get(b.id);
      if (s && !taken.has(s.key) && fits(s, b.size, sizeNames)) taken.set(s.key, b);
      else toPlace.push(b);
    }
  } else {
    toPlace.push(...bins);
  }

  const vecs = toPlace.map(b => termVector(b, display));
  const assigned = new Map(); // bin id -> slot
  const noRoom = [];
  // Bins waiting to move physically still sit in their old spot (possibly several in one),
  // so that spot stays unavailable until all of them have moved out.
  const held = new Map(); // slot key -> Map(bin id -> bin)
  if (mode === 'unplaced') {
    for (const b of toPlace) {
      const s = current.get(b.id);
      if (!s || taken.get(s.key)?.id === b.id) continue;
      if (!held.has(s.key)) held.set(s.key, new Map());
      held.get(s.key).set(b.id, b);
    }
  }

  if (mode === 'unplaced') {
    // Most constrained first, each one placed next to its most similar neighbour so far
    const placedBins = () => [...taken.values(), ...[...held.values()].filter(m => m.size).map(m => m.values().next().value)];
    const order = toPlace.map((b, i) => i).sort((a, b) =>
      slots.filter(s => fits(s, toPlace[a].size, sizeNames)).length - slots.filter(s => fits(s, toPlace[b].size, sizeNames)).length);
    for (const i of order) {
      const b = toPlace[i];
      const [pick] = suggest(layout, placedBins(), { ...b, id: 0 }, 1);
      if (!pick) { noRoom.push(b); continue; }
      const s = byKey.get(slotKey(pick.rack, pick.shelf, pick.position));
      const old = current.get(b.id);
      if (old) held.get(old.key)?.delete(b.id);
      taken.set(s.key, { ...b, rack: s.rack, shelf: s.shelf, position: s.position });
      assigned.set(b.id, s);
    }
  } else {
    const free = new Set(slots.filter(s => !s.allow || s.allow.length).map(s => s.index));
    const demand = new Map();
    for (const b of toPlace) if (sizeNames.includes(b.size)) demand.set(b.size, (demand.get(b.size) || 0) + 1);
    const shelves = new Map(); // shelfKey -> slot indexes, in order
    for (const s of slots) { if (!shelves.has(s.shelfKey)) shelves.set(s.shelfKey, []); shelves.get(s.shelfKey).push(s.index); }

    // Sizes whose remaining bins need every remaining spot that takes them
    const tightSizes = except => {
      const tight = new Set();
      for (const [size, n] of demand) {
        if (n <= 0 || size === except) continue;
        let cap = 0;
        for (const idx of free) if (fits(slots[idx], size, sizeNames)) cap++;
        if (n >= cap) tight.add(size);
      }
      return tight;
    };

    // Pick the shelf a group should start on: enough free room that suits the group,
    // with as little left over and as few unneeded sizes allowed as possible.
    const pickShelf = group => {
      const sizes = new Set(group.map(b => b.size));
      let best = null, bestScore = Infinity;
      for (const idxs of shelves.values()) {
        const room = idxs.filter(i => free.has(i) && group.some(b => fits(slots[i], b.size, sizeNames))).length;
        if (!room) continue;
        const allow = slots[idxs[0]].allow; // shelf-level character (positions may narrow it further)
        const unneeded = allow === null ? sizeNames.filter(n => !sizes.has(n)).length : allow.filter(n => !sizes.has(n)).length;
        // Bins with no size set shouldn't take shelves kept for particular sizes
        const unsized = allow !== null && group.some(b => !sizeNames.includes(b.size)) ? 3 : 0;
        const score = (room >= group.length ? (room - group.length) : 1000 + (group.length - room) * 10) + 2 * unneeded + unsized;
        if (score < bestScore) { bestScore = score; best = idxs; }
      }
      return best ? Math.min(...best.filter(i => free.has(i))) : 0;
    };

    const groups = chainGroups(toPlace, vecs).map(g => g.map(i => toPlace[i]));
    // Big groups claim shelves first; single odd bins fill the gaps at the end
    const ordered = groups.map((g, k) => ({ g, k })).sort((a, b) => b.g.length - a.g.length || a.k - b.k).map(x => x.g);
    for (const group of ordered) {
      let cursor = group.length > 1 ? pickShelf(group) : 0;
      for (const b of group) {
        const tight = tightSizes(b.size);
        let best = null, bestCost = Infinity;
        for (const idx of free) {
          const s = slots[idx];
          if (!fits(s, b.size, sizeNames)) continue;
          let cost = idx >= cursor ? idx - cursor : (cursor - idx) * 1.5;
          for (const t of tight) if (fits(s, t, sizeNames)) cost += 1000;
          if (s.allow !== null && !sizeNames.includes(b.size)) cost += 2;
          if (current.get(b.id)?.index === idx) cost -= 1.5; // avoid pointless moves
          if (cost < bestCost) { bestCost = cost; best = s; }
        }
        if (!best) { noRoom.push(b); continue; }
        free.delete(best.index);
        assigned.set(b.id, best);
        cursor = best.index + 1;
        if (demand.has(b.size)) demand.set(b.size, demand.get(b.size) - 1);
      }
    }
  }

  // Greedy grouping can strand a bin when size rules are tight. Shuffle bins placed by this plan
  // along to other spots that suit them (augmenting paths) to make room, if that's possible.
  if (noRoom.length) {
    const blocked = new Set();
    if (mode === 'unplaced') {
      for (const [k, b] of taken) if (!assigned.has(b.id)) blocked.add(k);
      for (const [k, m] of held) if (m.size) blocked.add(k);
    }
    const owner = new Map([...assigned].map(([id, s]) => [s.index, toPlace.find(b => b.id === id)]));
    const augment = (b, seen) => {
      for (const s of slots) {
        if (seen.has(s.index) || blocked.has(s.key) || !fits(s, b.size, sizeNames)) continue;
        seen.add(s.index);
        const o = owner.get(s.index);
        if (!o || augment(o, seen)) { owner.set(s.index, b); assigned.set(b.id, s); return true; }
      }
      return false;
    };
    for (let i = noRoom.length - 1; i >= 0; i--) {
      const b = noRoom[i];
      const old = current.get(b.id);
      if (mode === 'unplaced' && old) held.get(old.key)?.delete(b.id);
      if (augment(b, new Set())) noRoom.splice(i, 1);
      else if (mode === 'unplaced' && old) held.get(old.key)?.set(b.id, b);
    }
  }

  const moves = [];
  for (const b of toPlace) {
    const to = assigned.get(b.id);
    const from = { rack: b.rack, shelf: b.shelf, position: b.position };
    if (to) {
      if (current.get(b.id)?.key !== to.key) moves.push({ id: b.id, code: b.code, name: b.name, size: b.size, from, to: { rack: to.rack, shelf: to.shelf, position: to.position } });
    } else if (mode === 'all' && (b.rack || b.shelf || b.position)) {
      // No room anywhere: take it off the rack rather than leave it double-booked
      moves.push({ id: b.id, code: b.code, name: b.name, size: b.size, from, to: { rack: '', shelf: '', position: '' } });
    }
  }

  // Themes of the resulting shelves, for the preview
  const after = bins.map(b => { const s = assigned.get(b.id); return s ? { ...b, rack: s.rack, shelf: s.shelf, position: s.position } : b; });
  return {
    moves,
    noRoom: noRoom.map(b => ({ id: b.id, code: b.code, name: b.name, size: b.size })),
    themes: shelfThemes(layout, after),
  };
}

module.exports = { DEFAULT_SIZES, normalizeLayout, listSlots, occupancy, shelfThemes, suggest, plan, slotKey, binKey, fits };
