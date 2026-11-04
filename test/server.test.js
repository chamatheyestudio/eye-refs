// Tests for server/Code.gs running against a simulated Google account.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGas } = require('./gas-shim');

module.exports = async function (test) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-gas-'));
  let n = 0;
  // A fresh simulated Google account for each test
  const fresh = () => {
    const dir = path.join(tmp, 'acct' + (++n));
    const gas = createGas(path.join(dir, 'drive'), 'contact@eyestudio.ae');
    const codeFor = (email) => { const m = [...gas.mail].reverse().find((x) => x.to === email); return /code is (\d{6})/.exec(m.body)[1]; };
    const signIn = (email, name) => {
      const a = gas.call({ action: 'auth.request', email });
      assert.ok(a.ok, a.error);
      const r = gas.call({ action: 'auth.verify', email, code: codeFor(email), name });
      assert.ok(r.ok, r.error);
      return r.data.token;
    };
    const board = (token, id, name) => { const r = gas.call({ action: 'projects.create', token, id, name }); assert.ok(r.ok, r.error); return r.data; };
    const RealDate = Date;
    let shift = 0;
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
      static now() { return RealDate.now() + shift; }
    }
    gas.ctx.Date = FakeDate;
    const later = (ms) => { shift += ms; };
    return { gas, dir, drive: path.join(dir, 'drive'), codeFor, signIn, board, later };
  };
  const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
  const ID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
  const DAY = 86400000;

  await test('server: email code sign in, wrong codes rejected', () => {
    const { gas, codeFor } = fresh();
    gas.call({ action: 'auth.request', email: 'nousaiba@eyestudio.ae' });
    const bad = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: '000000' });
    assert.equal(bad.ok, false);
    const ok = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: codeFor('nousaiba@eyestudio.ae') });
    assert.ok(ok.ok && ok.data.token);
    const reuse = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: codeFor('nousaiba@eyestudio.ae') });
    assert.equal(reuse.ok, false, 'a code works once');
    const forged = gas.call({ action: 'me', token: ok.data.token.replace(/.$/, 'x') });
    assert.equal(forged.ok, false, 'tampered tokens are refused');
    const info = JSON.parse(gas.ctx.doGet().getContent());
    assert.ok(info.ok && info.data.app === 'Eye Refs');
    assert.ok(!/contact@/.test(JSON.stringify(info)), 'doGet does not reveal the owner email');
  });

  await test('server: share, invite, join request, approve, sync and media', () => {
    const { gas, drive, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');

    assert.ok(gas.call({ action: 'clients.save', token: owner, clients: ['Hutong', 'Jou Jou', 'hutong'] }).ok);
    assert.equal(gas.call({ action: 'clients.save', token: nous, clients: [] }).ok, false, 'only admins edit clients');
    assert.deepEqual(gas.call({ action: 'me', token: nous }).data.clients, ['Hutong', 'Jou Jou']);

    // The freelancer is known through another board, then asks to join this one with the code
    board(owner, ID2, 'Other Board');
    assert.ok(gas.call({ action: 'projects.invite', token: owner, id: ID2, emails: ['studio@freelancer.com'] }).ok);
    const guest = signIn('studio@freelancer.com', 'Rami');
    const meGuest = gas.call({ action: 'me', token: guest }).data;
    assert.deepEqual(meGuest.clients, [], 'clients only go to EyeStudio accounts');
    assert.equal(meGuest.owner, undefined);

    const id = ID;
    assert.equal(gas.call({ action: 'projects.create', token: guest, id, name: 'X', client: 'Hutong' }).ok, false, 'outsiders cannot create shared boards');
    board(owner, id, 'Spring Campaign');
    assert.ok(fs.existsSync(path.join(drive, 'Eye Refs', 'Spring Campaign', 'media')), 'same folder path in Drive');

    assert.equal(gas.call({ action: 'sync.pull', token: nous, id, device: 'nousaiba-aa11' }).ok, false, 'not a member yet');
    assert.ok(gas.call({ action: 'projects.invite', token: owner, id, emails: ['nousaiba@eyestudio.ae'] }).ok);
    assert.ok(gas.mail.some((m) => m.to === 'nousaiba@eyestudio.ae' && /shared/.test(m.subject)), 'invite email sent');

    const code = gas.call({ action: 'projects.members', token: owner, id }).data.code;
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/, '8 character join code');
    const req = gas.call({ action: 'projects.request', token: guest, code: code.toLowerCase() });
    assert.ok(req.ok && req.data.name === 'Spring Campaign', req.error);
    assert.ok(gas.mail.some((m) => m.to === 'contact@eyestudio.ae' && /asked to join/.test(m.subject)), 'owner told about the request');
    assert.equal(gas.call({ action: 'projects.decide', token: nous, id, email: 'studio@freelancer.com', allow: true }).ok, false, 'members cannot approve');
    assert.ok(gas.call({ action: 'projects.decide', token: owner, id, email: 'studio@freelancer.com', allow: true }).ok);
    assert.equal(gas.call({ action: 'projects.list', token: guest }).data.length, 2);

    // Change files: each device writes only its own
    assert.equal(gas.call({ action: 'sync.push', token: nous, id, device: 'contact-xx11', data: '{}' }).ok, false, 'cannot write someone else\'s file');
    assert.ok(gas.call({ action: 'sync.push', token: nous, id, device: 'nousaiba-aa11', data: JSON.stringify({ items: { a: { x: [1, 1] } } }) }).ok);
    // Teammates are told who changed a board last
    const listed = gas.call({ action: 'projects.list', token: owner }).data.find((p) => p.id === id);
    assert.ok(listed.updated && listed.updated.email === 'nousaiba@eyestudio.ae' && listed.updated.at > 0, 'last change is listed');
    const asGuest = gas.call({ action: 'projects.list', token: guest }).data.find((p) => p.id === id);
    assert.ok(asGuest.sharedAt > 0 && asGuest.sharedBy, 'who shared it is listed');
    const pull = gas.call({ action: 'sync.pull', token: owner, id, device: 'contact-zz99' });
    assert.ok(pull.ok, pull.error);
    assert.equal(pull.data.changes.length, 1);
    assert.equal(pull.data.more, false);
    assert.equal(pull.data.changes[0].name, 'nousaiba-aa11.json');
    assert.equal(pull.data.here.length, 1);
    const pull2 = gas.call({ action: 'sync.pull', token: owner, id, device: 'contact-zz99', known: { 'nousaiba-aa11.json': pull.data.changes[0].modified } });
    assert.equal(pull2.data.changes.length, 0, 'unchanged files are not sent again');
    const pull3 = gas.call({ action: 'sync.pull', token: nous, id, device: 'nousaiba-aa11' });
    assert.equal(pull3.data.here.length, 2, 'both people are here');

    // Media: chunked upload then ranged download
    const blob = Buffer.alloc(300000, 7);
    blob.write('EYEREFS', 0);
    const start = gas.call({ action: 'media.start', token: guest, id, name: '2026-11-02_RA_abcdefgh_ref.jpg', size: blob.length, mime: 'image/jpeg' });
    assert.ok(start.ok, start.error);
    let off = 0;
    while (off < blob.length) {
      const piece = blob.subarray(off, off + 131072);
      const r = gas.call({ action: 'media.chunk', token: guest, upload: start.data.upload, offset: off, total: blob.length, data: piece.toString('base64') });
      assert.ok(r.ok, r.error);
      off += piece.length;
      assert.equal(r.data.done, off >= blob.length);
    }
    assert.equal(gas.call({ action: 'media.start', token: guest, id, name: '../evil', size: 1 }).ok, false, 'path tricks refused');
    assert.ok(gas.call({ action: 'media.start', token: guest, id, name: '2026-11-02_RA_abcdefgh_ref.jpg', size: 1 }).data.exists, 'existing files are not uploaded twice');
    const got = gas.call({ action: 'media.get', token: nous, id, name: '2026-11-02_RA_abcdefgh_ref.jpg', offset: 0, length: 7 });
    assert.equal(Buffer.from(got.data.data, 'base64').toString(), 'EYEREFS');
    assert.equal(got.data.size, blob.length);

    assert.ok(gas.call({ action: 'projects.remove', token: owner, id, email: 'studio@freelancer.com' }).ok);
    assert.equal(gas.call({ action: 'sync.pull', token: guest, id, device: 'studio-bb22' }).ok, false, 'removed people lose access');
    assert.notEqual(gas.call({ action: 'projects.members', token: owner, id }).data.code, code, 'removing someone changes the join code');
  });

  await test('server: only known people get sign in codes, with daily limits', () => {
    const { gas, signIn, board, codeFor } = fresh();
    const before = gas.mail.length;
    const r = gas.call({ action: 'auth.request', email: 'stranger@gmail.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Ask an EyeStudio teammate to invite you first.');
    for (let i = 0; i < 20; i++) gas.call({ action: 'auth.request', email: 'v' + i + '@example.com' });
    assert.equal(gas.mail.length, before, 'no email to unknown addresses');

    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    gas.call({ action: 'projects.invite', token: owner, id: ID, emails: ['guest@x.com'] });
    assert.ok(signIn('guest@x.com', 'Guest'), 'invited guests can sign in');

    // Someone new with a join code can sign in, then ask to join
    const code = gas.call({ action: 'projects.members', token: owner, id: ID }).data.code;
    assert.match(gas.call({ action: 'auth.request', email: 'new@gmail.com', joinCode: 'WRONGCODE' }).error, /No board uses that code/);
    const jr = gas.call({ action: 'auth.request', email: 'new@gmail.com', joinCode: code.toLowerCase() });
    assert.ok(jr.ok, jr.error);
    const nt = gas.call({ action: 'auth.verify', email: 'new@gmail.com', code: codeFor('new@gmail.com') });
    assert.ok(nt.ok, nt.error);
    assert.ok(gas.call({ action: 'projects.request', token: nt.data.token, code }).ok);
    let slowed = false;
    for (let i = 0; i < 25; i++) { const r = gas.call({ action: 'auth.request', email: 'spam@gmail.com', joinCode: 'BAD' + i + 'XYZ' }); if (/Too many tries/.test(r.error || '')) slowed = true; }
    assert.ok(slowed, 'join code sign ins are rate limited');

    gas.setQuota(10);
    assert.match(gas.call({ action: 'auth.request', email: 'nousaiba@eyestudio.ae' }).error, /can't send more sign in emails/);
    gas.setQuota(1500);
    const today = new gas.ctx.Date().toISOString().slice(0, 10);
    gas.props.MAILDAY = JSON.stringify({ d: today, n: 300 });
    assert.match(gas.call({ action: 'auth.request', email: 'nousaiba@eyestudio.ae' }).error, /can't send more sign in emails/, 'global daily limit');
  });

  await test('server: wrong code guesses lock the email for the day', () => {
    const { gas, codeFor, later } = fresh();
    const email = 'nousaiba@eyestudio.ae';
    const wrong = (c) => gas.call({ action: 'auth.verify', email, code: c });
    gas.call({ action: 'auth.request', email });
    for (let i = 0; i < 5; i++) assert.equal(wrong('000000').ok, false);
    assert.equal(gas.call({ action: 'auth.verify', email, code: codeFor(email) }).ok, false, 'code dropped after 5 wrong tries');
    gas.call({ action: 'auth.request', email });
    for (let i = 0; i < 5; i++) wrong('000001');
    gas.call({ action: 'auth.request', email });
    const locked = gas.call({ action: 'auth.verify', email, code: codeFor(email) });
    assert.equal(locked.ok, false, 'a new code does not reset the daily count');
    assert.match(locked.error, /Try again tomorrow/);
    later(DAY + 1000);
    gas.call({ action: 'auth.request', email });
    assert.ok(gas.call({ action: 'auth.verify', email, code: codeFor(email) }).ok, 'works again the next day');
  });

  await test('server: a big team file never breaks the cache, and invites are capped', () => {
    const { gas, drive, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const many = (k, from) => Array.from({ length: k }, (_, i) => 'person.with.a.long.name' + (from + i) + '@example-agency-domain.com');
    board(owner, ID, 'Spring');
    assert.equal(gas.call({ action: 'projects.invite', token: owner, id: ID, emails: many(51, 0) }).ok, false, 'max 50 per invite');
    assert.ok(gas.call({ action: 'projects.invite', token: owner, id: ID, emails: many(50, 0) }).ok);
    assert.ok(gas.call({ action: 'projects.invite', token: owner, id: ID, emails: many(49, 50) }).ok);
    assert.match(gas.call({ action: 'projects.invite', token: owner, id: ID, emails: many(2, 99) }).error, /up to 100 people/, 'max 100 per board');
    for (let b = 0; b < 12; b++) {
      const id = 'b0000000-0000-4000-8000-0000000000' + String(b).padStart(2, '0');
      board(owner, id, 'Board ' + b);
      assert.ok(gas.call({ action: 'projects.invite', token: owner, id, emails: many(50, 1000 + b * 100) }).ok);
      assert.ok(gas.call({ action: 'projects.invite', token: owner, id, emails: many(49, 1050 + b * 100) }).ok);
    }
    assert.ok(fs.statSync(path.join(drive, 'Eye Refs', '.eyerefs-team.json')).size > 100000, 'team file is over the cache limit');
    gas.cache.delete('team');
    for (const action of ['me', 'projects.list']) {
      const r = gas.call({ action, token: owner });
      assert.ok(r.ok, action + ': ' + r.error);
    }
    assert.ok(gas.call({ action: 'sync.pull', token: owner, id: ID, device: 'contact-aaaaaa' }).ok);
    assert.ok(gas.call({ action: 'projects.remove', token: owner, id: ID, email: many(1, 0)[0] }).ok);
    assert.ok(gas.call({ action: 'projects.list', token: owner }).data.length === 13);
  });

  await test('server: an older team copy never replaces a newer one in the cache', () => {
    const { gas, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    const stale = gas.ctx.readTeamFile_();
    assert.ok(gas.call({ action: 'projects.rename', token: owner, id: ID, name: 'Summer' }).ok);
    gas.ctx.cacheTeam_(stale); // a slow reader finishing late
    assert.equal(gas.call({ action: 'projects.list', token: owner }).data[0].name, 'Summer');
    gas.cache.delete('team');
    gas.ctx.cacheTeam_(stale);
    assert.equal(gas.cache.get('team'), undefined, 'stale copy not put back');
    assert.equal(gas.call({ action: 'projects.list', token: owner }).data[0].name, 'Summer');
  });

  await test('server: device files belong to whoever wrote them first', () => {
    const { gas, drive, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    gas.call({ action: 'projects.invite', token: owner, id: ID, emails: ['contact@freelancer.com', 'nousaiba@eyestudio.ae'] });
    const evil = signIn('contact@freelancer.com', 'Chamath');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    assert.ok(gas.call({ action: 'sync.push', token: owner, id: ID, device: 'contact-abc123', data: '{"items":{"real":1}}' }).ok);
    const r = gas.call({ action: 'sync.push', token: evil, id: ID, device: 'contact-abc123', data: '{"items":{}}' });
    assert.equal(r.ok, false, 'same email name on another domain cannot overwrite');
    assert.equal(gas.call({ action: 'sync.pull', token: evil, id: ID, device: 'contact-abc123' }).ok, false);
    const changes = path.join(drive, 'Eye Refs', 'Spring', 'changes');
    assert.equal(fs.readFileSync(path.join(changes, 'contact-abc123.json'), 'utf8'), '{"items":{"real":1}}');

    // Files from before ownership was recorded: the first matching pusher claims them
    fs.writeFileSync(path.join(changes, 'nousaiba-old111.json'), '{"items":{"old":1}}');
    assert.ok(gas.call({ action: 'sync.push', token: nous, id: ID, device: 'nousaiba-old111', data: '{"items":{"new":1}}' }).ok);
    assert.equal(gas.ctx.readTeamFile_().projects[ID].devices['nousaiba-old111'], 'nousaiba@eyestudio.ae');

    // At most 6 computers per person per board
    for (let i = 2; i <= 6; i++) assert.ok(gas.call({ action: 'sync.push', token: nous, id: ID, device: 'nousaiba-dev' + i, data: '{}' }).ok);
    assert.match(gas.call({ action: 'sync.push', token: nous, id: ID, device: 'nousaiba-dev7', data: '{}' }).error, /6 computers/);
    assert.ok(gas.call({ action: 'sync.push', token: nous, id: ID, device: 'nousaiba-dev3', data: '{"a":1}' }).ok, 'known computers keep working');
  });

  await test('server: big change files are capped and pull sends the rest with more', () => {
    const { gas, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    const big = JSON.stringify({ pad: 'x'.repeat(1500 * 1024) });
    assert.equal(gas.call({ action: 'sync.push', token: owner, id: ID, device: 'contact-a1', data: JSON.stringify({ pad: 'x'.repeat(2100 * 1024) }) }).ok, false, 'over 2MB refused');
    assert.equal(gas.call({ action: 'sync.push', token: owner, id: ID, device: 'contact-a1', data: JSON.stringify(['\u0001'.repeat(1024 * 1024)]) }).ok, false, 'escapes into a huge reply, refused');
    for (const d of ['contact-a1', 'contact-a2', 'contact-a3']) assert.ok(gas.call({ action: 'sync.push', token: owner, id: ID, device: d, data: big }).ok);
    const known = {};
    const p1 = gas.call({ action: 'sync.pull', token: owner, id: ID, device: 'contact-zz' }).data;
    assert.equal(p1.changes.length, 2);
    assert.equal(p1.more, true);
    for (const c of p1.changes) known[c.name] = c.modified;
    const p2 = gas.call({ action: 'sync.pull', token: owner, id: ID, device: 'contact-zz', known }).data;
    assert.equal(p2.changes.length, 1);
    assert.equal(p2.more, false);
    assert.ok(!known[p2.changes[0].name]);
  });

  await test('server: uploads stop when someone is removed, and sizes and names are checked', () => {
    const { gas, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    gas.call({ action: 'projects.invite', token: owner, id: ID, emails: ['guest@x.com'] });
    const guest = signIn('guest@x.com', 'Guest');
    const st = gas.call({ action: 'media.start', token: guest, id: ID, name: 'big.bin', size: 20 });
    assert.ok(st.ok, st.error);
    assert.equal(gas.call({ action: 'media.start', token: owner, id: ID, name: 'big.bin', size: 20 }).ok, false, 'same name already uploading');
    assert.ok(gas.call({ action: 'projects.remove', token: owner, id: ID, email: 'guest@x.com' }).ok);
    const chunk = gas.call({ action: 'media.chunk', token: guest, upload: st.data.upload, offset: 0, total: 20, data: Buffer.alloc(20, 1).toString('base64') });
    assert.equal(chunk.ok, false, 'removed people cannot keep uploading');

    assert.match(gas.call({ action: 'media.start', token: owner, id: ID, name: 'huge.mp4', size: 2 * 1024 ** 3 + 1 }).error, /up to 2GB/);
    // 20 bytes are still reserved by the removed guest's upload
    for (let i = 0; i < 9; i++) assert.ok(gas.call({ action: 'media.start', token: owner, id: ID, name: 'v' + i + '.mp4', size: 2 * 1024 ** 3 }).ok);
    assert.match(gas.call({ action: 'media.start', token: owner, id: ID, name: 'v9.mp4', size: 2 * 1024 ** 3 }).error, /20GB/, 'board total capped');
    assert.ok(gas.call({ action: 'media.start', token: owner, id: ID, name: 'v9.mp4', size: 2 * 1024 ** 3 - 100 }).ok);

    for (const bad of ['CON', 'nul.txt', 'Lpt3.jpg', 'com1', '.hidden', 'a/b.jpg', 'a\\b.jpg', 'café.jpg', 'x.jpg.', 'x:y.jpg', '-x.jpg']) {
      assert.equal(gas.ctx.safeName_(bad), false, bad);
    }
    for (const good of ['2026-11-02_RA_abcdefgh_ref.jpg', 'a', 'Con-test.jpg', 'console.png']) assert.equal(gas.ctx.safeName_(good), true, good);
  });

  await test('server: rename, delete and missing folders', () => {
    const { gas, drive, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    board(owner, ID, 'Spring');
    gas.call({ action: 'projects.invite', token: owner, id: ID, emails: ['nousaiba@eyestudio.ae'] });
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    assert.equal(gas.call({ action: 'projects.rename', token: nous, id: ID, name: 'Hack' }).ok, false, 'members cannot rename');
    const r = gas.call({ action: 'projects.rename', token: owner, id: ID, name: 'Summer: Launch' });
    assert.ok(r.ok, r.error);
    assert.equal(r.data.name, 'Summer Launch');
    assert.ok(fs.existsSync(path.join(drive, 'Eye Refs', 'Summer Launch', 'media')), 'Drive folder renamed');
    assert.equal(gas.call({ action: 'projects.list', token: nous }).data[0].name, 'Summer Launch');
    assert.ok(gas.call({ action: 'sync.pull', token: nous, id: ID, device: 'nousaiba-aa' }).ok, 'still syncs after rename');

    assert.equal(gas.call({ action: 'projects.delete', token: nous, id: ID }).ok, false, 'members cannot delete');
    assert.ok(gas.call({ action: 'projects.delete', token: owner, id: ID }).ok);
    assert.ok(!fs.existsSync(path.join(drive, 'Eye Refs', 'Summer Launch')), 'folder trashed');
    assert.equal(gas.call({ action: 'projects.list', token: nous }).data.length, 0);
    assert.equal(gas.call({ action: 'sync.pull', token: nous, id: ID, device: 'nousaiba-aa' }).error, 'That board is no longer shared.');

    board(owner, ID2, 'Gone');
    fs.rmSync(path.join(drive, 'Eye Refs', 'Gone'), { recursive: true });
    assert.match(gas.call({ action: 'sync.pull', token: owner, id: ID2, device: 'contact-aa' }).error, /folder is missing/);
    assert.match(gas.call({ action: 'projects.rename', token: owner, id: ID2, name: 'X' }).error, /folder is missing/);
    assert.ok(gas.call({ action: 'projects.delete', token: owner, id: ID2 }).ok, 'a board with a missing folder can still be deleted');
  });

  await test('server: revoke signs someone out and refreshes stop after a year', () => {
    const { gas, signIn, later } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    assert.equal(gas.call({ action: 'auth.revoke', token: nous, email: 'contact@eyestudio.ae' }).ok, false, 'only admins revoke');
    const refreshed = gas.call({ action: 'me', token: nous }).data.token;
    assert.ok(gas.call({ action: 'auth.revoke', token: owner, email: 'nousaiba@eyestudio.ae' }).ok);
    assert.match(gas.call({ action: 'me', token: nous }).error, /sign in again/i);
    assert.match(gas.call({ action: 'me', token: refreshed }).error, /sign in again/i);
    let t = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    assert.ok(gas.call({ action: 'me', token: t }).ok, 'signing in again works');

    // Refresh every 80 days: fine until a year after the code sign in
    for (let i = 0; i < 4; i++) { later(80 * DAY); const r = gas.call({ action: 'me', token: t }); assert.ok(r.ok, r.error); t = r.data.token; }
    later(80 * DAY);
    assert.match(gas.call({ action: 'me', token: t }).error, /expired/);
  });

  await test('server: join codes are rate limited and the owner is emailed once', () => {
    const { gas, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const p = board(owner, ID, 'Spring');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    const before = gas.mail.filter((m) => /asked to join/.test(m.subject)).length;
    for (let i = 0; i < 3; i++) assert.ok(gas.call({ action: 'projects.request', token: nous, code: p.code }).ok);
    assert.equal(gas.mail.filter((m) => /asked to join/.test(m.subject)).length - before, 1, 'one email per requester');
    const rot = gas.call({ action: 'projects.rotateCode', token: owner, id: ID });
    assert.ok(rot.ok && rot.data.code !== p.code);
    assert.equal(gas.call({ action: 'projects.rotateCode', token: nous, id: ID }).ok, false);
    assert.equal(gas.call({ action: 'projects.request', token: nous, code: p.code }).ok, false, 'old code stops working');
    let limited = false;
    for (let i = 0; i < 25; i++) { const r = gas.call({ action: 'projects.request', token: nous, code: 'WRONG' + i }); if (/Too many tries/.test(r.error || '')) limited = true; }
    assert.ok(limited, 'guessing is rate limited');
  });

  await test('server: internal errors are logged, not shown', () => {
    const { gas, signIn } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const real = gas.ctx.DriveApp.getRootFolder;
    const realError = console.error;
    const logged = [];
    gas.ctx.DriveApp.getRootFolder = () => { throw new Error('Drive exploded at /secret/path'); };
    console.error = (m) => logged.push(m);
    gas.cache.delete('team');
    const r = gas.call({ action: 'projects.list', token: owner });
    console.error = realError;
    gas.ctx.DriveApp.getRootFolder = real;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Something went wrong on the server. Try again.');
    assert.ok(logged.some((m) => /Drive exploded/.test(m)));
  });

  await test('server: view link shows the board to anyone, read only, and can be turned off', () => {
    const { gas, drive, signIn, board } = fresh();
    const owner = signIn('contact@eyestudio.ae', 'Contact');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    board(owner, ID, 'Spring Campaign');
    // Owner pushes a change file and a picture
    const file = { format: 1, device: { key: 'contact-aaa111' }, clock: 3, items: { a: { type: ['image', 1], src: ['2026-11-04_CO_abcdefgh_x.png', 1], x: [0, 1], y: [0, 1], w: [100, 1], nw: [100, 1], nh: [50, 1] }, b: { type: ['note', 2], text: ['hello', 2], deleted: [true, 3] } } };
    assert.ok(gas.call({ action: 'sync.push', token: owner, id: ID, device: 'contact-aaa111', data: JSON.stringify(file) }).ok);
    fs.writeFileSync(path.join(drive, 'Eye Refs', 'Spring Campaign', 'media', '2026-11-04_CO_abcdefgh_x.png'), Buffer.from('fakepng'));
    // Only the owner can make a link
    assert.equal(gas.call({ action: 'projects.viewLink', token: nous, id: ID, on: true }).ok, false);
    const on = gas.call({ action: 'projects.viewLink', token: owner, id: ID, on: true });
    assert.ok(on.ok && /^[A-Za-z0-9]{24}$/.test(on.data.key));
    const key = on.data.key;
    // Anyone with the key sees merged items (deleted ones left out) and media sizes, no token needed
    const st = gas.ctx.viewState(key);
    assert.ok(st.ok, st.error);
    assert.equal(st.data.name, 'Spring Campaign');
    assert.deepEqual(st.data.items.map((i) => i.id), ['a']);
    assert.equal(st.data.media['2026-11-04_CO_abcdefgh_x.png'], 7);
    assert.equal(st.data.downloads.windows, 'https://example.com/win.exe');
    const m = gas.ctx.viewMedia(key, '2026-11-04_CO_abcdefgh_x.png', 0);
    assert.equal(Buffer.from(m.data.data, 'base64').toString(), 'fakepng');
    assert.equal(gas.ctx.viewMedia(key, '../secret', 0).ok, false);
    // The page itself
    const page = gas.ctx.doGet({ parameter: { v: key } });
    assert.ok(page.html && page.getContent().includes(key) && page.getContent().includes('View only'));
    // Nothing that changes the board is reachable with a view key
    assert.equal(gas.call({ action: 'sync.push', key, id: ID, device: 'x-1', data: '{}' }).ok, false);
    // Turning it off kills the link
    assert.ok(gas.call({ action: 'projects.viewLink', token: owner, id: ID, on: false }).ok);
    const off = gas.ctx.viewState(key);
    assert.equal(off.ok, false);
    assert.match(off.error, /turned off/);
    assert.equal(gas.ctx.viewState('nope').ok, false);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
};
