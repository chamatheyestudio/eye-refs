/**
 * Eye Refs server. Runs as an Apps Script web app inside the EyeStudio Google account
 * and keeps every shared board in that account's Google Drive:
 *
 *   My Drive / Eye Refs / Hutong / Spring Campaign / media / ...
 *                                                    changes / ...
 *
 * Deploy: Execute as "Me", Who has access "Anyone". See SETUP.md.
 * By Matte Black.
 */

var CFG = {
  ROOT: 'Eye Refs',
  TEAM_FILE: '.eyerefs-team.json',
  TEAM_DOMAIN: 'eyestudio.ae',     // these emails can create shared boards
  ADMINS: ['chamath@eyestudio.ae'], // manage clients and every shared board
  TOKEN_DAYS: 90,                   // a token works this long after it was issued
  SIGNIN_MAX_DAYS: 365,             // refreshed tokens stop working this long after the code sign in
  CODE_MINUTES: 10,
  PRESENCE_SECONDS: 150,
  MAX_CHUNK: 10 * 1024 * 1024,
  CACHE_MAX: 90000,                 // CacheService refuses values over 100KB
  MAX_INVITE: 50,                   // emails per invite
  MAX_MEMBERS: 100,                 // people per board
  MAX_REQUESTS: 50,                 // waiting join requests per board
  MAX_NOTIFIED: 200,                // remembered join requesters per board
  MAIL_PER_DAY: 300,                // sign in emails per day, everyone together
  MAIL_RESERVE: 50,                 // stop sending codes when the Google quota is this low
  VERIFY_FAILS_PER_DAY: 10,         // wrong codes per email per day
  JOIN_PER_HOUR: 20,                // join code tries per person per hour
  JOIN_GLOBAL_PER_HOUR: 500,        // join code tries per hour, everyone together
  MAX_CHANGE_FILE: 2 * 1024 * 1024, // one device's change file
  MAX_CHANGE_JSON: 3 * 1024 * 1024, // the same file once escaped inside a reply
  PULL_BUDGET: 4 * 1024 * 1024,     // change file data per sync.pull reply
  MAX_DEVICES: 6,                   // computers per person per board
  MAX_FILE: 2 * 1024 * 1024 * 1024, // one media file
  MAX_BOARD: 20 * 1024 * 1024 * 1024, // media per board
  MAX_PENDING_UPLOADS: 30,          // uploads in progress per board
  UPLOAD_HOURS: 6,                  // an upload session lives this long
};

var GENERIC_ERROR = 'Something went wrong on the server. Try again.';

// ---------------------------------------------------------------- entry points

function doGet(e) {
  // ?v=<key> opens the board in the browser, view only, for anyone with the link
  var key = e && e.parameter && e.parameter.v;
  if (key) return viewerPage_(String(key));
  return json_({ ok: true, data: { app: 'Eye Refs', api: 2 } });
}

function doPost(e) {
  var out, req = null;
  try {
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (x) {
      throw userError_('Unknown request.');
    }
    var fn = req && typeof req.action === 'string' && API.hasOwnProperty(req.action) ? API[req.action] : null;
    if (!fn) throw userError_('Unknown request.');
    out = { ok: true, data: fn(req) };
  } catch (x) {
    if (x && x.userMessage) {
      out = { ok: false, error: x.userMessage };
    } else {
      console.error('Eye Refs ' + (req && req.action) + ' failed: ' + ((x && x.stack) || x));
      out = { ok: false, error: GENERIC_ERROR };
    }
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(msg) {
  var e = new Error(msg);
  e.userMessage = msg;
  return e;
}

// ---------------------------------------------------------------- small helpers

function day_() {
  return new Date().toISOString().slice(0, 10);
}

function hour_() {
  return new Date().toISOString().slice(0, 13);
}

// Never let one big value break a request: CacheService throws over 100KB.
function cachePut_(key, value, seconds) {
  var s = String(value);
  var cache = CacheService.getScriptCache();
  if (s.length > CFG.CACHE_MAX) {
    try { cache.remove(key); } catch (x) {}
    return false;
  }
  try {
    cache.put(key, s, seconds);
    return true;
  } catch (x) {
    try { cache.remove(key); } catch (y) {}
    return false;
  }
}

function cacheGet_(key) {
  try { return CacheService.getScriptCache().get(key); } catch (x) { return null; }
}

// A counter in the cache that resets with its key; not exact under heavy load, good enough for limits.
function bump_(key, seconds) {
  var n = Number(cacheGet_(key) || 0) + 1;
  cachePut_(key, String(n), seconds);
  return n;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function randomBytes_(n) {
  var out = [];
  while (out.length < n) {
    // Bytes 0-5 and 10-15 of a v4 uuid are fully random
    var hex = Utilities.getUuid().replace(/-/g, '');
    var idx = [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15];
    for (var i = 0; i < idx.length && out.length < n; i++) out.push(parseInt(hex.substr(idx[i] * 2, 2), 16));
  }
  return out;
}

// ---------------------------------------------------------------- identity

function ownerEmail_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function secret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SECRET', s);
  }
  return s;
}

function b64url_(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '');
}

function sign_(payload) {
  return b64url_(Utilities.computeHmacSha256Signature(payload, secret_()));
}

function tokenVersion_(email) {
  return Number(PropertiesService.getScriptProperties().getProperty('tv:' + email) || 0);
}

// since: when this person last signed in with an emailed code
function makeToken_(email, name, since) {
  var now = Date.now();
  var payload = b64url_(JSON.stringify({ e: email, n: name || '', t: now, s: since || now, v: tokenVersion_(email) }));
  return payload + '.' + sign_(payload);
}

function readToken_(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) throw userError_('Please sign in again.');
  var parts = token.split('.');
  if (sign_(parts[0]) !== parts[1]) throw userError_('Please sign in again.');
  var data;
  try {
    var padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
  } catch (x) {
    throw userError_('Please sign in again.');
  }
  if (!data || !data.e) throw userError_('Please sign in again.');
  var email = String(data.e).toLowerCase();
  var now = Date.now();
  var since = Number(data.s || data.t) || 0;
  if (now - data.t > CFG.TOKEN_DAYS * 86400000 || now - since > CFG.SIGNIN_MAX_DAYS * 86400000) {
    throw userError_('Your sign in has expired. Please sign in again.');
  }
  if ((Number(data.v) || 0) < tokenVersion_(email)) throw userError_('Please sign in again.');
  return { email: email, name: data.n || firstName_(data.e), since: since };
}

function firstName_(email) {
  var local = String(email).split('@')[0].split(/[._-]+/)[0] || 'Someone';
  return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
}

function validEmail_(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 200;
}

function isTeam_(email) {
  return email === ownerEmail_() || email.slice(-(CFG.TEAM_DOMAIN.length + 1)) === '@' + CFG.TEAM_DOMAIN;
}

function isAdmin_(email, team) {
  return email === ownerEmail_() || CFG.ADMINS.indexOf(email) >= 0 || (team.admins || []).indexOf(email) >= 0;
}

// Only people EyeStudio knows get a sign in email.
function mayGetCode_(email, team) {
  if (isTeam_(email) || isAdmin_(email, team)) return true;
  for (var id in team.projects) {
    var p = team.projects[id];
    if (p.owner === email || (p.members && p.members[email]) || (p.requests && p.requests[email])) return true;
  }
  return false;
}

// The device file name must start with the signed in person's email name.
function deviceOk_(device, email) {
  if (typeof device !== 'string' || !/^[a-z0-9-]{3,60}$/.test(device)) return false;
  var local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return device.indexOf(local + '-') === 0;
}

var WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeName_(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}$/.test(name) &&
    !WIN_RESERVED.test(name) && !/[. ]$/.test(name);
}

// ---------------------------------------------------------------- Drive helpers

function child_(parent, name, create) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return create ? parent.createFolder(name) : null;
}

