// Eye Refs by Matte Black
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, net, screen, Menu, clipboard, Notification } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');
const { readJson, writeJson, exists } = require('./fsutil');
const { mergeFiles } = require('../shared/merge');
const lib = require('./library');
const media = require('./media');
const office = require('./office');
const pluck = require('./pluck');
const { Session } = require('./session');
const { Cloud } = require('./cloud');
const { Sync } = require('./sync');
const { pack, unpack, isPacked } = require('./pack');
const { randCode, initialsFrom, firstNameFrom, cleanFolderName } = require('../shared/names');
const PKG = require('../package.json');
// Tests keep their settings apart from the real app
if (process.env.EYEREFS_DATA) app.setPath('userData', process.env.EYEREFS_DATA);

let win = null;
const SEE_ALWAYS = process.platform === 'darwin'; // Mac windows can always see through
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
    transparent: !!settings.transparent, startWith: settings.startWith === 'last' ? 'last' : 'new', notify: settings.notify !== false, pins: Array.isArray(settings.pins) ? settings.pins : [],
  };
}

// When a board last changed: the newest of its change files
async function lastEdited(dir) {
  let t = 0;
  for (const f of await fsp.readdir(path.join(dir, 'changes')).catch(() => [])) {
    try { t = Math.max(t, (await fsp.stat(path.join(dir, 'changes', f))).mtimeMs); } catch (_) {}
  }
  return t;
}

// What is on a board, read straight from its files: live pieces, when it last
// changed, and a small layout for the start screen thumbnail.
async function boardSummary(dir) {
  const files = [];
  let modified = 0;
  for (const f of await fsp.readdir(path.join(dir, 'changes')).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, 'changes', f);
    const data = await readJson(fp);
    if (data) files.push(data);
    try { modified = Math.max(modified, (await fsp.stat(fp)).mtimeMs); } catch (_) {}
  }
  const live = Object.values(mergeFiles(files)).filter((it) => !it.deleted && it.type && Number.isFinite(it.x) && Number.isFinite(it.w));
  return { count: live.length, modified, live };
}

// Untitled boards left empty from earlier sessions are tidied away at start,
// so the list never fills up with blank ones. Anything with content stays.
async function clearEmptyUntitled() {
  for (const p of await lib.scanProjects(SCRATCH(), me)) {
    if (session && session.rec.id === p.id) continue;
    if (importing.has(p.id)) continue;
    try {
      if ((await boardSummary(p.dir)).count === 0) await fsp.rm(p.dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

// Start screen, like PureRef: the latest boards with a small picture of each
async function recentBoards() {
  const out = [];
  const seen = new Set();
  for (const p of [...await lib.scanProjects(ROOT(), me), ...(await lib.scanProjects(SCRATCH(), me)).map((p) => ({ ...p, scratch: true }))]) {
    if (seen.has(p.id) || (session && session.rec.id === p.id)) continue;
    seen.add(p.id);
    const sum = await boardSummary(p.dir);
    if (!sum.count) continue;
    const media = pathToFileURL(path.join(p.dir, 'media')).href + '/';
    const shapes = sum.live
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .slice(-40)
      .map((it) => {
        const c = it.crop || { l: 0, r: 0, t: 0, b: 0 };
        const vw = Math.max(1, (it.nw || it.w) * (1 - c.l - c.r)), vh = Math.max(1, (it.nh || it.w) * (1 - c.t - c.b));
        const h = it.type === 'note' ? (it.fs || 16) * 3 : it.w * vh / vw;
        return { type: it.type, x: it.x, y: it.y, w: it.w, h, src: it.type === 'image' && it.src ? media + encodeURIComponent(it.src) : null, color: it.color || null };
      });
    out.push({ id: p.id, name: p.name, scratch: !!p.scratch, modified: sum.modified, shapes });
  }
  out.sort((a, b) => b.modified - a.modified);
  return out.slice(0, 8);
}

let resumeProject = null;

// ---------- each board remembers its window ----------
// Size and place of the window per board, brought back when that board opens.
let boundsTimer = null, settingBounds = false;
function rememberBoardWindow() {
  if (settingBounds || !win || win.isDestroyed() || !session) return;
  const id = session.rec.id;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || !session || session.rec.id !== id || win.isFullScreen() || win.isMinimized()) return;
    settings.boardWin = settings.boardWin || {};
    settings.boardWin[id] = { ...(win.isMaximized() ? (settings.boardWin[id] || {}) : { bounds: win.getBounds() }), max: win.isMaximized(), at: Date.now() };
    // Keep the list from growing forever
    const ids = Object.keys(settings.boardWin);
    if (ids.length > 200) for (const k of ids.sort((a, b) => settings.boardWin[a].at - settings.boardWin[b].at).slice(0, ids.length - 200)) delete settings.boardWin[k];
    saveSettings();
  }, 500);
}
function restoreBoardWindow(id) {
  const saved = settings.boardWin && settings.boardWin[id];
  if (!saved || !win || win.isDestroyed() || win.isFullScreen()) return;
  settingBounds = true;
  try {
    if (saved.max) { if (!win.isMaximized()) win.maximize(); }
    else if (saved.bounds) {
      if (win.isMaximized()) win.unmaximize();
      // Only if it still fits on a screen that's connected now
      const b = saved.bounds;
      const area = screen.getDisplayMatching(b).workArea;
      const fits = b.x + 60 > area.x && b.y + 20 > area.y && b.x < area.x + area.width - 60 && b.y < area.y + area.height - 40;
      if (fits) win.setBounds({ x: b.x, y: b.y, width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) }, process.platform === 'darwin');
    }
  } catch (_) {}
  setTimeout(() => { settingBounds = false; }, 400);
}
let quitAsked = false;

