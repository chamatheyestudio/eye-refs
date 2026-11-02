// Eye Refs by Matte Black
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, net, screen, Menu } = require('electron');
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');
const { readJson, writeJson, exists } = require('./fsutil');
const drive = require('./drive');
const lib = require('./library');
const media = require('./media');
const { Session } = require('./session');
const { randCode, initialsFrom, firstNameFrom } = require('../shared/names');

let win = null;
let settings = {};
let me = null;
let myDrive = null;
let session = null;
let pendingOpenFile = null;
let clickThrough = false;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const backupDir = () => path.join(app.getPath('userData'), 'backups');

async function loadSettings() {
  settings = (await readJson(settingsPath())) || {};
  if (!settings.deviceId) {
    settings.deviceId = randCode(6);
    await saveSettings();
  }
}
async function saveSettings() {
  try { await writeJson(settingsPath(), settings); } catch (_) {}
}

function makeMe(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'user';
  const name = settings.name || firstNameFrom(email);
  return { email: email.toLowerCase(), name, initials: initialsFrom(name, email), deviceKey: `${local}-${settings.deviceId}` };
}

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

// ---------- Startup: find Drive, the team folder and projects ----------
async function boot() {
  const accounts = await drive.findDriveAccounts();
  let account = null;

  if (settings.myDrive && (await exists(settings.myDrive))) {
    account = accounts.find((a) => a.myDrive === settings.myDrive) || { email: null, myDrive: settings.myDrive };
  } else if (process.platform === 'darwin') {
    const studio = accounts.filter((a) => drive.isStudioEmail(a.email));
    if (!studio.length) {
      if (accounts.length) return { screen: 'wrong-account', emails: accounts.map((a) => a.email).filter(Boolean) };
      return { screen: 'no-drive' };
    }
    account = studio[0];
  } else {
    if (!accounts.length) return { screen: 'no-drive' };
    account = accounts[0];
  }

  const email = account.email && drive.isStudioEmail(account.email) ? account.email : settings.email;
  if (!email || !drive.isStudioEmail(email)) return { screen: 'who', platform: process.platform };
  if (account.email && !drive.isStudioEmail(account.email)) return { screen: 'wrong-account', emails: [account.email] };

  myDrive = account.myDrive;
  me = makeMe(email);

  const team = await lib.readTeam(myDrive);
  if (!team) return { screen: 'no-team', me };
  await lib.ensureClientFolders(myDrive, team.clients);
  const projects = await lib.scanProjects(myDrive, me);
  const open = pendingOpenFile;
  pendingOpenFile = null;
  return { screen: 'app', me, team, projects, lastProject: settings.lastProject || null, openFile: open, prefs: prefs(), version: app.getVersion() };
}

function prefs() {
  return { alwaysOnTop: !!settings.alwaysOnTop, opacity: settings.opacity || 1, sidebar: settings.sidebar !== false };
}

// ---------- Board session ----------
async function openProject(rec) {
  if (session) { try { await session.close(); } catch (_) {} session = null; }
  const s = new Session(rec, me, backupDir(), {
    state: (items) => send('board:state', { projectId: rec.id, items }),
    status: (st) => send('board:status', { projectId: rec.id, status: st }),
    presence: (list) => send('board:presence', { projectId: rec.id, here: list }),
  });
  session = s;
  const items = await s.open();
  settings.lastProject = rec.id;
  saveSettings();
  return {
    record: rec,
    items,
    status: s.status,
    readOnly: s.readOnly,
    mediaBase: pathToFileURL(s.mediaDir).href + '/',
  };
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

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { return { error: String((e && e.message) || e) }; }
  });
}

handle('boot', boot);

handle('identity:set', async (email) => {
  if (!drive.isStudioEmail(email)) return { error: 'Use your eyestudio.ae email.' };
  settings.email = email.trim().toLowerCase();
  await saveSettings();
  return boot();
});

handle('drive:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your Google Drive folder (My Drive)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return boot();
  settings.myDrive = r.filePaths[0];
  await saveSettings();
  return boot();
});

handle('drive:download', async () => { await shell.openExternal('https://www.google.com/drive/download/'); return true; });

handle('team:create', async () => {
  await lib.createTeam(myDrive, me);
  return boot();
});

handle('team:saveClients', async (clients) => {
  const team = await lib.saveClients(myDrive, me, clients);
  await lib.ensureClientFolders(myDrive, team.clients);
  return team;
});

handle('projects:scan', async () => {
  const team = await lib.readTeam(myDrive);
  if (team) await lib.ensureClientFolders(myDrive, team.clients);
  return { team, projects: await lib.scanProjects(myDrive, me) };
});

handle('projects:create', async (name, client) => {
  if (!name || !name.trim()) return { error: 'Give the project a name.' };
  if (!client) return { error: 'Pick a client.' };
  const rec = await lib.createProject(myDrive, me, name, client);
  return openProject(rec);
});

handle('projects:open', async (id) => {
  const list = await lib.scanProjects(myDrive, me);
  const rec = list.find((p) => p.id === id);
  if (!rec) return { error: "That project isn't in your Drive anymore. It may have been unshared or moved." };
  return openProject(rec);
});

