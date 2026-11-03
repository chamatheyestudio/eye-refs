// Keeps one shared board in step with the EyeStudio Google Drive.
//
// * This computer's change file goes up after each save.
// * Everyone else's change files come down into changes/, where the board picks them up.
// * New images and videos go up and come down in pieces, so big files never block.
// * Names are unique and nothing is ever overwritten, so the same file is never moved twice.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { writeAtomic, listDir } = require('./fsutil');
const { randCode } = require('../shared/names');
const { safeSrc } = require('./media');

const PULL_MS = 15000;
const CHUNK = 6 * 1024 * 1024; // 8MB once base64 encoded

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

class Sync {
  constructor(cloud, rec, me, events) {
    this.cloud = cloud;
    this.rec = rec;
    this.me = me;
    this.events = events; // { presence(list), status(s) }
    this.id = rec.shared.id;
    this.changesDir = path.join(rec.dir, 'changes');
    this.mediaDir = path.join(rec.dir, 'media');
    this.ownFile = path.join(this.changesDir, `${me.deviceKey}.json`);
    this.known = {};
    this.lastPushed = null;
    this.dirty = true;
    this.queue = [];
    this.active = null;
    this.remoteMedia = new Set();
    this.failed = new Map();
    this.state = { state: 'syncing', up: 0, down: 0 };
    this.stopped = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), PULL_MS);
    return this.tick();
  }

  // Something changed here: push soon
  kick(delay = 1500) {
    this.dirty = true;
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this.tick(), delay);
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.state.up = this.queue.filter((j) => j.type === 'up').length + (this.active && this.active.type === 'up' ? 1 : 0);
    this.state.down = this.queue.filter((j) => j.type === 'down').length + (this.active && this.active.type === 'down' ? 1 : 0);
    if (this.state.state !== 'offline' && this.state.state !== 'error') this.state.state = this.state.up || this.state.down || this.dirty ? 'syncing' : 'synced';
    this.events.status({ ...this.state });
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (this.dirty) await this.push();
      await this.pull();
      this.setState({ state: 'ok', message: null });
      this.pumpPromise = this.pump();
    } catch (e) {
      this.setState({ state: e.kind === 'offline' ? 'offline' : 'error', message: e.message });
    } finally {
      this.running = false;
    }
  }

  async push() {
    let data;
    try { data = await fsp.readFile(this.ownFile, 'utf8'); } catch (_) { this.dirty = false; return; }
    this.dirty = false;
    if (data === this.lastPushed) return;
    try {
      await this.cloud.call('sync.push', { id: this.id, device: this.me.deviceKey, data });
      this.lastPushed = data;
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  async pull() {
    // Only plain device file names, and never our own (compared without caring
    // about capitals, since Mac and Windows disks don't either).
    const ownName = `${this.me.deviceKey}.json`.toLowerCase();
    const okChange = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/.test(n) && n.toLowerCase() !== ownName;
    let res;
    // The server sends change files in batches and says when there are more
    for (let round = 0; round < 20; round++) {
      res = await this.cloud.call('sync.pull', { id: this.id, device: this.me.deviceKey, known: this.known });
      for (const c of res.changes || []) {
        const name = String(c.name || '');
        if (!okChange(name) || typeof c.data !== 'string') continue;
        await writeAtomic(path.join(this.changesDir, name), c.data);
        this.known[name] = c.modified;
      }
      if (!res.more || !(res.changes || []).length) break;
    }
    res.media = (res.media || []).filter((m) => m && safeSrc(m.name));
    const here = (res.here || [])
      .filter((h) => h.device !== this.me.deviceKey)
      .map((h) => ({ ...h, self: h.email === this.me.email }));
    this.events.presence(here);

    this.remoteMedia = new Set((res.media || []).map((m) => m.name));
    const local = new Set((await listDir(this.mediaDir)).filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name));
    for (const m of res.media || []) {
      if (!local.has(m.name)) this.enqueue({ type: 'down', name: m.name, size: m.size });
    }
    for (const name of local) {
      if (!this.remoteMedia.has(name)) this.enqueue({ type: 'up', name });
    }
  }

  enqueue(job) {
    const key = job.type + ':' + job.name;
    if (this.active && this.active.type + ':' + this.active.name === key) return;
    if (this.queue.some((j) => j.type + ':' + j.name === key)) return;
    const f = this.failed.get(key);
    if (f && Date.now() < f) return; // back off after a failure
    // Downloads first, so the board fills in quickly
    if (job.type === 'down') this.queue.unshift(job); else this.queue.push(job);
  }

  isDownloading(name) {
    return (this.active && this.active.type === 'down' && this.active.name === name) || this.queue.some((j) => j.type === 'down' && j.name === name) || (this.remoteMedia.has(name) && !fs.existsSync(path.join(this.mediaDir, name)));
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        this.active = this.queue.shift();
        this.setState({});
        const key = this.active.type + ':' + this.active.name;
        try {
          if (this.active.type === 'up') await this.upload(this.active.name);
          else await this.download(this.active.name);
          this.failed.delete(key);
        } catch (e) {
          this.failed.set(key, Date.now() + 60000);
          if (e.kind === 'offline') { this.queue = []; this.active = null; this.setState({ state: 'offline', message: e.message }); return; }
        }
        this.active = null;
        this.setState({});
      }
    } finally {
      this.pumping = false;
      this.active = null;
    }
  }

  // Resolves once every queued upload and download has finished
  async settle() {
    while (this.pumping || this.queue.length) {
      if (this.pumping) await this.pumpPromise;
      else this.pumpPromise = this.pump();
    }
  }

  async upload(name) {
    const file = path.join(this.mediaDir, name);
    const st = await fsp.stat(file);
    const ext = path.extname(name).slice(1).toLowerCase();
    const start = await this.cloud.call('media.start', { id: this.id, name, size: st.size, mime: MIME[ext] || 'application/octet-stream' });
    if (start.exists) { this.remoteMedia.add(name); return; }
    const fh = await fsp.open(file, 'r');
    try {
      let offset = 0;
      while (offset < st.size) {
        const len = Math.min(CHUNK, st.size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        await this.cloud.call('media.chunk', { upload: start.upload, offset, total: st.size, data: buf.toString('base64') }, 180000);
        offset += len;
        this.events.status({ ...this.state, progress: { name, type: 'up', fraction: offset / st.size } });
      }
    } finally {
      await fh.close();
    }
    this.remoteMedia.add(name);
  }

  async download(name) {
    const safe = path.basename(name);
    const dest = path.join(this.mediaDir, safe);
    if (fs.existsSync(dest)) return;
    const part = path.join(this.mediaDir, `.${safe}.${randCode(5)}.part`);
    const fh = await fsp.open(part, 'w');
    let ok = false;
    try {
      let offset = 0, size = Infinity;
      while (offset < size) {
        const r = await this.cloud.call('media.get', { id: this.id, name: safe, offset, length: CHUNK }, 180000);
        size = r.size;
        const buf = Buffer.from(r.data || '', 'base64');
        if (!buf.length && offset < size) throw new Error('Download stalled.');
        await fh.write(buf, 0, buf.length, offset);
        offset += buf.length;
        this.events.status({ ...this.state, progress: { name: safe, type: 'down', fraction: size ? offset / size : 1 } });
      }
      ok = true;
    } finally {
      await fh.close();
      if (ok) await fsp.rename(part, dest); else { try { await fsp.unlink(part); } catch (_) {} }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.kickTimer);
    try { this.dirty = true; await this.push(); } catch (_) {}
  }
}

module.exports = { Sync };