// The answer to "Save this board?" when closing: close now, keeping or dropping it
handle('app:quitNow', async (opts) => {
  quitAsked = true;
  const drop = opts && opts.discard && session && session.rec.scratch ? session.rec : null;
  if (drop) { await serial(closeCurrent); try { await fsp.rm(drop.dir, { recursive: true, force: true }); } catch (_) {} }
  if (win) win.close();
  return { ok: true };
});

// Local projects plus shared boards not yet on this computer
async function allProjects(online = true) {
  const local = [];
  const seenIds = new Set();
  for (const p of [...await lib.scanProjects(ROOT(), me), ...(await lib.scanProjects(SCRATCH(), me)).map((p) => ({ ...p, scratch: true }))]) {
    if (seenIds.has(p.id)) continue; // a half finished move can leave a copy behind
    seenIds.add(p.id);
    p.modified = await lastEdited(p.dir);
    local.push(p);
  }
  let remote = [];
  if (online) { try { remote = await cloud.call('projects.list', {}, 20000); } catch (_) { remote = []; } }
  const fresh = online && remote.length ? news(remote) : null;
  const byShared = new Map(local.filter((p) => p.shared).map((p) => [p.shared.id, p]));
  for (const r of remote) {
    // A board you left stays out of your list, even as an admin, until it's shared with you again
    const left = settings.left && settings.left[r.id];
    if (left && !(r.sharedAt && r.sharedAt > left)) continue;
    const l = byShared.get(r.id) || local.find((p) => p.id === r.id);
    if (l) {
      Object.assign(l, { shared: l.shared || { id: r.id }, role: r.role, requests: r.requests, members: r.members, ownerName: r.ownerName });
      if (fresh && fresh.has(r.id)) l.unread = true;
      l.mine = r.owner === me.email;
      // The owner renamed it: show the new name here too (the folder keeps its name)
      if (r.name && r.name !== l.name && !l.mine) {
        try { await lib.updateProject(l, { name: r.name }); l.name = r.name; if (session && session.rec.id === l.id) session.rec.name = r.name; } catch (_) {}
      }
    } else {
      local.push({ id: r.id, name: r.name, client: r.client, owner: { email: r.owner, name: r.ownerName }, mine: r.owner === me.email, shared: { id: r.id }, cloudOnly: true, role: r.role, requests: r.requests, members: r.members, unread: !!(fresh && fresh.has(r.id)) });
    }
  }
  return local;
}

