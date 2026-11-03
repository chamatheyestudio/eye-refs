// Board state model.
//
// Every device keeps its own change file. Nobody ever writes another person's file,
// so Google Drive never sees two writers on one file.
//
// A change file holds, for every item it has touched, the latest value it wrote for
// each field together with a logical clock:
//   { format: 1, device: {...}, clock: 42, items: { "<itemId>": { "x": [120, 41], ... } } }
//
// Merging all change files: for every item and field, the write with the highest clock
// wins; ties go to the higher device key. Clocks are logical counters, not wall time,
// so a computer with the wrong date cannot reorder edits.

const FORMAT = 1;

// Names that would reach into JavaScript's object internals. A change file from
// someone else must never be able to set these.
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const okKey = (k) => typeof k === 'string' && k.length > 0 && k.length < 200 && !BAD_KEYS.has(k);
// A clock must be a sane whole number. One wildly ahead of everyone else would win
// every edit forever, so anything past this is ignored.
const MAX_CLOCK = 1e12;
const okClock = (t) => Number.isSafeInteger(t) && t >= 0 && t <= MAX_CLOCK;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function emptyDeviceFile(device) {
  return { format: FORMAT, device, clock: 0, items: {} };
}

function maxClock(files) {
  let m = 0;
  for (const f of files) {
    if (!f || typeof f.items !== 'object' || !f.items) continue;
    if (okClock(f.clock) && f.clock > m) m = f.clock;
    for (const id of Object.keys(f.items)) {
      const fields = f.items[id];
      if (!okKey(id) || !fields || typeof fields !== 'object') continue;
      for (const k of Object.keys(fields)) {
        const pair = fields[k];
        if (!Array.isArray(pair) || !okClock(pair[1])) continue;
        if (pair[1] > m) m = pair[1];
      }
    }
  }
  return m;
}

// Returns { items: { id: { ...values, _by: deviceKeyOfLatestWrite, _t: latestClock } } }
function mergeFiles(files) {
  const win = Object.create(null); // id -> field -> [value, t, deviceKey]
  for (const f of files) {
    if (!f || typeof f.items !== 'object' || !f.items || !f.device) continue;
    const dk = String(f.device.key || '');
    for (const id of Object.keys(f.items)) {
      const fields = f.items[id];
      if (!okKey(id) || !fields || typeof fields !== 'object') continue;
      const w = win[id] || (win[id] = Object.create(null));
      for (const k of Object.keys(fields)) {
        const pair = fields[k];
        if (!okKey(k) || !Array.isArray(pair) || pair.length < 2 || !okClock(pair[1])) continue;
        const [v, t] = pair;
        const cur = w[k];
        if (!cur || t > cur[1] || (t === cur[1] && dk > cur[2])) w[k] = [v, t, dk];
      }
    }
  }
  const items = {};
  for (const id of Object.keys(win)) {
    const o = {};
    let lt = -1, lb = '';
    for (const k of Object.keys(win[id])) {
      o[k] = win[id][k][0];
      if (win[id][k][1] > lt) { lt = win[id][k][1]; lb = win[id][k][2]; }
    }
    o.id = id;
    o._t = lt;
    o._dev = lb;
    items[id] = o;
  }
  return items;
}

// Apply a set of field writes to this device's own file. Returns the new clock.
function applyWrites(own, writes, clockFloor) {
  let clock = Math.max(okClock(own.clock) ? own.clock : 0, okClock(clockFloor) ? clockFloor : 0);
  for (const w of writes) {
    if (!w || !okKey(w.id) || !w.fields) continue;
    clock += 1;
    const it = has(own.items, w.id) ? own.items[w.id] : (own.items[w.id] = {});
    for (const k of Object.keys(w.fields)) {
      if (!okKey(k) || k === 'id' || k.startsWith('_')) continue;
      it[k] = [w.fields[k], clock];
    }
  }
  own.clock = clock;
  return clock;
}

module.exports = { FORMAT, emptyDeviceFile, maxClock, mergeFiles, applyWrites };
