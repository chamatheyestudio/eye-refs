// Decks and documents, page by page.
//
// A PowerPoint, Word, Excel or Keynote file is turned into a PDF once, with an
// app that's already on this computer, so it can sit on the board and be flipped
// through like any PDF. Videos inside a PowerPoint are taken out as the original
// files, with the spot each one sits on its slide, so they can play right there.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const yauzl = require('yauzl');

const DECKS = new Set(['ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx', 'odp', 'key']);
const DOCS = new Set(['doc', 'docx', 'dot', 'dotx', 'odt', 'rtf', 'xls', 'xlsx', 'ods']);
const extOf = (n) => (path.extname(String(n || '')).slice(1) || '').toLowerCase();
const isOffice = (name) => DECKS.has(extOf(name)) || DOCS.has(extOf(name));

const GET_LIBREOFFICE = 'https://www.libreoffice.org/download/download-libreoffice/';

function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return null;
}

// LibreOffice: free, quiet, and the same on every computer
function soffice() {
  if (process.platform === 'darwin') {
    return firstExisting(['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(os.homedir(), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')]);
  }
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
    return firstExisting(roots.filter(Boolean).map((r) => path.join(r, 'LibreOffice', 'program', 'soffice.exe')));
  }
  return firstExisting(['/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice']);
}
const keynote = () => (process.platform === 'darwin' ? firstExisting(['/Applications/Keynote.app']) : null);
// Microsoft Office on Windows can save a PDF itself, without LibreOffice
function msOffice(ext) {
  if (process.platform !== 'win32') return null;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const exe = DECKS.has(ext) ? 'POWERPNT.EXE' : ['xls', 'xlsx', 'ods'].includes(ext) ? 'EXCEL.EXE' : 'WINWORD.EXE';
  for (const r of roots) for (const v of ['root\\Office16', 'root\\Office15', 'Office16', 'Office15']) {
    const p = path.join(r, 'Microsoft Office', v, exe);
    if (fs.existsSync(p)) return exe;
  }
  return null;
}

// Can this computer turn this kind of file into pages?
function canConvert(name) {
  const ext = extOf(name);
  // Keynote files need Keynote: other apps can't read today's Keynote files properly
  if (ext === 'key') return !!keynote();
  return !!soffice() || !!msOffice(ext);
}

function run(cmd, args, timeoutMs, opts = {}) {
  return new Promise((resolve) => {
    let done = false, err = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...opts });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const t = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ code: -1, err: 'timed out' }); } }, timeoutMs);
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, err: e.message }); } });
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, err }); } });
  });
}