// ---------- notifications ----------
// A board shared with you, or a teammate changing a shared board you don't have
// open: a note in the app, and a system notification when Eye Refs is in the back.
// Returns the boards with changes you haven't looked at yet.
function news(remote) {
  const first = !settings.news;
  const N = settings.news || (settings.news = { boards: {}, seen: {}, told: {} });
  N.told = N.told || {};
  const openShared = session && session.rec.shared ? session.rec.shared.id : session ? session.rec.id : null;
  const unread = new Set();
  let changed = first;
  for (const r of remote) {
    if (!N.boards[r.id]) {
      N.boards[r.id] = 1; changed = true;
      if (!first && r.owner !== me.email) tell({ id: r.id, title: 'New board shared with you', body: `${r.sharedBy || r.ownerName || 'Someone'} shared "${r.name}" with you` });
    }
    const u = r.updated;
    if (first) { N.seen[r.id] = u ? u.at : Date.now(); continue; }
    if (!u || u.email === me.email || u.at <= (N.seen[r.id] || 0)) continue;
    if (openShared === r.id) { N.seen[r.id] = u.at; changed = true; continue; } // the open board tells you itself
    unread.add(r.id);
    if ((N.told[r.id] || 0) < u.at) { N.told[r.id] = u.at; changed = true; tell({ id: r.id, title: r.name, body: `${u.by || 'A teammate'} made changes to "${r.name}"` }); }
  }
  if (changed) saveSettings();
  return unread;
}

function tell(n) {
  if (!n.local) send('news', n);
  if (settings.notify === false || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isFocused()) return; // the app shows it already
  try {
    const note = new Notification({ title: n.title || 'Eye Refs', body: n.body, silent: false });
    note.on('click', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); send('news-open', n.id); } });
    note.show();
  } catch (_) {}
}
handle('app:notify', async (n) => { if (n && n.body) tell({ id: n.id || null, title: n.title || 'Eye Refs', body: String(n.body).slice(0, 200), local: true }); return true; });

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
  restoreBoardWindow(rec.id);
  if (rec.shared && settings.news) { settings.news.seen[rec.shared.id] = Date.now(); }
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
handle('projects:recent', async () => ({ boards: await recentBoards() }));

// Throw away an untitled board that isn't open (the "Don't save" choice)
handle('projects:discard', (id) => serial(async () => {
  if (session && session.rec.id === id) return { error: 'That board is open.' };
  const p = (await lib.scanProjects(SCRATCH(), me)).find((x) => x.id === id);
  if (!p || importing.has(id)) return { ok: false };
  await fsp.rm(p.dir, { recursive: true, force: true });
  return { ok: true };
}));

