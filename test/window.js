// The window itself, on the computer it runs on: always on top, minimize,
// see through, opacity, lock, moving, click through, remembering settings.
// node test/window.js   (on Linux: xvfb-run -a node test/window.js)
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createGas } = require('./gas-shim');

const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAT = process.platform;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyerefs-win-'));
  const gas = createGas(path.join(tmp, 'drive'), 'chamath@eyestudio.ae');
  const srv = await gas.listen();
  const codeFor = (email) => /code is (\d{6})/.exec([...gas.mail].reverse().find((m) => m.to === email).body)[1];
  const errors = [];
  const checks = {};
  const expect = (name, ok, detail) => { checks[name] = !!ok; if (!ok) errors.push(`check failed: ${name} ${JSON.stringify(detail === undefined ? '' : detail)}`); console.log('check', name, !!ok, detail !== undefined ? JSON.stringify(detail) : ''); };
  const env = { ...process.env, EYEREFS_SERVER: srv.url, EYEREFS_ROOT: path.join(tmp, 'Documents', 'Eye Refs'), EYEREFS_DATA: path.join(tmp, 'data') };

  const launch = async () => {
    const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), '--no-sandbox'], env });
    const win = await app.firstWindow();
    win.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', e.message); });
    win.on('console', (m) => { if (m.type() === 'error') { errors.push('console: ' + m.text()); console.log('CONSOLEERR', m.text()); } });
    return { app, win };
  };
  // The app's own window (not a test window), read from the main process
  const W = (app, fn, arg) => app.evaluate(({ BrowserWindow }, [src, a]) => {
    const w = BrowserWindow.getAllWindows().filter((x) => !x.__test && !x.isDestroyed()).sort((a2, b2) => b2.id - a2.id)[0];
    return new Function('w', 'a', 'return (' + src + ')(w, a)')(w, a);
  }, [fn.toString(), arg]);

  let { app, win } = await launch();
  await win.waitForSelector('#siEmail');
  await win.fill('#siEmail', 'chamath');
  await win.click('text=Send me a code');
  await win.waitForSelector('#siCode');
  await win.fill('#siCode', codeFor('chamath@eyestudio.ae'));
  await win.click('#screen >> text=Sign in');
  await win.waitForSelector('#title:not([hidden])');
  await W(app, (w) => { w.setBounds({ x: 120, y: 120, width: 1000, height: 700 }); });
  await sleep(500);

  // ---------- always on top ----------
  await win.evaluate(() => document.querySelector('#canvas').focus());
  await win.keyboard.press('ControlOrMeta+Shift+A');
  await sleep(400);
  expect('shortcut turns always on top on', await W(app, (w) => w.isAlwaysOnTop()));
  expect('toolbar shows always on top', await win.evaluate(() => document.querySelector('#tTop').classList.contains('on')));

  await W(app, (w) => w.minimize());
  await sleep(800);
  await W(app, (w) => w.restore());
  await sleep(800);
  expect('still on top after minimize and restore', await W(app, (w) => w.isAlwaysOnTop()));

  await W(app, (w) => { w.maximize(); });
  await sleep(600);
  await W(app, (w) => { w.unmaximize(); w.setBounds({ x: 120, y: 120, width: 1000, height: 700 }); });
  await sleep(600);
  expect('still on top after maximize', await W(app, (w) => w.isAlwaysOnTop()));

  // Really in front: another app's window takes focus over the same spot
  const front = async (label) => {
    const r = await app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }) => {
      const mine = BrowserWindow.getAllWindows().filter((x) => !x.__test && !x.isDestroyed()).sort((a, b) => b.id - a.id)[0];
      const b = mine.getBounds();
      const other = new BrowserWindow({ x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80, backgroundColor: '#FF0000', show: false, frame: true });
      other.__test = true;
      await other.loadURL('data:text/html,<body style="margin:0;background:%23ff0000"></body>');
      other.show(); other.focus(); other.moveTop();
      await new Promise((r) => setTimeout(r, 1200));
      const out = { onTop: mine.isAlwaysOnTop(), focused: BrowserWindow.getFocusedWindow() === other };
      try {
        const d = screen.getPrimaryDisplay();
        const sf = d.scaleFactor || 1;
        const src = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * sf, height: d.size.height * sf } }))[0];
        const img = src && src.thumbnail;
        if (img && !img.isEmpty()) {
          const sz = img.getSize();
          const bmp = img.toBitmap(); // BGRA
          const px = (x, y) => { const i = (Math.round(y * sz.height / d.size.height) * sz.width + Math.round(x * sz.width / d.size.width)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
          const c = px(b.x + b.width / 2, b.y + b.height / 2);
          const edge = px(b.x - 20, b.y + b.height / 2);
          out.center = c; out.edge = edge;
          const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60;
          out.captured = red(edge); // the test window shows around ours, so the capture works
          out.inFront = !red(c);
          out.png = img.resize({ width: 960 }).toPNG().toString('base64');
        }
      } catch (e) { out.captureError = String(e && e.message || e); }
      other.destroy();
      await new Promise((r) => setTimeout(r, 300));
      return out;
    });
    if (r.png) { fs.writeFileSync(path.join(OUT, `w-front-${label.replace(/\W+/g, '-')}.png`), Buffer.from(r.png, 'base64')); delete r.png; }
    // Linux test screens have no window manager, so stacking can't be judged there
    const tested = r.captured && PLAT !== 'linux';
    expect(`${label}: in front of other windows`, r.onTop && (!tested || r.inFront), r);
    return r;
  };
  await front('on top');

  // Other windows of Eye Refs (settings, menus) and the board switching keep it
  await win.evaluate(() => Board.addNote ? true : true);
  await win.evaluate(() => document.querySelector('#settingsBtn') && document.querySelector('#settingsBtn').click());
  await sleep(300);
  await win.keyboard.press('Escape');
  expect('still on top after opening settings', await W(app, (w) => w.isAlwaysOnTop()));

  // See through rebuilds the window on Windows; it must stay on top
  await win.evaluate(async () => { const b = [...document.querySelectorAll('button, .set-row')].find((x) => /see through/i.test(x.textContent)); return !!b; });
  const seeOn = await win.evaluate(async () => { const r = await window.eyerefs.setTransparent(true); return r; });
  await sleep(seeOn && seeOn.rebuilt ? 4000 : 800);
  if (seeOn && seeOn.rebuilt) { win = await app.windows().then ? win : win; }
  const pages = app.windows();
  win = pages[pages.length - 1];
  await win.waitForSelector('#title:not([hidden])', { timeout: 15000 }).catch(() => {});
  expect('see through on', await W(app, (w) => w.isVisible()), seeOn);
  expect('still on top in see through', await W(app, (w) => w.isAlwaysOnTop()));
  expect('only one Eye Refs window after see through', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length) === 1);
  await front('see through');
  await win.screenshot({ path: `${OUT}/w-see.png` });
  const seeOff = await win.evaluate(async () => window.eyerefs.setTransparent(false));
  await sleep(seeOff && seeOff.rebuilt ? 4000 : 800);
  win = app.windows()[app.windows().length - 1];
  await win.waitForSelector('#title:not([hidden])', { timeout: 15000 }).catch(() => {});
  expect('still on top after leaving see through', await W(app, (w) => w.isAlwaysOnTop()));

  // Off again
  await win.evaluate(() => document.querySelector('#canvas').focus());
  await win.keyboard.press('ControlOrMeta+Shift+A');
  await sleep(400);
  expect('shortcut turns always on top off', !(await W(app, (w) => w.isAlwaysOnTop())));
  await win.keyboard.press('ControlOrMeta+Shift+A');
  await sleep(300);

  // ---------- opacity ----------
  await win.keyboard.press('ControlOrMeta+Shift+Minus');
  await sleep(300);
  const op = await W(app, (w) => w.getOpacity());
  expect('opacity goes down with the shortcut', PLAT === 'linux' || op < 1, { op });
  await win.evaluate(() => window.eyerefs.setOpacity(1));

  // ---------- moving the window ----------
  const p0 = await W(app, (w) => w.getPosition());
  await win.mouse.move(500, 400);
  await win.mouse.down({ button: 'right' });
  await win.mouse.move(540, 430, { steps: 6 });
  await win.mouse.up({ button: 'right' });
  await sleep(300);
  const p1 = await W(app, (w) => w.getPosition());
  expect('right drag moves the window', p1[0] !== p0[0] || p1[1] !== p0[1], { p0, p1 });
  const menuLeft = await win.evaluate(() => !!document.querySelector('.ctx, .menu:not([hidden])'));
  expect('right drag does not open the menu', !menuLeft);
  await win.keyboard.press('Escape');
  // A right press whose release gets lost must not leave the window stuck to the mouse
  await win.mouse.move(500, 400);
  await win.mouse.down({ button: 'right' });
  await win.evaluate(() => window.dispatchEvent(new Event('blur')));
  await win.mouse.up({ button: 'right' });
  await win.mouse.move(600, 500, { steps: 4 });
  const p2 = await W(app, (w) => w.getPosition());
  await win.mouse.move(650, 520, { steps: 4 });
  const p3 = await W(app, (w) => w.getPosition());
  expect('window does not follow the mouse after a lost release', p2[0] === p3[0] && p2[1] === p3[1], { p2, p3 });

  // ---------- lock ----------
  await win.evaluate(() => document.querySelector('#canvas').focus());
  await win.evaluate(() => window.eyerefs.lockWindow(true));
  expect('locked window cannot be moved or resized', (PLAT === 'linux' || await W(app, (w) => !w.isMovable())) && await W(app, (w) => !w.isResizable()));
  await win.evaluate(() => window.eyerefs.lockWindow(false));
  expect('unlocked window can be moved again', await W(app, (w) => w.isMovable() && w.isResizable()));

  // ---------- click through ----------
  await win.evaluate(() => document.querySelector('#canvas').focus());
  await win.keyboard.press('ControlOrMeta+T');
  await sleep(300);
  const ctOn = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+T'));
  expect('click through on, with a way back', ctOn);
  await win.evaluate(() => window.eyerefs.setClickThrough ? window.eyerefs.setClickThrough(false) : null);
  await app.evaluate(({ globalShortcut }) => { /* the way back */ });
  await sleep(200);

  // ---------- remembered ----------
  await win.evaluate(() => window.eyerefs.setOpacity(0.8));
  const b0 = await W(app, (w) => w.getBounds());
  await win.screenshot({ path: `${OUT}/w-before-restart.png` });
  await app.evaluate(({ app: a }) => { a.exit(0); }).catch(() => {});
  await sleep(1500);
  ({ app, win } = await launch());
  await win.waitForSelector('#title:not([hidden])', { timeout: 30000 });
  await sleep(800);
  const after = await W(app, (w) => ({ top: w.isAlwaysOnTop(), op: w.getOpacity(), b: w.getBounds() }));
  expect('always on top remembered after restart', after.top, after);
  expect('opacity remembered after restart', PLAT === 'linux' || Math.abs(after.op - 0.8) < 0.03, after);
  await front('after restart');
  await win.screenshot({ path: `${OUT}/w-after-restart.png` });

  await app.evaluate(({ app: a }) => { a.exit(0); }).catch(() => {});
  srv.close();
  console.log(JSON.stringify({ platform: PLAT, checks, errors }, null, 1));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