function rootFolder_() {
  return child_(DriveApp.getRootFolder(), CFG.ROOT, true);
}

function fileIn_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function cleanFolderName_(s) {
  s = String(s || '').replace(/[<>:"\/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return s.slice(0, 60) || 'Untitled';
}

function boardFolder_(p) {
  var dir = null;
  try {
    dir = DriveApp.getFolderById(p.folderId);
    if (dir && dir.isTrashed && dir.isTrashed()) dir = null;
  } catch (x) {
    dir = null;
  }
  if (!dir) throw userError_("This board's folder is missing from the EyeStudio Drive. Ask the board owner to share it again.");
  return dir;
}

function folders_(p) {
  var dir = boardFolder_(p);
  return { dir: dir, media: child_(dir, 'media', true), changes: child_(dir, 'changes', true) };
}

function sumMedia_(folder) {
  var total = 0;
  var it = folder.getFiles();
  while (it.hasNext()) total += it.next().getSize();
  return total;
}

// ---------------------------------------------------------------- team data
//
// The team file carries a version number (team.v) that goes up on every write.
// The cache holds the newest version only: 'teamv' remembers the latest version
// written, and nobody puts an older team over it.

function readTeamFile_() {
  var f = fileIn_(rootFolder_(), CFG.TEAM_FILE);
  var team = f ? JSON.parse(f.getBlob().getDataAsString()) : null;
  if (!team) team = { clients: [], admins: [], projects: {}, v: 0 };
  team.projects = team.projects || {};
  team.v = Number(team.v) || 0;
  return team;
}

function cacheTeam_(team, txt) {
  var latest = Number(cacheGet_('teamv') || 0);
  if (team.v < latest) return;
  if (team.v > latest) cachePut_('teamv', String(team.v), 21600);
  cachePut_('team', txt || JSON.stringify(team), 300);
}

function readTeam_() {
  var hit = cacheGet_('team');
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      var latest = Number(cacheGet_('teamv') || 0);
      if (cached && cached.projects && (Number(cached.v) || 0) >= latest) return cached;
    } catch (x) {}
  }
  var team = readTeamFile_();
  cacheTeam_(team);
  return team;
}

function writeTeam_(team) {
  team.v = (Number(team.v) || 0) + 1;
  var root = rootFolder_();
  var f = fileIn_(root, CFG.TEAM_FILE);
  var txt = JSON.stringify(team);
  if (f) f.setContent(txt); else root.createFile(CFG.TEAM_FILE, txt, 'application/json');
  cachePut_('teamv', String(team.v), 21600);
  cachePut_('team', txt, 300); // too big: the old copy is removed and readers go to Drive
}

// Read, change and write the team file under a lock so two requests never clash.
function withTeam_(fn) {
  return withLock_(function () {
    var team = readTeamFile_();
    var result = fn(team);
    writeTeam_(team);
    return result;
  });
}

function project_(team, id) {
  var p = typeof id === 'string' && team.projects.hasOwnProperty(id) ? team.projects[id] : null;
  if (!p) throw userError_('That board is no longer shared.');
  return p;
}

function roleOf_(p, email, team) {
  if (p.owner === email) return 'owner';
  if (isAdmin_(email, team)) return 'admin';
  if (p.members && p.members.hasOwnProperty(email)) return 'member';
  return null;
}

function requireRole_(p, email, team, roles) {
  var r = roleOf_(p, email, team);
  if (!r || roles.indexOf(r) < 0) throw userError_(r ? 'Only the owner of this board can do that.' : "You don't have access to this board.");
  return r;
}

var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, no 0/O or 1/I

function joinCode_(team) {
  for (;;) {
    var bytes = randomBytes_(8), s = '';
    for (var i = 0; i < 8; i++) s += CODE_ALPHABET.charAt(bytes[i] & 31);
    var used = false;
    for (var id in (team && team.projects) || {}) if (team.projects[id].code === s) used = true;
    if (!used) return s;
  }
}

function countKeys_(o) {
  return Object.keys(o || {}).length;
}

function projectSummary_(p, email, team) {
  var role = roleOf_(p, email, team);
  var manage = role === 'owner' || role === 'admin';
  return {
    id: p.id, name: p.name, client: p.client, owner: p.owner, ownerName: p.ownerName || firstName_(p.owner),
    role: role, members: countKeys_(p.members),
    requests: manage ? countKeys_(p.requests) : 0,
    code: manage ? p.code : null, created: p.created,
    viewKey: manage ? (p.viewKey || null) : null,
  };
}

function notify_(to, subject, body) {
  try {
    if (MailApp.getRemainingDailyQuota() < CFG.MAIL_RESERVE) return; // keep the rest for sign in codes
    MailApp.sendEmail({ to: to, subject: subject, body: body + '\n\nEye Refs by Matte Black', name: 'Eye Refs' });
  } catch (x) {
    console.error('Eye Refs email failed: ' + x);
  }
}

// Once a day, forget yesterday's wrong code counts.
function pruneDaily_(day) {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    for (var k in all) {
      if (k.indexOf('vf:') !== 0) continue;
      var rec = null;
      try { rec = JSON.parse(all[k]); } catch (x) {}
      if (!rec || rec.d !== day) props.deleteProperty(k);
    }
  } catch (x) {
    console.error('Eye Refs prune failed: ' + x);
  }
}

// Join code guesses: limited per person and for everyone together.
function joinRate_(email) {
  var slow = 'Too many tries with join codes. Try again in an hour.';
  var hour = hour_();
  if (bump_('jr:' + hour + ':' + email, 3700) > CFG.JOIN_PER_HOUR) throw userError_(slow);
  if (bump_('jrg:' + hour, 3700) > CFG.JOIN_GLOBAL_PER_HOUR) throw userError_(slow);
}

function cleanCode_(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function boardByCode_(team, code) {
  if (code.length < 6) return null;
  for (var id in team.projects) if (team.projects[id].code === code) return id;
  return null;
}

// ---------------------------------------------------------------- API

var API = {};

API['auth.request'] = function (req) {
  var email = String(req.email || '').trim().toLowerCase();
  if (!validEmail_(email)) throw userError_('Enter a valid email address.');
  var team = readTeam_();
  if (!mayGetCode_(email, team)) {
    // Someone new with a board's join code may sign in, so they can then ask to join it
    if (!req.joinCode) throw userError_('Ask an EyeStudio teammate to invite you first.');
    joinRate_(email);
    if (!boardByCode_(team, cleanCode_(req.joinCode))) throw userError_('No board uses that code. Check it with whoever shared it.');
  }
  var tries = Number(cacheGet_('rl:' + email) || 0);
  if (tries >= 5) throw userError_('Too many codes requested. Try again in 10 minutes.');
  cachePut_('rl:' + email, String(tries + 1), 600);
  if (MailApp.getRemainingDailyQuota() < CFG.MAIL_RESERVE) throw userError_("Eye Refs can't send more sign in emails today. Try again tomorrow.");
  withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var today = day_();
    var rec = null;
    try { rec = JSON.parse(props.getProperty('MAILDAY') || 'null'); } catch (x) {}
    if (!rec || rec.d !== today) { rec = { d: today, n: 0 }; pruneDaily_(today); }
    if (rec.n >= CFG.MAIL_PER_DAY) throw userError_("Eye Refs can't send more sign in emails today. Try again tomorrow.");
    rec.n += 1;
    props.setProperty('MAILDAY', JSON.stringify(rec));
  });
  var b = randomBytes_(4);
  var n = ((b[0] * 16777216) + (b[1] << 16) + (b[2] << 8) + b[3]) % 900000;
  var code = String(100000 + n);
  if (!cachePut_('code:' + email, JSON.stringify({ h: sign_(code + email), n: 0 }), CFG.CODE_MINUTES * 60)) throw new Error('could not store code');
  MailApp.sendEmail({
    to: email,
    subject: 'Your Eye Refs code: ' + code,
    body: 'Your Eye Refs sign in code is ' + code + '\n\nIt works for ' + CFG.CODE_MINUTES + ' minutes. If you didn\'t ask for it, ignore this email.\n\nEye Refs by Matte Black',
    name: 'Eye Refs',
  });
  return { sent: true };
};