// Delete a board. Never permanent: a board on this computer goes to the Trash
// (or a Deleted boards folder if there's no Trash), and a shared board the owner
// deletes goes to the Trash in their Google Drive. Someone it was shared with
// only leaves it; everyone else keeps it.
handle('projects:delete', (id, mode) => serial(async () => {
  if (session && session.rec.id === id) return { error: 'Close the board first.' };
  if (importing.has(id)) return { error: "It's still being saved. Try again in a moment." };
  const all = await allProjects(true);
  const p = all.find((x) => x.id === id);
  if (!p) return { error: "That board isn't here any more." };
  if (p.shared) {
    try {
      if (mode === 'everyone') {
        if (!p.mine) return { error: 'Only the owner can delete this board for everyone.' };
        await cloud.call('projects.delete', { id: p.shared.id });
      } else if (!p.mine) {
        await cloud.call('projects.remove', { id: p.shared.id, email: me.email });
        settings.left = { ...(settings.left || {}), [p.shared.id]: Date.now() };
        saveSettings();
      } else return { error: 'Choose how to delete a shared board.' };
    } catch (e) {
      return { error: (e && e.message) || "Couldn't reach the server. Check your connection and try again." };
    }
  }
  if (p.dir && (await exists(p.dir))) {
    let moved = false;
    try { await shell.trashItem(p.dir); moved = true; } catch (_) {}
    if (!moved) {
      // No Trash on this computer: keep it in the app's own Deleted boards folder
      const bin = path.join(app.getPath('userData'), 'Deleted boards');
      await fsp.mkdir(bin, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      await fsp.rename(p.dir, path.join(bin, `${path.basename(p.dir)} ${stamp}`)).catch(async () => {
        await fsp.cp(p.dir, path.join(bin, `${path.basename(p.dir)} ${stamp}`), { recursive: true });
        await fsp.rm(p.dir, { recursive: true, force: true });
      });
    }
  }
  if (Array.isArray(settings.pins) && settings.pins.includes(id)) { settings.pins = settings.pins.filter((x) => x !== id); saveSettings(); }
  if (settings.boardWin && settings.boardWin[id]) { delete settings.boardWin[id]; saveSettings(); }
  return { ok: true };
}));

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

// View link: anyone with it sees the board in a browser, phones too, read only
handle('projects:viewLink', async (projectId, on) => {
  const s = sessionFor(projectId);
  if (!s.rec.shared) return { key: null, url: null };
  const r = await cloud.call('projects.viewLink', on === undefined ? { id: s.rec.shared.id } : { id: s.rec.shared.id, on: !!on });
  return { key: r.key, url: r.key ? `${serverUrl()}?v=${r.key}` : null };
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

// ---------- decks and documents, page by page ----------
handle('doc:get', () => { shell.openExternal(office.GET_LIBREOFFICE); return true; });
handle('doc:can', (name) => office.isOffice(name) ? { office: true, can: office.canConvert(name), getUrl: office.GET_LIBREOFFICE } : { office: false });

// Turn a deck or document already on the board into pages, and take out its
// videos with the spot each one sits on its slide.
handle('doc:pages', async (projectId, src, original) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  let file;
  try { file = media.inMedia(s.mediaDir, src); } catch (e) { return { error: e.message }; }
  if (!(await exists(file))) return { error: "That file hasn't arrived on this computer yet." };
  if (media.runsCode(src)) return { error: "Files that can run code aren't opened." };
  return tracked(s.rec, async () => {
    const work = path.join(app.getPath('temp'), 'eye-refs-doc', Math.random().toString(36).slice(2, 10));
    try {
      // A plain copy with its proper name, so the converter knows what it is
      const ext = office.extOf(src);
      const base = String(path.basename(original || '') || 'document').replace(/[\\/:*?"<>|]/g, '_').replace(/\.[^.]*$/, '').slice(0, 80) + '.' + ext;
      const inDir = path.join(work, 'in');
      await fsp.mkdir(inDir, { recursive: true });
      const copy = path.join(inDir, base);
      await fsp.copyFile(file, copy);
      const conv = await office.toPdf(copy, path.join(work, 'out'), path.join(app.getPath('userData'), 'office-profile'));
      if (!conv.pdf) return conv;
      const known = knownHashes();
      const pdf = await media.importFile(s.mediaDir, conv.pdf, me, known, null, path.basename(copy, path.extname(copy)) + ' pages.pdf');
      if (pdf.error) return { error: pdf.error };
      const videos = [];
      const seen = new Map();
      for (const v of await office.deckVideos(copy).catch(() => [])) {
        if (!seen.has(v.part)) {
          const out = await office.extract(copy, v.part, path.join(work, 'media'));
          const r = out ? await media.importFile(s.mediaDir, out, me, known).catch(() => null) : null;
          seen.set(v.part, r && r.kind === 'video' ? r : null);
          if (r && r.hash && r.src) known.set(r.hash, r.src);
        }
        const r = seen.get(v.part);
        if (r) videos.push({ page: v.page, src: r.src, x: v.x, y: v.y, w: v.w, h: v.h, duration: r.duration || 0, fps: r.fps || 0 });
      }
      return { pdf: pdf.src, videos };
    } catch (e) {
      return { error: "Couldn't turn that file into pages." };
    } finally {
      fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// Every picture and video inside a deck or document, as they are, in slide order
handle('doc:media', async (projectId, src) => {
  const s = sessionFor(projectId);
  if (s.readOnly) return { error: 'This project is view only.' };
  let file;
  try { file = media.inMedia(s.mediaDir, src); } catch (e) { return { error: e.message }; }
  if (!(await exists(file))) return { error: "That file hasn't arrived on this computer yet." };
  return tracked(s.rec, async () => {
    const work = path.join(app.getPath('temp'), 'eye-refs-doc', Math.random().toString(36).slice(2, 10));
    const list = await office.innerMedia(file).catch(() => []);
    const closer = list.length && list[list.length - 1].close ? list.pop() : null;
    const out = [];
    try {
      await fsp.mkdir(work, { recursive: true });
      const known = knownHashes();
      for (let i = 0; i < list.length; i++) {
        const to = path.join(work, `${i}-${path.posix.basename(list[i].part).replace(/[^\w.\- ]/g, '_')}`);
        if (!(await list[i].save(to))) continue;
        send('import:progress', { index: i, total: list.length, name: path.basename(to) });
        const r = await media.importFile(s.mediaDir, to, me, known, (f, mode) => send('import:progress', { index: i, total: list.length, name: path.basename(to), fraction: f, mode })).catch((e) => ({ error: e.message }));
        if (r && r.hash && r.src) known.set(r.hash, r.src);
        if (r && !r.error && (r.kind === 'image' || r.kind === 'video')) out.push({ ...r, page: list[i].page });
        send('import:progress', { index: i, total: list.length, done: true });
      }
    } finally {
      if (closer) closer.close();
      fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
    return { results: out };
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

// ---------- saved versions ----------
// A copy of the board as it was, kept in the board's own folder. Restoring
// writes it back as ordinary changes, so teammates get it too and undo works.
function versionsDir() { return session ? path.join(session.rec.dir, 'versions') : null; }
handle('versions:list', async (projectId) => {
  if (!session || session.rec.id !== projectId) return { versions: [] };
  const dir = versionsDir();
  const out = [];
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const v = await readJson(path.join(dir, f));
    if (v && v.id) out.push({ id: v.id, name: v.name, at: v.at, by: v.by, count: Object.keys(v.items || {}).length });
  }
  out.sort((a, b) => b.at - a.at);
  return { versions: out };
});
handle('versions:save', async (projectId, name, items) => {
  if (!session || session.rec.id !== projectId) return { error: 'Open the board first.' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const v = { id, name: String(name || '').trim().slice(0, 80) || 'Saved version', at: Date.now(), by: me ? me.name : '', items: items && typeof items === 'object' ? items : {} };
  await fsp.mkdir(versionsDir(), { recursive: true });
  await writeJson(path.join(versionsDir(), id + '.json'), v);
  return { id, name: v.name, at: v.at };
});
handle('versions:get', async (projectId, id) => {
  if (!session || session.rec.id !== projectId) return null;
  return readJson(path.join(versionsDir(), path.basename(String(id)) + '.json'));
});
handle('versions:delete', async (projectId, id) => {
  if (!session || session.rec.id !== projectId) return { ok: false };
  await fsp.rm(path.join(versionsDir(), path.basename(String(id)) + '.json'), { force: true });
  return { ok: true };
});

// Social links through Pluck: progress goes to the page as it comes in
handle('pluck:fetch', async (projectId, url, key) => {
  if (!session || session.rec.id !== projectId) return { error: 'Open the board first.' };
  return pluck.fetchLink(String(url || ''), (p) => send('pluck:progress', { ...p, key }));
});
handle('pluck:cancel', (token) => { pluck.cancel(String(token || '')); return true; });
handle('pluck:cleanup', async (token) => { await pluck.cleanup(String(token || '')); return true; });
handle('pluck:get', () => { shell.openExternal(pluck.GET_PLUCK); return true; });
handle('pluck:installed', () => pluck.installed());

// Media as bytes for an export (a video gives the frame showing now)
// A file card opens in its own app. Anything that could run code is only shown
// in its folder, so a shared board can never start a program on this computer.
handle('media:open', async (projectId, src, original) => {
  if (!session || session.rec.id !== projectId) return { error: 'That board is closed.' };
  let file;
  try { file = media.inMedia(session.mediaDir, src); } catch (e) { return { error: e.message }; }
  if (!(await exists(file))) return { error: "That file hasn't arrived on this computer yet." };
  if (media.runsCode(src) || media.runsCode(original || src)) { shell.showItemInFolder(file); return { shown: true }; }
  const err = await shell.openPath(file);
  return err ? { error: "This computer doesn't have an app for that file." } : { opened: true };
});

handle('media:bytes', async (projectId, src, time, kind) => {
  if (!session || session.rec.id !== projectId) return null;
  const file = path.join(session.mediaDir, path.basename(String(src || '')));
  if (!(await exists(file))) return null;
  if (kind === 'video') return media.frameBytes(file, Number(time) || 0);
  return fsp.readFile(file);
});

// A one page PDF holding a JPEG, sized so the longest side is about A3
function jpegPdf(jpg, w, h) {
  const k = 1190 / Math.max(w, h);
  const pw = Math.round(w * k * 100) / 100, ph = Math.round(h * k * 100) / 100;
  const parts = [];
  const offsets = [];
  let len = 0;
  const add = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'binary'); parts.push(buf); len += buf.length; };
  const obj = (n, body) => { offsets[n] = len; add(`${n} 0 obj\n`); for (const b of [].concat(body)) add(b); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

handle('export:save', async (o) => {
  const kind = o && o.kind === 'pdf' ? 'pdf' : 'png';
  const safe = String((o && o.name) || 'Eye Refs').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Eye Refs';
  const r = await dialog.showSaveDialog(win, {
    title: kind === 'pdf' ? 'Export as PDF' : 'Export as picture',
    defaultPath: path.join(app.getPath('downloads'), `${safe}.${kind}`),
    filters: kind === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'PNG picture', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  const bytes = Buffer.from(o.bytes);
  await fsp.writeFile(r.filePath, kind === 'pdf' ? jpegPdf(bytes, o.w, o.h) : bytes);
  return { saved: r.filePath, name: path.basename(r.filePath) };
});
handle('export:reveal', (p) => { if (p) shell.showItemInFolder(String(p)); return true; });

handle('media:palette', async (projectId, src, time) => {
  if (!session || session.rec.id !== projectId) return { colors: [] };
  const file = path.join(session.mediaDir, path.basename(String(src || '')));
  if (!(await exists(file))) return { colors: [] };
  return { colors: await media.palette(file, Number(time) || 0) };
});

handle('dialog:openImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add images and videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images, videos and PDFs', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'mts', 'm2ts', '3gp', 'pdf'] }, { name: 'All files', extensions: ['*'] }],
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
  if (patch && 'notify' in patch) settings.notify = !!patch.notify;
  if (patch && Array.isArray(patch.pins)) settings.pins = patch.pins.filter((x) => typeof x === 'string').slice(0, 50);
  saveSettings();
  return prefs();
});

// Transparent mode needs a window made see through from the start, so the window
// is rebuilt in place (same size and spot) and goes straight back to the board.
// On a Mac the window is always made able to see through, so switching is instant
// and only the page background changes. Windows can only resize a normal window,
// so there the window is rebuilt: the new one stays hidden until its board has
// loaded, then takes the old one's place, with nothing closing on screen.
let swapFrom = null;
handle('win:transparent', async (on) => {
  on = !!on;
  if (on === !!settings.transparent) return { on, rebuilt: false };
  settings.transparent = on;
  await saveSettings();
  // A window made see through capable can switch on the spot
  if (win && win.__canSee) return { on, rebuilt: false };
  if (session) await session.flush();
  resumeProject = session ? session.rec.id : null;
  const old = win;
  swapFrom = old;
  createWindow(old.getBounds(), { swap: true });
  setTimeout(finishSwap, 6000); // never leave the old one hanging
  return { on, rebuilt: true };
});
function finishSwap() {
  const old = swapFrom;
  if (!old) return;
  swapFrom = null;
  if (settings.opacity) win.setOpacity(settings.opacity);
  applyAlwaysOnTop();
  win.show();
  win.focus();
  old.__rebuilding = true;
  if (!old.isDestroyed()) old.destroy();
}
ipcMain.on('app:ready', (e) => { if (swapFrom && win && e.sender === win.webContents) finishSwap(); });

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

function createWindow(bounds, opts = {}) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const see = SEE_ALWAYS || !!settings.transparent;
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
  win.__canSee = see;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (opts.swap) return; // shown once its board is on screen
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
  thisWin.on('move', () => { if (win === thisWin) send('win:moved'); rememberBoardWindow(); });
  thisWin.on('resize', () => rememberBoardWindow());

  let closing = false;
  win.on('close', async (e) => {
    if (thisWin.__rebuilding || win !== thisWin) return;
    if (closing || (!session && !sync)) return;
    e.preventDefault();
    // An untitled board with something on it: ask first, like PureRef
    if (!quitAsked && session && session.rec.scratch && !isEmpty(session) && !importing.has(session.rec.id)) {
      send('ask-save-quit');
      return;
    }
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
    // Always open in the normal view. See through is for the moment you need it.
    settings.transparent = false;
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
