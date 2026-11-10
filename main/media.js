// Bringing images and videos into a project's media folder.
// Every file gets a new unique name, originals are never modified, and
// files keep their full size and quality. Only a video the board can't play, or an
// iPhone HEIC photo, gets one copy at the highest quality so it can show.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { mediaName, randCode, slug } = require('../shared/names');

const MAX_DOWNLOAD = 2 * 1024 * 1024 * 1024;

// Media names come from board files other people can write. Only plain names
// that stay inside the board's media folder are accepted.
function safeSrc(src) {
  const s = String(src || '');
  return s && s === path.basename(s) && !s.startsWith('.') && !/[\\/:*?"<>|]/.test(s) ? s : null;
}
function inMedia(mediaDir, src) {
  const s = safeSrc(src);
  if (!s) throw new Error("That file isn't part of this board.");
  return path.join(mediaDir, s);
}
const { exists } = require('./fsutil');

const COMPRESS_OVER_BYTES = 500 * 1024 * 1024;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
const CONVERT_IMAGE_EXT = new Set(['heic', 'heif', 'tif', 'tiff']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mts', 'm2ts', '3gp', 'ogv', 'mpg', 'mpeg']);
const PLAYABLE_CONTAINER = new Set(['mp4', 'm4v', 'mov', 'webm']);
const PLAYABLE_CODEC = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p) p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return 'ffmpeg';
}

function extOf(name) {
  return path.extname(name || '').slice(1).toLowerCase();
}

function kindOf(name) {
  const e = extOf(name);
  if (IMAGE_EXT.has(e) || CONVERT_IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  return null;
}

// Anything can go on a board: pictures and videos show as they are, a PDF gets
// its pages, and every other file becomes a card that opens in its own app.
function kindForImport(name) {
  return kindOf(name) || (extOf(name) === 'pdf' ? 'pdf' : 'file');
}

// Files that run something when opened. On a shared board they are only ever
// shown in their folder, never opened straight from the board.
const RUNS_CODE = new Set(['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'jar', 'sh', 'bash', 'zsh', 'command', 'tool', 'app', 'pkg', 'mpkg', 'dmg', 'scpt', 'applescript', 'workflow', 'py', 'pyw', 'rb', 'pl', 'php', 'apk', 'deb', 'rpm', 'run', 'bin', 'elf', 'out', 'xll', 'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'ppam', 'iso', 'img', 'vhd', 'vhdx', 'library-ms', 'settingcontent-ms', 'desktop', 'appimage']);
const runsCode = (name) => RUNS_CODE.has(extOf(name)) || !extOf(name);

// A preview of the first page, made by the computer the way Finder or
// File Explorer makes theirs. Not every computer or file has one.
async function filePreview(file, mediaDir, original, initials) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    const { nativeImage } = require('electron');
    const img = await nativeImage.createThumbnailFromPath(file, { width: 800, height: 800 });
    if (!img || img.isEmpty()) return null;
    const { name, p } = await uniqueMediaPath(mediaDir, original.replace(/\.[^.]*$/, '') + ' preview', initials, 'png');
    const part = path.join(mediaDir, `.${name}.${randCode(5)}.part`);
    await fsp.writeFile(part, img.toPNG());
    await fsp.rename(part, p);
    const sz = img.getSize();
    return { src: name, w: sz.width, h: sz.height };
  } catch (_) {
    return null;
  }
}