API['auth.verify'] = function (req) {
  var email = String(req.email || '').trim().toLowerCase();
  var code = String(req.code || '').replace(/\D/g, '');
  var tooMany = 'Too many wrong codes today. Try again tomorrow.';
  withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var cache = CacheService.getScriptCache();
    var today = day_();
    var fails = null;
    try { fails = JSON.parse(props.getProperty('vf:' + email) || 'null'); } catch (x) {}
    if (!fails || fails.d !== today) fails = { d: today, n: 0 };
    if (fails.n >= CFG.VERIFY_FAILS_PER_DAY) { cache.remove('code:' + email); throw userError_(tooMany); }
    var raw = cacheGet_('code:' + email);
    if (!raw) throw userError_('That code has expired. Ask for a new one.');
    var rec = JSON.parse(raw);
    if (rec.n >= 5) { cache.remove('code:' + email); throw userError_('Too many wrong codes. Ask for a new one.'); }
    if (sign_(code + email) !== rec.h) {
      rec.n += 1;
      fails.n += 1;
      props.setProperty('vf:' + email, JSON.stringify(fails));
      if (fails.n >= CFG.VERIFY_FAILS_PER_DAY) { cache.remove('code:' + email); throw userError_(tooMany); }
      if (rec.n >= 5) cache.remove('code:' + email);
      else cachePut_('code:' + email, JSON.stringify(rec), CFG.CODE_MINUTES * 60);
      throw userError_("That code isn't right. Check the email and try again.");
    }
    cache.remove('code:' + email);
  });
  var name = String(req.name || '').trim().slice(0, 40) || firstName_(email);
  return { token: makeToken_(email, name), email: email, name: name };
};

// Signs this person out everywhere: every token made before now stops working.
API['auth.revoke'] = function (req) {
  var me = readToken_(req.token);
  if (!isAdmin_(me.email, readTeam_())) throw userError_('Only an admin can sign people out.');
  var email = String(req.email || '').trim().toLowerCase();
  if (!validEmail_(email)) throw userError_('Enter a valid email address.');
  var v = withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var next = Number(props.getProperty('tv:' + email) || 0) + 1;
    props.setProperty('tv:' + email, String(next));
    return next;
  });
  return { revoked: email, version: v };
};

API['me'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var inTeam = isTeam_(me.email);
  // A fresh token each launch, up to a year after the last code sign in
  var out = {
    email: me.email, name: me.name, team: inTeam, admin: isAdmin_(me.email, team),
    clients: inTeam ? (team.clients || []) : [],
    token: makeToken_(me.email, me.name, me.since),
  };
  if (inTeam) out.owner = ownerEmail_();
  return out;
};

API['clients.save'] = function (req) {
  var me = readToken_(req.token);
  return withTeam_(function (team) {
    if (!isAdmin_(me.email, team)) throw userError_('Only an admin can change the client list.');
    var seen = {};
    team.clients = (req.clients || []).slice(0, 500).map(cleanFolderName_).filter(function (c) {
      var k = c.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).sort();
    return team.clients;
  });
};

API['projects.list'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var out = [];
  for (var id in team.projects) {
    var p = team.projects[id];
    if (!roleOf_(p, me.email, team)) continue;
    var sum = projectSummary_(p, me.email, team);
    var mine = p.members && p.members[me.email];
    if (mine && mine.at) { sum.sharedAt = mine.at; sum.sharedBy = mine.by ? firstName_(mine.by) : sum.ownerName; }
    try { var u = JSON.parse(cacheGet_('upd:' + id) || 'null'); if (u && u.at) sum.updated = { at: u.at, by: String(u.by || ''), email: String(u.email || '') }; } catch (x) {}
    out.push(sum);
  }
  return out;
};

API['projects.create'] = function (req) {
  var me = readToken_(req.token);
  if (!isTeam_(me.email)) throw userError_('Only EyeStudio accounts can share new boards.');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(req.id || ''))) throw userError_('That board has an invalid id.');
  return withTeam_(function (team) {
    if (team.projects.hasOwnProperty(req.id)) {
      var existing = team.projects[req.id];
      requireRole_(existing, me.email, team, ['owner', 'admin', 'member']);
      return projectSummary_(existing, me.email, team);
    }
    var client = req.client ? cleanFolderName_(req.client) : '';
    var clientDir = client ? child_(rootFolder_(), client, true) : rootFolder_();
    var base = cleanFolderName_(req.name), name = base, n = 2;
    while (clientDir.getFoldersByName(name).hasNext()) { name = base + ' ' + n; n++; }
    var dir = clientDir.createFolder(name);
    child_(dir, 'media', true);
    child_(dir, 'changes', true);
    var members = {};
    members[me.email] = { name: me.name, at: Date.now() };
    var p = {
      id: req.id, name: cleanFolderName_(req.name), client: client, folderId: dir.getId(),
      owner: me.email, ownerName: me.name, created: Date.now(), code: joinCode_(team), members: members, requests: {},
      devices: {}, uploads: {}, mediaBytes: 0,
    };
    team.projects[req.id] = p;
    return projectSummary_(p, me.email, team);
  });
};

API['projects.rename'] = function (req) {
  var me = readToken_(req.token);
  var name = cleanFolderName_(req.name);
  return withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    var dir = boardFolder_(p);
    if (dir.getName() !== name) {
      var parents = dir.getParents();
      var parent = parents.hasNext() ? parents.next() : null;
      var folderName = name, n = 2;
      while (parent && parent.getFoldersByName(folderName).hasNext()) { folderName = name + ' ' + n; n++; }
      dir.setName(folderName);
    }
    p.name = name;
    return projectSummary_(p, me.email, team);
  });
};

API['projects.delete'] = function (req) {
  var me = readToken_(req.token);
  var p = withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    delete team.projects[req.id];
    return p;
  });
  try {
    var dir = DriveApp.getFolderById(p.folderId);
    if (dir && !(dir.isTrashed && dir.isTrashed())) dir.setTrashed(true);
  } catch (x) {
    // The folder was already gone; the board is unshared either way
  }
  return { deleted: true };
};

API['projects.members'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  var role = requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  var manage = role !== 'member';
  var members = Object.keys(p.members || {}).map(function (e) { return { email: e, name: p.members[e].name || firstName_(e), owner: e === p.owner }; });
  var requests = manage ? Object.keys(p.requests || {}).map(function (e) { return { email: e, name: p.requests[e].name || firstName_(e), at: p.requests[e].at }; }) : [];
  return { members: members, requests: requests, code: manage ? p.code : null, role: role };
};

API['projects.invite'] = function (req) {
  var me = readToken_(req.token);
  var list = Array.isArray(req.emails) ? req.emails : [];
  if (list.length > CFG.MAX_INVITE) throw userError_('You can invite up to ' + CFG.MAX_INVITE + ' people at a time.');
  var seen = {};
  var emails = list.map(function (e) { return String(e).trim().toLowerCase(); }).filter(function (e) {
    if (!validEmail_(e) || seen[e]) return false;
    seen[e] = true;
    return true;
  });
  if (!emails.length) throw userError_('Add at least one email address.');
  var added = [];
  var p = withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    p.members = p.members || {};
    var fresh = emails.filter(function (e) { return !p.members.hasOwnProperty(e); });
    if (countKeys_(p.members) + fresh.length > CFG.MAX_MEMBERS) throw userError_('A board can have up to ' + CFG.MAX_MEMBERS + ' people.');
    fresh.forEach(function (e) {
      p.members[e] = { name: firstName_(e), at: Date.now(), by: me.email };
      added.push(e);
    });
    emails.forEach(function (e) { if (p.requests) delete p.requests[e]; });
    return p;
  });
  added.forEach(function (e) {
    notify_(e, me.name + ' shared "' + p.name + '" with you', me.name + ' added you to the board "' + p.name + '" in Eye Refs.\n\nOpen Eye Refs and sign in with ' + e + ' to see it.');
  });
  return { added: emails };
};

