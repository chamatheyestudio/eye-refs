// "Save as one file": a whole board, images and videos included, in one .eyerefs file.
// Like a PureRef file, it can be sent anywhere and opened on any computer.
// Inside it's a plain zip (stored, not compressed, since media is already compressed).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { listDir, writeJson } = require('./fsutil');
const { makeProjectDir } = require('./library');
const { randCode } = require('../shared/names');

async function isPacked(file) {
  try {
    const fh = await fsp.open(file, 'r');
    const b = Buffer.alloc(4);
    await fh.read(b, 0, 4, 0);
    await fh.close();
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  } catch (_) {
    return false;
  }
}

// Where this computer keeps things is never written into the file
const LOCAL_ONLY = ['doc', 'saveId', 'mirrored'];

async function pack(rec, outFile, onProgress, extra) {
  const zip = new yazl.ZipFile();
  const data = JSON.parse(await fsp.readFile(rec.file, 'utf8'));
  for (const k of LOCAL_ONLY) delete data[k];
  zip.addBuffer(Buffer.from(JSON.stringify({ ...data, ...(extra || {}), packed: Date.now() })), 'project.json', { compress: true });
  const files = [];
  for (const sub of ['changes', 'media', 'versions']) {
    for (const e of await listDir(path.join(rec.dir, sub))) {
      if (e.isFile() && !e.name.startsWith('.')) files.push(sub + '/' + e.name);
    }
  }
  let total = 0;
  for (const f of files) total += (await fsp.stat(path.join(rec.dir, f))).size;
  let done = 0;
  for (const f of files) {
    const abs = path.join(rec.dir, f);
    const size = (await fsp.stat(abs)).size;
    zip.addFile(abs, f, { compress: f.startsWith('changes/') });
    done += size;
  }
  // Written to a hidden file next to it, flushed to disk, then swapped in with one
  // rename. A crash or power cut at any moment leaves the old file or the new one,
  // never half of one.
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = path.join(path.dirname(outFile), `.${path.basename(outFile)}.${randCode(5)}.tmp`);
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      let written = 0;
      zip.outputStream.on('data', (d) => { written += d.length; if (onProgress && total) onProgress(Math.min(1, written / total)); });
      zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
      zip.outputStream.on('error', reject);
      zip.end();
    });
    const fh = await fsp.open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await renameOver(tmp, outFile);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
  }
  return { files: files.length, bytes: done };
}

// Windows can refuse to replace a file something is reading (a preview, a backup app)
async function renameOver(tmp, file) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(tmp, file); } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

// What a packed file says about itself, without unpacking it
async function readInfo(file) {
  let zip;
  try { zip = await openZip(file); } catch (_) { return null; }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { zip.close(); } catch (_) {} resolve(v); };
    zip.on('error', () => finish(null));
    zip.on('end', () => finish(null));
    zip.on('entry', (entry) => {
      if (entry.fileName !== 'project.json') return zip.readEntry();
      zip.openReadStream(entry, (err, rs) => {
        if (err) return finish(null);
        const chunks = [];
        rs.on('data', (d) => chunks.push(d));
        rs.on('error', () => finish(null));
        rs.on('end', () => {
          try {
            const p = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(p && p.kind === 'eyerefs-project' ? { ...p, entries: zip.entryCount } : null);
          } catch (_) { finish(null); }
        });
      });
    });
    zip.readEntry();
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (e, z) => (e ? reject(e) : resolve(z))));
}

// Unpack into a working folder as a project owned by me.
// opts.keepId keeps the board's id (my own board coming back); opts.doc is the
// single file the board saves into from now on.
async function unpack(file, root, me, opts) {
  const made = { dir: null };
  try {
    return await unpackInto(file, root, me, made, opts || {});
  } catch (e) {
    // A damaged file leaves nothing behind
    if (made.dir) { try { await fsp.rm(made.dir, { recursive: true, force: true }); } catch (_) {} }
    throw new Error(/Eye Refs board/.test(e.message) ? e.message : "That file is damaged and can't be opened.");
  }
}

async function unpackInto(file, root, me, made, opts) {
  const zip = await openZip(file);
  let dest = null;
  let project = null;
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const name = entry.fileName;
      const okPath = /^(media|changes|versions)\/[^/\\]+$/.test(name) && !name.includes('..') && !path.basename(name).startsWith('.');
      if (name === 'project.json') {
        zip.openReadStream(entry, (err, rs) => {
          if (err) return reject(err);
          rs.on('error', reject);
          const chunks = [];
          rs.on('data', (d) => chunks.push(d));
          rs.on('end', async () => {
            try {
              project = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (project.kind !== 'eyerefs-project') throw new Error("That file isn't an Eye Refs board.");
              dest = await makeProjectDir(root, '', project.name);
              made.dir = dest.dir;
              await fsp.mkdir(path.join(dest.dir, 'versions'), { recursive: true });
              zip.readEntry();
            } catch (e) { reject(e); }
          });
        });
        return;
      }
      if (!okPath || !dest) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, rs) => {
        if (err) return reject(err);
        // Written under a hidden name, renamed once the whole entry checked out
        const target = path.join(dest.dir, name);
        const part = path.join(path.dirname(target), `.${path.basename(target)}.${randCode(5)}.part`);
        const ws = fs.createWriteStream(part);
        rs.on('error', (e) => { ws.destroy(); reject(e); });
        rs.pipe(ws).on('close', async () => { try { await fsp.rename(part, target); zip.readEntry(); } catch (e) { reject(e); } }).on('error', reject);
      });
    });
    zip.readEntry();
  });
  if (!project || !dest) throw new Error("That file isn't an Eye Refs board.");
  const mine = !project.owner || project.owner.email === me.email;
  const data = {
    kind: 'eyerefs-project', format: 1, id: opts.keepId && project.id && mine && !project.shared ? project.id : crypto.randomUUID(), name: project.name, client: '',
    owner: { email: me.email, name: me.name }, created: (mine && project.created) || Date.now(), shared: null,
    app: 'Eye Refs by Matte Black',
  };
  if (!mine) data.from = { name: project.name, owner: project.owner || null, packed: project.packed || null };
  else if (project.from) data.from = project.from;
  if (opts.doc) { data.doc = opts.doc; data.saveId = project.saveId || null; data.mirrored = project.packed || Date.now(); }
  const projectFile = path.join(dest.dir, `${dest.folder}.eyerefs`);
  await writeJson(projectFile, data);
  return projectFile;
}

module.exports = { pack, unpack, isPacked, readInfo };
