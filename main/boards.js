// Boards as single files, like PureRef.
//
// Your own board is one .eyerefs file in Documents/Eye Refs: layout, pictures,
// videos, PDFs and saved versions all inside it. Double click it to open it.
//
// While you work, Eye Refs edits a working copy kept out of sight in its own
// storage, and keeps the file in step: a few seconds after you stop, on Cmd or
// Ctrl + S, and when the board closes. Each write goes to a hidden file first and
// is swapped in with one rename, so the file is always whole.
//
// Shared boards are folders that sync with the EyeStudio Drive. They live in the
// app's storage too, out of Documents.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const lib = require('./library');
const { pack, unpack, isPacked, readInfo } = require('./pack');
const { exists, listDir, uniqueChild } = require('./fsutil');
const { cleanFolderName } = require('../shared/names');

const MIRROR_DELAY_MS = 3000;

const same = (a, b) => !!a && !!b && (process.platform === 'linux' ? path.resolve(a) === path.resolve(b) : path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());

// A free name for a new file in the folder: "Name.eyerefs", "Name 2.eyerefs"...
async function freeDocPath(root, name) {
  await fsp.mkdir(root, { recursive: true });
  return path.join(root, await uniqueChild(root, cleanFolderName(name), '.eyerefs'));
}

// iCloud can leave a stand in for a file it moved to the cloud
async function docThere(file) {
  if (await exists(file)) return true;
  return exists(path.join(path.dirname(file), `.${path.basename(file)}.icloud`));
}

// Half written hidden files from a save that was cut off (a crash, a power cut)
async function clearLeftovers(doc) {
  const dir = path.dirname(doc), base = `.${path.basename(doc)}.`;
  for (const e of await listDir(dir)) {
    if (e.isFile() && e.name.startsWith(base) && e.name.endsWith('.tmp')) await fsp.rm(path.join(dir, e.name), { force: true }).catch(() => {});
  }
}

// ---------- keeping the file in step ----------
// One queue per board, so two writes never overlap and a rename never races a save.
class Mirror {
  constructor(opts = {}) {
    this.boards = new Map(); // id -> { rec, timer, chain, dirty, took, at }
    this.onError = opts.onError || (() => {});
    this.onWritten = opts.onWritten || (() => {});
    this.delay = opts.delay || MIRROR_DELAY_MS;
  }

  slot(rec) {
    let b = this.boards.get(rec.id);
    if (!b) { b = { rec, timer: null, chain: Promise.resolve(), dirty: false, took: 0, at: 0 }; this.boards.set(rec.id, b); }
    b.rec = rec;
    return b;
  }

  wants(rec) { return !!(rec && rec.doc && !rec.shared && !rec.scratch); }

  // Something changed: write the file soon. Big boards write less often, so
  // writing never takes up more than a small share of the time.
  kick(rec) {
    if (!this.wants(rec)) return;
    const b = this.slot(rec);
    b.dirty = true;
    if (b.timer) return;
    const gap = Math.max(this.delay, b.took * 5 - (Date.now() - b.at));
    b.timer = setTimeout(() => { b.timer = null; this.now(b.rec).catch(() => {}); }, gap);
  }

  // Write it now (Cmd/Ctrl + S, closing, quitting)
  now(rec) {
    if (!this.wants(rec)) return Promise.resolve({ skipped: true });
    const b = this.slot(rec);
    clearTimeout(b.timer); b.timer = null;
    b.dirty = true;
    return this.run(b, async () => {
      if (!b.dirty || !this.wants(b.rec)) return { skipped: true };
      b.dirty = false;
      const t0 = Date.now();
      const saveId = crypto.randomUUID();
      try {
        await clearLeftovers(b.rec.doc);
        await pack(b.rec, b.rec.doc, null, { saveId });
        // The file is written first and only then remembered, so a crash between
        // the two leaves a file that is newer than what we remember, never older.
        await lib.updateProject(b.rec, { saveId, mirrored: Date.now() });
        b.rec.saveId = saveId;
        b.took = Date.now() - t0; b.at = Date.now();
        this.onWritten(b.rec);
        return { ok: true, file: b.rec.doc };
      } catch (e) {
        b.dirty = true;
        this.onError(b.rec, e);
        return { error: e.message || String(e) };
      }
    });
  }

  // Run something on this board's queue (renaming its file, deleting it)
  run(b, fn) {
    b.active = (b.active || 0) + 1;
    const wrapped = async () => { try { return await fn(); } finally { b.active--; } };
    const next = b.chain.then(wrapped, wrapped);
    b.chain = next.catch(() => {});
    return next;
  }
  busy(id) { const b = this.boards.get(id); return !!(b && (b.active || b.timer)); }
  queue(rec, fn) { return this.run(this.slot(rec), fn); }

  // Done with a board: write anything pending, then forget it
  async settle(rec) {
    if (!rec) return;
    const b = this.boards.get(rec.id);
    if (!b) return;
    if (b.dirty || b.timer) await this.now(b.rec);
    else await b.chain;
  }

  async settleAll() {
    for (const b of [...this.boards.values()]) await this.settle(b.rec);
  }
}

