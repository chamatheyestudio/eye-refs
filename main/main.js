// Eye Refs by Matte Black
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, net, screen, Menu, clipboard } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');
const { readJson, writeJson, exists } = require('./fsutil');
const lib = require('./library');
const media = require('./media');
const { Session } = require('./session');
const { Cloud } = require('./cloud');
const { Sync } = require('./sync');
const { pack, unpack, isPacked } = require('./pack');
const { randCode, initialsFrom, firstNameFrom, cleanFolderName } = require('../shared/names');
const PKG = require('../package.json');

let win = null;
let settings = {};
let me = null;
let session = null;
let sync = null;
let pendingOpenFile = null;
let clickThrough = false;
let identity = { admin: false, team: false };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const SCRATCH = () => path.join(app.getPath('userData'), 'unsaved');
const ROOT = () => process.env.EYEREFS_ROOT || path.join(app.getPath('documents'), 'Eye Refs');

// ---------- settings and sign in ----------
async function loadSettings() {
  settings = (await readJson(settingsPath())) || {};
  // Settings from betas 1 to 3 (Drive folder setup) are dropped for a clean start.
  if ((settings.v || 0) < 4) { settings = { v: 4 }; await saveSettings(); }
  if (!settings.deviceId) { settings.deviceId = randCode(6); await saveSettings(); }
}
async function saveSettings() {
  try { await writeJson(settingsPath(), settings); } catch (_) {}
}

function serverUrl() {
  return settings.server || process.env.EYEREFS_SERVER || (PKG.eyerefs && PKG.eyerefs.server) || '';
}

// The sign in token sits in the app's own settings file, readable only by this user.
// No keychain, so macOS and Windows never ask for a password.
function getToken() {
  if (!settings.token || settings.tokenEnc) return null;
  return settings.token;
}
function setToken(t) {
  delete settings.tokenEnc;
  if (!t) { delete settings.token; return; }
  settings.token = t;
}

const cloud = new Cloud(serverUrl, getToken, (url, opts) => net.fetch(url, opts));

function makeMe(email, name) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'user';
  const n = name || firstNameFrom(email);
  return { email: email.toLowerCase(), name: n, initials: initialsFrom(n, email), deviceKey: `${local}-${settings.deviceId}` };
}

const { createUpdater } = require('./updater');
const updater = createUpdater((u) => send('update:ready', u));

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

// ---------- startup ----------
async function boot() {
  // Documents/Eye Refs exists from the first launch, signed in or not.
  try { await fsp.mkdir(ROOT(), { recursive: true }); } catch (e) { console.error('Documents folder', e); }
  if (!serverUrl()) return { screen: 'connect' };
  if (!getToken() || !settings.email) return { screen: 'signin', email: settings.email || '' };

  let online = true;
  try {
    const who = await cloud.call('me', {}, 12000);
    settings.email = who.email;
    settings.name = who.name;
    if (who.token) setToken(who.token); // refreshed each launch, so the code is a one time thing
    identity = { admin: who.admin, team: who.team };
    await saveSettings();
  } catch (e) {
    if (e.kind === 'auth') { setToken(null); await saveSettings(); return { screen: 'signin', email: settings.email || '' }; }
    online = false; // work offline with what we know
    identity = { admin: false, team: true };
  }
  me = makeMe(settings.email, settings.name);
  await clearEmptyUntitled();
  const projects = await allProjects(online);
  const open = pendingOpenFile;
  pendingOpenFile = null;
  // Like PureRef, start on a fresh board, unless set to reopen the last one.
  // A window rebuilt for transparent mode goes straight back to its board.
  const resume = resumeProject;
  resumeProject = null;
  const last = resume || (settings.startWith === 'last' ? settings.lastProject : null);
  return {
    screen: 'app', me, online, admin: identity.admin, team: identity.team,
    projects, lastProject: last || null, openFile: open, prefs: prefs(), version: app.getVersion(), root: ROOT(),
  };
}

function prefs() {
  return {
    alwaysOnTop: !!settings.alwaysOnTop, opacity: settings.opacity || 1, sidebar: settings.sidebar !== false,
    transparent: !!settings.transparent, startWith: settings.startWith === 'last' ? 'last' : 'new',
  };
}

