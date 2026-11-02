// End to end run of the real app against a simulated Drive folder.
// xvfb-run -s "-screen 0 1440x900x24" node test/e2e.js
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = process.env.SHOTS || '/tmp/shots';
const DRIVE = '/tmp/fakedrive/My Drive';
const SRC = '/tmp/refsrc';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, EYEREFS_DRIVE: DRIVE, EYEREFS_EMAIL: 'chamath@eyestudio.ae', XDG_CONFIG_HOME: '/tmp/er-cfg1' },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.setPosition(0, 0); });
  await win.waitForSelector('#screen:not([hidden])');
  await sleep(400);
  await win.screenshot({ path: `${OUT}/01-team-setup.png` });

  await win.click('text=Set up a new team as admin');
  await win.waitForSelector('#modalWrap:not([hidden])');
  await sleep(300);
  await win.screenshot({ path: `${OUT}/02-no-clients.png` });
  await win.click('text=Add clients');
  for (const c of ['Hutong', 'Jou Jou', 'Indienne', 'Luna']) { await win.fill('#mcName', c); await win.press('#mcName', 'Enter'); }
  await win.screenshot({ path: `${OUT}/03-clients.png` });
  await win.click('#modalWrap >> text=Save');
  await sleep(300);

  await win.click('#newProject');
  await win.fill('#npName', 'Spring Campaign');
  await win.selectOption('#npClient', 'Hutong');
  await win.screenshot({ path: `${OUT}/04-new-project.png` });
  await win.click('text=Create project');
  await win.waitForSelector('#title:not([hidden])');

  // Add references the way a drop would
  await win.evaluate(async (src) => {
    await Board.addPaths([`${src}/mandel.png`, `${src}/warm.jpg`, `${src}/night.jpg`, `${src}/pattern.png`], { x: 0, y: 0 });
    await Board.addPaths([`${src}/reel.mp4`, `${src}/clip.avi`], { x: 0, y: 1300 });
    Board.arrange();
    Board.focusAll();
  }, SRC);
  await sleep(1500);
  await win.evaluate(() => Board.clearSel());
  await sleep(300);
  await win.screenshot({ path: `${OUT}/05-board.png` });

  // Second project in another client so the sidebar has depth
  await require('../main/library').createProject(DRIVE, { email: 'nousaiba@eyestudio.ae', name: 'Nousaiba' }, 'Summer Terrace', 'Jou Jou');
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));

  // A teammate opens the same project from their computer and moves an image
  const lib = require('../main/library');
  const { Session } = require('../main/session');
  const projects = await lib.scanProjects(DRIVE, { email: 'nousaiba@eyestudio.ae' });
  const rec = projects.find((p) => p.name === 'Spring Campaign');
  const nousaiba = { email: 'nousaiba@eyestudio.ae', name: 'Nousaiba', initials: 'NO', deviceKey: 'nousaiba-zz9911' };
  const shoaib = { email: 'shoaib@eyestudio.ae', name: 'Shoaib', initials: 'SH', deviceKey: 'shoaib-yy8822' };
  const noop = { state() {}, status() {}, presence() {} };
  const sN = new Session(rec, nousaiba, '/tmp/er-bk-n', noop);
  const sS = new Session(rec, shoaib, '/tmp/er-bk-s', noop);
  await sN.open(); await sS.open();
  const items = sN.merged();
  const img = Object.values(items).find((it) => it.original === 'night.jpg');
  sN.write([{ id: img.id, fields: { x: img.x + 260, y: img.y - 140, gray: true, by: 'Nousaiba' } }]);
  await sN.flush();
  await sleep(5500);
  await win.screenshot({ path: `${OUT}/06-teammate-moved.png` });

  // Select the video: the video bar appears
  await win.evaluate(() => {
    const v = Board.live().find((it) => it.original === 'reel.mp4');
    Board.sel = new Set([v.id]);
    Board.focusSelection();
  });
  await sleep(600);
  await win.evaluate(() => { const id = Board.activeVideoId(); const v = Board.els.get(id).querySelector('video'); v.currentTime = 2.2; });
  await sleep(500);
  await win.evaluate(() => Board.setInOut('in'));
  await win.evaluate(() => { const id = Board.activeVideoId(); const v = Board.els.get(id).querySelector('video'); v.currentTime = 4.6; });
  await sleep(400);
  await win.evaluate(() => Board.setInOut('out'));
  await win.evaluate(() => { const id = Board.activeVideoId(); const v = Board.els.get(id).querySelector('video'); v.currentTime = 3.1; });
  await sleep(600);
  await win.screenshot({ path: `${OUT}/07-video.png` });
  await win.evaluate(() => Board.grabFrame());
  await sleep(1500);
  await win.evaluate(() => Board.focusAll());
  await sleep(500);

  // Right click menu on an image
  const box = await win.evaluate(() => { const it = Board.live().find((x) => x.original === 'warm.jpg'); const r = Board.els.get(it.id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await win.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(300);
  await win.screenshot({ path: `${OUT}/08-menu.png` });
  await win.keyboard.press('Escape');

  // Crop with C held, then sidebar hidden
  await win.evaluate(() => { const it = Board.live().find((x) => x.original === 'mandel.png'); Board.sel = new Set([it.id]); Board.renderOverlay && 0; });
  const mb = await win.evaluate(() => { const it = Board.live().find((x) => x.original === 'mandel.png'); const r = Board.els.get(it.id).getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
  await win.keyboard.down('c');
  await win.mouse.move(mb.l + mb.w * 0.95, mb.t + mb.h * 0.5);
  await win.mouse.down();
  await win.mouse.move(mb.l + mb.w * 0.7, mb.t + mb.h * 0.5, { steps: 6 });
  await win.mouse.up();
  await win.keyboard.up('c');
  await win.click('#hideSidebar');
  await win.evaluate(() => Board.clearSel());
  await sleep(400);
  await win.screenshot({ path: `${OUT}/09-sidebar-hidden.png` });
  await win.click('#showSidebar');

  // Undo the crop, add a note
  await win.keyboard.press('Control+Z');
  await win.evaluate(() => Board.addNote({ x: 0, y: -200 }, 'Warmer than the Jan shoot. Keep the red lacquer, push amber.'));
  await sleep(300);
  await win.keyboard.press('Control+Space');
  await sleep(1200);
  await win.evaluate(() => Board.clearSel());
  await win.screenshot({ path: `${OUT}/10-final.png` });

  await win.keyboard.press('Control+h');
  await sleep(300);
  await win.screenshot({ path: `${OUT}/11-shortcuts.png` });
  await win.keyboard.press('Escape');

  const state = await win.evaluate(() => ({ items: Board.live().length, crop: (Board.live().find((x) => x.original === 'mandel.png') || {}).crop, notes: Board.live().filter((x) => x.type === 'note').length }));
  await win.evaluate(() => window.eyerefs.flush());
  await sleep(500);
  await sS.close(); await sN.close();
  await app.close();

  const dir = rec.dir;
  console.log(JSON.stringify({
    state,
    media: fs.readdirSync(path.join(dir, 'media')),
    changes: fs.readdirSync(path.join(dir, 'changes')),
    here: fs.readdirSync(path.join(dir, 'here')),
    tree: fs.readdirSync(path.join(DRIVE, 'Eye Refs')).map((c) => [c, fs.readdirSync(path.join(DRIVE, 'Eye Refs', c))]),
    errors,
  }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
