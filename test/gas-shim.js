// Runs server/Code.gs in Node with stand-ins for the Google services it uses,
// backed by a folder on disk that plays the role of the owner's Google Drive.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const http = require('http');

function createGas(driveDir, ownerEmail) {
  fs.mkdirSync(driveDir, { recursive: true });
  const props = {};
  const cache = new Map(); // key -> { v, exp }
  const mail = [];
  const uploads = new Map(); // session url -> { folder, name, total, buf }
  const ids = new Map(); // id -> absolute path
  let idSeq = 0;
  const idFor = (p) => { for (const [k, v] of ids) if (v === p) return k; const id = 'id' + (++idSeq) + crypto.randomBytes(4).toString('hex'); ids.set(id, p); return id; };
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

  function File(p) {
    return {
      getId: () => idFor(p),
      getName: () => path.basename(p),
      getSize: () => fs.statSync(p).size,
      getLastUpdated: () => fs.statSync(p).mtime,
      getBlob: () => ({ getDataAsString: () => fs.readFileSync(p, 'utf8'), getBytes: () => fs.readFileSync(p) }),
      setContent: (s) => { fs.writeFileSync(p, s); const t = new Date(Date.now() + 1); fs.utimesSync(p, t, t); return File(p); },
    };
  }
  function Folder(p) {
    const list = () => fs.readdirSync(p, { withFileTypes: true });
    return {
      getId: () => idFor(p),
      getName: () => path.basename(p),
      getFoldersByName: (n) => iter(list().filter((e) => e.isDirectory() && e.name === n).map((e) => Folder(path.join(p, e.name)))),
      getFilesByName: (n) => iter(list().filter((e) => e.isFile() && e.name === n).map((e) => File(path.join(p, e.name)))),
      getFiles: () => iter(list().filter((e) => e.isFile()).map((e) => File(path.join(p, e.name)))),
      createFolder: (n) => { fs.mkdirSync(path.join(p, n)); return Folder(path.join(p, n)); },
      createFile: (n, content) => { fs.writeFileSync(path.join(p, n), content); return File(path.join(p, n)); },
    };
  }

  const toBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x));
  const g = {
    console, JSON, Math, Date, Number, String, Object, Array, Error, RegExp,
    Logger: { log: () => {} },
    Session: { getEffectiveUser: () => ({ getEmail: () => ownerEmail }) },
    ScriptApp: { getOAuthToken: () => 'fake-token' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const e = cache.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
        put: (k, v, ttl) => { if (String(v).length > 100000) throw new Error('cache value too large'); cache.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }); },
        remove: (k) => cache.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    MailApp: { sendEmail: (o) => mail.push(o), getRemainingDailyQuota: () => 1500 },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (v, k) => crypto.createHmac('sha256', k).update(toBuf(v)).digest(),
      base64EncodeWebSafe: (x) => toBuf(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      base64Encode: (x) => toBuf(x).toString('base64'),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (b) => ({ getDataAsString: () => toBuf(b).toString('utf8') }),
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }) },
    DriveApp: { getRootFolder: () => Folder(driveDir), getFolderById: (id) => Folder(ids.get(id)) },
    UrlFetchApp: {
      fetch(url, o = {}) {
        const resp = (code, body = Buffer.alloc(0), headers = {}) => ({ getResponseCode: () => code, getHeaders: () => headers, getContent: () => body, getContentText: () => body.toString() });
        if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
          const meta = JSON.parse(o.payload);
          const session = 'https://upload.fake/' + crypto.randomUUID();
          uploads.set(session, { folder: ids.get(meta.parents[0]), name: meta.name, total: Number(o.headers['X-Upload-Content-Length']), buf: Buffer.alloc(0) });
          return resp(200, Buffer.alloc(0), { Location: session });
        }
        if (url.startsWith('https://upload.fake/')) {
          const u = uploads.get(url);
          const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(o.headers['Content-Range']);
          if (+m[1] !== u.buf.length) return resp(400);
          u.buf = Buffer.concat([u.buf, toBuf(o.payload)]);
          if (u.buf.length >= u.total) { fs.writeFileSync(path.join(u.folder, u.name), u.buf); uploads.delete(url); return resp(200); }
          return resp(308);
        }
        const dl = /drive\/v3\/files\/([^?]+)\?alt=media/.exec(url);
        if (dl) {
          const data = fs.readFileSync(ids.get(dl[1]));
          const r = /bytes=(\d+)-(\d+)/.exec(o.headers.Range);
          return resp(206, data.subarray(+r[1], +r[2] + 1));
        }
        if (url.includes('/drive/v3/about')) return resp(200, Buffer.from('{}'));
        throw new Error('unexpected fetch ' + url);
      },
    },
  };
  const ctx = vm.createContext(g);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

  function call(body) {
    const out = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(out.getContent());
  }
  // The app talks HTTP, so serve the script like Google would.
  function listen() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet();
          res.setHeader('content-type', 'application/json');
          res.end(out.getContent());
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/exec`, close: () => srv.close() }));
    });
  }
  return { call, listen, mail, ctx };
}

module.exports = { createGas };