// Untitled boards left empty from earlier sessions are tidied away at start,
// so the list never fills up with blank ones. Anything with content stays.
async function clearEmptyUntitled() {
  for (const p of await lib.scanProjects(SCRATCH(), me)) {
    if (session && session.rec.id === p.id) continue;
    try {
      if (!(await noMedia(p.dir))) continue;
      let hasItems = false;
      for (const f of await fsp.readdir(path.join(p.dir, 'changes'))) {
        const data = await readJson(path.join(p.dir, 'changes', f));
        if (data && data.items && Object.keys(data.items).length) { hasItems = true; break; }
      }
      if (!hasItems) await fsp.rm(p.dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

let resumeProject = null;

// Local projects plus shared boards not yet on this computer
async function allProjects(online = true) {
  const local = [];
  const seenIds = new Set();
  for (const p of [...await lib.scanProjects(ROOT(), me), ...(await lib.scanProjects(SCRATCH(), me)).map((p) => ({ ...p, scratch: true }))]) {
    if (seenIds.has(p.id)) continue; // a half finished move can leave a copy behind
    seenIds.add(p.id);
    local.push(p);
  }
  let remote = [];
  if (online) { try { remote = await cloud.call('projects.list', {}, 20000); } catch (_) { remote = []; } }
  const byShared = new Map(local.filter((p) => p.shared).map((p) => [p.shared.id, p]));
  for (const r of remote) {
    const l = byShared.get(r.id) || local.find((p) => p.id === r.id);
    if (l) {
      Object.assign(l, { shared: l.shared || { id: r.id }, role: r.role, requests: r.requests, members: r.members, ownerName: r.ownerName });
      l.mine = r.owner === me.email;
      // The owner renamed it: show the new name here too (the folder keeps its name)
      if (r.name && r.name !== l.name && !l.mine) {
        try { await lib.updateProject(l, { name: r.name }); l.name = r.name; if (session && session.rec.id === l.id) session.rec.name = r.name; } catch (_) {}
      }
    } else {
      local.push({ id: r.id, name: r.name, client: r.client, owner: { email: r.owner, name: r.ownerName }, mine: r.owner === me.email, shared: { id: r.id }, cloudOnly: true, role: r.role, requests: r.requests, members: r.members });
    }
  }
  return local;
}

// ---------- board session ----------
// Save first, then the final upload, so the very last edit reaches teammates.
async function closeCurrent() {
  const s = session, y = sync;
  session = null; sync = null;
  if (s) { try { await s.flush(); } catch (_) {} }
  if (y) { try { await y.stop(); } catch (_) {} }
  if (s) { try { await s.close(); } catch (_) {} }
}

// Opening, closing, saving and sharing boards run one at a time, so two quick
// clicks can never leave a board running in the background.
let boardQueue = Promise.resolve();
function serial(fn) {
  const run = boardQueue.then(fn, fn);
  boardQueue = run.catch(() => {});
  return run;
}

// Imports still running per board. A board is never cleared while one is.
const importing = new Map();
async function tracked(rec, fn) {
  importing.set(rec.id, (importing.get(rec.id) || 0) + 1);
  try { return await fn(); } finally {
    const n = (importing.get(rec.id) || 1) - 1;
    if (n > 0) importing.set(rec.id, n); else importing.delete(rec.id);
  }
}

async function openProject(rec) {
  const prev = session && session.rec.scratch && session.rec.id !== rec.id && isEmpty(session) ? session.rec : null;
  await closeCurrent();
  // An untitled board nobody added anything to just goes away. Only when it is
  // truly empty: nothing on it and no files at all in its media folder, so a board
  // with an import still running is never touched.
  if (prev && !importing.has(prev.id) && await noMedia(prev.dir)) { try { await fsp.rm(prev.dir, { recursive: true, force: true }); } catch (_) {} }
  const s = new Session(rec, me, backupDir(), {
    state: (items) => send('board:state', { projectId: rec.id, items }),
    status: (st) => send('board:status', { projectId: rec.id, status: st }),
    presence: () => {},
  }, { onSaved: () => { if (sync) sync.kick(); } });
  session = s;
  const items = await s.open();
  if (rec.shared) startSync(rec, s);
  settings.lastProject = rec.id;
  saveSettings();
  return { record: rec, items, status: s.status, readOnly: s.readOnly, mediaBase: pathToFileURL(s.mediaDir).href + '/' };
}

function startSync(rec, forSession) {
  if (forSession && session !== forSession) return; // that board was closed meanwhile
  if (sync) { const old = sync; sync = null; old.stop().catch(() => {}); }
  sync = new Sync(cloud, rec, me, {
    presence: (list) => send('board:presence', { projectId: rec.id, here: list }),
    status: (st) => send('cloud:status', { projectId: rec.id, ...st }),
  });
  sync.start();
}

function knownHashes() {
  const map = new Map();
  if (!session) return map;
  const items = session.merged();
  for (const id in items) {
    const it = items[id];
    if (it.hash && it.src && !it.deleted) map.set(it.hash, it.src);
  }
  return map;
}

async function noMedia(dir) {
  try { return (await fsp.readdir(path.join(dir, 'media'))).length === 0; } catch (_) { return false; }
}

function isEmpty(s) {
  const items = s.merged();
  return !Object.values(items).some((it) => !it.deleted);
}

function sessionFor(projectId) {
  if (!session || session.rec.id !== projectId) throw new Error('That project is no longer open.');
  return session;
}

async function findLocal(id) {
  const list = [...await lib.scanProjects(ROOT(), me), ...await lib.scanProjects(SCRATCH(), me)];
  return list.find((p) => p.id === id || (p.shared && p.shared.id === id)) || null;
}

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: String((e && e.message) || e) }; }
  });
}

