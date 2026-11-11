// Shared boards: files added just before the board closes (or Eye Refs quits)
// still reach the team.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sync, UNSENT } = require('../main/sync');

const me = { email: 'chamath@eyestudio.ae', name: 'Chamath', deviceKey: 'chamath-aaa111' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend Drive: slow uploads, can go offline
function fakeDrive() {
  const d = { files: new Map(), offline: false, starts: [], slow: 30 };
  const offline = () => Object.assign(new Error('offline'), { kind: 'offline' });
  d.call = async (action, req) => {
    await sleep(5);
    if (d.offline) throw offline();
    if (action === 'sync.push') return { saved: true };
    if (action === 'sync.pull') return { changes: [], media: [...d.files].map(([name, b]) => ({ name, size: b.length })), here: [] };
    if (action === 'media.start') { d.starts.push(req.name); return d.files.has(req.name) ? { exists: true } : { upload: req.name }; }
    if (action === 'media.chunk') {
      await sleep(d.slow);
      if (d.offline) throw offline();
      d.files.set(req.upload, Buffer.from(req.data, 'base64'));
      return {};
    }
    throw new Error('unknown ' + action);
  };
  return d;
}

function board(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-sync-'));
  for (const s of ['changes', 'media']) fs.mkdirSync(path.join(dir, s));
  fs.writeFileSync(path.join(dir, 'changes', me.deviceKey + '.json'), '{}');
  return { id: name, dir, shared: { id: 'S-' + name } };
}
const add = (rec, n) => fs.writeFileSync(path.join(rec.dir, 'media', n), Buffer.alloc(1000, 7));
const quiet = { presence() {}, status() {} };

module.exports = async function (test) {
  await test('shared board: files still go up after the board closes', async () => {
    const drive = fakeDrive();
    const rec = board('a');
    add(rec, 'one.jpg');
    const y = new Sync(drive, rec, me, quiet);
    await y.tick(); // one.jpg queued and going up
    add(rec, 'two.jpg'); add(rec, 'three.jpg'); // added after the last check
    await y.stop();
    await y.finish();
    assert.deepEqual([...drive.files.keys()].sort(), ['one.jpg', 'three.jpg', 'two.jpg']);
    assert.ok(!fs.existsSync(path.join(rec.dir, UNSENT)), 'nothing left to send');
  });

  await test('shared board: offline at close, the rest goes next launch', async () => {
    const drive = fakeDrive();
    const rec = board('b');
    const y = new Sync(drive, rec, me, quiet);
    await y.tick();
    add(rec, 'late1.jpg'); add(rec, 'late2.jpg');
    drive.offline = true;
    await y.stop();
    await y.finish();
    assert.equal(drive.files.size, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rec.dir, UNSENT), 'utf8')).sort(), ['late1.jpg', 'late2.jpg']);
    // Next launch, back online, board not opened
    drive.offline = false;
    await new Sync(drive, rec, me, quiet).sendUnsent();
    assert.deepEqual([...drive.files.keys()].sort(), ['late1.jpg', 'late2.jpg']);
    assert.ok(!fs.existsSync(path.join(rec.dir, UNSENT)));
  });

  await test('shared board: reopening while files still go up never sends one twice at once', async () => {
    const drive = fakeDrive();
    drive.slow = 120;
    const rec = board('c');
    const y = new Sync(drive, rec, me, quiet);
    await y.tick();
    for (const n of ['p1.jpg', 'p2.jpg', 'p3.jpg']) add(rec, n);
    await y.stop();
    const done = y.finish();
    await sleep(40);
    const z = new Sync(drive, rec, me, quiet); // the board opens again
    await z.tick();
    await Promise.all([done, z.settle()]);
    await z.stop();
    assert.deepEqual([...drive.files.keys()].sort(), ['p1.jpg', 'p2.jpg', 'p3.jpg']);
    const uploads = drive.starts.filter((n, i, a) => a.indexOf(n) === i);
    assert.equal(uploads.length, 3);
    for (const n of uploads) assert.ok(drive.starts.filter((x) => x === n).length <= 2, n + ' started too often');
  });
};