API['projects.request'] = function (req) {
  var me = readToken_(req.token);
  joinRate_(me.email);
  var code = cleanCode_(req.code);
  var notFound = 'No board uses that code. Check it with whoever shared it.';
  // Look without the lock, so wrong guesses never hold up everyone else
  var matchId = boardByCode_(readTeam_(), code);
  if (!matchId) throw userError_(notFound);
  var found = withTeam_(function (team) {
    var p = team.projects.hasOwnProperty(matchId) ? team.projects[matchId] : null;
    if (!p || p.code !== code) throw userError_(notFound);
    if (roleOf_(p, me.email, team)) return { p: p, already: true };
    p.requests = p.requests || {};
    if (!p.requests[me.email] && countKeys_(p.requests) >= CFG.MAX_REQUESTS) throw userError_('This board has too many people waiting to join. Ask the owner to look at them first.');
    p.requests[me.email] = { name: me.name, at: Date.now() };
    p.notified = p.notified || {};
    var tell = !p.notified[me.email];
    if (tell) {
      p.notified[me.email] = Date.now();
      var keys = Object.keys(p.notified);
      if (keys.length > CFG.MAX_NOTIFIED) {
        keys.sort(function (a, b) { return p.notified[a] - p.notified[b]; });
        for (var i = 0; i < keys.length - CFG.MAX_NOTIFIED; i++) delete p.notified[keys[i]];
      }
    }
    return { p: p, tell: tell };
  });
  if (found.tell) {
    notify_(found.p.owner, me.name + ' asked to join "' + found.p.name + '"', me.name + ' (' + me.email + ') asked to join "' + found.p.name + '" in Eye Refs.\n\nOpen the board, press Share and approve or decline.');
  }
  return { name: found.p.name, owner: found.p.ownerName || firstName_(found.p.owner), already: !!found.already };
};

API['projects.rotateCode'] = function (req) {
  var me = readToken_(req.token);
  return withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    p.code = joinCode_(team);
    return { code: p.code };
  });
};

API['projects.decide'] = function (req) {
  var me = readToken_(req.token);
  var email = String(req.email || '').toLowerCase();
  var p = withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    var r = (p.requests || {})[email];
    if (!r) throw userError_('That request is no longer waiting.');
    if (req.allow && !(p.members || {})[email] && countKeys_(p.members) >= CFG.MAX_MEMBERS) throw userError_('A board can have up to ' + CFG.MAX_MEMBERS + ' people.');
    delete p.requests[email];
    if (req.allow) { p.members = p.members || {}; p.members[email] = { name: r.name, at: Date.now(), by: me.email }; }
    return p;
  });
  if (req.allow) notify_(email, 'You can now open "' + p.name + '"', me.name + ' approved your request to join "' + p.name + '" in Eye Refs. Open Eye Refs to see it.');
  return { ok: true };
};

API['projects.remove'] = function (req) {
  var me = readToken_(req.token);
  var email = String(req.email || '').toLowerCase();
  withTeam_(function (team) {
    var p = project_(team, req.id);
    var self = email === me.email;
    if (!self) requireRole_(p, me.email, team, ['owner', 'admin']);
    if (email === p.owner) throw userError_("The owner can't be removed.");
    var was = p.members && p.members.hasOwnProperty(email);
    delete (p.members || {})[email];
    // Whoever was removed may still know the code
    if (was && !self) p.code = joinCode_(team);
  });
  return { ok: true };
};

// A device file belongs to the first email that wrote it.
function checkDevice_(p, device, email) {
  var owner = p.devices && p.devices.hasOwnProperty(device) ? p.devices[device] : null;
  if (owner && owner !== email) throw userError_('This computer is not signed in correctly. Sign out and in again.');
  if (!owner && !deviceOk_(device, email)) throw userError_('This computer is not signed in correctly. Sign out and in again.');
  return !!owner;
}

function claimDevice_(projectId, device, email) {
  withTeam_(function (team) {
    var p = project_(team, projectId);
    requireRole_(p, email, team, ['owner', 'admin', 'member']);
    p.devices = p.devices || {};
    if (p.devices.hasOwnProperty(device)) {
      if (p.devices[device] !== email) throw userError_('This computer is not signed in correctly. Sign out and in again.');
      return;
    }
    if (!deviceOk_(device, email)) throw userError_('This computer is not signed in correctly. Sign out and in again.');
    var mine = 0;
    for (var d in p.devices) if (p.devices[d] === email) mine++;
    if (mine >= CFG.MAX_DEVICES) throw userError_('Your account already syncs this board from ' + CFG.MAX_DEVICES + ' computers. Ask the board owner for help.');
    p.devices[device] = email;
  });
}

// Everything a computer needs to catch up: newer change files, the media list, who's here.
// When the change files don't fit in one reply, `more` is true and the computer pulls again.
API['sync.pull'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  checkDevice_(p, req.device, me.email);

  // Presence lives in the cache: no Drive writes for "I'm here"
  var hereKey = 'here:' + p.id;
  var here = {};
  try { here = JSON.parse(cacheGet_(hereKey) || '{}') || {}; } catch (x) { here = {}; }
  var now = Date.now();
  here[req.device] = { name: me.name, email: me.email, device: req.device, at: now };
  var list = [];
  for (var d in here) { if (now - here[d].at > CFG.PRESENCE_SECONDS * 1000) delete here[d]; else list.push(here[d]); }
  cachePut_(hereKey, JSON.stringify(here), CFG.PRESENCE_SECONDS * 2);

  var f = folders_(p);
  var known = req.known && typeof req.known === 'object' ? req.known : {};
  var changes = [];
  var used = 0, more = false;
  var it = f.changes.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    var name = file.getName();
    if (!/\.json$/.test(name) || name === req.device + '.json') continue;
    var m = file.getLastUpdated().getTime();
    if (known.hasOwnProperty(name) && Number(known[name]) >= m) continue;
    if (file.getSize() > CFG.MAX_CHANGE_FILE) { console.warn('Eye Refs skipped oversized change file ' + p.id + '/' + name); continue; }
    if (more) continue;
    var data = file.getBlob().getDataAsString();
    var cost = JSON.stringify(data).length + name.length + 64;
    if (cost > CFG.PULL_BUDGET) { console.warn('Eye Refs skipped oversized change file ' + p.id + '/' + name); continue; }
    if (used + cost > CFG.PULL_BUDGET && changes.length) { more = true; continue; }
    used += cost;
    changes.push({ name: name, modified: m, data: data });
  }
  var media = [];
  var mi = f.media.getFiles();
  while (mi.hasNext()) {
    var mf = mi.next();
    media.push({ name: mf.getName(), size: mf.getSize() });
  }
  return {
    changes: changes, more: more, media: media, here: list,
    project: { name: p.name, client: p.client, owner: p.owner, ownerName: p.ownerName },
  };
};

API['sync.push'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  var owned = checkDevice_(p, req.device, me.email);
  if (typeof req.data !== 'string' || req.data.length > CFG.MAX_CHANGE_FILE || JSON.stringify(req.data).length > CFG.MAX_CHANGE_JSON) {
    throw userError_('That change file is too large.');
  }
  try { JSON.parse(req.data); } catch (x) { throw userError_('That change file is not valid.'); }
  if (!owned) claimDevice_(p.id, req.device, me.email);
  var f = folders_(p);
  var name = req.device + '.json';
  var file = fileIn_(f.changes, name);
  if (file) file.setContent(req.data); else f.changes.createFile(name, req.data, 'application/json');
  // Who changed the board last, so teammates can be told. Cache only: no Drive write.
  cachePut_('upd:' + p.id, JSON.stringify({ at: Date.now(), by: me.name, email: me.email }), 21600);
  return { saved: true };
};