handle('boot', boot);
handle('update:state', async () => updater.state());
handle('update:install', async () => {
  await serial(closeCurrent); // save and upload everything before the installer takes over
  return updater.install();
});

handle('connect:set', async (url) => {
  url = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url) && !/^http:\/\/127\.0\.0\.1:\d+\/exec$/.test(url)) {
    return { error: 'Paste the web app link that ends in /exec.' };
  }
  if (!(await cloud.ping(url))) return { error: "That link didn't answer like Eye Refs. Check the deployment is set to Anyone." };
  settings.server = url;
  await saveSettings();
  return boot();
});

// People outside EyeStudio sign in with the join code of the board they were given
handle('auth:request', async (email, joinCode) => {
  email = String(email || '').trim().toLowerCase();
  joinCode = String(joinCode || '').trim().toUpperCase();
  await cloud.call('auth.request', joinCode ? { email, joinCode } : { email }, 30000);
  settings.email = email;
  settings.pendingJoin = joinCode || null;
  await saveSettings();
  return { sent: true };
});

handle('auth:verify', async (code, name) => {
  const r = await cloud.call('auth.verify', { email: settings.email, code, name }, 30000);
  setToken(r.token);
  settings.email = r.email;
  settings.name = r.name;
  const join = settings.pendingJoin;
  settings.pendingJoin = null;
  await saveSettings();
  let joinResult = null;
  if (join) { try { joinResult = await cloud.call('projects.request', { code: join }); } catch (e) { joinResult = { error: e.message }; } }
  const res = await boot();
  if (joinResult) res.joinResult = joinResult;
  return res;
});

handle('auth:signout', async () => {
  await closeCurrent();
  setToken(null);
  await saveSettings();
  return boot();
});

handle('projects:scan', async () => ({ projects: await allProjects(true) }));

handle('projects:create', (name) => serial(async () => {
  if (!name || !name.trim()) return { error: 'Give the project a name.' };
  const rec = await lib.createProject(ROOT(), me, name, '');
  return openProject(rec);
}));

// PureRef style: a fresh untitled board, saved with a name later
handle('projects:new', (opts) => serial(async () => {
  if (session && session.rec.scratch && isEmpty(session)) return openProject(session.rec);
  const discard = opts && opts.discard && session && session.rec.scratch ? session.rec : null;
  const rec = await lib.createProject(SCRATCH(), me, 'Untitled', '', { scratch: true });
  const res = await openProject(rec);
  if (discard && !importing.has(discard.id)) { try { await fsp.rm(discard.dir, { recursive: true, force: true }); } catch (_) {} }
  return res;
}));

handle('projects:save', (projectId, name) => serial(async () => {
  const s = sessionFor(projectId);
  if (!s.rec.scratch) return { error: 'This board is already saved.' };
  if (!name || !String(name).trim()) return { error: 'Give the board a name.' };
  if (importing.has(s.rec.id)) return { error: 'Wait for the files to finish coming in, then save.' };
  const old = s.rec;
  await closeCurrent();
  let rec;
  try {
    rec = await lib.saveScratch(old, ROOT(), name);
  } catch (e) {
    // Couldn't move it: keep working on the untitled board rather than leave nothing open
    const res = await openProject(old);
    res.error = "Couldn't save the board there. Close anything using its files and try again.";
    return res;
  }
  rec.mine = true;
  return openProject(rec);
}));

