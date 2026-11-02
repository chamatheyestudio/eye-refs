const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('eyerefs', {
  platform: process.platform,
  boot: call('boot'),
  setIdentity: call('identity:set'),
  chooseDrive: call('drive:choose'),
  downloadDrive: call('drive:download'),
  createTeam: call('team:create'),
  saveClients: call('team:saveClients'),
  scan: call('projects:scan'),
  createProject: call('projects:create'),
  openProject: call('projects:open'),
  openProjectFile: call('projects:openFile'),
  renameProject: call('projects:rename'),
  share: call('projects:share'),
  reveal: call('projects:reveal'),
  write: call('board:write'),
  flush: call('board:flush'),
  importPaths: call('media:importPaths'),
  importBytes: call('media:importBytes'),
  importUrl: call('media:importUrl'),
  grabFrame: call('media:grabFrame'),
  mediaExists: call('media:exists'),
  openImagesDialog: call('dialog:openImages'),
  importFolderDialog: call('dialog:importFolder'),
  openExternal: call('shell:open'),
  setAlwaysOnTop: call('win:alwaysOnTop'),
  changeOpacity: call('win:opacity'),
  setClickThrough: call('win:clickThrough'),
  moveWindowBy: call('win:moveBy'),
  lockWindow: call('win:lock'),
  minimize: call('win:minimize'),
  maximize: call('win:maximize'),
  close: call('win:close'),
  setSidebarPref: call('prefs:sidebar'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch (_) { return null; }
  },
  onState: on('board:state'),
  onStatus: on('board:status'),
  onPresence: on('board:presence'),
  onImportProgress: on('import:progress'),
  onOpenFile: on('open-file'),
  onClickThrough: on('win:clickThrough'),
});
