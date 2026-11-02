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

  await test('session saves, merges two devices and survives a restart', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-test-'));
    const lib = require('../main/library');
    const { Session } = require('../main/session');
    const md = path.join(tmp, 'My Drive');
    fs.mkdirSync(md, { recursive: true });
    const chamath = { email: 'chamath@eyestudio.ae', name: 'Chamath', initials: 'CH', deviceKey: 'chamath-aaa111' };
    const nousaiba = { email: 'nousaiba@eyestudio.ae', name: 'Nousaiba', initials: 'NO', deviceKey: 'nousaiba-bbb222' };
    await lib.createTeam(md, chamath);
    await lib.saveClients(md, chamath, ['Hutong', 'Jou Jou']);
    await lib.ensureClientFolders(md, ['Hutong', 'Jou Jou']);
    const rec = await lib.createProject(md, chamath, 'Spring Campaign', 'Hutong');
    const rec2 = await lib.createProject(md, chamath, 'Spring Campaign', 'Hutong');
    assert.notEqual(rec.dir, rec2.dir, 'second project with the same name gets its own folder');
    assert.ok(fs.existsSync(rec.file) && rec.file.endsWith('.eyerefs'));

    const noop = { state() {}, status() {}, presence() {} };
    const s1 = new Session(rec, chamath, path.join(tmp, 'bk1'), noop);
    const s2 = new Session({ ...rec, mine: false }, nousaiba, path.join(tmp, 'bk2'), noop);
    await s1.open(); await s2.open();
    s1.write([{ id: 'a', fields: { src: 'a.jpg', x: 1 } }]);
    await s1.flush();
    await s2.poll(true);
    s2.write([{ id: 'a', fields: { x: 42 } }, { id: 'b', fields: { src: 'b.jpg' } }]);
    await s2.flush();
    await s1.poll(true);
    const m = s1.merged();
    assert.equal(m.a.x, 42);
    assert.equal(m.a.src, 'a.jpg');
    assert.equal(m.b.src, 'b.jpg');
    const changes = fs.readdirSync(path.join(rec.dir, 'changes')).filter((f) => !f.startsWith('.'));
    assert.deepEqual(changes.sort(), ['chamath-aaa111.json', 'nousaiba-bbb222.json']);
    const here = await lib.presenceIn(rec.dir, chamath);
    assert.equal(here.length, 1);
    assert.equal(here[0].name, 'Nousaiba');
    await s1.close(); await s2.close();
    assert.equal(fs.readdirSync(path.join(rec.dir, 'here')).filter((f) => !f.startsWith('.')).length, 0, 'presence notes removed on close');

    // Lose the Drive copy: the local backup restores it
    fs.unlinkSync(path.join(rec.dir, 'changes', 'chamath-aaa111.json'));
    const s3 = new Session(rec, chamath, path.join(tmp, 'bk1'), noop);
    await s3.open();
    assert.equal(s3.merged().a.src, 'a.jpg');
    await s3.close();
    assert.ok(fs.existsSync(path.join(rec.dir, 'changes', 'chamath-aaa111.json')), 'restored file written back to Drive');

    const scanned = await lib.scanProjects(md, nousaiba);
    assert.equal(scanned.length, 2);
    assert.ok(scanned.every((p) => p.client === 'Hutong' && p.owner.email === 'chamath@eyestudio.ae' && !p.mine));
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

  console.log(`\n${passed} passed`);
})();