handle('projects:open', (id) => serial(async () => {
  let rec = await findLocal(id);
  if (!rec) {
    // A shared board that isn't on this computer yet: make its folder, then sync fills it
    const remote = (await cloud.call('projects.list')).find((p) => p.id === id);
    if (!remote) return { error: "That board isn't shared with you anymore." };
    rec = await lib.createProject(ROOT(), me, remote.name, '', {
      id: remote.id, owner: { email: remote.owner, name: remote.ownerName }, shared: { id: remote.id },
    });
  }
  return openProject(rec);
}));

handle('projects:openFile', (file) => serial(async () => {
  if (await isPacked(file)) {
    const projectFile = await unpack(file, ROOT(), me);
    const rec = await lib.openProjectFile(projectFile, me);
    const res = await openProject(rec);
    res.unpacked = true;
    return res;
  }
  const rec = await lib.openProjectFile(file, me);
  if (!rec) return { error: "That file isn't an Eye Refs project." };
  return openProject(rec);
}));

handle('projects:rename', async (newName) => {
  if (!session) return { error: 'No project open.' };
  if (!session.rec.mine) return { error: 'Only the owner can rename this project.' };
  const s = session;
  const data = await lib.updateProject(s.rec, { name: cleanFolderName(newName) });
  s.rec.name = data.name;
  // Shared boards: everyone else sees the new name too
  if (s.rec.shared) { try { await cloud.call('projects.rename', { id: s.rec.shared.id, name: data.name }); } catch (_) {} }
  return { name: data.name };
});

// Rename any board from the sidebar or the top bar. An untitled board gets saved
// into Documents under the new name; an open one is renamed in place.
handle('projects:renameAny', (id, newName) => serial(async () => {
  const name = cleanFolderName(newName);
  if (!String(newName || '').trim()) return { error: 'Give the board a name.' };
  const open = session && session.rec.id === id ? session : null;
  const rec = open ? open.rec : await findLocal(id);
  if (!rec) return { error: "That board isn't on this computer yet. Open it first." };
  if (rec.scratch) {
    if (importing.has(rec.id)) return { error: 'Wait for the files to finish coming in, then save.' };
    if (open) await closeCurrent();
    let saved;
    try { saved = await lib.saveScratch(rec, ROOT(), name); } catch (e) {
      if (open) await openProject(rec);
      return { error: "Couldn't save the board there. Close anything using its files and try again." };
    }
    saved.mine = true;
    if (open) { const res = await openProject(saved); return { name: saved.name, reopened: res }; }
    return { name: saved.name };
  }
  if (rec.owner && me && rec.owner.email && rec.owner.email !== me.email) return { error: 'Only the owner can rename this board.' };
  const data = await lib.updateProject(rec, { name });
  rec.name = data.name;
  if (rec.shared) { try { await cloud.call('projects.rename', { id: rec.shared.id, name: data.name }); } catch (_) {} }
  return { name: data.name };
}));

// Share: upload this board to the EyeStudio Drive, then invite people
handle('projects:share', async (projectId, emails) => {
  const s = sessionFor(projectId);
  if (!s.rec.shared) {
    await s.flush();
    await cloud.call('projects.create', { id: s.rec.id, name: s.rec.name, client: '' });
    await lib.updateProject(s.rec, { shared: { id: s.rec.id } });
    s.rec.shared = { id: s.rec.id };
    await serial(async () => startSync(s.rec, s)); // only if this board is still the open one
  }
  if (emails && emails.length) await cloud.call('projects.invite', { id: s.rec.shared.id, emails });
  return { shared: s.rec.shared, members: await cloud.call('projects.members', { id: s.rec.shared.id }) };
});

