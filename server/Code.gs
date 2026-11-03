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

function doGet() {
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
    if (roleOf_(p, me.email, team)) out.push(projectSummary_(p, me.email, team));
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
