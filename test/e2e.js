// End to end: the real app against a simulated EyeStudio Google account.
// xvfb-run -s "-screen 0 1440x900x24" node test/e2e.js
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createGas } = require('./gas-shim');

const OUT = process.env.SHOTS || '/tmp/shots';
const SRC = '/tmp/refsrc';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-e2e-'));
  const gas = createGas(path.join(tmp, 'drive'), 'chamath@eyestudio.ae');
  const srv = await gas.listen();
  const codeFor = (email) => /code is (\d{6})/.exec([...gas.mail].reverse().find((m) => m.to === email).body)[1];

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, EYEREFS_SERVER: srv.url, EYEREFS_ROOT: path.join(tmp, 'Documents', 'Eye Refs'), XDG_CONFIG_HOME: path.join(tmp, 'cfg') },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.setPosition(0, 0); });

  // Sign in with an emailed code
  await win.waitForSelector('#siEmail');
  await win.fill('#siEmail', 'chamath');
  await sleep(200);
  await win.screenshot({ path: `${OUT}/01-signin.png` });
  await win.click('text=Send me a code');
  await win.waitForSelector('#siCode');
  await win.fill('#siCode', codeFor('chamath@eyestudio.ae'));
  await win.screenshot({ path: `${OUT}/02-code.png` });
  await win.click('#screen >> text=Sign in');

  // Like PureRef: straight onto a blank untitled board
  await win.waitForSelector('#title:not([hidden])');
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Untitled');
  await win.evaluate(async (src) => {
    await Board.addPaths([`${src}/mandel.png`, `${src}/warm.jpg`, `${src}/night.jpg`, `${src}/pattern.png`, `${src}/reel.mp4`], { x: 0, y: 0 });
    Board.arrange(); Board.focusAll(); Board.clearSel();
  }, SRC);
  await sleep(1200);
  await win.screenshot({ path: `${OUT}/03-board-local.png` });
  // Clean view: only the board until the pointer reaches an edge
  await win.mouse.move(720, 450);
  await sleep(300);
  await win.screenshot({ path: `${OUT}/02a-clean.png` });
  const hiddenOk = await win.evaluate(() => getComputedStyle(document.querySelector('#toolbar')).display === 'none' && getComputedStyle(document.querySelector('#topbar')).opacity === '0');
  await win.mouse.move(720, 10);
  await sleep(400);
  await win.screenshot({ path: `${OUT}/02b-clean-top.png` });
  const shownOk = await win.evaluate(() => getComputedStyle(document.querySelector('#topbar')).opacity === '1' && getComputedStyle(document.querySelector('#title')).opacity === '1');
  await win.mouse.move(720, 45);
  await sleep(500);
  const staysOk = await win.evaluate(() => document.body.classList.contains('show-top'));
  await win.mouse.move(720, 300);
  await sleep(600);
  const leftOk = await win.evaluate(() => !document.body.classList.contains('show-top'));
  console.log('clean stays', staysOk, 'leaves', leftOk);
  console.log('clean', hiddenOk, shownOk);
  await win.mouse.move(720, 450);
  await win.keyboard.press('Tab');
  await sleep(200);
  await win.evaluate(() => { const v = [...Board.items.values()].find((it) => it.type === 'video'); Board.sel = new Set([v.id]); Board.focusAll(); });
  await sleep(400);
  await win.screenshot({ path: `${OUT}/03a-video.png` });
  await win.evaluate(() => Board.clearSel());
  // Draw: circle a detail, then an arrow in another colour
  await win.keyboard.press('Control+D');
  await win.waitForSelector('#penBar:not([hidden])');
  const circle = async (cx, cy, rx, ry) => {
    await win.mouse.move(cx + rx, cy);
    await win.mouse.down();
    for (let a = 0; a <= Math.PI * 2.1; a += 0.12) await win.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry * (1 + a * 0.02));
    await win.mouse.up();
  };
  await circle(1110, 300, 95, 70);
  await win.click('#penColors button:nth-child(2)');
  await win.click('#penSizes button:nth-child(2)');
  await win.keyboard.press('3');
  await win.mouse.move(980, 470); await win.mouse.down();
  for (let i = 0; i <= 20; i++) await win.mouse.move(980 + i * 4.5, 470 - i * 6 + Math.sin(i / 3) * 4);
  await win.mouse.up();
  await win.keyboard.press('2');
  await win.click('#penColors button:nth-child(3)');
  await win.mouse.move(470, 560); await win.mouse.down();
  for (let i = 0; i <= 30; i++) await win.mouse.move(470 + i * 10, 560 + Math.sin(i / 4) * 20);
  await win.mouse.up();
  // Eraser takes out a scribble
  await win.keyboard.press('1');
  await win.mouse.move(700, 700); await win.mouse.down(); await win.mouse.move(760, 720); await win.mouse.move(800, 690); await win.mouse.up();
  const before = await win.evaluate(() => Board.live().filter((it) => it.type === 'draw').length);
  await win.keyboard.press('e');
  await win.mouse.move(760, 740); await win.mouse.down(); await win.mouse.move(760, 700, { steps: 10 }); await win.mouse.up();
  const after = await win.evaluate(() => Board.live().filter((it) => it.type === 'draw').length);
  console.log('erased', before - after);
  await win.keyboard.press('d');
  await sleep(300);
  await win.screenshot({ path: `${OUT}/03d-draw.png` });
  const strokes = await win.evaluate(() => Board.live().filter((it) => it.type === 'draw').length);
  console.log('strokes', strokes);
  await win.keyboard.press('Escape');

  // Paste from outside: a Google Slides style copy (html with an image link),
  // a picture copied in another app, and plain text
  const http = require('http');
  const imgSrv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'image/jpeg' }); fs.createReadStream(`${SRC}/warm.jpg`).pipe(r); });
  await new Promise((r) => imgSrv.listen(0, '127.0.0.1', r));
  const imgUrl = `http://127.0.0.1:${imgSrv.address().port}/slidesz/AGV_vUe?key=abc&amp;w=1600`;
  const count = () => win.evaluate(() => Board.live().filter((it) => it.type !== 'draw').length);
  const n0 = await count();
  await app.evaluate(({ clipboard }, u) => clipboard.write({ html: `<meta charset="utf-8"><b id="docs-internal-guid-1"><img src="${u}" width="400"></b>`, text: '' }), imgUrl);
  await win.mouse.move(720, 450); await win.mouse.click(720, 450);
  await win.keyboard.press('Control+V');
  await win.waitForFunction((n) => Board.live().filter((it) => it.type !== 'draw').length > n, n0, { timeout: 15000 });
  await app.evaluate(({ clipboard, nativeImage }, f) => clipboard.writeImage(nativeImage.createFromPath(f)), `${SRC}/night.jpg`);
  await win.keyboard.press('Control+V');
  await win.waitForFunction((n) => Board.live().filter((it) => it.type !== 'draw').length > n + 1, n0, { timeout: 15000 });
  await app.evaluate(({ clipboard }) => clipboard.writeText('Warmer light, like the second shot'));
  await win.keyboard.press('Control+V');
  await win.waitForFunction(() => Board.live().some((it) => it.type === 'note' && /Warmer light/.test(it.text || '')), null, { timeout: 15000 });
  console.log('pasted', (await count()) - n0);
  imgSrv.close();
  await win.evaluate(() => { Board.arrange(); Board.focusAll(); Board.clearSel(); });

  await win.screenshot({ path: `${OUT}/03b-untitled.png` });
  // Share asks for a name first, then saves into Documents/Eye Refs
  await win.click('#share');
  await win.waitForSelector('#svName');
  await win.fill('#svName', 'Spring Campaign');
  await win.screenshot({ path: `${OUT}/03c-save.png` });
  await win.press('#svName', 'Enter');
  await win.waitForSelector('#shEmails');
  await win.fill('#shEmails', 'nousaiba');
  await win.screenshot({ path: `${OUT}/04-share.png` });
  await win.click('#modalWrap >> text=Share board');
  await win.waitForSelector('text=People on this board');
  await sleep(300);
  await win.screenshot({ path: `${OUT}/05-members.png` });
  const code = await win.evaluate(() => (document.querySelector('#modalWrap b') || {}).textContent);
  await win.click('#modalWrap >> text=Done');

  // An outside freelancer asks to join with the code
  const guest = (() => { gas.call({ action: 'auth.request', email: 'rami@freelancer.com' }); return gas.call({ action: 'auth.verify', email: 'rami@freelancer.com', code: codeFor('rami@freelancer.com'), name: 'Rami' }).data.token; })();
  const reqRes = gas.call({ action: 'projects.request', token: guest, code });

  // Nousaiba opens it on her computer (simulated) and moves an image
  const { Cloud } = require('../main/cloud');
  const { Sync } = require('../main/sync');
  const lib = require('../main/library');
  const { Session } = require('../main/session');
  const tB = (() => { gas.call({ action: 'auth.request', email: 'nousaiba@eyestudio.ae' }); return gas.call({ action: 'auth.verify', email: 'nousaiba@eyestudio.ae', code: codeFor('nousaiba@eyestudio.ae'), name: 'Nousaiba' }).data.token; })();
  const cloudB = new Cloud(() => srv.url, () => tB, fetch);
  const B = { email: 'nousaiba@eyestudio.ae', name: 'Nousaiba', initials: 'NO', deviceKey: 'nousaiba-bbb222' };
  const remote = (await cloudB.call('projects.list'))[0];
  const recB = await lib.createProject(path.join(tmp, 'B'), B, remote.name, '', { id: remote.id, owner: { email: remote.owner }, shared: { id: remote.id } });
  const syncB = new Sync(cloudB, recB, B, { presence() {}, status() {} });
  await sleep(4000); // let the app upload
  await syncB.tick(); await syncB.settle();
  const sB = new Session(recB, B, path.join(tmp, 'bkB'), { state() {}, status() {}, presence() {} }, { onSaved: () => syncB.kick(0) });
  await sB.open();
  const items = sB.merged();
  const night = Object.values(items).find((it) => it.original === 'night.jpg');
  sB.write([{ id: night.id, fields: { x: night.x + 300, y: night.y - 200, gray: true, by: 'Nousaiba' } }]);
  await sB.flush(); await syncB.tick();
  // The app pulls every 15 seconds
  await win.waitForFunction((id) => Board.items.get(id) && Board.items.get(id).gray === true, night.id, { timeout: 40000 });
  await sleep(800);
  await win.screenshot({ path: `${OUT}/06-teammate.png` });

  // Approve Rami from the share window
  await win.click('#share');
  await win.waitForSelector('text=Asking to join');
  await win.screenshot({ path: `${OUT}/07-request.png` });
  await win.click('#modalWrap >> text=Approve');
  await sleep(800);
  await win.click('#modalWrap >> text=Done');

  // An update arrives
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update:ready', { version: '1.0.2' }));
  await sleep(300);
  await win.screenshot({ path: `${OUT}/07b-update.png` });

  // Account menu
  await win.click('#account');
  await sleep(200);
  await win.screenshot({ path: `${OUT}/08-account.png` });
  await win.keyboard.press('Escape');

  // New board: back to a blank untitled one, saved board stays in the list
  await win.keyboard.press('Control+K');
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Untitled');
  await win.screenshot({ path: `${OUT}/09-new.png` });
  const fresh = await win.evaluate(() => Board.live().length);
  await win.click('#tree >> text=Spring Campaign');
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Spring Campaign');
  const result = await win.evaluate((fresh) => ({ fresh, items: Board.live().length, status: document.querySelector('#tStatus').textContent, rows: [...document.querySelectorAll('#tree .row')].map((r) => r.textContent) }), fresh);
  await syncB.stop(); await sB.close();
  await app.close();
  const driveDir = path.join(tmp, 'drive', 'Eye Refs', 'Spring Campaign');
  console.log(JSON.stringify({
    result, request: reqRes.ok,
    driveMedia: fs.readdirSync(path.join(driveDir, 'media')).length,
    driveChanges: fs.readdirSync(path.join(driveDir, 'changes')),
    local: fs.readdirSync(path.join(tmp, 'Documents', 'Eye Refs')),
    unsaved: fs.readdirSync(path.join(tmp, 'cfg', 'Eye Refs', 'unsaved')),
    members: gas.call({ action: 'projects.members', token: tB, id: remote.id }).data.members.map((m) => m.email),
    errors,
  }, null, 1));
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