// Turn a deck or document into a PDF in outDir. Returns { pdf } or { missing } or { error }.
async function toPdf(file, outDir, profileDir) {
  const ext = extOf(file);
  await fsp.mkdir(outDir, { recursive: true });
  const want = path.join(outDir, path.basename(file, path.extname(file)) + '.pdf');
  const done = async () => ((await fsp.stat(want).catch(() => null)) ? { pdf: want } : null);

  if (ext === 'key' && !keynote()) return { unsupported: true };
  if (ext === 'key') {
    const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Keynote"
      set d to open POSIX file "${q(file)}"
      export d to POSIX file "${q(want)}" as PDF
      close d saving no
    end tell`;
    await run('/usr/bin/osascript', ['-e', script], 180000);
    return (await done()) || { error: "Keynote couldn't save that one as pages." };
  }
  const lo = soffice();
  if (lo) {
    // Its own settings folder, so it works even while LibreOffice is open for something else
    await fsp.mkdir(profileDir, { recursive: true });
    const r0 = await run(lo, ['--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', `-env:UserInstallation=${pathToFileURL(profileDir).href}`, '--convert-to', 'pdf', '--outdir', outDir, file], 240000);
    const r = await done();
    if (r) return r;
    if (r0.err === 'timed out') return { error: 'That one took too long to turn into pages.' };
  }
  const ms = msOffice(ext);
  if (ms) {
    const ps = (s) => String(s).replace(/'/g, "''");
    const scripts = {
      'POWERPNT.EXE': `$a = New-Object -ComObject PowerPoint.Application; $p = $a.Presentations.Open('${ps(file)}', $true, $false, $false); $p.SaveAs('${ps(want)}', 32); $p.Close(); $a.Quit()`,
      'WINWORD.EXE': `$a = New-Object -ComObject Word.Application; $a.Visible = $false; $d = $a.Documents.Open('${ps(file)}', $false, $true); $d.ExportAsFixedFormat('${ps(want)}', 17); $d.Close($false); $a.Quit()`,
      'EXCEL.EXE': `$a = New-Object -ComObject Excel.Application; $a.Visible = $false; $a.DisplayAlerts = $false; $w = $a.Workbooks.Open('${ps(file)}', 0, $true); $w.ExportAsFixedFormat(0, '${ps(want)}'); $w.Close($false); $a.Quit()`,
    };
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', scripts[ms]], 240000);
    const r = await done();
    if (r) return r;
  }
  if (!lo && !ms) return { missing: true, getUrl: GET_LIBREOFFICE };
  return { error: "Couldn't turn that file into pages." };
}

// ---------- reading inside a deck (a zipped folder) ----------
function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? reject(e) : resolve(z))));
}
async function zipEntries(file) {
  const z = await openZip(file);
  const entries = new Map();
  await new Promise((resolve, reject) => {
    z.on('entry', (e) => { entries.set(e.fileName, e); z.readEntry(); });
    z.on('end', resolve);
    z.on('error', reject);
    z.readEntry();
  });
  const read = (name, limit = 64 * 1024 * 1024) => new Promise((resolve, reject) => {
    const e = entries.get(name);
    if (!e) return resolve(null);
    if (e.uncompressedSize > limit) return resolve(null);
    z.openReadStream(e, (err, s) => {
      if (err) return reject(err);
      const parts = [];
      s.on('data', (d) => parts.push(d));
      s.on('end', () => resolve(Buffer.concat(parts)));
      s.on('error', reject);
    });
  });
  const save = (name, to, limit = 4 * 1024 * 1024 * 1024) => new Promise((resolve, reject) => {
    const e = entries.get(name);
    if (!e || e.uncompressedSize > limit) return resolve(false);
    z.openReadStream(e, (err, s) => {
      if (err) return reject(err);
      const w = fs.createWriteStream(to);
      s.pipe(w);
      w.on('finish', () => resolve(true));
      w.on('error', reject);
      s.on('error', reject);
    });
  });
  return { entries, read, save, close: () => { try { z.close(); } catch (_) {} } };
}

// Resolve "../media/x.mp4" against "ppt/slides/slide1.xml"
function resolvePart(from, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = path.posix.dirname(from).split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
function relsOf(xml, from) {
  const out = new Map();
  if (!xml) return out;
  for (const m of xml.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = m[1];
    const id = /\bId="([^"]+)"/.exec(a), t = /\bTarget="([^"]+)"/.exec(a), mode = /\bTargetMode="([^"]+)"/.exec(a);
    if (id && t) out.set(id[1], { target: resolvePart(from, decodeURIComponent(t[1])), external: !!(mode && mode[1] === 'External') });
  }
  return out;
}
const num = (a, k) => { const m = new RegExp(`\\b${k}="(-?\\d+)"`).exec(a); return m ? Number(m[1]) : 0; };

// Every video in a PowerPoint: which slide, and where on it (as parts of the slide)
async function deckVideos(file) {
  if (extOf(file) !== 'pptx' && extOf(file) !== 'ppsx' && extOf(file) !== 'potx') return [];
  const z = await zipEntries(file);
  try {
    const pres = (await z.read('ppt/presentation.xml') || '').toString('utf8');
    const sz = /<p:sldSz\b([^>]*)\/?>/.exec(pres);
    const W = sz ? num(sz[1], 'cx') : 12192000, H = sz ? num(sz[1], 'cy') : 6858000;
    const prels = relsOf(await z.read('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
    const order = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => prels.get(m[1])).filter(Boolean).map((r) => r.target);
    const out = [];
    for (let i = 0; i < order.length; i++) {
      const part = order[i];
      const xml = (await z.read(part) || '').toString('utf8');
      const rels = relsOf(await z.read(resolvePart(part, `_rels/${path.posix.basename(part)}.rels`)), part);
      // Walk the shapes, keeping track of groups, which move and scale what's inside them
      const stack = [{ ox: 0, oy: 0, cx: 0, cy: 0, sx: 1, sy: 1 }];
      const tf = () => stack[stack.length - 1];
      let pic = null, grp = null, inSpPr = false, inGrpSpPr = false, xf = null;
      const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>/g;
      let m;
      while ((m = re.exec(xml))) {
        const [, close, tag, attrs, self] = m;
        if (!close) {
          if (tag === 'p:grpSp') grp = { off: null, ext: null, choff: null, chext: null };
          else if (tag === 'p:grpSpPr') inGrpSpPr = true;
          else if (tag === 'p:pic') pic = { media: null, link: null, off: null, ext: null };
          else if (tag === 'p:spPr' && pic) inSpPr = true;
          else if (tag === 'a:xfrm') xf = true;
          else if (xf && tag === 'a:off') { const v = { x: num(attrs, 'x'), y: num(attrs, 'y') }; if (pic && inSpPr) pic.off = v; else if (grp && inGrpSpPr) grp.off = v; }
          else if (xf && tag === 'a:ext') { const v = { x: num(attrs, 'cx'), y: num(attrs, 'cy') }; if (pic && inSpPr) pic.ext = v; else if (grp && inGrpSpPr) grp.ext = v; }
          else if (xf && tag === 'a:chOff' && grp && inGrpSpPr) grp.choff = { x: num(attrs, 'x'), y: num(attrs, 'y') };
          else if (xf && tag === 'a:chExt' && grp && inGrpSpPr) grp.chext = { x: num(attrs, 'cx'), y: num(attrs, 'cy') };
          else if (pic && tag === 'p14:media') { const r = /\br:embed="([^"]+)"/.exec(attrs); if (r) pic.media = r[1]; }
          else if (pic && tag === 'a:videoFile') { const r = /\br:link="([^"]+)"/.exec(attrs); if (r) pic.link = r[1]; }
        }
        if (close || self) {
          if (tag === 'a:xfrm') xf = null;
          else if (tag === 'p:spPr') inSpPr = false;
          else if (tag === 'p:grpSpPr') {
            inGrpSpPr = false;
            if (grp && grp.off && grp.ext && grp.choff && grp.chext) {
              const p = tf();
              const sx = grp.chext.x ? grp.ext.x / grp.chext.x : 1, sy = grp.chext.y ? grp.ext.y / grp.chext.y : 1;
              stack.push({ ox: p.ox + p.sx * (grp.off.x - grp.choff.x * sx), oy: p.oy + p.sy * (grp.off.y - grp.choff.y * sy), sx: p.sx * sx, sy: p.sy * sy });
              grp.pushed = true;
            }
            grp = grp && { ...grp, open: true };
          } else if (tag === 'p:grpSp') { if (stack.length > 1) stack.pop(); grp = null; }
          else if (tag === 'p:pic' && pic) {
            const rel = (pic.media && rels.get(pic.media)) || (pic.link && rels.get(pic.link));
            if (rel && !rel.external && z.entries.has(rel.target) && pic.off && pic.ext) {
              const t = tf();
              const x = t.ox + pic.off.x * t.sx, y = t.oy + pic.off.y * t.sy;
              out.push({ page: i + 1, part: rel.target, x: x / W, y: y / H, w: (pic.ext.x * t.sx) / W, h: (pic.ext.y * t.sy) / H });
            }
            pic = null;
          }
        }
      }
    }
    return out;
  } finally { z.close(); }
}

const MEDIA_DIRS = ['ppt/media/', 'word/media/', 'xl/media/', 'Data/', 'media/'];
const PICTURE_OR_VIDEO = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg|mp4|m4v|mov|webm|avi|wmv|mkv|mpe?g)$/i;

// Every picture and video inside a deck or document, in slide order when known
async function innerMedia(file) {
  const z = await zipEntries(file).catch(() => null);
  if (!z) return [];
  try {
    const all = [...z.entries.keys()].filter((n) => MEDIA_DIRS.some((d) => n.startsWith(d)) && PICTURE_OR_VIDEO.test(n) && !/thumbnail|preview|\/(st-|mt-)/i.test(n));
    // Which slide uses each file first
    const firstPage = new Map();
    const covers = new Set();
    const pres = await z.read('ppt/presentation.xml');
    if (pres) {
      const prels = relsOf(await z.read('ppt/_rels/presentation.xml.rels'), 'ppt/presentation.xml');
      const order = [...pres.toString('utf8').matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => prels.get(m[1])).filter(Boolean).map((r) => r.target);
      for (let i = 0; i < order.length; i++) {
        const rels = relsOf(await z.read(resolvePart(order[i], `_rels/${path.posix.basename(order[i])}.rels`)), order[i]);
        for (const r of rels.values()) if (!r.external && !firstPage.has(r.target)) firstPage.set(r.target, i + 1);
        // A video's still frame is only its cover, not a picture of its own
        const xml = ((await z.read(order[i])) || '').toString('utf8');
        for (const pm of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
          if (!/videoFile|p14:media/.test(pm[0])) continue;
          const b = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(pm[0]);
          if (b && rels.get(b[1])) covers.add(rels.get(b[1]).target);
        }
      }
    }
    // Skip tiny bits like bullets and icons
    const keep = all.filter((n) => !covers.has(n) && (z.entries.get(n).uncompressedSize > 12 * 1024 || /\.(mp4|m4v|mov|webm|avi|wmv|mkv|mpe?g)$/i.test(n)));
    keep.sort((a, b) => (firstPage.get(a) || 1e9) - (firstPage.get(b) || 1e9) || a.localeCompare(b, undefined, { numeric: true }));
    return keep.map((n) => ({ part: n, page: firstPage.get(n) || null, save: (to) => z.save(n, to) })).concat([{ close: z.close }]);
  } catch (e) { z.close(); throw e; }
}

// Take one file out of a deck into a folder
async function extract(file, part, toDir) {
  const z = await zipEntries(file);
  try {
    await fsp.mkdir(toDir, { recursive: true });
    const to = path.join(toDir, path.posix.basename(part).replace(/[^\w.\- ]/g, '_'));
    return (await z.save(part, to)) ? to : null;
  } finally { z.close(); }
}

module.exports = { hasLibreOffice: () => !!soffice(), isOffice, canConvert, toPdf, deckVideos, innerMedia, extract, GET_LIBREOFFICE, DECKS, DOCS, extOf };