// ---------- the folders in Documents from before ----------
// Every board folder in Documents/Eye Refs moves into the app's storage. Your own
// boards come back as one file each; the old folder goes to the Trash, so nothing
// is lost if something looks wrong. Shared boards just move.
async function migrate(root, store, me, trash, log = () => {}) {
  const done = [];
  const known = new Set((await lib.scanProjects(store, me)).map((p) => p.id));
  for (const p of await lib.scanProjects(root, me)) {
    try {
      if (known.has(p.id)) {
        // Moved already, the old folder just didn't make it to the Trash last time
        await trash(p.dir).catch(() => {});
        continue;
      }
      const dest = await lib.makeProjectDir(store, '', p.name);
      try {
        await fsp.cp(p.dir, dest.dir, { recursive: true, errorOnExist: false, force: true });
        const moved = await lib.openProjectFile(path.join(dest.dir, path.basename(p.file)), me);
        if (!moved) throw new Error('Board file missing after copy.');
        if (!p.shared) {
          const doc = await freeDocPath(root, p.name);
          const saveId = crypto.randomUUID();
          await pack(moved, doc, null, { saveId });
          const info = await readInfo(doc);
          if (!info || info.id !== p.id || info.saveId !== saveId) throw new Error('The new file did not read back.');
          await lib.updateProject(moved, { doc, saveId, mirrored: Date.now() });
        }
      } catch (e) {
        await fsp.rm(dest.dir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      known.add(p.id);
      await trash(p.dir).catch((e) => log('trash', p.dir, e));
      done.push(p.id);
    } catch (e) {
      log('migrate', p.dir, e); // left where it was, tried again next launch
    }
  }
  // Client folders from early betas, now empty
  for (const e of await listDir(root)) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const d = path.join(root, e.name);
    const left = (await listDir(d)).filter((x) => !x.name.startsWith('.'));
    if (!left.length) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  return done;
}

// ---------- files in Documents/Eye Refs ----------
// Board files sitting in the folder, with what each says about itself.
const infoCache = new Map(); // file -> { key, info }
async function looseFiles(root) {
  const out = [];
  for (const e of await listDir(root)) {
    if (!e.isFile() || e.name.startsWith('.') || !e.name.toLowerCase().endsWith('.eyerefs')) continue;
    const file = path.join(root, e.name);
    let st;
    try { st = await fsp.stat(file); } catch (_) { continue; }
    const key = `${st.size}:${st.mtimeMs}`;
    let c = infoCache.get(file);
    if (!c || c.key !== key) { c = { key, info: (await isPacked(file)) ? await readInfo(file) : null }; infoCache.set(file, c); }
    if (c.info) out.push({ file, info: c.info, modified: st.mtimeMs });
  }
  return out;
}

// Line the working copies up with the files. A file renamed or moved within the
// folder is followed. A file that was deleted takes its board with it, the way
// deleting a PureRef file does; the working copy goes to the Deleted boards folder
// in the app's storage, so it can still be brought back.
async function reconcile(root, store, me, { busy = () => false, retire } = {}) {
  const boards = await lib.scanProjects(store, me);
  const files = await looseFiles(root);
  const claimed = new Set();
  const rootThere = await exists(root);
  for (const b of boards) {
    if (!b.doc || b.shared) continue;
    if (await docThere(b.doc)) { claimed.add(path.resolve(b.doc)); continue; }
    if (busy(b)) continue;
    const moved = files.find((f) => f.info.id === b.id && f.info.saveId && f.info.saveId === b.saveId && !claimed.has(path.resolve(f.file)));
    if (moved) {
      await lib.updateProject(b, { doc: moved.file });
      b.doc = moved.file;
      claimed.add(path.resolve(moved.file));
      continue;
    }
    // Only when the file is surely gone: the folder is there and the file was written at least once
    if (rootThere && b.saveId && retire) { await retire(b); b.retired = true; }
  }
  const live = boards.filter((b) => !b.retired);
  const byId = new Set(live.map((b) => b.id));
  const loose = files
    .filter((f) => !claimed.has(path.resolve(f.file)))
    .map((f) => ({
      id: byId.has(f.info.id) ? 'file:' + f.file : f.info.id,
      name: path.basename(f.file, path.extname(f.file)),
      owner: f.info.owner || null,
      mine: !f.info.owner || !me || f.info.owner.email === me.email,
      shared: null, fileOnly: true, doc: f.file, modified: f.modified,
    }));
  return { boards: live, loose };
}

// ---------- opening a file ----------
// Opening a .eyerefs file: if it's one of ours, open its working copy; if it's new
// to this computer (sent by someone, or from your other computer), bring it in and
// keep saving into that same file.
async function openDoc(file, store, me, { retire, isOpen = () => false } = {}) {
  file = path.resolve(file);
  const info = await readInfo(file);
  if (!info) throw new Error("That file is damaged and can't be opened.");
  const boards = await lib.scanProjects(store, me);
  const byPath = boards.find((b) => b.doc && same(b.doc, file));
  if (byPath) {
    if (info.saveId === byPath.saveId || isOpen(byPath)) return byPath;
    // The file changed outside Eye Refs (copied back from a backup, or from another
    // computer): the file wins. The working copy is kept in Deleted boards.
    if (retire) await retire(byPath);
    else await fsp.rm(byPath.dir, { recursive: true, force: true });
    const rest = boards.filter((b) => b !== byPath);
    return bringIn(file, store, me, !rest.some((b) => b.id === info.id));
  }
  const sameBoard = boards.find((b) => b.id === info.id && !b.shared);
  if (sameBoard && info.saveId && info.saveId === sameBoard.saveId && !(sameBoard.doc && await docThere(sameBoard.doc))) {
    // The file was moved or renamed: follow it
    await lib.updateProject(sameBoard, { doc: file });
    sameBoard.doc = file;
    return sameBoard;
  }
  // New here, or a copy of a board that's already here (a copy gets its own id)
  const clash = boards.some((b) => b.id === info.id);
  return bringIn(file, store, me, !clash);
}

async function bringIn(file, store, me, keepId) {
  const projectFile = await unpack(file, store, me, { keepId, doc: file });
  return lib.openProjectFile(projectFile, me);
}

module.exports = { Mirror, migrate, reconcile, looseFiles, openDoc, freeDocPath, docThere, same, MIRROR_DELAY_MS };