handle('projects:openFile', async (file) => {
  const rec = await lib.openProjectFile(file, me);
  if (!rec) return { error: "That file isn't an Eye Refs project." };
  return openProject(rec);
});

handle('projects:rename', async (newName) => {
  if (!session) return { error: 'No project open.' };
  const data = await lib.renameProject(session.rec, me, newName);
  session.rec.name = data.name;
  return { name: data.name };
});

handle('projects:share', async () => {
  if (!session) return { error: 'No project open.' };
  const id = drive.driveIdOf(session.rec.dir);
  if (id) {
    await shell.openExternal(`https://drive.google.com/drive/folders/${id}?usp=sharing`);
    return { opened: 'drive' };
  }
  shell.showItemInFolder(session.rec.file);
  return { opened: 'folder' };
});

handle('projects:reveal', async () => {
  if (session) shell.showItemInFolder(session.rec.file);
  return true;
});

// Every board call names its project, so a write can never land in a different one.
function sessionFor(projectId) {
  if (!session || session.rec.id !== projectId) throw new Error('That project is no longer open.');
  return session;
}

handle('board:write', async (projectId, writes) => sessionFor(projectId).write(writes));
handle('board:flush', async () => { if (session) await session.flush(); return true; });

handle('media:importPaths', async (projectId, paths) => {
  const session = sessionFor(projectId);
  if (session.readOnly) return { error: 'This project is view only.' };
  const out = [];
  const known = knownHashes();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const job = { index: i, total: paths.length, name: path.basename(p) };
    try {
      const r = await media.importFile(session.mediaDir, p, me, known, (f, mode) => send('import:progress', { ...job, fraction: f, mode }));
      if (r.hash && r.src) known.set(r.hash, r.src);
      out.push(r);
    } catch (e) {
      out.push({ error: `${path.basename(p)}: ${e.message || e}` });
    }
    send('import:progress', { ...job, done: true });
  }
  return out;
});

handle('media:importBytes', async (projectId, bytes, name) => {
  const session = sessionFor(projectId);
  if (session.readOnly) return { error: 'This project is view only.' };
  return media.importBytes(session.mediaDir, bytes, name, me, knownHashes());
});

handle('media:importUrl', async (projectId, url) => {
  const session = sessionFor(projectId);
  if (session.readOnly) return { error: 'This project is view only.' };
  if (!/^https?:\/\//i.test(url)) return { error: 'Only web links can be dropped.' };
  return media.importUrl(session.mediaDir, url, me, knownHashes(), (u) => net.fetch(u));
});

handle('media:grabFrame', async (projectId, src, time) => {
  const session = sessionFor(projectId);
  if (session.readOnly) return { error: 'This project is view only.' };
  return media.grabFrame(session.mediaDir, src, time, me);
});

handle('media:exists', async (projectId, src) => {
  if (!session || session.rec.id !== projectId) return true;
  return exists(path.join(session.mediaDir, path.basename(src)));
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

handle('shell:open', async (url) => { if (/^https:\/\//.test(url)) await shell.openExternal(url); return true; });

// ---------- Window ----------
handle('win:alwaysOnTop', async (on) => {
  settings.alwaysOnTop = !!on;
  applyAlwaysOnTop();
  saveSettings();
  return settings.alwaysOnTop;
});

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

function setClickThrough(on) {
  clickThrough = !!on;
  if (!win) return;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  const accel = 'CommandOrControl+T';
  if (clickThrough) {
    if (!globalShortcut.isRegistered(accel)) globalShortcut.register(accel, () => setClickThrough(false));
  } else if (globalShortcut.isRegistered(accel)) {
    globalShortcut.unregister(accel);
  }
  send('win:clickThrough', clickThrough);
}
handle('win:clickThrough', async (on) => { setClickThrough(on); return clickThrough; });

handle('win:moveBy', async (dx, dy) => {
  if (!win || win.isMaximized()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});
handle('win:lock', async (on) => { win.setMovable(!on); win.setResizable(!on); return on; });
handle('win:minimize', async () => win.minimize());
handle('win:maximize', async () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
handle('win:close', async () => win.close());
handle('prefs:sidebar', async (on) => { settings.sidebar = !!on; saveSettings(); return on; });

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1360, area.width - 80),
    height: Math.min(860, area.height - 80),
    minWidth: 360,
    minHeight: 260,
    frame: false,
    backgroundColor: '#1C1B1A',
    show: false,
    title: 'Eye Refs Beta',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (settings.opacity) win.setOpacity(settings.opacity);
    applyAlwaysOnTop();
    win.show();
  });
  // Links never open inside the app window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  let closing = false;
  win.on('close', async (e) => {
    if (closing || !session) return;
    e.preventDefault();
    closing = true;
    try { await session.close(); } catch (_) {}
    session = null;
    win.close();
  });
}

// Opening .eyerefs files from Finder or Explorer
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
    // Mac needs an Edit menu for copy and paste keys to reach the page. Undo stays with the board.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
        { role: 'windowMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    pendingOpenFile = pendingOpenFile || fileFromArgs(process.argv);
    createWindow();
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
