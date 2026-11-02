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
  TOKEN_DAYS: 90,
  CODE_MINUTES: 10,
  PRESENCE_SECONDS: 150,
  MAX_CHUNK: 10 * 1024 * 1024,
};

// ---------------------------------------------------------------- entry points

function doGet() {
  return json_({ ok: true, data: { app: 'Eye Refs', api: 1, owner: ownerEmail_() } });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API[req.action];
    if (!fn) throw userError_('Unknown request.');
    out = { ok: true, data: fn(req) };
  } catch (x) {
    out = { ok: false, error: x && x.userMessage ? x.userMessage : 'Something went wrong on the EyeStudio side. ' + String((x && x.message) || x) };
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

function makeToken_(email, name) {
  var payload = b64url_(JSON.stringify({ e: email, n: name || '', t: Date.now() }));
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
  if (!data.e || Date.now() - data.t > CFG.TOKEN_DAYS * 86400000) throw userError_('Your sign in has expired. Please sign in again.');
  return { email: String(data.e).toLowerCase(), name: data.n || firstName_(data.e) };
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

// The device file name must belong to the signed in person.
function deviceOk_(device, email) {
  if (typeof device !== 'string' || !/^[a-z0-9-]{3,60}$/.test(device)) return false;
  var local = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
  return device.indexOf(local + '-') === 0;
}

function safeName_(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 220 &&
    name.indexOf('/') < 0 && name.indexOf('\\') < 0 && name.charAt(0) !== '.' && name.indexOf('..') < 0;
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

// ---------------------------------------------------------------- team data

function readTeam_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('team');
  if (hit) return JSON.parse(hit);
  var f = fileIn_(rootFolder_(), CFG.TEAM_FILE);
  var team = f ? JSON.parse(f.getBlob().getDataAsString()) : null;
  if (!team) team = { clients: [], admins: [], projects: {} };
  team.projects = team.projects || {};
  cache.put('team', JSON.stringify(team), 300);
  return team;
}

function writeTeam_(team) {
  var root = rootFolder_();
  var f = fileIn_(root, CFG.TEAM_FILE);
  var txt = JSON.stringify(team);
  if (f) f.setContent(txt); else root.createFile(CFG.TEAM_FILE, txt, 'application/json');
  CacheService.getScriptCache().put('team', txt, 300);
}

// Read, change and write the team file under a lock so two requests never clash.
function withTeam_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    CacheService.getScriptCache().remove('team');
    var team = readTeam_();
    var result = fn(team);
    writeTeam_(team);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function project_(team, id) {
  var p = team.projects[id];
  if (!p) throw userError_('That board is no longer shared.');
  return p;
}

function roleOf_(p, email, team) {
  if (p.owner === email) return 'owner';
  if (isAdmin_(email, team)) return 'admin';
  if (p.members && p.members[email]) return 'member';
  return null;
}

function requireRole_(p, email, team, roles) {
  var r = roleOf_(p, email, team);
  if (!r || roles.indexOf(r) < 0) throw userError_(r ? 'Only the owner of this board can do that.' : "You don't have access to this board.");
  return r;
}

function joinCode_() {
  var a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 6; i++) s += a.charAt(Math.floor(Math.random() * a.length));
  return s;
}

function projectSummary_(p, email, team) {
  var role = roleOf_(p, email, team);
  var manage = role === 'owner' || role === 'admin';
  return {
    id: p.id, name: p.name, client: p.client, owner: p.owner, ownerName: p.ownerName || firstName_(p.owner),
    role: role, members: Object.keys(p.members || {}).length,
    requests: manage ? Object.keys(p.requests || {}).length : 0,
    code: manage ? p.code : null, created: p.created,
  };
}

function folders_(p) {
  var dir = DriveApp.getFolderById(p.folderId);
  return { dir: dir, media: child_(dir, 'media', true), changes: child_(dir, 'changes', true) };
}

function notify_(to, subject, body) {
  try { MailApp.sendEmail({ to: to, subject: subject, body: body + '\n\nEye Refs by Matte Black', name: 'Eye Refs' }); } catch (x) {}
}

// ---------------------------------------------------------------- API

var API = {};

API['auth.request'] = function (req) {
  var email = String(req.email || '').trim().toLowerCase();
  if (!validEmail_(email)) throw userError_('Enter a valid email address.');
  var cache = CacheService.getScriptCache();
  var tries = Number(cache.get('rl:' + email) || 0);
  if (tries >= 5) throw userError_('Too many codes requested. Try again in 10 minutes.');
  cache.put('rl:' + email, String(tries + 1), 600);
  var code = String(100000 + Math.floor(Math.random() * 900000));
  cache.put('code:' + email, JSON.stringify({ h: sign_(code + email), n: 0 }), CFG.CODE_MINUTES * 60);
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
  var cache = CacheService.getScriptCache();
  var raw = cache.get('code:' + email);
  if (!raw) throw userError_('That code has expired. Ask for a new one.');
  var rec = JSON.parse(raw);
  if (rec.n >= 5) { cache.remove('code:' + email); throw userError_('Too many wrong codes. Ask for a new one.'); }
  if (sign_(code + email) !== rec.h) {
    rec.n += 1;
    cache.put('code:' + email, JSON.stringify(rec), CFG.CODE_MINUTES * 60);
    throw userError_("That code isn't right. Check the email and try again.");
  }
  cache.remove('code:' + email);
  var name = String(req.name || '').trim().slice(0, 40) || firstName_(email);
  return { token: makeToken_(email, name), email: email, name: name };
};

API['me'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  // A fresh token each launch: people who use the app never have to enter a code again
  return { email: me.email, name: me.name, team: isTeam_(me.email), admin: isAdmin_(me.email, team), clients: team.clients || [], owner: ownerEmail_(), token: makeToken_(me.email, me.name) };
};

API['clients.save'] = function (req) {
  var me = readToken_(req.token);
  return withTeam_(function (team) {
    if (!isAdmin_(me.email, team)) throw userError_('Only an admin can change the client list.');
    var seen = {};
    team.clients = (req.clients || []).map(cleanFolderName_).filter(function (c) {
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
    if (team.projects[req.id]) {
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
      owner: me.email, ownerName: me.name, created: Date.now(), code: joinCode_(), members: members, requests: {},
    };
    team.projects[req.id] = p;
    return projectSummary_(p, me.email, team);
  });
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
  var emails = (req.emails || []).map(function (e) { return String(e).trim().toLowerCase(); }).filter(validEmail_);
  if (!emails.length) throw userError_('Add at least one email address.');
  var p = withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    p.members = p.members || {};
    emails.forEach(function (e) {
      if (!p.members[e]) p.members[e] = { name: firstName_(e), at: Date.now(), by: me.email };
      if (p.requests) delete p.requests[e];
    });
    return p;
  });
  emails.forEach(function (e) {
    notify_(e, me.name + ' shared "' + p.name + '" with you', me.name + ' added you to the board "' + p.name + '" in Eye Refs.\n\nOpen Eye Refs and sign in with ' + e + ' to see it.');
  });
  return { added: emails };
};

API['projects.request'] = function (req) {
  var me = readToken_(req.token);
  var code = String(req.code || '').trim().toUpperCase();
  var found = withTeam_(function (team) {
    for (var id in team.projects) {
      var p = team.projects[id];
      if (p.code === code) {
        if (roleOf_(p, me.email, team)) return { p: p, already: true };
        p.requests = p.requests || {};
        p.requests[me.email] = { name: me.name, at: Date.now() };
        return { p: p };
      }
    }
    throw userError_("No board uses that code. Check it with whoever shared it.");
  });
  if (!found.already) {
    notify_(found.p.owner, me.name + ' asked to join "' + found.p.name + '"', me.name + ' (' + me.email + ') asked to join "' + found.p.name + '" in Eye Refs.\n\nOpen the board, press Share and approve or decline.');
  }
  return { name: found.p.name, owner: found.p.ownerName || firstName_(found.p.owner), already: !!found.already };
};

API['projects.decide'] = function (req) {
  var me = readToken_(req.token);
  var email = String(req.email || '').toLowerCase();
  var p = withTeam_(function (team) {
    var p = project_(team, req.id);
    requireRole_(p, me.email, team, ['owner', 'admin']);
    var r = (p.requests || {})[email];
    if (!r) throw userError_('That request is no longer waiting.');
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
    delete (p.members || {})[email];
  });
  return { ok: true };
};

// Everything a computer needs to catch up: newer change files, the media list, who's here.
API['sync.pull'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (!deviceOk_(req.device, me.email)) throw userError_('This computer is not signed in correctly. Sign out and in again.');

  // Presence lives in the cache: no Drive writes for "I'm here"
  var cache = CacheService.getScriptCache();
  var hereKey = 'here:' + p.id;
  var here = JSON.parse(cache.get(hereKey) || '{}');
  var now = Date.now();
  here[req.device] = { name: me.name, email: me.email, device: req.device, at: now };
  var list = [];
  for (var d in here) { if (now - here[d].at > CFG.PRESENCE_SECONDS * 1000) delete here[d]; else list.push(here[d]); }
  cache.put(hereKey, JSON.stringify(here), CFG.PRESENCE_SECONDS * 2);

  var f = folders_(p);
  var known = req.known || {};
  var changes = [];
  var it = f.changes.getFiles();
  while (it.hasNext()) {
    var file = it.next();
    var name = file.getName();
    if (!/\.json$/.test(name) || name === req.device + '.json') continue;
    var m = file.getLastUpdated().getTime();
    if (known[name] && known[name] >= m) continue;
    changes.push({ name: name, modified: m, data: file.getBlob().getDataAsString() });
  }
  var media = [];
  var mi = f.media.getFiles();
  while (mi.hasNext()) {
    var mf = mi.next();
    media.push({ name: mf.getName(), size: mf.getSize() });
  }
  return {
    changes: changes, media: media, here: list,
    project: { name: p.name, client: p.client, owner: p.owner, ownerName: p.ownerName },
  };
};

API['sync.push'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (!deviceOk_(req.device, me.email)) throw userError_('This computer is not signed in correctly. Sign out and in again.');
  if (typeof req.data !== 'string' || req.data.length > 20 * 1024 * 1024) throw userError_('That change file is too large.');
  JSON.parse(req.data);
  var f = folders_(p);
  var name = req.device + '.json';
  var file = fileIn_(f.changes, name);
  if (file) file.setContent(req.data); else f.changes.createFile(name, req.data, 'application/json');
  return { saved: true };
};

API['media.start'] = function (req) {
  var me = readToken_(req.token);
  var team = readTeam_();
  var p = project_(team, req.id);
  requireRole_(p, me.email, team, ['owner', 'admin', 'member']);
  if (!safeName_(req.name)) throw userError_('That file name is not allowed.');
  var f = folders_(p);
  var existing = fileIn_(f.media, req.name);
  if (existing) return { exists: true };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ name: req.name, parents: [f.media.getId()] }),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Length': String(req.size),
      'X-Upload-Content-Type': req.mime || 'application/octet-stream',
    },
    muteHttpExceptions: true,
  });
  var headers = res.getHeaders();
  var url = headers.Location || headers.location;
  if (!url) throw userError_('Google Drive did not accept the upload. Try again.');
  var upload = Utilities.getUuid();
  CacheService.getScriptCache().put('up:' + upload, JSON.stringify({ url: url, id: p.id, by: me.email }), 21600);
  return { upload: upload };
};

API['media.chunk'] = function (req) {
  var me = readToken_(req.token);
  var raw = CacheService.getScriptCache().get('up:' + req.upload);
  if (!raw) throw userError_('That upload expired. It will start again.');
  var up = JSON.parse(raw);
  if (up.by !== me.email) throw userError_("You don't have access to this upload.");
  var bytes = Utilities.base64Decode(req.data);
  if (bytes.length > CFG.MAX_CHUNK) throw userError_('Upload piece too large.');
  var end = Number(req.offset) + bytes.length - 1;
  var res = UrlFetchApp.fetch(up.url, {
    method: 'put',
    contentType: 'application/octet-stream',
    payload: bytes,
    headers: { 'Content-Range': 'bytes ' + req.offset + '-' + end + '/' + req.total },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 308) return { done: false };
  if (code === 200 || code === 201) return { done: true };
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
