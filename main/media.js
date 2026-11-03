// Bringing images and videos into a project's media folder.
// Every file gets a new unique name, originals are never modified, and
// videos over 500MB (or in formats the board can't play) get one good quality copy.
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
  return {
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
    // High quality H.264. Resolution kept up to 4K, frame rate unchanged.
    args.push(
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale='if(gt(iw,3840),3840,iw)':-2",
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k'
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
          const p = spawn('sips', ['-s', 'format', ext === '.png' ? 'png' : 'jpeg', src, '--out', part]);
          p.on('error', reject);
          p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('sips failed'))));
        });
        done = true;
      } catch (_) {}
    }
    if (!done) {
      try {
        await run(['-hide_banner', '-y', '-i', src, '-frames:v', '1', '-q:v', '2', part]);
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
  const kind = kindOf(original);
  if (!kind) return { error: `${original} isn't an image or video Eye Refs can open.` };
  const hash = await quickHash(file);
  const reuse = known && known.has(hash) && safeSrc(known.get(hash));
  if (reuse && (await exists(path.join(mediaDir, reuse)))) {
    return { kind, src: reuse, hash, reused: true, original };
  }
  // The board's media folder must already exist. Never recreate it: if the board
  // was removed while this import ran, the file has nowhere to go.
  if (!(await exists(mediaDir))) throw new Error('That board was closed before the file finished.');
  const ext = extOf(original);

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
  const big = st.size > COMPRESS_OVER_BYTES;
  const codecOk = !info.codec || PLAYABLE_CODEC.has(info.codec);
  const containerOk = PLAYABLE_CONTAINER.has(ext);
  let mode = null;
  if (big || !codecOk) mode = 'compress';
  else if (!containerOk) mode = 'remux';
  const reason = big ? 'size' : 'format';

  if (!mode) {
    const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, ext);
    await copyAtomic(file, p);
    return { kind, src: name, hash, original, duration: info.duration };
  }
  const { name, p } = await uniqueMediaPath(mediaDir, original, me.initials, 'mp4');
  if (onProgress) onProgress(0, mode);
  try {
    await convertVideo(file, p, mode, info, (f) => onProgress && onProgress(f, mode));
  } catch (e) {
    if (mode === 'remux') await convertVideo(file, p, 'compress', info, (f) => onProgress && onProgress(f, 'compress'));
    else throw e;
  }
  return { kind, src: name, hash, original, duration: info.duration, reason, originalBytes: st.size };
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

async function importUrl(mediaDir, url, me, known, fetchImpl) {
  const res = await fetchImpl(url);
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

module.exports = { safeSrc, inMedia, importFile, importBytes, importUrl, grabFrame, kindOf, quickHash, probeInfo, COMPRESS_OVER_BYTES, ffmpegPath };
