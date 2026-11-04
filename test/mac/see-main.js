// Runs on a real Mac in CI: a red window, then see through windows on top built
// like Eye Refs builds them, then a screen capture to check red shows through.
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const out = process.env.OUT || '/tmp/see';
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (bg) => 'data:text/html,' + encodeURIComponent(`<html style="background:${bg}"><body style="margin:0;background:${bg}"><div style="position:fixed;left:20px;top:20px;width:80px;height:80px;background:%2300f"></div></body></html>`);
const variants = {
  plain: { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false },
  showFalse: { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, show: false },
  opacity: { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, show: false, opacity: true },
  onTop: { transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, show: false, onTop: true },
  noBg: { transparent: true, frame: false, hasShadow: false, show: false },
  app: { app: true },
};
app.whenReady().then(async () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const red = new BrowserWindow({ x: 0, y: 0, width, height, backgroundColor: '#ff0000', show: true });
  red.loadURL('data:text/html,<body style="background:%23ff0000"></body>');
  await sleep(1500);
  const results = {};
  for (const [name, v] of Object.entries(variants)) {
    let w;
    if (v.app) {
      // The real Eye Refs window and page, in see through mode
      process.env.EYEREFS_SEE_TEST = '1';
      w = new BrowserWindow({ x: 100, y: 100, width: 600, height: 400, frame: false, transparent: true, hasShadow: false, backgroundColor: '#00000000', show: false,
        webPreferences: { preload: path.join(__dirname, '..', '..', 'main', 'preload.js'), contextIsolation: true, sandbox: true } });
      await w.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
      await w.webContents.executeJavaScript("document.body.classList.add('see'); document.getElementById('screen').hidden = true; document.querySelectorAll('#sidebar,#title,#topRight,#toolbar,#zoom').forEach(e=>e.style.display='none'); true");
      w.show();
    } else {
      const { opacity, onTop, ...opts } = v;
      w = new BrowserWindow({ x: 100, y: 100, width: 600, height: 400, ...opts });
      await w.loadURL(page('transparent'));
      if (opacity) w.setOpacity(1);
      if (onTop) w.setAlwaysOnTop(true, 'floating');
      if (opts.show === false) w.show();
    }
    await sleep(1500);
    const file = path.join(out, `${name}.png`);
    try { execFileSync('screencapture', ['-x', file]); } catch (e) { results[name] = 'capture failed: ' + e.message; }
    w.destroy();
    await sleep(500);
    // Pixel in the middle of the see through window: red means it works
    try {
      const img = nativeImage.createFromPath(file);
      const { width: iw } = img.getSize();
      const bmp = img.toBitmap();
      const scale = iw / screen.getPrimaryDisplay().size.width;
      const px = (x, y) => { const i = (Math.round(y * scale) * iw + Math.round(x * scale)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
      results[name] = { middle: px(400, 300), blueBox: px(150, 150), outside: px(900, 700) };
    } catch (e) { results[name] = 'read failed: ' + e.message; }
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
  console.log('SEE RESULTS ' + JSON.stringify(results));
  app.quit();
});