// Fast content fingerprint: size plus the first and last megabyte.
async function quickHash(file) {
  const st = await fsp.stat(file);
  const h = crypto.createHash('sha1');
  h.update(String(st.size));
  const fh = await fsp.open(file, 'r');
  try {
    const chunk = Math.min(1024 * 1024, st.size);
    const a = Buffer.alloc(chunk);
    await fh.read(a, 0, chunk, 0);
    h.update(a);
    if (st.size > chunk) {
      const b = Buffer.alloc(chunk);
      await fh.read(b, 0, chunk, st.size - chunk);
      h.update(b);
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex').slice(0, 20);
}

// The main colours of a picture (or a video frame): shrink it, group similar
// colours, and keep the five that cover the most, each clearly different.
function palette(file, time, count = 5) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (time > 0) args.push('-ss', String(time));
    args.push('-i', file, '-frames:v', '1', '-vf', 'scale=96:96:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const px = Buffer.concat(chunks);
      if (px.length < 3) return resolve([]);
      const buckets = new Map();
      for (let i = 0; i + 2 < px.length; i += 3) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += b;
        buckets.set(key, e);
      }
      const all = [...buckets.values()].map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] })).sort((a, b) => b.n - a.n);
      const out = [];
      for (const minD of [60, 40, 24, 0]) {
        for (const e of all) {
          if (out.length >= count) break;
          if (out.includes(e) || out.some((o) => Math.hypot(o.c[0] - e.c[0], o.c[1] - e.c[1], o.c[2] - e.c[2]) < minD)) continue;
          out.push(e);
        }
        if (out.length >= count) break;
      }
      const total = px.length / 3;
      resolve(out.slice(0, count).map((e) => ({ hex: '#' + e.c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase(), share: e.n / total })));
    });
  });
}

// One frame of a video as PNG bytes, for exports
function frameBytes(file, time) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (time > 0) args.push('-ss', String(time));
    args.push('-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1');
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onLine) onLine(s);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.split('\n').slice(-4).join(' ').trim() || 'ffmpeg failed'))));
  });
}

// ffmpeg prints stream details to stderr when given only an input.
async function probeInfo(file) {
  const out = await new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(err));
  });
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  const vid = /Stream #[^\n]*Video:\s*([a-z0-9_]+)/i.exec(out);
  const dim = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(out);
  const rate = /Video:[^\n]*?,\s*([\d.]+)\s*fps/.exec(out) || /Video:[^\n]*?,\s*([\d.]+)\s*tbr/.exec(out);
  return {
    fps: rate ? Math.min(240, Math.max(1, parseFloat(rate[1]))) : 0,
    duration: dur ? +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]) : 0,
    codec: vid ? vid[1].toLowerCase() : null,
    width: dim ? +dim[1] : 0,
    height: dim ? +dim[2] : 0,
  };
}

async function uniqueMediaPath(mediaDir, original, initials, ext) {
  for (let i = 0; i < 20; i++) {
    const name = mediaName(original, initials, ext);
    const p = path.join(mediaDir, name);
    if (!(await exists(p))) return { name, p };
  }
  throw new Error('Could not pick a unique file name.');
}

async function copyAtomic(src, dest) {
  const part = path.join(path.dirname(dest), `.${path.basename(dest)}.${randCode(5)}.part`);
  await fsp.copyFile(src, part);
  await fsp.rename(part, dest);
}

function progressParser(duration, onProgress) {
  return (s) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    if (m && duration > 0 && onProgress) {
      const t = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
      onProgress(Math.max(0, Math.min(1, t / duration)));
    }
  };
}

async function convertVideo(src, dest, mode, info, onProgress) {
  const part = path.join(path.dirname(dest), `.${path.basename(dest)}.${randCode(5)}.part.mp4`);
  const args = ['-hide_banner', '-y', '-i', src];
  if (mode === 'remux') {
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
  } else {
    // Only for videos the board can't play. Visually lossless H.264 at the full
    // resolution and frame rate, so nothing gets smaller or softer.
    args.push(
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '320k'
    );
  }
  args.push('-movflags', '+faststart', part);
  try {
    await run(args, progressParser(info.duration, onProgress));
    await fsp.rename(part, dest);
  } catch (e) {
    try { await fsp.unlink(part); } catch (_) {}
    throw e;
  }
}