function freshUploads_(p) {
  var out = {}, now = Date.now();
  var all = p.uploads || {};
  for (var n in all) if (now - all[n].at < CFG.UPLOAD_HOURS * 3600000) out[n] = all[n];
  return out;
}

API['media.start'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (!safeName_(req.name)) throw userError_('That file name is not allowed.');
  var size = Number(req.size);
  if (!(size >= 1) || Math.floor(size) !== size) throw userError_('That file is empty or unreadable.');
  if (size > CFG.MAX_FILE) throw userError_('That file is too large to share. Files can be up to 2GB.');
  var f = folders_(p);
  if (fileIn_(f.media, req.name)) return { exists: true };

  // Reserve the name and the space before Drive hears about it
  withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
    var uploads = freshUploads_(p);
    var mine = uploads[req.name];
    if (mine && mine.by !== me.email) throw userError_('Someone else is uploading a file with that name. Try again later.');
    if (p.mediaBytes == null) p.mediaBytes = sumMedia_(f.media);
    var pending = 0, count = 0;
    for (var n in uploads) if (n !== req.name) { pending += uploads[n].size; count++; }
    if (count >= CFG.MAX_PENDING_UPLOADS) throw userError_('Too many uploads in progress on this board. Try again shortly.');
    if (p.mediaBytes + pending + size > CFG.MAX_BOARD) throw userError_('This board is full. Shared boards can hold up to 20GB of media.');
    uploads[req.name] = { size: size, by: me.email, at: Date.now() };
    p.uploads = uploads;
  });

  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: req.name, parents: [f.media.getId()] }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': req.mime || 'application/octet-stream',
    },
    muteHttpExceptions: true,
  });
  var headers = res.getHeaders();
  var url = headers.Location || headers.location;
  if (!url) {
    releaseUpload_(p.id, req.name, me.email, 0);
    throw userError_('Google Drive did not accept the upload. Try again.');
  }
  var upload = Utilities.getUuid();
  if (!cachePut_('up:' + upload, JSON.stringify({ url: url, id: p.id, by: me.email, name: req.name, size: size }), CFG.UPLOAD_HOURS * 3600)) {
    throw new Error('could not store upload session');
  }
  return { upload: upload };
};

// Drop an upload's reservation; add `bytes` to the board's media total when it finished.
function releaseUpload_(projectId, name, email, bytes) {
  try {
    withTeam_(function (team) {
      var p = team.projects.hasOwnProperty(projectId) ? team.projects[projectId] : null;
      if (!p) return;
      if (p.uploads && p.uploads[name] && p.uploads[name].by === email) delete p.uploads[name];
      if (bytes && p.mediaBytes != null) p.mediaBytes += bytes;
    });
  } catch (x) {
    console.error('Eye Refs could not update upload totals: ' + ((x && x.stack) || x));
  }
}

API['media.chunk'] = function (req) {
  var me = readToken_(req.token);
  var raw = cacheGet_('up:' + req.upload);
  if (!raw) throw userError_('That upload expired. It will start again.');
  var up = JSON.parse(raw);
  if (up.by !== me.email) throw userError_("You don't have access to this upload.");
  // The board may have been deleted, or this person removed, since the upload started
  var team = readTeam_();
  var p = project_(team, up.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (typeof req.data !== 'string') throw userError_('Upload piece missing.');
  var bytes = Utilities.base64Decode(req.data);
  if (bytes.length > CFG.MAX_CHUNK) throw userError_('Upload piece too large.');
  var offset = Number(req.offset), total = Number(req.total);
  if (!(offset >= 0) || Math.floor(offset) !== offset) throw userError_('Upload piece is out of place.');
  if (up.size != null && total !== up.size) throw userError_('That upload changed size. It will start again.');
  var end = offset + bytes.length - 1;
  if (end >= total) throw userError_('Upload piece is out of place.');
  var res = UrlFetchApp.fetch(up.url, {
    method: 'put',
    contentType: 'application/octet-stream',
    payload: bytes,
    headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + total },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 308) return { done: false };
  if (code === 200 || code === 201) {
    try { CacheService.getScriptCache().remove('up:' + req.upload); } catch (x) {}
    if (up.name) releaseUpload_(up.id, up.name, me.email, up.size || 0);
    return { done: true };
  }
  throw userError_('Google Drive stopped the upload (' + code + '). It will try again.');
};

API['media.get'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (!safeName_(req.name)) throw userError_('That file name is not allowed.');
  var file = fileIn_(folders_(p).media, req.name);
  if (!file) throw userError_('That file is not in the shared board yet.');
  var size = file.getSize();
  var offset = Math.max(0, Number(req.offset) || 0);
  var length = Math.min(Number(req.length) || CFG.MAX_CHUNK, CFG.MAX_CHUNK, size - offset);
  if (length <= 0) return { size: size, data: '' };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + offset + '-' + (offset + length - 1) },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 206) throw userError_('Google Drive did not send the file (' + code + ').');
  return { size: size, data: Utilities.base64Encode(res.getContent()) };
};

// ---------------------------------------------------------------- view links
// A board owner can turn on a link that shows the board in any browser, phones
// included, without signing in and without being able to change anything.

function viewKey_() {
  var a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var b = randomBytes_(24), s = '';
  for (var i = 0; i < b.length; i++) s += a.charAt(b[i] % a.length);
  return s;
}

API['projects.viewLink'] = function (req) {
  var me = readToken_(req.token);
  return withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    if (req.on === undefined && !req.rotate) return { key: p.viewKey || null }; // just asking
    if (req.rotate || (req.on && !p.viewKey)) p.viewKey = viewKey_();
    if (!req.on && !req.rotate) delete p.viewKey;
    return { key: p.viewKey || null };
  });
};

function boardByViewKey_(key) {
  if (!/^[A-Za-z0-9]{24}$/.test(String(key || ''))) throw userError_('This view link is not valid.');
  if (bump_('vw:' + key + ':' + hour_(), 3600) > 3000) throw userError_('This board is being viewed a lot right now. Try again in a little while.');
  var team = readTeam_();
  for (var id in team.projects) {
    if (team.projects.hasOwnProperty(id) && team.projects[id].viewKey === key) return team.projects[id];
  }
  throw userError_('This view link was turned off by the board owner.');
}

