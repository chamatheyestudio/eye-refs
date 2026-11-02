// Tests for server/Code.gs running against a simulated Google account.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGas } = require('./gas-shim');

module.exports = async function (test) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-gas-'));
  const gas = createGas(path.join(tmp, 'drive'), 'contact@eyestudio.ae');
  const codeFor = (email) => { const m = [...gas.mail].reverse().find((x) => x.to === email); return /code is (\d{6})/.exec(m.body)[1]; };
  const signIn = (email, name) => {
    assert.ok(gas.call({ action: 'auth.request', email }).ok);
    const r = gas.call({ action: 'auth.verify', email, code: codeFor(email), name });
    assert.ok(r.ok, r.error);
    return r.data.token;
  };

  await test('server: email code sign in, wrong codes rejected', () => {
    gas.call({ action: 'auth.request', email: 'nousaiba@eyestudio.ae' });
    const bad = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: '000000' });
    assert.equal(bad.ok, false);
    const ok = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: codeFor('nousaiba@eyestudio.ae') });
    assert.ok(ok.ok && ok.data.token);
    const reuse = gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: codeFor('nousaiba@eyestudio.ae') });
    assert.equal(reuse.ok, false, 'a code works once');
    const forged = gas.call({ action: 'me', token: ok.data.token.replace(/.$/, 'x') });
    assert.equal(forged.ok, false, 'tampered tokens are refused');
  });

  await test('server: share, invite, join request, approve, sync and media', () => {
    const owner = signIn('contact@eyestudio.ae', 'Chamath');
    const nous = signIn('nousaiba@eyestudio.ae', 'Nousaiba');
    const guest = signIn('studio@freelancer.com', 'Rami');

    assert.ok(gas.call({ action: 'clients.save', token: owner, clients: ['Hutong', 'Jou Jou', 'hutong'] }).ok);
    assert.equal(gas.call({ action: 'clients.save', token: nous, clients: [] }).ok, false, 'only admins edit clients');
    assert.deepEqual(gas.call({ action: 'me', token: nous }).data.clients, ['Hutong', 'Jou Jou']);

    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    assert.equal(gas.call({ action: 'projects.create', token: guest, id, name: 'X', client: 'Hutong' }).ok, false, 'outsiders cannot create shared boards');
    const created = gas.call({ action: 'projects.create', token: owner, id, name: 'Spring Campaign' });
    assert.ok(created.ok, created.error);
    assert.ok(fs.existsSync(path.join(tmp, 'drive', 'Eye Refs', 'Spring Campaign', 'media')), 'same folder path in Drive');

    assert.equal(gas.call({ action: 'sync.pull', token: nous, id, device: 'nousaiba-aa11' }).ok, false, 'not a member yet');
    assert.ok(gas.call({ action: 'projects.invite', token: owner, id, emails: ['nousaiba@eyestudio.ae'] }).ok);
    assert.ok(gas.mail.some((m) => m.to === 'nousaiba@eyestudio.ae' && /shared/.test(m.subject)), 'invite email sent');

    const code = gas.call({ action: 'projects.members', token: owner, id }).data.code;
    const req = gas.call({ action: 'projects.request', token: guest, code });
    assert.ok(req.ok && req.data.name === 'Spring Campaign');
    assert.ok(gas.mail.some((m) => m.to === 'contact@eyestudio.ae' && /asked to join/.test(m.subject)), 'owner told about the request');
    assert.equal(gas.call({ action: 'projects.decide', token: nous, id, email: 'studio@freelancer.com', allow: true }).ok, false, 'members cannot approve');
    assert.ok(gas.call({ action: 'projects.decide', token: owner, id, email: 'studio@freelancer.com', allow: true }).ok);
    assert.equal(gas.call({ action: 'projects.list', token: guest }).data.length, 1);

    // Change files: each device writes only its own
    assert.equal(gas.call({ action: 'sync.push', token: nous, id, device: 'contact-xx11', data: '{}' }).ok, false, 'cannot write someone else\'s file');
    assert.ok(gas.call({ action: 'sync.push', token: nous, id, device: 'nousaiba-aa11', data: JSON.stringify({ items: { a: { x: [1, 1] } } }) }).ok);
    const pull = gas.call({ action: 'sync.pull', token: owner, id, device: 'contact-zz99' });
    assert.ok(pull.ok, pull.error);
    assert.equal(pull.data.changes.length, 1);
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
  });

  fs.rmSync(tmp, { recursive: true, force: true });
};
