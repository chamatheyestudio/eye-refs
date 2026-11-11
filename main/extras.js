// The two free helpers Eye Refs leans on, set up from inside the app so nobody
// has to find and install them by hand:
//   Pluck        videos and posts from Instagram, TikTok, YouTube and more
//   LibreOffice  PowerPoint, Word and Excel files page by page
// Each is downloaded straight from its own home (Pluck's GitHub releases, The
// Document Foundation's servers) and installed quietly. On a Mac the app is
// copied into Applications. On Windows Pluck installs for this user only, and
// LibreOffice asks Windows for permission once.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, net } = require('electron');
const pluck = require('./pluck');
const office = require('./office');

const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const LO_STABLE = 'https://download.documentfoundation.org/libreoffice/stable/';

const supported = () => MAC || WIN;
const state = () => ({
  supported: supported(),
  pluck: pluck.installed(),
  office: office.hasLibreOffice(),
  running: running ? running.which : null,
});

// The newest LibreOffice release, from the folder list on its download server
async function newestLibreOffice() {
  const res = await net.fetch(LO_STABLE, { cache: 'no-store' });
  if (!res.ok) throw new Error("Couldn't reach LibreOffice's download server.");
  const html = await res.text();
  const vers = [...new Set([...html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]))];
  if (!vers.length) throw new Error("Couldn't find the latest LibreOffice.");
  const n = (v) => v.split('.').map(Number);
  vers.sort((a, b) => { const x = n(a), y = n(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return vers[0];
}

async function libreOfficeUrl() {
  const v = await newestLibreOffice();
  const arm = process.arch === 'arm64';
  if (MAC) return `${LO_STABLE}${v}/mac/${arm ? 'aarch64' : 'x86_64'}/LibreOffice_${v}_MacOS_${arm ? 'aarch64' : 'x86-64'}.dmg`;
  return `${LO_STABLE}${v}/win/${arm ? 'aarch64' : 'x86_64'}/LibreOffice_${v}_Win_${arm ? 'aarch64' : 'x86-64'}.msi`;
}

// Stream a download to disk, reporting how far along it is
async function download(url, dest, onFraction, isCancelled) {
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`The download didn't start (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const part = dest + '.part';
  const fh = await fsp.open(part, 'w');
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (isCancelled()) { try { await reader.cancel(); } catch (_) {} throw new Error('Cancelled.'); }
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
      got += value.length;
      if (total) onFraction(Math.min(1, got / total));
    }
  } finally { await fh.close(); }
  if (total && got < total) { await fsp.unlink(part).catch(() => {}); throw new Error('The download was cut short. Try again.'); }
  await fsp.rename(part, dest);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    if (p.stderr) p.stderr.on('data', (d) => { err += d; });
    if (opts.input != null && p.stdin) { p.stdin.end(opts.input); }
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, err }));
  });
}

// Mac: open the disk image out of sight, copy the app into Applications
// (the user's own Applications folder if the main one can't be written to)
async function macInstall(dmg, appName) {
  const mnt = path.join(os.tmpdir(), 'eyerefs-' + Date.now().toString(36));
  await fsp.mkdir(mnt, { recursive: true });
  // "Y" accepts a licence prompt if a disk image shows one
  const a = await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt], { input: 'Y\n', stdio: ['pipe', 'ignore', 'pipe'] });
  if (a.code !== 0) throw new Error("Couldn't open the download.");
  try {
    const src = path.join(mnt, appName);
    if (!fs.existsSync(src)) throw new Error("The download didn't have the app in it.");
    let dir = '/Applications';
    try { await fsp.access(dir, fs.constants.W_OK); } catch (_) { dir = path.join(os.homedir(), 'Applications'); await fsp.mkdir(dir, { recursive: true }); }
    const dest = path.join(dir, appName);
    const temp = path.join(dir, `.${appName}.${Date.now().toString(36)}`);
    const c = await run('/usr/bin/ditto', [src, temp], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (c.code !== 0) { await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}); throw new Error(`Couldn't copy ${appName} into Applications.`); }
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', temp], { stdio: 'ignore' }).catch(() => {});
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(temp, dest);
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' }).catch(() => {});
    await fsp.rmdir(mnt).catch(() => {});
  }
}

const JOBS = {
  pluck: {
    name: 'Pluck',
    url: async () => pluck.GET_PLUCK,
    file: MAC ? 'Pluck.dmg' : 'Pluck-Setup.exe',
    async install(file) {
      if (MAC) return macInstall(file, 'Pluck.app');
      const r = await run(file, ['/S'], { stdio: 'ignore' }); // installs for this user, no permission prompt
      if (r.code !== 0) throw new Error("Pluck's installer didn't finish.");
    },
    done: () => pluck.installed(),
  },
  office: {
    name: 'LibreOffice',
    url: libreOfficeUrl,
    file: MAC ? 'LibreOffice.dmg' : 'LibreOffice.msi',
    async install(file) {
      if (MAC) return macInstall(file, 'LibreOffice.app');
      // Windows asks once for permission. LibreOffice doesn't take over Word,
      // Excel or PowerPoint files, and no restart.
      const r = await run('msiexec.exe', ['/i', file, '/passive', '/norestart', 'REGISTER_NO_MSO_TYPES=1', 'RebootYesNo=No', 'ISCHECKFORPRODUCTUPDATES=0', 'QUICKSTART=0'], { stdio: 'ignore' });
      if (r.code === 1602 || r.code === 1223) throw new Error('LibreOffice needs your permission to install. Try again and choose Yes.');
      if (r.code !== 0 && r.code !== 3010) throw new Error(`LibreOffice's installer stopped (${r.code}).`);
    },
    done: () => office.hasLibreOffice(),
  },
};

// One set up at a time; asking again while it runs just follows along
let running = null;
async function setUp(which, onProgress) {
  if (!supported()) throw new Error('Set these up from their own websites on this computer.');
  const list = (Array.isArray(which) ? which : [which]).filter((w) => JOBS[w]);
  if (running) return running.promise;
  const work = path.join(app.getPath('userData'), 'extras');
  running = { which: list, cancelled: false };
  const cancelled = () => running && running.cancelled;
  running.promise = (async () => {
    const out = {};
    await fsp.mkdir(work, { recursive: true });
    for (const w of list) {
      const job = JOBS[w];
      if (job.done()) { out[w] = { ok: true }; onProgress({ which: w, step: 'done' }); continue; }
      const file = path.join(work, job.file);
      try {
        onProgress({ which: w, step: 'downloading', fraction: 0 });
        await download(await job.url(), file, (f) => onProgress({ which: w, step: 'downloading', fraction: f }), cancelled);
        onProgress({ which: w, step: 'installing' });
        await job.install(file);
        if (!job.done()) throw new Error(`${job.name} didn't end up installed.`);
        out[w] = { ok: true };
        onProgress({ which: w, step: 'done' });
      } catch (e) {
        out[w] = { error: e.message };
        onProgress({ which: w, step: 'error', message: e.message });
      } finally {
        await fsp.unlink(file).catch(() => {});
      }
    }
    return out;
  })();
  try { return await running.promise; } finally { running = null; await fsp.rm(work, { recursive: true, force: true }).catch(() => {}); }
}

function cancel() { if (running) running.cancelled = true; }

module.exports = { state, setUp, cancel, libreOfficeUrl, newestLibreOffice };
