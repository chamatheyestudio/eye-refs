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

function emptyDeviceFile(device) {
  return { format: FORMAT, device, clock: 0, items: {} };
}

function maxClock(files) {
  let m = 0;
  for (const f of files) {
    if (!f || !f.items) continue;
    if (typeof f.clock === 'number' && f.clock > m) m = f.clock;
    for (const id in f.items) {
      const fields = f.items[id];
      for (const k in fields) {
        const t = fields[k][1];
        if (t > m) m = t;
      }
    }
  }
  return m;
}

// Returns { items: { id: { ...values, _by: deviceKeyOfLatestWrite, _t: latestClock } } }
function mergeFiles(files) {
  const win = {}; // id -> field -> [value, t, deviceKey]
  for (const f of files) {
    if (!f || !f.items || !f.device) continue;
    const dk = String(f.device.key || '');
    for (const id in f.items) {
      const fields = f.items[id];
      const w = win[id] || (win[id] = {});
      for (const k in fields) {
        const pair = fields[k];
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const [v, t] = pair;
        const cur = w[k];
        if (!cur || t > cur[1] || (t === cur[1] && dk > cur[2])) w[k] = [v, t, dk];
      }
    }
  }
  const items = {};
  for (const id in win) {
    const o = {};
    let lt = -1, lb = '';
    for (const k in win[id]) {
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
  let clock = Math.max(own.clock || 0, clockFloor || 0);
  for (const w of writes) {
    if (!w || !w.id || !w.fields) continue;
    clock += 1;
    const it = own.items[w.id] || (own.items[w.id] = {});
    for (const k in w.fields) {
      if (k === 'id' || k.startsWith('_')) continue;
      it[k] = [w.fields[k], clock];
    }
  }
  own.clock = clock;
  return clock;
}

module.exports = { FORMAT, emptyDeviceFile, maxClock, mergeFiles, applyWrites };
