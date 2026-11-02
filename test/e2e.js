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
  await win.evaluate(() => { const v = [...Board.items.values()].find((it) => it.type === 'video'); Board.sel = new Set([v.id]); Board.focusAll(); });
  await sleep(400);
  await win.screenshot({ path: `${OUT}/03a-video.png` });
  await win.evaluate(() => Board.clearSel());

  await win.screenshot({ path: `${OUT}/03b-untitled.png` });
  // Share asks for a name first, then saves into Documents/Eye Refs
  await win.click('#share');
  await win.waitForSelector('#svName');
  await win.fill('#svName', 'Spring Campaign');
  await win.screenshot({ path: `${OUT}/03c-save.png` });
  await win.press('#svName', 'Enter');
  await win.waitForSelector('#shEmails');
  await win.fill('#shEmails', 'nousaiba@eyestudio.ae');
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
