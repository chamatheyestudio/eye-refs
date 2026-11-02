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

async function pack(rec, outFile, onProgress) {
  const zip = new yazl.ZipFile();
  const data = JSON.parse(await fsp.readFile(rec.file, 'utf8'));
  zip.addBuffer(Buffer.from(JSON.stringify({ ...data, packed: Date.now() })), 'project.json', { compress: true });
  const files = [];
  for (const sub of ['changes', 'media']) {
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
  const tmp = path.join(path.dirname(outFile), `.${path.basename(outFile)}.${randCode(5)}.tmp`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let written = 0;
    zip.outputStream.on('data', (d) => { written += d.length; if (onProgress && total) onProgress(Math.min(1, written / total)); });
    zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
    zip.outputStream.on('error', reject);
    zip.end();
  });
  await fsp.rename(tmp, outFile);
  return { files: files.length, bytes: done };
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (e, z) => (e ? reject(e) : resolve(z))));
}

// Unpack into Documents/Eye Refs/<name> as a new project owned by me.
async function unpack(file, root, me) {
  const zip = await openZip(file);
  let dest = null;
  let project = null;
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const name = entry.fileName;
      const okPath = /^(media|changes)\/[^/\\]+$/.test(name) && !name.includes('..') && !path.basename(name).startsWith('.');
      if (name === 'project.json') {
        zip.openReadStream(entry, (err, rs) => {
          if (err) return reject(err);
          const chunks = [];
          rs.on('data', (d) => chunks.push(d));
          rs.on('end', async () => {
            try {
              project = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (project.kind !== 'eyerefs-project') throw new Error("That file isn't an Eye Refs board.");
              dest = await makeProjectDir(root, '', project.name);
              zip.readEntry();
            } catch (e) { reject(e); }
          });
        });
        return;
      }
      if (!okPath || !dest) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, rs) => {
        if (err) return reject(err);
        const target = path.join(dest.dir, name);
        const ws = fs.createWriteStream(target);
        rs.pipe(ws).on('close', () => zip.readEntry()).on('error', reject);
      });
    });
    zip.readEntry();
  });
  if (!project || !dest) throw new Error("That file isn't an Eye Refs board.");
  const data = {
    kind: 'eyerefs-project', format: 1, id: crypto.randomUUID(), name: project.name, client: '',
    owner: { email: me.email, name: me.name }, created: Date.now(), shared: null,
    from: { name: project.name, owner: project.owner || null, packed: project.packed || null },
    app: 'Eye Refs by Matte Black',
  };
  const projectFile = path.join(dest.dir, `${dest.folder}.eyerefs`);
  await writeJson(projectFile, data);
  return projectFile;
}

module.exports = { pack, unpack, isPacked };
