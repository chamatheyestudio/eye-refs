// Updates itself from GitHub releases. Only full releases, never test versions.
//
// Windows: electron-updater downloads in the background and installs on quit
//          (or right away when the person clicks "Restart to update").
// Mac:     Apple only allows silent self updates for apps with a paid Apple
//          certificate, so the app downloads the new installer in the
//          background and opens it when the person clicks "Restart to update".
//
// Boards, unsaved boards, settings and sign in all live outside the app, so an
// update never touches them.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { app, net, shell } = require('electron');

const REPO = 'chamatheyestudio/eye-refs';
const EVERY = 4 * 60 * 60 * 1000;

function newer(a, b) {
  // true when version a is newer than b. Pre-release versions never count.
  if (/-/.test(a)) return false;
  const pa = a.split('.').map(Number), pb = b.replace(/-.*/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return /-/.test(b); // 1.0.0 is newer than 1.0.0-beta.9
}

function createUpdater(notify) {
  let ready = null; // { version, install() }
  let busy = false;

  async function checkMac() {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!version || rel.prerelease || rel.draft || !newer(version, app.getVersion())) return;
    const want = process.arch === 'arm64' ? `Eye-Refs-${version}-arm64.pkg` : `Eye-Refs-${version}.pkg`;
    const asset = (rel.assets || []).find((a) => a.name === want);
    if (!asset) return;
    const dir = path.join(app.getPath('userData'), 'updates');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, want);
    let have = 0;
    try { have = (await fsp.stat(file)).size; } catch (_) {}
    if (have !== asset.size) {
      const dl = await net.fetch(asset.browser_download_url);
      if (!dl.ok) return;
      const part = file + '.part';
      await fsp.writeFile(part, Buffer.from(await dl.arrayBuffer()));
      if ((await fsp.stat(part)).size !== asset.size) { await fsp.rm(part, { force: true }); return; }
      await fsp.rename(part, file);
    }
    // Old installers are not needed anymore
    for (const f of await fsp.readdir(dir)) if (f !== want) await fsp.rm(path.join(dir, f), { force: true });
    ready = {
      version,
      install: async () => {
        const err = await shell.openPath(file);
        if (!err) setTimeout(() => app.quit(), 600);
        return err;
      },
    };
    notify({ version });
  }

  let winUpdater = null;
  function setupWindows() {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    autoUpdater.on('update-downloaded', (info) => {
      ready = { version: info.version, install: async () => { autoUpdater.quitAndInstall(true, true); } };
      notify({ version: info.version });
    });
    autoUpdater.on('error', () => {});
    winUpdater = autoUpdater;
  }

  async function check() {
    if (busy || ready || !app.isPackaged) return;
    busy = true;
    try {
      if (process.platform === 'darwin') await checkMac();
      else if (process.platform === 'win32') { if (!winUpdater) setupWindows(); await winUpdater.checkForUpdates(); }
    } catch (_) {
      // Offline or GitHub unreachable: try again later
    } finally {
      busy = false;
    }
  }

  return {
    start() { setTimeout(check, 8000); setInterval(check, EVERY); },
    check,
    state() { return ready ? { version: ready.version } : null; },
    async install() { if (!ready) return { error: 'No update yet.' }; const err = await ready.install(); return err ? { error: err } : { ok: true }; },
  };
}

module.exports = { createUpdater, newer };
