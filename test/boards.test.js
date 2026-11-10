// Boards as single files: saving, crashes mid save, moving old folders, following
// renamed and deleted files, opening files from anywhere.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const me = { email: 'chamath@eyestudio.ae', name: 'Chamath', initials: 'CH', deviceKey: 'chamath-aaa111' };
const friend = { email: 'rami@freelancer.com', name: 'Rami', initials: 'RA', deviceKey: 'rami-ccc333' };

module.exports = async function (test) {
  const lib = require('../main/library');
  const boards = require('../main/boards');
  const { pack, unpack, readInfo } = require('../main/pack');
  const { Session } = require('../main/session');

  // A board with a picture, a video sized file, an edit and a saved version
  async function makeBoard(root, name, who = me, bytes = 60000) {
    const rec = await lib.createProject(root, who, name, '');
    fs.writeFileSync(path.join(rec.dir, 'media', 'pic.jpg'), Buffer.alloc(bytes, 3));
    fs.mkdirSync(path.join(rec.dir, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(rec.dir, 'versions', 'v1.json'), JSON.stringify({ name: 'Before feedback', items: {} }));
    const s = new Session(rec, who, path.join(os.tmpdir(), 'eyerefs-test-bk'), { state() {}, status() {}, presence() {} });
    await s.open();
    s.write([{ id: 'a', fields: { type: 'image', src: 'pic.jpg', x: 10, y: 20, w: 300 } }]);
    await s.close();
    return rec;
  }
  async function itemsOf(rec, who = me) {
    const s = new Session(rec, who, path.join(rec.dir, '..', '..', 'bk-read-' + Math.random().toString(36).slice(2)), { state() {}, status() {}, presence() {} });
    const items = await s.open();
    await s.close();
    return items;
  }
  const tmpDir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `eyerefs-${n}-`));
  const trashTo = (bin) => async (p) => { fs.mkdirSync(bin, { recursive: true }); fs.renameSync(p, path.join(bin, path.basename(p) + '-' + Date.now())); };

  await test('single file: a saved board is one file with layout, media and versions inside', async () => {
    const tmp = tmpDir('one');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const rec = await makeBoard(store, 'Spring');
    rec.doc = await boards.freeDocPath(root, 'Spring');
    await lib.updateProject(rec, { doc: rec.doc });
    const m = new boards.Mirror();
    const r = await m.now(rec);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(path.basename(rec.doc), 'Spring.eyerefs');
    const info = await readInfo(rec.doc);
    assert.equal(info.id, rec.id);
    assert.equal(info.saveId, rec.saveId, 'the file and the working copy agree');
    assert.ok(!('doc' in info), 'no local paths inside the file');
    assert.deepEqual(fs.readdirSync(root), ['Spring.eyerefs'], 'nothing but the file in the folder');
    // Everything comes back out of it
    const back = await lib.openProjectFile(await unpack(rec.doc, path.join(tmp, 'elsewhere'), me, { keepId: true }), me);
    assert.equal(back.id, rec.id);
    assert.ok(fs.existsSync(path.join(back.dir, 'media', 'pic.jpg')));
    assert.ok(fs.existsSync(path.join(back.dir, 'versions', 'v1.json')), 'saved versions travel in the file');
    assert.equal((await itemsOf(back)).a.x, 10);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('single file: edits write the file a moment later, many edits make one write', async () => {
    const tmp = tmpDir('kick');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const rec = await makeBoard(store, 'Kick');
    rec.doc = await boards.freeDocPath(root, 'Kick');
    let writes = 0;
    const m = new boards.Mirror({ delay: 300, onWritten: () => writes++ });
    for (let i = 0; i < 10; i++) { m.kick(rec); await sleep(20); }
    assert.ok(!fs.existsSync(rec.doc), 'not written while you are still going');
    assert.ok(m.busy(rec.id));
    await sleep(700);
    assert.equal(writes, 1);
    assert.ok(fs.existsSync(rec.doc));
    // Closing writes anything still pending straight away
    m.kick(rec);
    await m.settle(rec);
    assert.equal(writes, 2);
    assert.ok(!m.busy(rec.id));
    // Shared and untitled boards have no file
    m.kick({ ...rec, shared: { id: 'x' } });
    m.kick({ ...rec, id: 'scratch', scratch: true });
    assert.ok(!m.busy('scratch'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('single file: killing the app mid save never leaves a broken file', async () => {
    const tmp = tmpDir('crash');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const rec = await makeBoard(store, 'Crash', me, 12 * 1024 * 1024);
    rec.doc = await boards.freeDocPath(root, 'Crash');
    await lib.updateProject(rec, { doc: rec.doc });
    await new boards.Mirror().now(rec);
    const good = new Set([(await readInfo(rec.doc)).saveId]);
    // A child process saves the board over and over; it gets killed at random moments
    const child = path.join(tmp, 'saver.js');
    fs.writeFileSync(child, `
      const lib = require(${JSON.stringify(path.join(__dirname, '..', 'main', 'library'))});
      const boards = require(${JSON.stringify(path.join(__dirname, '..', 'main', 'boards'))});
      (async () => {
        const rec = await lib.openProjectFile(${JSON.stringify(rec.file)}, null);
        const m = new boards.Mirror({ onWritten: (r) => process.stdout.write('saved ' + r.saveId + '\\n') });
        for (;;) await m.now(rec);
      })();`);
    let kills = 0, sawSaves = 0;
    for (let round = 0; round < 24; round++) {
      const p = spawn(process.execPath, [child], { stdio: ['ignore', 'pipe', 'inherit'] });
      p.stdout.on('data', (d) => { for (const m of String(d).matchAll(/saved (\S+)/g)) { good.add(m[1]); sawSaves++; } });
      await sleep(40 + Math.floor(Math.random() * 400));
      p.kill('SIGKILL');
      await new Promise((r) => p.on('exit', r));
      kills++;
      const info = await readInfo(rec.doc);
      assert.ok(info, `file readable after kill ${kills}`);
      assert.equal(info.id, rec.id);
      // The file holds a whole save (one the app finished, or one finished just before the kill)
      const copy = await lib.openProjectFile(await unpack(rec.doc, path.join(tmp, 'check' + round), me, { keepId: true }), me);
      assert.equal(fs.statSync(path.join(copy.dir, 'media', 'pic.jpg')).size, 12 * 1024 * 1024, 'media whole');
      assert.equal((await itemsOf(copy)).a.x, 10, 'layout whole');
    }
    assert.ok(sawSaves > 0, 'saves did finish between kills');
    // The next save tidies the half written hidden files away
    const leftovers = () => fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
    const fresh = await lib.openProjectFile(rec.file, me);
    await new boards.Mirror().now(fresh);
    assert.deepEqual(leftovers(), []);
    assert.deepEqual(fs.readdirSync(root), ['Crash.eyerefs']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('single file: old board folders in Documents become one file each, shared ones move out of sight', async () => {
    const tmp = tmpDir('migrate');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs'), bin = path.join(tmp, 'Trash');
    const own = await makeBoard(root, 'Moodboard');
    const nested = await makeBoard(path.join(root, 'Old Client'), 'Lookbook'); // early beta layout
    const shared = await lib.createProject(root, me, 'Team Edit', '', { shared: { id: 'shared-1' }, id: 'shared-1' });
    const theirs = await makeBoard(root, 'From Rami', friend); // a board someone sent, opened before
    const ok = await boards.migrate(root, store, me, trashTo(bin));
    assert.equal(ok.length, 4);
    assert.deepEqual(fs.readdirSync(root).sort(), ['From Rami.eyerefs', 'Lookbook.eyerefs', 'Moodboard.eyerefs'], 'only files left in Documents');
    assert.equal(fs.readdirSync(bin).length, 4, 'old folders went to the Trash');
    const inStore = await lib.scanProjects(store, me);
    assert.equal(inStore.length, 4);
    const s = inStore.find((p) => p.id === 'shared-1');
    assert.ok(s && !s.doc, 'shared board has no single file');
    const m = inStore.find((p) => p.id === own.id);
    assert.equal(m.doc, path.join(root, 'Moodboard.eyerefs'));
    assert.equal((await readInfo(m.doc)).saveId, m.saveId);
    assert.equal((await itemsOf(m)).a.x, 10, 'board content intact');
    assert.ok(inStore.find((p) => p.id === nested.id) && inStore.find((p) => p.id === theirs.id));
    // Running again changes nothing
    assert.equal((await boards.migrate(root, store, me, trashTo(bin))).length, 0);
    assert.equal((await lib.scanProjects(store, me)).length, 4);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('single file: a move that fails half way leaves the old folder, and is never done twice', async () => {
    const tmp = tmpDir('migrate2');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const own = await makeBoard(root, 'Stubborn');
    // The Trash refuses: the board is moved, the old folder stays
    const refuse = async () => { throw new Error('no trash'); };
    assert.equal((await boards.migrate(root, store, me, refuse)).length, 1);
    assert.ok(fs.existsSync(own.dir));
    // Next launch: not moved again, just tidied
    let trashed = 0;
    await boards.migrate(root, store, me, async (p) => { trashed++; fs.rmSync(p, { recursive: true }); });
    assert.equal(trashed, 1);
    assert.equal((await lib.scanProjects(store, me)).length, 1, 'no duplicate');
    // A board that can't be written as a file stays exactly where it was
    const tmp2 = tmpDir('migrate3');
    const root2 = path.join(tmp2, 'Eye Refs');
    const b = await makeBoard(root2, 'Locked');
    fs.writeFileSync(path.join(tmp2, 'store'), 'not a folder'); // the store can't be made
    await boards.migrate(root2, path.join(tmp2, 'store'), me, refuse);
    assert.ok(fs.existsSync(path.join(b.dir, 'media', 'pic.jpg')), 'left as it was');
    assert.deepEqual(fs.readdirSync(root2), ['Locked']);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  await test('single file: renamed files are followed, deleted files take their board with them', async () => {
    const tmp = tmpDir('reconcile');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const m = new boards.Mirror();
    const mk = async (name) => { const r = await makeBoard(store, name); r.doc = await boards.freeDocPath(root, name); await lib.updateProject(r, { doc: r.doc }); await m.now(r); return r; };
    const a = await mk('Alpha'), b = await mk('Beta'), c = await mk('Gamma');
    fs.renameSync(a.doc, path.join(root, 'Alpha final.eyerefs'));
    fs.rmSync(b.doc);
    fs.copyFileSync(c.doc, path.join(root, 'Gamma copy.eyerefs')); // a copy made in Finder
    const retired = [];
    const r = await boards.reconcile(root, store, me, { retire: async (x) => { retired.push(x.id); fs.rmSync(x.dir, { recursive: true }); } });
    assert.deepEqual(retired, [b.id]);
    assert.equal(r.boards.find((x) => x.id === a.id).doc, path.join(root, 'Alpha final.eyerefs'));
    assert.equal((await lib.scanProjects(store, me)).find((x) => x.id === a.id).doc, path.join(root, 'Alpha final.eyerefs'), 'remembered');
    assert.equal(r.loose.length, 1);
    assert.equal(r.loose[0].name, 'Gamma copy');
    assert.ok(r.loose[0].id.startsWith('file:'), 'a copy is its own entry');
    // A board that's open or still saving is never touched
    fs.rmSync(c.doc);
    const again = await boards.reconcile(root, store, me, { busy: (x) => x.id === c.id, retire: async () => { throw new Error('should not'); } });
    assert.ok(again.boards.some((x) => x.id === c.id));
    // When the whole folder is missing (a drive not plugged in), nothing goes
    const gone = path.join(tmp, 'Unplugged');
    const r3 = await boards.reconcile(gone, store, me, { retire: async () => { throw new Error('should not'); } });
    assert.equal(r3.loose.length, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test('single file: opening files from anywhere', async () => {
    const tmp = tmpDir('open');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const m = new boards.Mirror();
    const rec = await makeBoard(store, 'Open me');
    rec.doc = await boards.freeDocPath(root, 'Open me');
    await lib.updateProject(rec, { doc: rec.doc });
    await m.now(rec);
    const opt = { retire: async (x) => fs.renameSync(x.dir, path.join(tmp, 'retired-' + x.id)) };
    // Its own file opens the board you have
    assert.equal((await boards.openDoc(rec.doc, store, me, opt)).dir, rec.dir);
    // Moved to the Desktop: still the same board, and it saves there from now on
    const desk = path.join(tmp, 'Desktop', 'Open me.eyerefs');
    fs.mkdirSync(path.dirname(desk));
    fs.renameSync(rec.doc, desk);
    const moved = await boards.openDoc(desk, store, me, opt);
    assert.equal(moved.id, rec.id);
    assert.equal(moved.doc, desk);
    // Duplicated: the copy is a separate board
    const dup = path.join(tmp, 'Desktop', 'Open me copy.eyerefs');
    fs.copyFileSync(desk, dup);
    const copy = await boards.openDoc(dup, store, me, opt);
    assert.notEqual(copy.id, rec.id);
    assert.equal(copy.doc, dup);
    assert.equal((await itemsOf(copy)).a.x, 10);
    // Opening the copy again opens that same copy, not another
    assert.equal((await boards.openDoc(dup, store, me, opt)).id, copy.id);
    // Someone else's board: yours to work on, under a new id
    const tmpR = tmpDir('rami');
    const ramis = await makeBoard(path.join(tmpR, 'store'), 'Rami refs', friend);
    const sent = path.join(tmp, 'Downloads', 'Rami refs.eyerefs');
    fs.mkdirSync(path.dirname(sent));
    await pack(ramis, sent, null, { saveId: 'r1' });
    const got = await boards.openDoc(sent, store, me, opt);
    assert.notEqual(got.id, ramis.id);
    assert.equal(got.owner.email, me.email);
    assert.equal((await boards.openDoc(sent, store, me, opt)).id, got.id, 'and it opens as the same board next time');
    // The file changed outside Eye Refs (an older copy put back): the file wins,
    // the working copy is kept aside
    const backup = path.join(tmp, 'backup.eyerefs');
    fs.copyFileSync(desk, backup);
    const s = new Session(moved, me, path.join(tmp, 'bk'), { state() {}, status() {}, presence() {} });
    await s.open(); s.write([{ id: 'a', fields: { x: 999 } }]); await s.close();
    await m.now(moved);
    assert.equal((await itemsOf(moved)).a.x, 999);
    fs.copyFileSync(backup, desk);
    const restored = await boards.openDoc(desk, store, me, opt);
    assert.equal(restored.id, rec.id);
    assert.equal((await itemsOf(restored)).a.x, 10, 'what the file says');
    assert.ok(fs.existsSync(path.join(tmp, 'retired-' + rec.id)), 'the newer working copy kept aside');
    // A damaged file opens nothing and leaves nothing
    const bad = path.join(tmp, 'bad.eyerefs');
    fs.writeFileSync(bad, fs.readFileSync(desk).subarray(0, 200));
    const before = fs.readdirSync(store).length;
    await assert.rejects(boards.openDoc(bad, store, me, opt));
    assert.equal(fs.readdirSync(store).length, before);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpR, { recursive: true, force: true });
  });

  await test('single file: renaming waits for a save in progress', async () => {
    const tmp = tmpDir('rename');
    const store = path.join(tmp, 'store'), root = path.join(tmp, 'Eye Refs');
    const rec = await makeBoard(store, 'Before', me, 8 * 1024 * 1024);
    rec.doc = await boards.freeDocPath(root, 'Before');
    const m = new boards.Mirror();
    const saving = m.now(rec);
    // Same steps the app runs to rename the file
    const renaming = m.queue(rec, async () => {
      const to = await boards.freeDocPath(root, 'After');
      fs.renameSync(rec.doc, to);
      await lib.updateProject(rec, { doc: to });
      rec.doc = to;
    });
    await Promise.all([saving, renaming]);
    m.kick(rec); await m.settle(rec);
    assert.deepEqual(fs.readdirSync(root), ['After.eyerefs'], 'the old name never comes back');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
};
