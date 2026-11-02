// The Eye Refs folder layout inside Google Drive:
//
//   My Drive/
//     Eye Refs Team/            shared by the admin, everyone adds a shortcut once
//       clients.json            the client list everyone picks from
//     Eye Refs/
//       Hutong/
//         Spring Campaign/
//           Spring Campaign.eyerefs
//           media/  changes/  here/
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { writeJson, readJson, exists, isWritable, listDir, uniqueChild } = require('./fsutil');
const { cleanFolderName } = require('../shared/names');

const PRESENCE_WINDOW_MS = 150 * 1000;

function paths(myDrive) {
  return {
    root: path.join(myDrive, 'Eye Refs'),
    team: path.join(myDrive, 'Eye Refs Team'),
    clients: path.join(myDrive, 'Eye Refs Team', 'clients.json'),
  };
}

async function readTeam(myDrive) {
  const p = paths(myDrive);
  const data = await readJson(p.clients);
  if (!data || !Array.isArray(data.clients)) return null;
  const clients = [...new Set(data.clients.map((c) => cleanFolderName(c)))].sort((a, b) => a.localeCompare(b));
  return { admin: data.admin || null, clients, writable: await isWritable(p.clients) };
}

async function createTeam(myDrive, me) {
  const p = paths(myDrive);
  if (await exists(p.clients)) return readTeam(myDrive);
  await writeJson(p.clients, { format: 1, admin: { email: me.email, name: me.name }, clients: [] });
  return readTeam(myDrive);
}

async function saveClients(myDrive, me, clients) {
  const p = paths(myDrive);
  const cur = (await readJson(p.clients)) || { format: 1, admin: { email: me.email, name: me.name } };
  if (cur.admin && cur.admin.email && cur.admin.email !== me.email) throw new Error('Only the admin can change the client list.');
  cur.clients = [...new Set(clients.map((c) => cleanFolderName(c)).filter(Boolean))];
  await writeJson(p.clients, cur);
  return readTeam(myDrive);
}

async function ensureClientFolders(myDrive, clients) {
  const { root } = paths(myDrive);
  await fsp.mkdir(root, { recursive: true });
  for (const c of clients) {
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

async function presenceIn(dir, me) {
  const now = Date.now();
  const out = [];
  for (const e of await listDir(path.join(dir, 'here'))) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const h = await readJson(path.join(dir, 'here', e.name));
    if (!h || !h.at || now - h.at > PRESENCE_WINDOW_MS) continue;
    if (me && h.device === me.deviceKey) continue;
    out.push({ name: h.name, email: h.email, device: h.device, at: h.at, self: !!(me && h.email === me.email) });
  }
  // One entry per person
  const seen = new Map();
  for (const h of out) if (!seen.has(h.email) || seen.get(h.email).at < h.at) seen.set(h.email, h);
  return [...seen.values()];
}

function toRecord(found, clientFolder, me) {
  const d = found.data;
  return {
    id: d.id,
    name: d.name,
    client: d.client || clientFolder || 'Other',
    owner: d.owner || null,
    created: d.created || 0,
    mine: !!(d.owner && me && d.owner.email === me.email),
    dir: found.dir,
    file: found.file,
  };
}

// Scan for every project this person can open.
async function scanProjects(myDrive, me) {
  const { root } = paths(myDrive);
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
  // Shortcuts people placed in the top of My Drive by mistake still show up
  for (const e of await listDir(myDrive)) {
    if (!e.isDirectory() || e.name === 'Eye Refs' || e.name === 'Eye Refs Team' || e.name.startsWith('.')) continue;
    const found = await projectInDir(path.join(myDrive, e.name));
    if (found && !byId.has(found.data.id)) byId.set(found.data.id, toRecord(found, null, me));
  }
  const list = [...byId.values()];
  await Promise.all(list.map(async (r) => { r.here = await presenceIn(r.dir, me); }));
  return list;
}

async function createProject(myDrive, me, name, client) {
  const { root } = paths(myDrive);
  const clientDir = path.join(root, cleanFolderName(client));
  await fsp.mkdir(clientDir, { recursive: true });
  const folder = await uniqueChild(clientDir, cleanFolderName(name));
  const dir = path.join(clientDir, folder);
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'changes'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'here'), { recursive: true });
  const data = {
    kind: 'eyerefs-project',
    format: 1,
    id: crypto.randomUUID(),
    name: cleanFolderName(name),
    client: cleanFolderName(client),
    owner: { email: me.email, name: me.name },
    created: Date.now(),
    app: 'Eye Refs by Matte Black',
  };
  const file = path.join(dir, `${folder}.eyerefs`);
  await writeJson(file, data);
  return toRecord({ data, file, dir }, client, me);
}

async function renameProject(record, me, newName) {
  if (!record.mine) throw new Error('Only the owner can rename this project.');
  const data = await readProjectFile(record.file);
  data.name = cleanFolderName(newName);
  await writeJson(record.file, data);
  return data;
}

async function openProjectFile(file, me) {
  const data = await readProjectFile(file);
  if (!data) return null;
  const dir = path.dirname(file);
  const rec = toRecord({ data, file, dir }, path.basename(path.dirname(dir)), me);
  rec.here = await presenceIn(dir, me);
  return rec;
}

module.exports = {
  paths, readTeam, createTeam, saveClients, ensureClientFolders,
  scanProjects, createProject, renameProject, openProjectFile, presenceIn, PRESENCE_WINDOW_MS,
};