handle('projects:members', async (projectId) => {
  const s = sessionFor(projectId);
  if (!s.rec.shared) return { members: [], requests: [] };
  return cloud.call('projects.members', { id: s.rec.shared.id });
});
handle('projects:invite', async (projectId, emails) => cloud.call('projects.invite', { id: sessionFor(projectId).rec.shared.id, emails }));
handle('projects:decide', async (projectId, email, allow) => cloud.call('projects.decide', { id: sessionFor(projectId).rec.shared.id, email, allow }));
handle('projects:removeMember', async (projectId, email) => cloud.call('projects.remove', { id: sessionFor(projectId).rec.shared.id, email }));
handle('projects:join', async (code) => cloud.call('projects.request', { code }));

handle('projects:pack', async (projectId) => {
  const s = sessionFor(projectId);
  await s.flush();
  const r = await dialog.showSaveDialog(win, { title: 'Save as one file', defaultPath: path.join(app.getPath('documents'), `${s.rec.name}.eyerefs`), filters: [{ name: 'Eye Refs', extensions: ['eyerefs'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  const out = r.filePath.toLowerCase().endsWith('.eyerefs') ? r.filePath : r.filePath + '.eyerefs';
  const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
  if (same(path.resolve(out), path.resolve(s.rec.file))) return { error: 'Choose a different place than the project folder.' };
  const res = await pack(s.rec, out, (f) => send('pack:progress', { fraction: f }));
  shell.showItemInFolder(out);
  return { file: out, ...res };
});

handle('projects:reveal', async () => { if (session) shell.showItemInFolder(session.rec.file); else shell.openPath(ROOT()); return true; });

handle('board:write', async (projectId, writes) => sessionFor(projectId).write(writes));
handle('board:flush', async () => { if (session) await session.flush(); return true; });

handle('media:importPaths', async (projectId, paths) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  return tracked(s.rec, async () => {
  const out = [];
  const known = knownHashes();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const job = { index: i, total: paths.length, name: path.basename(p) };
    try {
      const r = await media.importFile(s.mediaDir, p, me, known, (f, mode) => send('import:progress', { ...job, fraction: f, mode }));
      if (r.hash && r.src) known.set(r.hash, r.src);
      out.push(r);
    } catch (e) {
      out.push({ error: `${path.basename(p)}: ${e.message || e}` });
    }
    send('import:progress', { ...job, done: true });
  }
  return out;
  });
});

handle('media:importBytes', async (projectId, bytes, name) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  return tracked(s.rec, () => media.importBytes(s.mediaDir, bytes, name, me, knownHashes()));
});

handle('media:importUrl', async (projectId, url) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  if (!/^https?:\/\//i.test(url)) return { error: 'Only web links can be dropped.' };
  return tracked(s.rec, () => media.importUrl(s.mediaDir, url, me, knownHashes(), (u) => net.fetch(u)));
});

// What the system clipboard holds, for pastes the page itself can't see:
// pictures copied in Keynote, Figma, Photoshop, screenshots, files copied in Finder.
handle('clipboard:read', async () => {
  const out = { text: clipboard.readText() || '', html: clipboard.readHTML() || '', png: null, files: [] };
  try {
    if (process.platform === 'darwin') {
      const u = clipboard.read('public.file-url');
      if (u && u.startsWith('file://')) out.files.push(decodeURIComponent(new URL(u).pathname));
    } else if (process.platform === 'win32') {
      const raw = clipboard.readBuffer('FileNameW');
      if (raw && raw.length) { const f = raw.toString('ucs2').replace(/\0+$/, ''); if (f) out.files.push(f); }
    }
  } catch (_) {}
  if (!out.files.length) {
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) out.png = new Uint8Array(img.toPNG());
  }
  return out;
});

handle('media:grabFrame', async (projectId, src, time) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  return tracked(s.rec, () => media.grabFrame(s.mediaDir, src, time, me));
});

// 'here', 'downloading' (a shared file still on its way) or 'missing'
handle('media:state', async (projectId, src) => {
  if (!session || session.rec.id !== projectId) return 'here';
  const name = path.basename(src);
  if (await exists(path.join(session.mediaDir, name))) return 'here';
  if (sync && sync.isDownloading(name)) return 'downloading';
  return 'missing';
});

handle('dialog:openImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add images and videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images and videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'mts', 'm2ts', '3gp'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

handle('dialog:importFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import a folder of images', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return [];
  const dir = r.filePaths[0];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && media.kindOf(e.name)).map((e) => path.join(dir, e.name)).sort();
});

handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open an Eye Refs file', properties: ['openFile'], filters: [{ name: 'Eye Refs', extensions: ['eyerefs'] }] });
  return r.canceled ? null : r.filePaths[0];
});

