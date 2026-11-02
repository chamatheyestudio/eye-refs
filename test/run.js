// node test/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { emptyDeviceFile, mergeFiles, applyWrites, maxClock } = require('../shared/merge');
const { mediaName, cleanFolderName, slug } = require('../shared/names');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
}

(async () => {
  await test('two people editing different items both survive', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    const b = emptyDeviceFile({ key: 'nousaiba-b2' });
    applyWrites(a, [{ id: 'i1', fields: { x: 10, y: 10 } }], 0);
    applyWrites(b, [{ id: 'i2', fields: { x: 50, y: 50 } }], 0);
    const m = mergeFiles([a, b]);
    assert.equal(m.i1.x, 10);
    assert.equal(m.i2.x, 50);
  });

  await test('later edit wins on the same item, by edit counter not clock time', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    const b = emptyDeviceFile({ key: 'nousaiba-b2' });
    applyWrites(a, [{ id: 'i1', fields: { x: 10 } }], 0);
    // b has seen a's file, so its edit counts as later
    applyWrites(b, [{ id: 'i1', fields: { x: 99 } }], maxClock([a, b]));
    assert.equal(mergeFiles([a, b]).i1.x, 99);
    applyWrites(a, [{ id: 'i1', fields: { x: 5 } }], maxClock([a, b]));
    assert.equal(mergeFiles([a, b]).i1.x, 5);
  });

  await test('edits to different fields of one item combine', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    const b = emptyDeviceFile({ key: 'nousaiba-b2' });
    applyWrites(a, [{ id: 'i1', fields: { x: 10, gray: false } }], 0);
    applyWrites(b, [{ id: 'i1', fields: { gray: true } }], maxClock([a, b]));
    applyWrites(a, [{ id: 'i1', fields: { x: 20 } }], maxClock([a, b]));
    const m = mergeFiles([a, b]);
    assert.equal(m.i1.x, 20);
    assert.equal(m.i1.gray, true);
  });

  await test('simultaneous edits resolve the same way on every computer', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    const b = emptyDeviceFile({ key: 'nousaiba-b2' });
    applyWrites(a, [{ id: 'i1', fields: { x: 1 } }], 0);
    applyWrites(b, [{ id: 'i1', fields: { x: 2 } }], 0);
    assert.deepEqual(mergeFiles([a, b]).i1.x, mergeFiles([b, a]).i1.x);
  });

  await test('a deleted item stays restorable', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    applyWrites(a, [{ id: 'i1', fields: { src: 'x.jpg', x: 0 } }], 0);
    applyWrites(a, [{ id: 'i1', fields: { deleted: true } }], 0);
    let m = mergeFiles([a]);
    assert.equal(m.i1.deleted, true);
    assert.equal(m.i1.src, 'x.jpg');
    applyWrites(a, [{ id: 'i1', fields: { deleted: false } }], 0);
    m = mergeFiles([a]);
    assert.equal(m.i1.deleted, false);
  });

  await test('same person on two computers never overwrites', () => {
    const mac = emptyDeviceFile({ key: 'chamath-mac1' });
    const pc = emptyDeviceFile({ key: 'chamath-pc22' });
    applyWrites(mac, [{ id: 'i1', fields: { note: 'from mac' } }], 0);
    applyWrites(pc, [{ id: 'i2', fields: { note: 'from pc' } }], 0);
    const m = mergeFiles([mac, pc]);
    assert.equal(m.i1.note, 'from mac');
    assert.equal(m.i2.note, 'from pc');
  });

  await test('Drive conflicted copy of a file merges back cleanly', () => {
    const a = emptyDeviceFile({ key: 'chamath-a1' });
    applyWrites(a, [{ id: 'i1', fields: { x: 1 } }], 0);
    const copy = JSON.parse(JSON.stringify(a));
    applyWrites(a, [{ id: 'i1', fields: { x: 2 } }], 0);
    assert.equal(mergeFiles([copy, a]).i1.x, 2);
  });

  await test('media names are unique even for the same original name', () => {
    const names = new Set();
    for (let i = 0; i < 20000; i++) names.add(mediaName('IMG_0012.jpg', 'CH', 'jpg'));
    assert.equal(names.size, 20000);
    assert.match(mediaName('IMG_0012.JPG', 'ch', 'JPG'), /^\d{4}-\d{2}-\d{2}_CH_[a-z0-9]{8}_img-0012\.jpg$/);
  });

  await test('names are safe on Windows and Mac', () => {
    assert.equal(cleanFolderName('Spring: "Campaign"?'), 'Spring Campaign');
    assert.equal(cleanFolderName('Lunar New Year...'), 'Lunar New Year');
    assert.equal(cleanFolderName('CON'), 'CON_');
    assert.equal(slug('Café Menu*Final'), 'café-menu-final');
    assert.equal(slug('aux'), 'file');
    assert.ok(cleanFolderName('x'.repeat(200)).length <= 60);
    const nfd = 'Café';
    assert.equal(cleanFolderName(nfd), 'Café'.normalize('NFC'));
  });

  await test('local projects in Documents: create, merge two devices, survive a restart', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-test-'));
    const lib = require('../main/library');
    const { Session } = require('../main/session');
    const root = path.join(tmp, 'Documents', 'Eye Refs');
    const chamath = { email: 'chamath@eyestudio.ae', name: 'Chamath', initials: 'CH', deviceKey: 'chamath-aaa111' };
    const mac2 = { ...chamath, deviceKey: 'chamath-bbb222' };
    const rec = await lib.createProject(root, chamath, 'Spring Campaign', '');
    const rec2 = await lib.createProject(root, chamath, 'Spring Campaign', '');
    assert.notEqual(rec.dir, rec2.dir, 'second project with the same name gets its own folder');
    assert.ok(rec.file.endsWith(path.join('Eye Refs', 'Spring Campaign', 'Spring Campaign.eyerefs')));
    const oldRoot = path.join(tmp, 'old');
    const old = await lib.createProject(oldRoot, chamath, 'Old Board', 'Hutong');
    await lib.createProject(oldRoot, chamath, 'New Board', '');
    assert.equal((await lib.scanProjects(oldRoot, chamath)).length, 2, 'boards in client folders from older betas still show');
    assert.ok(old.dir.includes('Hutong'));

    const noop = { state() {}, status() {}, presence() {} };
    let saved = 0;
    const s1 = new Session(rec, chamath, path.join(tmp, 'bk1'), noop, { onSaved: () => saved++ });
    const s2 = new Session(rec, mac2, path.join(tmp, 'bk2'), noop);
    await s1.open(); await s2.open();
    s1.write([{ id: 'a', fields: { src: 'a.jpg', x: 1 } }]);
    await s1.flush();
    assert.equal(saved, 1, 'sync is told after each save');
    await s2.poll(true);
    s2.write([{ id: 'a', fields: { x: 42 } }, { id: 'b', fields: { src: 'b.jpg' } }]);
    await s2.flush();
    await s1.poll(true);
    const m = s1.merged();
    assert.equal(m.a.x, 42);
    assert.equal(m.b.src, 'b.jpg');
    await s1.close(); await s2.close();

    fs.unlinkSync(path.join(rec.dir, 'changes', 'chamath-aaa111.json'));
    const s3 = new Session(rec, chamath, path.join(tmp, 'bk1'), noop);
    await s3.open();
    assert.equal(s3.merged().a.src, 'a.jpg', 'local backup restores a lost file');
    await s3.close();
    assert.equal((await lib.scanProjects(root, chamath)).length, 2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('shared board: two people sync edits and media through the EyeStudio Drive', async () => {
    const { createGas } = require('./gas-shim');
    const { Cloud } = require('../main/cloud');
    const { Sync } = require('../main/sync');
    const lib = require('../main/library');
    const { Session } = require('../main/session');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-sync-'));
    const gas = createGas(path.join(tmp, 'drive'), 'contact@eyestudio.ae');
    const srv = await gas.listen();
    const cleanup = [];
    try {
    const tokenFor = (email) => {
      gas.call({ action: 'auth.request', email });
      const m = [...gas.mail].reverse().find((x) => x.to === email);
      return gas.call({ action: 'auth.verify', email, code: /code is (\d{6})/.exec(m.body)[1] }).data.token;
    };
    const tA = tokenFor('chamath@eyestudio.ae'), tB = tokenFor('nousaiba@eyestudio.ae');
    const cloudA = new Cloud(() => srv.url, () => tA, fetch), cloudB = new Cloud(() => srv.url, () => tB, fetch);
    const A = { email: 'chamath@eyestudio.ae', name: 'Chamath', initials: 'CH', deviceKey: 'chamath-aaa111' };
    const Bm = { email: 'nousaiba@eyestudio.ae', name: 'Nousaiba', initials: 'NO', deviceKey: 'nousaiba-bbb222' };
    const rootA = path.join(tmp, 'A', 'Eye Refs'), rootB = path.join(tmp, 'B', 'Eye Refs');

    // Chamath makes a local board with a 13MB "video", then shares it
    const recA = await lib.createProject(rootA, A, 'Spring Campaign', '');
    const big = Buffer.alloc(13 * 1024 * 1024 + 12345, 3); big.write('VIDEO', 0);
    fs.writeFileSync(path.join(recA.dir, 'media', '2026-11-02_CH_aaaaaaaa_reel.mp4'), big);
    const noop = { state() {}, status() {}, presence() {} };
    const sA = new Session(recA, A, path.join(tmp, 'bkA'), noop);
    await sA.open();
    sA.write([{ id: 'i1', fields: { type: 'video', src: '2026-11-02_CH_aaaaaaaa_reel.mp4', x: 10 } }]);
    await sA.flush();
    await cloudA.call('projects.create', { id: recA.id, name: recA.name, client: recA.client });
    await lib.updateProject(recA, { shared: { id: recA.id } });
    recA.shared = { id: recA.id };
    await cloudA.call('projects.invite', { id: recA.id, emails: ['nousaiba@eyestudio.ae'] });
    const syncA = new Sync(cloudA, recA, A, { presence() {}, status() {} });
    cleanup.push(() => syncA.stop(), () => sA.close());
    await syncA.tick();
    await syncA.settle();
    const driveMedia = path.join(tmp, 'drive', 'Eye Refs', 'Spring Campaign', 'media', '2026-11-02_CH_aaaaaaaa_reel.mp4');
    assert.equal(fs.statSync(driveMedia).size, big.length, 'video uploaded in pieces to the same path in Drive');

    // Nousaiba sees it, gets a local copy in her Documents and the video comes down
    const list = await cloudB.call('projects.list');
    assert.equal(list.length, 1);
    const recB = await lib.createProject(rootB, Bm, list[0].name, list[0].client, { id: list[0].id, owner: { email: list[0].owner }, shared: { id: list[0].id } });
    assert.ok(recB.dir.endsWith(path.join('B', 'Spring Campaign')) || recB.dir.endsWith('Spring Campaign'));
    let hereB = [];
    const syncB = new Sync(cloudB, recB, Bm, { presence: (l) => { hereB = l; }, status() {} });
    cleanup.push(() => syncB.stop());
    await syncB.tick();
    await syncB.settle();
    const gotB = fs.readFileSync(path.join(recB.dir, 'media', '2026-11-02_CH_aaaaaaaa_reel.mp4'));
    assert.ok(gotB.equals(big), 'video arrives byte for byte');
    const sB = new Session(recB, Bm, path.join(tmp, 'bkB'), noop, { onSaved: () => syncB.kick(0) });
    await sB.open();
    assert.equal(sB.merged().i1.x, 10, 'board arrives');
    assert.equal(hereB.length, 1, 'Nousaiba sees Chamath is here');

    // She moves it; Chamath gets the move
    sB.write([{ id: 'i1', fields: { x: 99 } }]);
    await sB.flush();
    await syncB.tick();
    await syncA.tick();
    await sA.poll(true);
    assert.equal(sA.merged().i1.x, 99);
    assert.ok(!fs.readdirSync(path.join(recB.dir, 'media')).some((f) => f.includes('.part')), 'no half files left');

    cleanup.push(() => syncA.stop(), () => syncB.stop(), () => sA.close(), () => sB.close());
    } finally {
      for (const c of cleanup) { try { await c(); } catch (_) {} }
      srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('save as one file, then open it as a new copy', async () => {
    const lib = require('../main/library');
    const { pack, unpack, isPacked } = require('../main/pack');
    const { Session } = require('../main/session');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-pack-'));
    const me = { email: 'chamath@eyestudio.ae', name: 'Chamath', initials: 'CH', deviceKey: 'chamath-aaa111' };
    const rec = await lib.createProject(path.join(tmp, 'A'), me, 'Lunar New Year', '');
    fs.writeFileSync(path.join(rec.dir, 'media', '2026-11-02_CH_bbbbbbbb_lantern.jpg'), Buffer.alloc(50000, 9));
    const s = new Session(rec, me, path.join(tmp, 'bk'), { state() {}, status() {}, presence() {} });
    await s.open();
    s.write([{ id: 'x', fields: { type: 'image', src: '2026-11-02_CH_bbbbbbbb_lantern.jpg', x: 5 } }]);
    await s.close();
    const out = path.join(tmp, 'Lunar New Year.eyerefs');
    const r = await pack(rec, out);
    assert.equal(r.files, 2);
    assert.ok(await isPacked(out));
    assert.ok(!(await isPacked(rec.file)), 'a live project file is not mistaken for a packed one');
    const friend = { email: 'rami@freelancer.com', name: 'Rami', initials: 'RA', deviceKey: 'rami-ccc333' };
    const projectFile = await unpack(out, path.join(tmp, 'B'), friend);
    const rec2 = await lib.openProjectFile(projectFile, friend);
    assert.notEqual(rec2.id, rec.id, 'opened as a new copy');
    assert.equal(rec2.mine, true);
    assert.ok(fs.existsSync(path.join(rec2.dir, 'media', '2026-11-02_CH_bbbbbbbb_lantern.jpg')));
    const s2 = new Session(rec2, friend, path.join(tmp, 'bk2'), { state() {}, status() {}, presence() {} });
    await s2.open();
    assert.equal(s2.merged().x.x, 5, 'the board comes with it');
    await s2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('media import: unique names, reuse duplicates, compress big or unplayable video', async () => {
    const media = require('../main/media');
    const { execFileSync } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-media-'));
    const md = path.join(tmp, 'media');
    const me = { initials: 'CH' };
    const img = path.join(tmp, 'IMG_0012.png');
    execFileSync(media.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x48', '-frames:v', '1', img]);
    const known = new Map();
    const r1 = await media.importFile(md, img, me, known);
    known.set(r1.hash, r1.src);
    const r2 = await media.importFile(md, img, me, known);
    assert.equal(r2.reused, true);
    assert.equal(r2.src, r1.src);
    const r3 = await media.importFile(md, img, me, new Map());
    assert.notEqual(r3.src, r1.src, 'same original name never overwrites');
    assert.ok(fs.existsSync(img), 'original untouched');

    const mkv = path.join(tmp, 'clip.mkv');
    execFileSync(media.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-c:v', 'mpeg4', mkv]);
    const v = await media.importFile(md, mkv, me, new Map());
    assert.equal(v.kind, 'video');
    assert.ok(v.src.endsWith('.mp4'));
    const info = await media.probeInfo(path.join(md, v.src));
    assert.equal(info.codec, 'h264');
    const frame = await media.grabFrame(md, v.src, 0.5, me);
    assert.ok(fs.existsSync(path.join(md, frame.src)) && frame.src.endsWith('.jpg'));
    assert.ok(!fs.readdirSync(md).some((f) => f.includes('.part')), 'no half written files left');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('updates: only newer full releases count', async () => {
    const Module = require('module');
    const load = Module._load;
    Module._load = function (r, ...rest) { return r === 'electron' ? { app: {}, net: {}, shell: {} } : load.call(this, r, ...rest); };
    const { newer } = require('../main/updater');
    Module._load = load;
    assert.ok(newer('1.0.1', '1.0.0'));
    assert.ok(newer('1.0.0', '1.0.0-beta.11'));
    assert.ok(newer('1.10.0', '1.9.9'));
    assert.ok(!newer('1.0.0', '1.0.0'));
    assert.ok(!newer('1.1.0-beta.1', '1.0.0'), 'test versions never go to the team');
  });

  await require('./server.test.js')(test);
  console.log(`\n${passed} passed`);
})();