// The same merge the app does: for every item and field, the newest write wins
// (ties go to the higher device name).
function mergeChanges_(files) {
  var win = {};
  for (var f = 0; f < files.length; f++) {
    var file = files[f];
    if (!file || !file.items || typeof file.items !== 'object' || !file.device) continue;
    var dk = String(file.device.key || '');
    for (var id in file.items) {
      if (!file.items.hasOwnProperty(id) || id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      var fields = file.items[id];
      if (!fields || typeof fields !== 'object') continue;
      var w = win[id] || (win[id] = {});
      for (var k in fields) {
        if (!fields.hasOwnProperty(k) || k === '__proto__') continue;
        var pair = fields[k];
        if (!pair || pair.length < 2 || typeof pair[1] !== 'number') continue;
        var cur = w[k];
        if (!cur || pair[1] > cur[1] || (pair[1] === cur[1] && dk > cur[2])) w[k] = [pair[0], pair[1], dk];
      }
    }
  }
  var out = [];
  for (var i in win) {
    if (!win.hasOwnProperty(i)) continue;
    var o = { id: i };
    for (var key in win[i]) if (win[i].hasOwnProperty(key)) o[key] = win[i][key][0];
    if (o.type && !o.deleted) out.push(o);
  }
  return out;
}

// Where the latest app lives, for the "Get Eye Refs" button
function downloads_() {
  var cached = cacheGet_('downloads');
  if (cached) { try { return JSON.parse(cached); } catch (x) {} }
  var out = { page: 'https://github.com/chamatheyestudio/eye-refs/releases/latest' };
  try {
    var res = UrlFetchApp.fetch('https://api.github.com/repos/chamatheyestudio/eye-refs/releases/latest', { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json' } });
    if (res.getResponseCode() === 200) {
      var rel = JSON.parse(res.getContentText());
      var assets = rel.assets || [];
      for (var i = 0; i < assets.length; i++) {
        var n = assets[i].name, u = assets[i].browser_download_url;
        if (/-arm64\.pkg$/.test(n)) out.macArm = u;
        else if (/\.pkg$/.test(n)) out.macIntel = u;
        else if (/\.exe$/.test(n)) out.windows = u;
      }
      out.version = String(rel.tag_name || '').replace(/^v/, '');
    }
  } catch (x) {}
  cachePut_('downloads', JSON.stringify(out), 3600);
  return out;
}

API['view.state'] = function (req) {
  var p = boardByViewKey_(req.key);
  var f = folders_(p);
  var files = [], it = f.changes.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    if (!/\.json$/.test(file.getName()) || file.getSize() > 3 * 1024 * 1024) continue;
    try { files.push(JSON.parse(file.getBlob().getDataAsString())); } catch (x) {}
  }
  var media = {}, mit = f.media.getFiles();
  while (mit.hasNext()) { var m = mit.next(); media[m.getName()] = m.getSize(); }
  // Comments stay with the team: a view link only shows the board itself
  var items = mergeChanges_(files).filter(function (it) { return it && it.type !== 'comment'; });
  return { name: p.name, owner: p.ownerName || firstName_(p.owner), items: items, media: media, downloads: downloads_() };
};

API['view.media'] = function (req) {
  var p = boardByViewKey_(req.key);
  if (!safeName_(req.name)) throw userError_('That file name is not allowed.');
  var file = fileIn_(folders_(p).media, req.name);
  if (!file) throw userError_('That file is not on the board yet.');
  var size = file.getSize();
  var offset = Math.max(0, Number(req.offset) || 0);
  var length = Math.min(4 * 1024 * 1024, size - offset);
  if (length <= 0) return { size: size, data: '' };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId() + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + offset + '-' + (offset + length - 1) },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 206) throw userError_('Google Drive did not send the file.');
  return { size: size, data: Utilities.base64Encode(res.getContent()) };
};

// The page calls these through google.script.run
function viewState(key) { return viewCall_('view.state', { key: key }); }
function viewMedia(key, name, offset) { return viewCall_('view.media', { key: key, name: name, offset: offset }); }
function viewCall_(action, req) {
  try {
    return { ok: true, data: API[action](req) };
  } catch (x) {
    if (x && x.userMessage) return { ok: false, error: x.userMessage };
    console.error('Eye Refs ' + action + ' failed: ' + ((x && x.stack) || x));
    return { ok: false, error: GENERIC_ERROR };
  }
}