handle('shell:open', async (url) => { if (/^https:\/\//.test(url)) await shell.openExternal(url); return true; });

// ---------- window ----------
handle('win:alwaysOnTop', async (on) => { settings.alwaysOnTop = !!on; applyAlwaysOnTop(); saveSettings(); return settings.alwaysOnTop; });

function applyAlwaysOnTop() {
  if (!win) return;
  const on = !!settings.alwaysOnTop;
  win.setAlwaysOnTop(on, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
}

handle('win:opacity', async (delta) => {
  const cur = settings.opacity || 1;
  settings.opacity = Math.max(0.2, Math.min(1, Math.round((cur + delta) * 20) / 20));
  win.setOpacity(settings.opacity);
  saveSettings();
  return settings.opacity;
});

handle('win:setOpacity', async (value) => {
  settings.opacity = Math.max(0.2, Math.min(1, Math.round(Number(value) * 20) / 20 || 1));
  win.setOpacity(settings.opacity);
  saveSettings();
  return settings.opacity;
});

handle('prefs:set', async (patch) => {
  if (patch && 'startWith' in patch) settings.startWith = patch.startWith === 'last' ? 'last' : 'new';
  saveSettings();
  return prefs();
});

// Transparent mode needs a window made see through from the start, so the window
// is rebuilt in place (same size and spot) and goes straight back to the board.
handle('win:transparent', async (on) => {
  on = !!on;
  if (on === !!settings.transparent) return on;
  settings.transparent = on;
  await saveSettings();
  if (session) await session.flush();
  resumeProject = session ? session.rec.id : null;
  const old = win;
  const bounds = old.getBounds();
  createWindow(bounds);
  old.__rebuilding = true;
  old.destroy();
  return on;
});

function setClickThrough(on) {
  clickThrough = !!on;
  if (!win) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  const accel = 'CommandOrControl+T';
  if (clickThrough) { if (!globalShortcut.isRegistered(accel)) globalShortcut.register(accel, () => setClickThrough(false)); }
  else if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
  send('win:clickThrough', clickThrough);
}
handle('win:clickThrough', async (on) => { setClickThrough(on); return clickThrough; });
handle('win:moveBy', async (dx, dy) => { if (!win || win.isMaximized()) return; const [x, y] = win.getPosition(); win.setPosition(Math.round(x + dx), Math.round(y + dy)); });
handle('win:lock', async (on) => { win.setMovable(!on); win.setResizable(!on); return on; });
handle('win:minimize', async () => win.minimize());
handle('win:maximize', async () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
handle('win:close', async () => win.close());
handle('prefs:sidebar', async (on) => { settings.sidebar = !!on; saveSettings(); return on; });

function createWindow(bounds) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const see = !!settings.transparent;
  win = new BrowserWindow({
    width: bounds ? bounds.width : Math.min(1360, area.width - 80),
    height: bounds ? bounds.height : Math.min(860, area.height - 80),
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 360,
    minHeight: 260,
    frame: false,
    transparent: see,
    hasShadow: !see,
    backgroundColor: see ? '#00000000' : '#1C1B1A',
    show: false,
    title: 'Eye Refs',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (settings.opacity) win.setOpacity(settings.opacity);
    applyAlwaysOnTop();
    win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Moving the window by its top bar: the page gets no pointer events while the
  // system drags, so tell it, and the bar stays put the whole time.
  const thisWin = win;
  thisWin.on('move', () => { if (win === thisWin) send('win:moved'); });

  let closing = false;
  win.on('close', async (e) => {
    if (thisWin.__rebuilding || win !== thisWin) return;
    if (closing || (!session && !sync)) return;
    e.preventDefault();
    closing = true;
    await closeCurrent();
    win.close();
  });
}

function fileFromArgs(argv) {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().endsWith('.eyerefs')) || null;
}
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (win && me) send('open-file', file);
  else pendingOpenFile = file;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileFromArgs(argv);
    if (f) send('open-file', f);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(async () => {
    await loadSettings();
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        // Undo, Redo and Select all for notes and text boxes. On the board the page
        // handles these keys itself first.
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        // No Close item: Cmd+W is Lock window, as in PureRef
        { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    pendingOpenFile = pendingOpenFile || fileFromArgs(process.argv);
    createWindow();
    updater.start();
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
