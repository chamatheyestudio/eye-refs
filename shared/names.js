// Safe, unique file and folder names that work on both Mac and Windows.

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/g;

function cleanPart(s, max) {
  let out = String(s || '').normalize('NFC').replace(FORBIDDEN, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[. ]+/g, ''); // a leading dot hides the folder
  out = out.replace(/[. ]+$/g, ''); // Windows drops trailing dots and spaces
  if ([...out].length > max) out = [...out].slice(0, max).join('').replace(/[. ]+$/g, ''); // never split an emoji
  if (!out) return 'Untitled';
  if (WIN_RESERVED.test(out)) out += '_';
  return out;
}

// Folder or project names people see, e.g. "Spring Campaign".
function cleanFolderName(name) {
  return cleanPart(name, 60);
}

// Short slug for media file names, e.g. "lantern-reel".
function slug(name) {
  const base = String(name || '').normalize('NFC').replace(/\.[^.]+$/, '');
  let s = base.toLowerCase().replace(FORBIDDEN, ' ').replace(/[\s_.]+/g, '-').replace(/-+/g, '-');
  s = s.replace(/^-|-$/g, '');
  if (s.length > 40) s = s.slice(0, 40).replace(/-$/, '');
  if (!s || WIN_RESERVED.test(s)) s = 'file';
  return s;
}

const crypto = require('crypto');

function randCode(n = 4) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 characters, no look-alikes
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += a[bytes[i] & 31];
  return s;
}

function today(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 2026-11-02_CH_k7f3xa9p_lantern-reel.mp4
function mediaName(originalName, initials, ext, date) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const ini = String(initials || 'XX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'XX';
  return `${today(date)}_${ini}_${randCode(8)}_${slug(originalName)}.${e}`;
}

function initialsFrom(name, email) {
  const src = (name || String(email || '').split('@')[0] || '').replace(/[._-]+/g, ' ').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || 'XX').slice(0, 2).toUpperCase();
}

function firstNameFrom(email) {
  const local = String(email || '').split('@')[0] || '';
  const first = local.split(/[._-]+/)[0] || local;
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : 'Someone';
}

module.exports = { cleanFolderName, slug, mediaName, randCode, initialsFrom, firstNameFrom, today };