function viewerPage_(key) {
  var html = VIEWER_HTML.replace('__VIEW_KEY__', /^[A-Za-z0-9]{24}$/.test(key) ? key : '');
  return HtmlService.createHtmlOutput(html)
    .setTitle('Eye Refs')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// VIEWER_HTML_START (built from server/viewer.html by tools/embed-viewer.js, do not edit here)
var VIEWER_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover\">\n<title>Eye Refs</title>\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n<style>\n  :root { --bg: #1C1B1A; --dot: #2B2A28; --panel: rgba(38, 37, 35, 0.86); --line: rgba(255,255,255,0.07); --text: #ECEAE3; --soft: #B8B6AE; --muted: #8F8D85; --lime: #D7F04A; --ink: #1C1B1A; }\n  * { box-sizing: border-box; }\n  [hidden] { display: none !important; }\n  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font: 14px/1.4 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; touch-action: none; }\n  #canvas { position: fixed; inset: 0; overflow: hidden; background-image: radial-gradient(var(--dot) 1px, transparent 1.2px); cursor: grab; }\n  #canvas.dragging { cursor: grabbing; }\n  #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }\n  .item { position: absolute; left: 0; top: 0; transform-origin: 50% 50%; }\n  .item .clip { position: absolute; inset: 0; overflow: hidden; }\n  .item .media { position: absolute; display: block; max-width: none; pointer-events: none; -webkit-user-drag: none; }\n  .item.gray .clip { filter: grayscale(1); }\n  .item .wait { position: absolute; inset: 0; background: #262523; }\n  .item .wait::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent); animation: shine 1.4s infinite; }\n  @keyframes shine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }\n  .item .big { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; background: #262523; color: var(--muted); font-size: 13px; }\n  .item.note { background: #2A2927; }\n  .item.note .note-text { padding: 0.8em 0.95em; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }\n  .item.note.plain { background: transparent; }\n  .item.note.plain .note-text { padding: 0.1em 0.15em; line-height: 1.25; font-weight: 600; white-space: pre; }\n  .item.section { background: rgba(255,255,255,0.03); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14); border-radius: 14px; }\n  .item.section .section-label { position: absolute; left: 14px; top: 10px; font-size: 13px; font-weight: 600; color: #C9C7BF; white-space: nowrap; }\n  .item.draw svg { position: absolute; left: 0; top: 0; overflow: visible; }\n  .bar { position: fixed; left: 12px; right: 12px; top: max(12px, env(safe-area-inset-top)); display: flex; align-items: center; gap: 10px; pointer-events: none; z-index: 5; }\n  .pill { pointer-events: auto; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 16px 0 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); min-width: 0; }\n  .logo { width: 28px; height: 28px; border-radius: 50%; background: var(--lime); color: var(--ink); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\n  .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }\n  .by { color: var(--muted); font-size: 12px; white-space: nowrap; }\n  .tag { font-size: 11px; font-weight: 600; color: var(--lime); background: rgba(215,240,74,0.12); border-radius: 999px; padding: 3px 9px; white-space: nowrap; }\n  .grow { flex: 1; }\n  .get { pointer-events: auto; display: flex; align-items: center; gap: 8px; }\n  .btn { height: 44px; padding: 0 18px; border-radius: 999px; border: 0; background: var(--text); color: var(--ink); font: 600 13px Inter, system-ui, sans-serif; text-decoration: none; display: inline-flex; align-items: center; white-space: nowrap; }\n  .link { color: var(--muted); font-size: 12px; text-decoration: none; white-space: nowrap; }\n  .link:hover { color: var(--text); }\n  .note-m { color: var(--muted); font-size: 12px; padding: 0 6px; }\n  .center { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 24px; z-index: 4; }\n  .center h1 { margin: 0; font-size: 20px; }\n  .center p { margin: 0; color: var(--muted); max-width: 360px; }\n  .zoom { position: fixed; right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); z-index: 5; display: flex; align-items: center; gap: 2px; height: 44px; padding: 0 4px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); }\n  .zoom button { width: 36px; height: 36px; border-radius: 50%; border: 0; background: transparent; color: var(--soft); font: 500 18px Inter, sans-serif; cursor: pointer; }\n  .zoom .val { width: 56px; font-size: 12px; font-family: ui-monospace, Menlo, monospace; border-radius: 999px; }\n  .credit { position: fixed; left: 16px; bottom: max(16px, env(safe-area-inset-bottom)); color: #5E5C55; font-size: 11px; z-index: 5; }\n  @media (max-width: 640px) { .by, .credit { display: none; } .btn { padding: 0 14px; } .note-m { display: none; } }\n</style>\n</head>\n<body>\n<div id=\"canvas\"><div id=\"world\"></div></div>\n<div class=\"bar\">\n  <div class=\"pill\">\n    <span class=\"logo\"><svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"11\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"18\" width=\"7\" height=\"3\" rx=\"1.5\"/></svg></span>\n    <span class=\"name\" id=\"name\">Eye Refs</span>\n    <span class=\"by\" id=\"by\"></span>\n    <span class=\"tag\">View only</span>\n  </div>\n  <span class=\"grow\"></span>\n  <div class=\"get\" id=\"get\"></div>\n</div>\n<div class=\"center\" id=\"msg\"><h1>Opening the board</h1><p id=\"msgText\">One moment.</p></div>\n<div class=\"zoom\" id=\"zoom\" hidden>\n  <button id=\"zOut\" aria-label=\"Zoom out\">\u2212</button>\n  <button class=\"val\" id=\"zVal\" aria-label=\"Fit everything\">100%</button>\n  <button id=\"zIn\" aria-label=\"Zoom in\">+</button>\n</div>\n<div class=\"credit\">Eye Refs by Matte Black</div>\n<script>\n(function () {\n  var KEY = '__VIEW_KEY__';\n  var $ = function (id) { return document.getElementById(id); };\n  var canvas = $('canvas'), world = $('world');\n  var view = { s: 1, x: 0, y: 0 };\n  var items = [];\n  var SVGNS = 'http://www.w3.org/2000/svg';\n\n  function server(fn, args) {\n    return new Promise(function (resolve, reject) {\n      var run = google.script.run.withSuccessHandler(function (r) { if (r && r.ok) resolve(r.data); else reject(new Error((r && r.error) || 'Something went wrong.')); })\n        .withFailureHandler(function (e) { reject(e instanceof Error ? e : new Error(String(e))); });\n      run[fn].apply(run, args);\n    });\n  }\n  function message(title, text) {\n    $('msg').hidden = false;\n    $('msg').querySelector('h1').textContent = title;\n    $('msgText').textContent = text || '';\n  }\n\n  // ---------- the right download for this computer ----------\n  function offerApp(d) {\n    var box = $('get');\n    var ua = navigator.userAgent;\n    var mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));\n    function button(text, url) { var a = document.createElement('a'); a.className = 'btn'; a.textContent = text; a.href = url; a.target = '_blank'; a.rel = 'noopener'; return a; }\n    function small(text, url) { var a = document.createElement('a'); a.className = 'link'; a.textContent = text; a.href = url; a.target = '_blank'; a.rel = 'noopener'; return a; }\n    if (mobile) { var s = document.createElement('span'); s.className = 'note-m'; s.textContent = 'Get Eye Refs on a Mac or PC'; box.appendChild(s); return; }\n    if (/Windows/.test(ua)) { box.appendChild(button('Get Eye Refs for Windows', d.windows || d.page)); return; }\n    if (/Mac/.test(ua)) {\n      var arm = button('Get Eye Refs for Mac', d.macArm || d.page);\n      var intel = small('Intel Mac', d.macIntel || d.page);\n      box.appendChild(intel); box.appendChild(arm);\n      // Chrome and Edge can tell an Apple chip from Intel; Safari can't, so both stay on offer\n      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {\n        navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (v) {\n          if (v.architecture === 'x86') { arm.href = d.macIntel || d.page; intel.textContent = 'Apple chip Mac'; intel.href = d.macArm || d.page; }\n        }).catch(function () {});\n      }\n      return;\n    }\n    box.appendChild(small('Get Eye Refs', d.page));\n  }\n\n  // ---------- drawing the board ----------\n  function dims(it) {\n    if (it.type === 'section') return { w: it.w, h: it.h || 400, k: 1 };\n    if (it.type === 'note') return { w: it.w, h: null, k: 1 };\n    var c = it.crop || { l: 0, t: 0, r: 0, b: 0 };\n    var vw = Math.max(1, (it.nw || 1) * (1 - c.l - c.r)), vh = Math.max(1, (it.nh || 1) * (1 - c.t - c.b));\n    var k = it.w / vw;\n    return { w: it.w, h: vh * k, k: k };\n  }\n  function parsePts(s) { var n = String(s || '').split(' ').map(Number), out = []; for (var i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i], y: n[i + 1] }); return out; }\n  function strokePath(pts, arrow) {\n    if (!pts.length) return '';\n    var d = 'M' + pts[0].x + ' ' + pts[0].y;\n    if (pts.length < 3) { for (var i = 1; i < pts.length; i++) d += ' L' + pts[i].x + ' ' + pts[i].y; }\n    else {\n      for (var j = 1; j < pts.length - 1; j++) d += ' Q' + pts[j].x + ' ' + pts[j].y + ' ' + (pts[j].x + pts[j + 1].x) / 2 + ' ' + (pts[j].y + pts[j + 1].y) / 2;\n      d += ' L' + pts[pts.length - 1].x + ' ' + pts[pts.length - 1].y;\n    }\n    if (arrow && pts.length > 1) {\n      var tip = pts[pts.length - 1], back = pts[0];\n      for (var b = pts.length - 2; b >= 0; b--) if (Math.hypot(tip.x - pts[b].x, tip.y - pts[b].y) > arrow * 4) { back = pts[b]; break; }\n      var a = Math.atan2(tip.y - back.y, tip.x - back.x), L = arrow * 4.5;\n      d += ' M' + (tip.x - L * Math.cos(a - 0.5)) + ' ' + (tip.y - L * Math.sin(a - 0.5)) + ' L' + tip.x + ' ' + tip.y + ' L' + (tip.x - L * Math.cos(a + 0.5)) + ' ' + (tip.y - L * Math.sin(a + 0.5));\n    }\n    return d;\n  }\n  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }\n  function render() {\n    world.innerHTML = '';\n    items.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });\n    items.forEach(function (it) {\n      if (it.type === 'comment') return;\n      var node = el('div', 'item' + (it.gray ? ' gray' : ''));\n      var d = dims(it);\n      node.style.width = it.plain ? 'max-content' : d.w + 'px';\n      if (d.h != null) node.style.height = d.h + 'px';\n      node.style.transform = 'translate(' + it.x + 'px,' + it.y + 'px) rotate(' + (it.rot || 0) + 'deg)';\n      if (it.op != null && it.op < 1 && it.type !== 'draw') node.style.opacity = String(it.op);\n      if (it.type === 'section') {\n        node.classList.add('section');\n        var lab = el('div', 'section-label'); lab.textContent = it.title || 'Section';\n        node.appendChild(lab);\n      } else if (it.type === 'note') {\n        node.classList.add('note');\n        if (it.plain) node.classList.add('plain');\n        var t = el('div', 'note-text'); t.textContent = it.text || ''; node.style.fontSize = (it.fs || 16) + 'px';\n        if (it.plain) t.style.color = it.color || '#D7F04A';\n        node.appendChild(t);\n      } else if (it.type === 'draw') {\n        node.classList.add('draw');\n        var svg = document.createElementNS(SVGNS, 'svg');\n        svg.setAttribute('viewBox', '0 0 ' + it.nw + ' ' + it.nh); svg.setAttribute('preserveAspectRatio', 'none');\n        svg.setAttribute('width', d.w); svg.setAttribute('height', d.h);\n        var p = document.createElementNS(SVGNS, 'path');\n        p.setAttribute('d', strokePath(parsePts(it.pts), it.style === 'arrow' ? (it.sw || 4) : 0));\n        p.setAttribute('fill', 'none'); p.setAttribute('stroke', it.color || '#D7F04A'); p.setAttribute('stroke-width', it.sw || 4); p.setAttribute('stroke-opacity', it.op == null ? 1 : it.op);\n        p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');\n        if (it.style === 'dotted') p.setAttribute('stroke-dasharray', '0 ' + (it.sw || 4) * 2);\n        svg.appendChild(p); node.appendChild(svg);\n      } else {\n        var c = it.crop || { l: 0, t: 0, r: 0, b: 0 };\n        var clip = el('div', 'clip');\n        clip.style.transform = 'scale(' + (it.flipX ? -1 : 1) + ',' + (it.flipY ? -1 : 1) + ')';\n        clip.appendChild(el('div', 'wait'));\n        node.appendChild(clip);\n        it._clip = clip;\n        it._box = { w: it.nw * d.k, h: it.nh * d.k, l: -c.l * it.nw * d.k, t: -c.t * it.nh * d.k };\n      }\n      world.appendChild(node);\n    });\n  }\n  function showMedia(it, url) {\n    var m = it.type === 'video' ? el('video', 'media') : el('img', 'media');\n    if (it.type === 'video') { m.muted = true; m.loop = true; m.playsInline = true; m.autoplay = true; m.setAttribute('playsinline', ''); }\n    m.style.width = it._box.w + 'px'; m.style.height = it._box.h + 'px'; m.style.left = it._box.l + 'px'; m.style.top = it._box.t + 'px';\n    m.src = url;\n    it._clip.innerHTML = '';\n    it._clip.appendChild(m);\n  }\n  function showBig(it, text) { it._clip.innerHTML = ''; var b = el('div', 'big'); b.textContent = text; it._clip.appendChild(b); }\n\n  // ---------- loading pictures and videos, a few at a time ----------\n  var TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm' };\n  var MAX_PREVIEW = 60 * 1024 * 1024;\n  function fetchFile(name, size) {\n    var parts = [], offset = 0;\n    function next() {\n      if (offset >= size) return Promise.resolve();\n      return server('viewMedia', [KEY, name, offset]).then(function (r) {\n        var bin = atob(r.data || ''), bytes = new Uint8Array(bin.length);\n        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n        parts.push(bytes); offset += bytes.length;\n        if (!bytes.length) offset = size;\n        return next();\n      });\n    }\n    return next().then(function () {\n      var ext = (name.split('.').pop() || '').toLowerCase();\n      return URL.createObjectURL(new Blob(parts, { type: TYPES[ext] || 'application/octet-stream' }));\n    });\n  }\n  function loadAll(media) {\n    var queue = items.filter(function (it) { return it.type === 'image' || it.type === 'video'; });\n    var cache = {};\n    function worker() {\n      var it = queue.shift();\n      if (!it) return Promise.resolve();\n      var size = media[it.src];\n      if (size == null) { showBig(it, 'Still uploading'); return worker(); }\n      if (size > MAX_PREVIEW) { showBig(it, it.type === 'video' ? 'This video is too big to preview here. Open the board in Eye Refs.' : 'Too big to preview here'); return worker(); }\n      var p = cache[it.src] || (cache[it.src] = fetchFile(it.src, size));\n      return p.then(function (url) { showMedia(it, url); }, function () { showBig(it, \"Couldn't load this file\"); }).then(worker);\n    }\n    return Promise.all([worker(), worker(), worker()]);\n  }\n\n  // ---------- pan and zoom with a mouse, a trackpad or fingers ----------\n  function apply() {\n    world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')';\n    canvas.style.backgroundSize = 28 * view.s + 'px ' + 28 * view.s + 'px';\n    canvas.style.backgroundPosition = view.x + 'px ' + view.y + 'px';\n    $('zVal').textContent = Math.round(view.s * 100) + '%';\n  }\n  function zoomAt(cx, cy, f) {\n    var s = Math.max(0.03, Math.min(20, view.s * f));\n    f = s / view.s;\n    view.x = cx - (cx - view.x) * f; view.y = cy - (cy - view.y) * f; view.s = s;\n    apply();\n  }\n  function fit() {\n    if (!items.length) return;\n    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;\n    items.forEach(function (it) { var d = dims(it); var h = d.h == null ? (it.fs || 16) * 4 : d.h; x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + d.w); y1 = Math.max(y1, it.y + h); });\n    var W = innerWidth, H = innerHeight, top = 72, pad = 24;\n    var s = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - top - pad * 2) / Math.max(1, y1 - y0), 2);\n    view.s = s; view.x = (W - (x1 - x0) * s) / 2 - x0 * s; view.y = top + (H - top - (y1 - y0) * s) / 2 - y0 * s;\n    apply();\n  }\n  var pointers = {}, last = null, pinch = null;\n  canvas.addEventListener('pointerdown', function (e) {\n    canvas.setPointerCapture(e.pointerId);\n    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };\n    canvas.classList.add('dragging');\n    var ids = Object.keys(pointers);\n    if (ids.length === 2) { var a = pointers[ids[0]], b = pointers[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s }; }\n    last = { x: e.clientX, y: e.clientY };\n  });\n  canvas.addEventListener('pointermove', function (e) {\n    if (!pointers[e.pointerId]) return;\n    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };\n    var ids = Object.keys(pointers);\n    if (ids.length === 2 && pinch) {\n      var a = pointers[ids[0]], b = pointers[ids[1]];\n      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;\n      var target = pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d);\n      if (last) { view.x += mx - last.x; view.y += my - last.y; }\n      zoomAt(mx, my, target / view.s);\n      last = { x: mx, y: my };\n      return;\n    }\n    if (last) { view.x += e.clientX - last.x; view.y += e.clientY - last.y; apply(); }\n    last = { x: e.clientX, y: e.clientY };\n  });\n  function up(e) {\n    delete pointers[e.pointerId];\n    var ids = Object.keys(pointers);\n    pinch = null;\n    last = ids.length ? { x: pointers[ids[0]].x, y: pointers[ids[0]].y } : null;\n    if (!ids.length) canvas.classList.remove('dragging');\n  }\n  canvas.addEventListener('pointerup', up);\n  canvas.addEventListener('pointercancel', up);\n  canvas.addEventListener('wheel', function (e) {\n    e.preventDefault();\n    var mouseLike = e.deltaMode === 1 || Math.abs(e.deltaY) >= 50;\n    if (e.ctrlKey || mouseLike) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey && !mouseLike ? 0.01 : 0.0018)));\n    else { view.x -= e.deltaX; view.y -= e.deltaY; apply(); }\n  }, { passive: false });\n  canvas.addEventListener('dblclick', fit);\n  $('zIn').onclick = function () { zoomAt(innerWidth / 2, innerHeight / 2, 1.25); };\n  $('zOut').onclick = function () { zoomAt(innerWidth / 2, innerHeight / 2, 0.8); };\n  $('zVal').onclick = fit;\n  window.addEventListener('resize', fit);\n\n  // ---------- start ----------\n  if (!KEY) { message('This view link is not valid', 'Ask whoever shared it for a new link.'); return; }\n  server('viewState', [KEY]).then(function (st) {\n    document.title = st.name + ' \u00b7 Eye Refs';\n    $('name').textContent = st.name;\n    $('by').textContent = 'by ' + st.owner;\n    offerApp(st.downloads || {});\n    items = (st.items || []).filter(function (it) { return it && it.type && it.type !== 'comment' && isFinite(it.x) && isFinite(it.w); });\n    if (!items.length) { message('Nothing on this board yet', 'Check back once something is added.'); return; }\n    $('msg').hidden = true;\n    $('zoom').hidden = false;\n    render(); fit();\n    return loadAll(st.media || {});\n  }).catch(function (e) { message(\"Can't show this board\", e.message); });\n})();\n</script>\n</body>\n</html>\n";
// VIEWER_HTML_END

// Run once from the editor to grant permissions before deploying.
function setup() {
  rootFolder_();
  secret_();
  Logger.log('Eye Refs is ready in ' + ownerEmail_() + "'s Drive.");
  // Touch the services so Google asks for every permission at once
  DriveApp.getRootFolder();
  UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  MailApp.getRemainingDailyQuota();
}
