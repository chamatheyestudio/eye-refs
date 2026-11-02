// One open board. Keeps this device's change file, reads everyone else's,
// writes the "I'm here" note and saves automatically.
const path = require('path');
const fsp = require('fs').promises;
const { writeJson, readJson, listDir, mtime, isWritable } = require('./fsutil');
const { emptyDeviceFile, maxClock, mergeFiles, applyWrites } = require('../shared/merge');
const { presenceIn } = require('./library');

const SAVE_DELAY_MS = 700;
const POLL_MS = 4000;
const PRESENCE_MS = 60 * 1000;

class Session {
  constructor(record, me, backupDir, events) {
    this.rec = record;
    this.me = me;
    this.events = events; // { state(items), status(s), presence(list) }
    this.changesDir = path.join(record.dir, 'changes');
    this.hereDir = path.join(record.dir, 'here');
    this.mediaDir = path.join(record.dir, 'media');
    this.ownName = `${me.deviceKey}.json`;
    this.ownPath = path.join(this.changesDir, this.ownName);
    this.backupPath = path.join(backupDir, `${record.id}.json`);
    this.herePath = path.join(this.hereDir, `${me.deviceKey}.json`);
    this.others = new Map(); // filename -> { mtime, data }
    this.own = null;
    this.saveTimer = null;
    this.saving = Promise.resolve();
    this.status = 'saved';
    this.readOnly = false;
    this.lastMergedKey = '';
    this.closed = false;
  }

  device() {
    return { key: this.me.deviceKey, email: this.me.email, name: this.me.name, platform: process.platform };
  }

  async open() {
    for (const d of [this.changesDir, this.hereDir, this.mediaDir]) {
      try { await fsp.mkdir(d, { recursive: true }); } catch (_) {}
    }
    this.readOnly = !(await isWritable(this.changesDir));

    // Use whichever copy of our own file is further ahead: the one in Drive or the local backup.
    const inDrive = await readJson(this.ownPath);
    const backup = await readJson(this.backupPath);
    const good = (f) => f && f.items && f.device && f.device.key === this.me.deviceKey;
    let own = good(inDrive) ? inDrive : null;
    if (good(backup) && (!own || (backup.clock || 0) > (own.clock || 0))) {
      own = backup;
      this.needsRestoreSave = true;
    }
    this.own = own || emptyDeviceFile(this.device());
    this.own.device = this.device();

    await this.poll(true);
    if (this.needsRestoreSave && !this.readOnly) this.scheduleSave();
    this.setStatus(this.readOnly ? 'readonly' : 'saved');
    this.pollTimer = setInterval(() => this.poll(false).catch(() => {}), POLL_MS);
    await this.heartbeat();
    this.hereTimer = setInterval(() => this.heartbeat().catch(() => {}), PRESENCE_MS);
    return this.merged();
  }

  files() {
    return [this.own, ...[...this.others.values()].map((o) => o.data)];
  }

  merged() {
    return mergeFiles(this.files());
  }

  emitIfChanged(force) {
    const items = this.merged();
    // Cheap change detection on clocks
    let key = '';
    for (const id in items) key += id + ':' + items[id]._t + ';';
    if (force || key !== this.lastMergedKey) {
      this.lastMergedKey = key;
      this.events.state(items);
    }
  }

  async poll(force) {
    if (this.closed) return;
    const seen = new Set();
    for (const e of await listDir(this.changesDir)) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
      if (e.name === this.ownName) continue;
      seen.add(e.name);
      const p = path.join(this.changesDir, e.name);
      const m = await mtime(p);
      const prev = this.others.get(e.name);
      if (prev && prev.mtime === m) continue;
      const data = await readJson(p);
      if (data && data.items) this.others.set(e.name, { mtime: m, data });
    }
    for (const k of [...this.others.keys()]) if (!seen.has(k)) this.others.delete(k);
    this.emitIfChanged(force);
    await this.checkPresence(force);
  }

  // Who else has this board open. Read on every sync, sent on when it changes.
  async checkPresence(force) {
    const list = await presenceIn(this.rec.dir, this.me);
    const key = list.map((h) => h.device).sort().join(',');
    if (force || key !== this.lastHereKey) {
      this.lastHereKey = key;
      this.events.presence(list);
    }
  }

  write(writes) {
    if (this.readOnly) return { ok: false, readOnly: true };
    const floor = maxClock(this.files());
    applyWrites(this.own, writes, floor);
    this.scheduleSave();
    return { ok: true };
  }

  scheduleSave() {
    this.setStatus('saving');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const snapshot = JSON.parse(JSON.stringify(this.own));
    this.saving = this.saving.then(async () => {
      // Local backup first, so a crash or a Drive hiccup never loses work.
      try { await writeJson(this.backupPath, snapshot); } catch (_) {}
      try {
        await writeJson(this.ownPath, snapshot);
        if (!this.saveTimer) this.setStatus('saved');
      } catch (e) {
        this.readOnly = !(await isWritable(this.changesDir));
        this.setStatus(this.readOnly ? 'readonly' : 'local');
      }
    });
    return this.saving;
  }

  async flush() {
    if (this.saveTimer) await this.save();
    await this.saving;
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.events.status(s);
  }

  async heartbeat() {
    if (this.closed) return;
    if (!this.readOnly) {
      try {
        await writeJson(this.herePath, { name: this.me.name, email: this.me.email, device: this.me.deviceKey, at: Date.now() });
      } catch (_) {}
    }
    await this.checkPresence(false);
  }

  async close() {
    this.closed = true;
    clearInterval(this.pollTimer);
    clearInterval(this.hereTimer);
    await this.flush();
    try { await fsp.unlink(this.herePath); } catch (_) {}
  }
}

module.exports = { Session };
