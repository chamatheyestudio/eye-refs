// Projects on this computer, in Documents:
//
//   Documents/Eye Refs/
//     Hutong/
//       Spring Campaign/
//         Spring Campaign.eyerefs   double click to open
//         media/  changes/
//
// Shared boards use the same layout here and in the EyeStudio Google Drive.
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { writeJson, readJson, listDir, uniqueChild, exists } = require('./fsutil');
const { cleanFolderName } = require('../shared/names');

async function ensureClientFolders(root, clients) {
  await fsp.mkdir(root, { recursive: true });
  for (const c of clients || []) {
    try { await fsp.mkdir(path.join(root, cleanFolderName(c)), { recursive: true }); } catch (_) {}
  }
}

async function readProjectFile(file) {
  const data = await readJson(file);
  if (!data || data.kind !== 'eyerefs-project' || !data.id) return null;
  return data;
}

async function projectInDir(dir) {
  for (const e of await listDir(dir)) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.eyerefs') && !e.name.startsWith('.')) {
      const file = path.join(dir, e.name);
      const data = await readProjectFile(file);
      if (data) return { data, file, dir };
    }
  }
  return null;
}

function toRecord(found, clientFolder, me) {
  const d = found.data;
  return {
    id: d.id,
    name: d.name,
    client: d.client || clientFolder || 'Other',
    owner: d.owner || null,
    created: d.created || 0,
    mine: !d.owner || !me || d.owner.email === me.email,
    shared: d.shared || null,
    dir: found.dir,
    file: found.file,
  };
}

async function scanProjects(root, me) {
  const byId = new Map();
  for (const c of await listDir(root)) {
    if (!c.isDirectory() || c.name.startsWith('.')) continue;
    const clientDir = path.join(root, c.name);
    for (const p of await listDir(clientDir)) {
      if (!p.isDirectory() || p.name.startsWith('.')) continue;
      const found = await projectInDir(path.join(clientDir, p.name));
      if (found && !byId.has(found.data.id)) byId.set(found.data.id, toRecord(found, c.name, me));
    }
  }
  return [...byId.values()];
}

async function makeProjectDir(root, client, name) {
  const clientDir = path.join(root, cleanFolderName(client || 'Other'));
  await fsp.mkdir(clientDir, { recursive: true });
  const folder = await uniqueChild(clientDir, cleanFolderName(name));
  const dir = path.join(clientDir, folder);
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'changes'), { recursive: true });
  return { dir, folder };
}

async function createProject(root, me, name, client, extra) {
  const { dir, folder } = await makeProjectDir(root, client, name);
  const data = {
    kind: 'eyerefs-project',
    format: 1,
    id: (extra && extra.id) || crypto.randomUUID(),
    name: cleanFolderName(name),
    client: cleanFolderName(client || 'Other'),
    owner: (extra && extra.owner) || { email: me.email, name: me.name },
    created: Date.now(),
    shared: (extra && extra.shared) || null,
    app: 'Eye Refs by Matte Black',
  };
  const file = path.join(dir, `${folder}.eyerefs`);
  await writeJson(file, data);
  return toRecord({ data, file, dir }, client, me);
}

async function updateProject(rec, patch) {
  const data = await readProjectFile(rec.file);
  if (!data) throw new Error('Project file is missing.');
  Object.assign(data, patch);
  await writeJson(rec.file, data);
  return data;
}

async function openProjectFile(file, me) {
  const data = await readProjectFile(file);
  if (!data) return null;
  const dir = path.dirname(file);
  return toRecord({ data, file, dir }, path.basename(path.dirname(dir)), me);
}

module.exports = { ensureClientFolders, scanProjects, createProject, updateProject, openProjectFile, readProjectFile, makeProjectDir, exists };
