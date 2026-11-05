// Videos and pictures from social links, brought in through Pluck.
//
// Pluck (Matte Black's downloader) runs a small engine on this computer at
// 127.0.0.1:47821. Eye Refs asks it to fetch a link into a private folder, then
// adds what comes back to the board like any other file. If Pluck is installed
// but closed, Eye Refs starts it quietly in the background.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { app, net } = require('electron');

const BASE = 'http://127.0.0.1:47821';
const RELEASES = 'https://github.com/chamatheyestudio/pluck/releases/latest';
// The installer for this computer, straight from Pluck's latest release
const GET_PLUCK = process.platform === 'darwin' ? `${RELEASES}/download/Pluck.dmg`
  : process.platform === 'win32' ? `${RELEASES}/download/Pluck-Setup.exe` : RELEASES;

// Links Pluck knows how to fetch (pages, not direct picture files)
const SOCIAL = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|fb\.watch|vimeo\.com|reddit\.com|redd\.it|pinterest\.[a-z.]+|pin\.it|threads\.net|threads\.com|linkedin\.com|snapchat\.com|twitch\.tv|dailymotion\.com|dai\.ly|tumblr\.com|bsky\.app|imgur\.com|flickr\.com)\/\S*$/i;
const isSocial = (u) => SOCIAL.test(String(u || '').trim());

class Friendly extends Error {}

async function call(p, body, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await net.fetch(BASE + p, body === undefined
      ? { signal: ctrl.signal, cache: 'no-store' }
      : { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', 'x-pluck': '1' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Friendly(data.error || "Pluck couldn't get that one.");
    return data;
  } finally { clearTimeout(t); }
}

async function running() {
  try { await call('/api/state', undefined, 2500); return true; } catch (_) { return false; }
}

function where() {
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Pluck.app', path.join(app.getPath('home'), 'Applications', 'Pluck.app'), path.join(app.getPath('home'), 'Downloads', 'Pluck.app')]) if (fs.existsSync(p)) return { mac: p };
    return null;
  }
  if (process.platform === 'win32') {
    const root = path.join(process.env.LOCALAPPDATA || '', 'Pluck');
    const engine = path.join(root, 'bin', 'engine.exe');
    if (fs.existsSync(engine)) return { exe: engine };
    const exe = path.join(root, 'Pluck.exe');
    if (fs.existsSync(exe)) return { exe };
  }
  return null;
}

// Make sure Pluck's engine is answering, starting it out of sight if needed
async function ensure(onStatus) {
  if (await running()) return true;
  const w = where();
  if (!w) return false;
  onStatus && onStatus('Starting Pluck');
  // Only Pluck's engine, in the background: no window, nothing in the way.
  // It closes itself again a little while after the last download.
  const env = { ...process.env, PLUCK_NO_WINDOW: '1' };
  try {
    if (w.mac) {
      const sh = path.join(w.mac, 'Contents', 'Resources', 'launch.sh');
      if (fs.existsSync(sh)) spawn('/bin/bash', [sh], { detached: true, stdio: 'ignore', env }).unref();
      else spawn('open', ['-g', '-j', w.mac], { detached: true, stdio: 'ignore' }).unref();
    } else spawn(w.exe, [], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
  } catch (_) { return false; }
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await running()) return true;
  }
  throw new Friendly("Pluck didn't start. Open Pluck once, then try the link again.");
}

// The board page only shows local pictures, so the preview comes over as data
async function thumbData(u) {
  if (!/^https:\/\//.test(String(u || ''))) return '';
  try {
    const res = await net.fetch(u, { headers: { Accept: 'image/*' } });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.startsWith('image/')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return '';
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch (_) { return ''; }
}

const jobs = new Map(); // token -> { id, dir, canceled }

// Fetch a link. onProgress gets { phase, pct, title, thumb, platform }.
async function fetchLink(url, onProgress) {
  const token = Math.random().toString(36).slice(2, 10);
  const job = { id: null, dir: path.join(app.getPath('temp'), 'eye-refs-pluck', token), canceled: false };
  jobs.set(token, job);
  const tell = (o) => { try { onProgress && onProgress({ token, ...o }); } catch (_) {} };
  try {
    tell({ phase: 'Looking at the link', pct: 0 });
    const ok = await ensure((phase) => tell({ phase, pct: 0 }));
    if (!ok) return { token, missing: true, getUrl: GET_PLUCK };
    const info = await call('/api/probe', { url }, 120000);
    if (job.canceled) return { token, canceled: true };
    if (info.kind === 'music' || info.kind === 'audio') throw new Friendly("That's a music link. Eye Refs brings in videos and pictures.");
    const base = { title: info.title || '', thumb: await thumbData(info.thumb), platform: info.platform ? info.platform.name : '' };
    tell({ ...base, phase: 'Getting it', pct: 0 });
    await fsp.mkdir(job.dir, { recursive: true });
    // A post with several pieces keeps every picture and video as it is
    const mode = info.kind === 'gallery' ? 'orig' : 'video';
    const started = await call('/api/download', { url, mode, quality: 'best', dir: job.dir }, 60000);
    job.id = started.id;
    const until = Date.now() + 45 * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 700));
      if (job.canceled) { call('/api/cancel', { id: job.id }).catch(() => {}); return { token, canceled: true }; }
      let st;
      try { st = await call('/api/state', undefined, 5000); } catch (_) { continue; }
      const j = (st.jobs || []).find((x) => x.id === job.id);
      if (!j) continue;
      if (j.status === 'done') {
        // Only files Pluck put in the folder made for this job, nothing else on the computer
        const root = await fsp.realpath(job.dir).catch(() => job.dir);
        const files = [];
        for (const f of j.files || []) {
          const real = await fsp.realpath(String(f || '')).catch(() => null);
          if (real && (real + '').startsWith(root + path.sep)) files.push(real);
        }
        if (!files.length) throw new Friendly('Pluck finished but nothing came back.');
        tell({ ...base, phase: 'Adding to the board', pct: 100 });
        return { token, files, ...base };
      }
      if (j.status === 'error') throw new Friendly(j.error || "Pluck couldn't get that one.");
      if (j.status === 'canceled') return { token, canceled: true };
      tell({ ...base, phase: j.status === 'queued' ? 'Waiting its turn' : 'Getting it', pct: j.pct || 0, item: j.item, items: j.items });
    }
    throw new Friendly('That took too long. Try the link again.');
  } catch (e) {
    return { token, error: e instanceof Friendly ? e.message : "Couldn't reach Pluck. Try again in a moment." };
  }
}

function cancel(token) {
  const j = jobs.get(token);
  if (!j) return;
  j.canceled = true;
  if (j.id) call('/api/cancel', { id: j.id }).catch(() => {});
}

// The files were copied onto the board, so the private folder can go
async function cleanup(token) {
  const j = jobs.get(token);
  jobs.delete(token);
  if (j) await fsp.rm(j.dir, { recursive: true, force: true }).catch(() => {});
}

// Is Pluck on this computer (installed, not necessarily running)?
const installed = () => !!where();

module.exports = { isSocial, fetchLink, cancel, cleanup, installed, GET_PLUCK, SOCIAL };