// Converts into a hidden temporary file and renames it at the end, so sync never
// sees a half written picture.
async function convertImage(src, dest) {
  const ext = path.extname(dest);
  const part = path.join(path.dirname(dest), `.${path.basename(dest, ext)}.${randCode(5)}.part${ext}`);
  try {
    let done = false;
    // macOS has a built in converter that understands iPhone HEIC photos.
    if (process.platform === 'darwin') {
      try {
        await new Promise((resolve, reject) => {
          const p = spawn('sips', ['-s', 'format', ext === '.png' ? 'png' : 'jpeg', '-s', 'formatOptions', 'best', src, '--out', part]);
          p.on('error', reject);
          p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('sips failed'))));
        });
        done = true;
      } catch (_) {}
    }
    if (!done) {
      try {
        await run(['-hide_banner', '-y', '-i', src, '-frames:v', '1', '-q:v', '1', part]);
      } catch (e) {
        if (/\.hei[cf]$/i.test(src)) throw new Error('HEIC photos open on Mac only. Export it as JPEG first.');
        throw e;
      }
    }
    await fsp.rename(part, dest);
  } catch (e) {
    try { await fsp.unlink(part); } catch (_) {}
    throw e;
  }
}

// Import one file from disk into the project. known: Map(hash -> src) for reuse.
async function importFile(mediaDir, file, me, known, onProgress, asName) {
  const original = asName || path.basename(file);
  const kind = kindForImport(original);
  const st0 = await fsp.stat(file);
  if (!st0.isFile()) return { error: `${original} is a folder. Drop the files inside it instead.` };
  const hash = await quickHash(file);
  const reuse = known && known.has(hash) && safeSrc(known.get(hash));
  if (reuse && (await exists(path.join(mediaDir, reuse))) && kindForImport(reuse) === kind) {
    return { kind, src: reuse, hash, reused: true, original, size: st0.size, ext: extOf(original) };
  }
  // The board's media folder must already exist. Never recreate it: if the board
  // was removed while this import ran, the file has nowhere to go.
  if (!(await exists(mediaDir))) throw new Error('That board was closed before the file finished.');
  const ext = extOf(original);

  if (kind === 'pdf' || kind === 'file') {
    // Kept exactly as it is, with its own extension so it opens in the right app
    const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, ext || 'bin');
    await copyAtomic(file, p);
    const preview = kind === 'file' ? await filePreview(p, mediaDir, original, me.initials) : null;
    return { kind, src: name, hash, original, size: st0.size, ext, preview };
  }

  if (kind === 'image') {
    if (CONVERT_IMAGE_EXT.has(ext)) {
      const outExt = ext === 'tif' || ext === 'tiff' ? 'png' : 'jpg';
      const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, outExt);
      await convertImage(file, p);
      return { kind, src: name, hash, original, converted: true };
    }
    const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, ext);
    await copyAtomic(file, p);
    return { kind, src: name, hash, original };
  }

  // Video
  const st = await fsp.stat(file);
  const info = await probeInfo(file);
  // Big files stay exactly as they are. Only a format the board can't play is changed.
  const codecOk = !info.codec || PLAYABLE_CODEC.has(info.codec);
  const containerOk = PLAYABLE_CONTAINER.has(ext);
  let mode = null;
  if (!codecOk) mode = 'compress';
  else if (!containerOk) mode = 'remux';
  const reason = 'format';

  if (!mode) {
    const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, ext);
    await copyAtomic(file, p);
    return { kind, src: name, hash, original, duration: info.duration, fps: info.fps };
  }
  const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, 'mp4');
  if (onProgress) onProgress(0, mode);
  try {
    await convertVideo(file, p, mode, info, (f) => onProgress && onProgress(f, mode));
  } catch (e) {
    if (mode === 'remux') await convertVideo(file, p, 'compress', info, (f) => onProgress && onProgress(f, 'compress'));
    else throw e;
  }
  return { kind, src: name, hash, original, duration: info.duration, fps: info.fps, reason, originalBytes: st.size };
}

