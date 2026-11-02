const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randCode } = require('../shared/names');

// Write to a temporary file then rename over the target, so Google Drive never
// uploads a half written file.
async function writeAtomic(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${randCode(6)}.tmp`);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    // Windows can refuse to rename over a file Drive is reading. Retry briefly.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      try { await fsp.rename(tmp, file); return; } catch (_) {}
    }
    try { await fsp.unlink(tmp); } catch (_) {}
    throw e;
  }
}

async function writeJson(file, obj) {
  await writeAtomic(file, JSON.stringify(obj));
}

async function readJson(file) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

async function isWritable(p) {
  try { await fsp.access(p, fs.constants.W_OK); return true; } catch (_) { return false; }
}

async function listDir(p) {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch (_) { return []; }
}

async function mtime(p) {
  try { return (await fsp.stat(p)).mtimeMs; } catch (_) { return 0; }
}

// Pick a name that does not exist yet inside dir: "Name", "Name 2", "Name 3"...
async function uniqueChild(dir, name, ext = '') {
  let candidate = name + ext;
  let n = 2;
  while (await exists(path.join(dir, candidate))) {
    candidate = `${name} ${n}${ext}`;
    n++;
  }
  return candidate;
}

module.exports = { writeAtomic, writeJson, readJson, exists, isWritable, listDir, mtime, uniqueChild };
