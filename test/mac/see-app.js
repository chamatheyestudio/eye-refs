// The real Eye Refs app on a real Mac: sign in, add a picture, switch on see
// through, capture the screen and read pixels. Red behind the board means it works.
const { _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const { createGas } = require('../gas-shim');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.OUT || '/tmp/see';
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const red = spawn(require('electron'), [path.join(__dirname, 'red.js')], { stdio: 'ignore' });
  await sleep(3000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see-'));
  const gas = createGas(path.join(tmp, 'drive'), 'chamath@eyestudio.ae');
  const srv = await gas.listen();
  const codeFor = (e) => /code is (\d{6})/.exec([...gas.mail].reverse().find((m) => m.to === e).body)[1];
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, EYEREFS_SERVER: srv.url, EYEREFS_ROOT: path.join(tmp, 'Documents', 'Eye Refs'), HOME: tmp } });
  const win = await app.firstWindow();
  win.on('console', (m) => console.log('page:', m.text()));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 100, y: 100, width: 900, height: 600 }); });
  await win.waitForSelector('#siEmail'); await win.fill('#siEmail', 'chamath'); await win.click('text=Send me a code');
  await win.waitForSelector('#siCode'); await win.fill('#siCode', codeFor('chamath@eyestudio.ae')); await win.click('#screen >> text=Sign in');
  await win.waitForSelector('#title:not([hidden])');
  const img = path.join(tmp, 'blue.png');
  execFileSync('python3', ['-c', `import zlib,struct\nw,h=400,300\nraw=b''.join(b'\\x00'+b'\\x00\\x00\\xff'*w for _ in range(h))\ndef c(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)\nopen('${img}','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))`]);
  await win.evaluate(async (f) => { await Board.addPaths([f], { x: 0, y: 0 }); }, img);
  await sleep(800);
  await win.evaluate(() => { Board.view = { s: 1, x: 300, y: 250 }; Board.applyView(); Board.clearSel(); });
  const shot = async (name) => {
    await sleep(1500);
    const file = path.join(OUT, name + '.png');
    execFileSync('screencapture', ['-x', file]);
    return file;
  };
  const before = await shot('before');
  const r = await win.evaluate(async () => window.eyerefs.setTransparent(true));
  await win.evaluate(() => { document.body.classList.add('see'); });
  const state = await win.evaluate(() => ({ see: document.body.classList.contains('see'), html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor, canvas: getComputedStyle(document.querySelector('#canvas')).backgroundColor, top: document.elementFromPoint(700, 80) && document.elementFromPoint(700, 80).id }));
  const after = await shot('after');
  const info = await app.evaluate(({ BrowserWindow, screen }) => ({ wins: BrowserWindow.getAllWindows().map((w) => w.getBounds()), scale: screen.getPrimaryDisplay().scaleFactor, size: screen.getPrimaryDisplay().size }));
  const px = await app.evaluate(({ nativeImage }, { files, info }) => {
    const out = {};
    for (const f of files) {
      const im = nativeImage.createFromPath(f); const { width } = im.getSize(); const b = im.toBitmap(); const k = width / info.size.width;
      const p = (x, y) => { const i = (Math.round(y * k) * width + Math.round(x * k)) * 4; return [b[i + 2], b[i + 1], b[i]]; };
      // empty board area, the picture, outside the window
      out[f.split('/').pop()] = { board: p(100 + 700, 100 + 450), picture: p(100 + 500, 100 + 400), outside: p(50, 50) };
    }
    return out;
  }, { files: [before, after], info });
  console.log('SEE APP ' + JSON.stringify({ r, state, info, px }));
  await app.close(); red.kill(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
