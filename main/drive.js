// Finds the Google Drive for desktop folder on this computer.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exists, listDir } = require('./fsutil');

const DOMAIN = 'eyestudio.ae';

function isStudioEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith('@' + DOMAIN);
}

// The "My Drive" folder name can be translated, so fall back to the first real folder.
async function myDriveIn(accountRoot) {
  const preferred = path.join(accountRoot, 'My Drive');
  if (await exists(preferred)) return preferred;
  const entries = await listDir(accountRoot);
  const skip = new Set(['Shared drives', 'Other computers', '.shortcut-targets-by-id', '.Encrypted', '.file-revisions-by-id']);
  for (const e of entries) {
    if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) return path.join(accountRoot, e.name);
  }
  return null;
}

// Returns [{ email|null, myDrive }]
async function findDriveAccounts() {
  const found = [];
  if (process.platform === 'darwin') {
    const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
    for (const e of await listDir(cloud)) {
      if (!e.name.startsWith('GoogleDrive-')) continue;
      const email = e.name.slice('GoogleDrive-'.length);
      const md = await myDriveIn(path.join(cloud, e.name));
      if (md) found.push({ email, myDrive: md });
    }
    // Older Drive for desktop versions mounted a volume
    const vol = '/Volumes/GoogleDrive';
    if (!found.length && (await exists(vol))) {
      const md = await myDriveIn(vol);
      if (md) found.push({ email: null, myDrive: md });
    }
  } else if (process.platform === 'win32') {
    for (let c = 68; c <= 90; c++) { // D: to Z:
      const root = String.fromCharCode(c) + ':\\';
      const md = path.join(root, 'My Drive');
      if (await exists(md)) found.push({ email: null, myDrive: md });
    }
  } else {
    // Linux has no Drive for desktop. Used for development only.
    const dev = process.env.EYEREFS_DRIVE;
    if (dev && (await exists(dev))) found.push({ email: process.env.EYEREFS_EMAIL || null, myDrive: dev });
  }
  if (process.env.EYEREFS_DRIVE && process.platform !== 'linux') {
    found.unshift({ email: process.env.EYEREFS_EMAIL || null, myDrive: process.env.EYEREFS_DRIVE });
  }
  return found;
}

// Drive for desktop on Mac tags every synced item with its Drive ID.
// With it we can open the exact folder on drive.google.com to share it.
function driveIdOf(p) {
  if (process.platform !== 'darwin') return null;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('xattr', ['-p', 'com.google.drivefs.item-id#S', p], { encoding: 'utf8', timeout: 3000 });
    const id = out.trim();
    return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}

module.exports = { DOMAIN, isStudioEmail, findDriveAccounts, driveIdOf };