// Images pasted from the clipboard or dragged from a browser arrive as bytes.
async function importBytes(mediaDir, bytes, suggestedName, me, known) {
  const ext = (path.extname(String(suggestedName || '')).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'png').slice(0, 8);
  const tmp = path.join(os.tmpdir(), `eyerefs-${randCode(8)}-${slug(suggestedName || 'pasted')}.${ext}`);
  await fsp.writeFile(tmp, Buffer.from(bytes));
  try {
    return await importFile(mediaDir, tmp, me, known, null, suggestedName ? path.basename(String(suggestedName)) : null);
  } finally {
    try { await fsp.unlink(tmp); } catch (_) {}
  }
}

const TYPE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

// Many sites hand over a smaller preview of a picture. Ask for the full original
// first, and fall back to the link as it was if that doesn't work.
function fullSizeUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (/(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/.test(h)) {
      if (/=[a-z0-9-]+$/i.test(u.pathname)) u.pathname = u.pathname.replace(/=[a-z0-9-]+$/i, '=s0');
      else u.pathname += '=s0';
      for (const k of ['w', 'h', 'sz']) u.searchParams.delete(k);
      return u.toString();
    }
    if (h === 'pbs.twimg.com') { u.searchParams.set('name', 'orig'); return u.toString(); }
    if (h === 'i.pinimg.com') { u.pathname = u.pathname.replace(/^\/\d+x(\d+)?\//, '/originals/'); return u.toString(); }
    if (/(^|\.)images\.unsplash\.com$/.test(h)) { for (const k of ['w', 'h', 'q', 'fit', 'crop', 'auto', 'fm']) u.searchParams.delete(k); return u.toString(); }
  } catch (_) {}
  return url;
}

async function importUrl(mediaDir, url, me, known, fetchImpl) {
  const big = fullSizeUrl(url);
  let res = null;
  if (big !== url) { try { res = await fetchImpl(big); if (!res.ok) res = null; else url = big; } catch (_) { res = null; } }
  if (!res) res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Couldn't download that (${res.status}).`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (type && !/^(image|video)\//.test(type) && type !== 'application/octet-stream') throw new Error("That link isn't an image or video.");
  const size = Number(res.headers.get('content-length') || 0);
  if (size > MAX_DOWNLOAD) throw new Error('That file is too big to download here.');
  let name = (new URL(url).pathname.split('/').pop() || 'download').split('?')[0];
  try { name = decodeURIComponent(name); } catch (_) {}
  if (!kindOf(name)) name = `${slug(name) || 'download'}.${TYPE_EXT[type] || 'png'}`;
  if (!kindOf(name)) throw new Error("That link isn't an image or video.");
  // Stream to a temporary file with a size cap, so a huge link can't fill memory
  const tmp = path.join(os.tmpdir(), `eyerefs-${randCode(8)}-${slug(name)}.${extOf(name)}`);
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_DOWNLOAD) { try { reader.cancel(); } catch (_) {} throw new Error('That file is too big to download here.'); }
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    return await importFile(mediaDir, tmp, me, known, null, name);
  } finally {
    out.destroy();
    try { await fsp.unlink(tmp); } catch (_) {}
  }
}

async function grabFrame(mediaDir, src, time, me) {
  const input = inMedia(mediaDir, src);
  const base = src.replace(/^\d{4}-\d{2}-\d{2}_[A-Z0-9]+_[a-z0-9]{8}_/, '').replace(/\.[^.]+$/, '');
  const { name, p } = await uniqueMediaPath(mediaDir, `${base}-frame`, me.initials, 'jpg');
  const part = path.join(mediaDir, `.${name}.${randCode(5)}.part.jpg`);
  await run(['-hide_banner', '-y', '-ss', String(Math.max(0, time || 0)), '-i', input, '-frames:v', '1', '-q:v', '2', part]);
  await fsp.rename(part, p);
  return { kind: 'image', src: name, hash: await quickHash(p) };
}

module.exports = {
  kindForImport, runsCode, palette, frameBytes, fullSizeUrl, safeSrc, inMedia, importFile, importBytes, importUrl, grabFrame, kindOf, quickHash, probeInfo, COMPRESS_OVER_BYTES, ffmpegPath };
