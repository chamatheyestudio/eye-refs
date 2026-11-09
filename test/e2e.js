// End to end: the real app against a simulated EyeStudio Google account.
// xvfb-run -s "-screen 0 1440x900x24" node test/e2e.js
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createGas } = require('./gas-shim');

const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'shots');
const SRC = process.env.REFSRC || path.join(os.tmpdir(), 'refsrc');
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
    env: { ...process.env, EYEREFS_SERVER: srv.url, EYEREFS_ROOT: path.join(tmp, 'Documents', 'Eye Refs'), XDG_CONFIG_HOME: path.join(tmp, 'cfg'), EYEREFS_DATA: path.join(tmp, 'cfg', 'Eye Refs') },
  });
  const win = await app.firstWindow();
  const errors = [];
  const checks = {};
  const expect = (name, ok, detail) => { checks[name] = ok; if (!ok) errors.push(`check failed: ${name} ${JSON.stringify(detail || '')}`); console.log('check', name, ok, detail !== undefined ? JSON.stringify(detail) : ''); };
  win.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGEERROR', e.message); });
  win.on('console', (m) => { if (m.type() === 'error') { errors.push('console: ' + m.text()); console.log('CONSOLEERR', m.text()); } });
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
  expect('opens in the normal view, not see through', await win.evaluate(() => !document.body.classList.contains('see')));
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
  const hiddenOk = await win.evaluate(() => getComputedStyle(document.querySelector('#toolbar')).opacity === '0' && getComputedStyle(document.querySelector('#sidebar')).display === 'none' && getComputedStyle(document.querySelector('#topbar')).opacity === '0');
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
  // Top bar moves the window, its controls stay clickable
  await win.mouse.move(720, 10);
  await sleep(400);
  const regions = await win.evaluate(() => {
    const r = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).getPropertyValue('-webkit-app-region') || getComputedStyle(n).webkitAppRegion : null; };
    return { topbar: r('#topbar'), name: r('#tName'), share: r('#share'), update: r('#update'), win: r('#wClose'), winctl: r('#winctl'), presence: r('#presence'), logo: r('#showSidebar') };
  });
  expect('topbar regions', regions.topbar === 'drag' && ['name', 'share', 'update', 'win', 'winctl', 'presence', 'logo'].every((k) => regions[k] === 'no-drag'), regions);
  // Search from clean view shows the controls, then focuses the search box
  await win.mouse.move(720, 450);
  await sleep(500);
  await win.keyboard.press('ControlOrMeta+Shift+P');
  await sleep(200);
  const searchOk = await win.evaluate(() => ({ focused: document.activeElement && document.activeElement.id === 'search', clean: document.body.classList.contains('clean'), sidebar: getComputedStyle(document.querySelector('#sidebar')).display !== 'none' }));
  expect('search from clean view', searchOk.focused && !searchOk.clean && searchOk.sidebar, searchOk);
  await win.keyboard.press('Escape');
  await win.mouse.move(720, 450);
  if (await win.evaluate(() => document.body.classList.contains('clean'))) await win.keyboard.press('Tab');
  await sleep(200);
  await win.evaluate(() => { const v = [...Board.items.values()].find((it) => it.type === 'video'); Board.sel = new Set([v.id]); Board.focusAll(); });
  await sleep(400);
  await win.screenshot({ path: `${OUT}/03a-video.png` });
  await win.evaluate(() => Board.clearSel());
  // Draw: circle a detail, then an arrow in another colour
  await win.keyboard.press('ControlOrMeta+D');
  await win.waitForSelector('#penBar:not([hidden])');
  const circle = async (cx, cy, rx, ry) => {
    await win.mouse.move(cx + rx, cy);
    await win.mouse.down();
    for (let a = 0; a <= Math.PI * 2.1; a += 0.12) await win.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry * (1 + a * 0.02));
    await win.mouse.up();
  };
  await circle(1110, 300, 95, 70);
  await win.evaluate(() => { Board.pen.color = '#F4F3EE'; Board.pen.size = 4; });
  await win.keyboard.press('3');
  await win.mouse.move(980, 470); await win.mouse.down();
  for (let i = 0; i <= 20; i++) await win.mouse.move(980 + i * 4.5, 470 - i * 6 + Math.sin(i / 3) * 4);
  await win.mouse.up();
  await win.keyboard.press('2');
  await win.evaluate(() => { Board.pen.color = '#FF5A4E'; });
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
  // Pen thickness belongs to the board: the same at any zoom you draw at
  const v0 = await win.evaluate(() => ({ ...Board.view }));
  const swAt = async (s) => {
    await win.evaluate((s) => { Board.view.s = s; Board.applyView(); }, s);
    await win.keyboard.press('d');
    await win.mouse.move(600, 300); await win.mouse.down();
    for (let i = 0; i <= 10; i++) await win.mouse.move(600 + i * 8, 300 + i * 3);
    await win.mouse.up();
    const sw = await win.evaluate(() => { const d = Board.live().filter((it) => it.type === 'draw').sort((a, b) => b.created - a.created)[0]; return { sw: d.sw, size: Board.pen.size }; });
    await win.keyboard.press('ControlOrMeta+Z');
    await win.keyboard.press('d');
    return sw;
  };
  const swOut = await swAt(0.5), swIn = await swAt(2);
  await win.evaluate((v) => { Object.assign(Board.view, v); Board.applyView(); }, v0);
  expect('pen width is the same on the board at any zoom', swOut.sw === swIn.sw && swOut.sw === swOut.size, { swOut, swIn });
  // Line opacity: set on the pen bar, kept on the line, changeable later
  await win.evaluate(() => Board.setTool('pen'));
  await win.waitForSelector('#penBar:not([hidden])');
  await win.evaluate(() => { Board.pen.op = 0.5; });
  await win.mouse.move(600, 300); await win.mouse.down();
  for (let i = 0; i <= 10; i++) await win.mouse.move(600 + i * 8, 300 + i * 3);
  await win.mouse.up();
  const opRes = await win.evaluate(() => {
    const d = Board.live().filter((it) => it.type === 'draw').sort((a, b) => b.created - a.created)[0];
    const attr = Board.els.get(d.id).querySelector('path').getAttribute('stroke-opacity');
    const op = d.op;
    Board.commit([{ id: d.id, fields: { op: 0.25 } }]);
    const attr2 = Board.els.get(d.id).querySelector('path').getAttribute('stroke-opacity');
    Board.undo(); Board.undo();
    return { op, attr, attr2 };
  });
  await win.evaluate(() => { Board.pen.op = 1; });
  await win.evaluate(() => Board.setTool('select'));
  expect('line opacity', opRes.op === 0.5 && opRes.attr === '0.5' && opRes.attr2 === '0.25', opRes);
  // A line drawn on a picture sticks to it: drag, scale, delete and undo carry it along
  const host = await win.evaluate(() => { const it = Board.live().filter((x) => x.type === 'image').sort((a, b) => b.w - a.w)[0]; const r = Board.toScreen(it.x + it.w / 2, it.y + 40); return { id: it.id, sx: r.x, sy: r.y, x: it.x, w: it.w }; });
  await win.evaluate(() => Board.setTool('pen'));
  await win.mouse.move(host.sx - 30, host.sy); await win.mouse.down();
  for (let i = 0; i <= 12; i++) await win.mouse.move(host.sx - 30 + i * 5, host.sy + Math.sin(i) * 6);
  await win.mouse.up();
  await win.evaluate(() => Board.setTool('select'));
  const line0 = await win.evaluate(() => { const d = Board.live().filter((it) => it.type === 'draw').sort((a, b) => b.created - a.created)[0]; return { id: d.id, on: d.on, x: d.x, y: d.y, w: d.w }; });
  await win.evaluate((id) => { Board.clearSel(); }, host.id);
  await win.mouse.move(host.sx + 60, host.sy + 30); await win.mouse.down();
  await win.mouse.move(host.sx + 160, host.sy + 80, { steps: 8 });
  const midDrag = await win.evaluate((id) => Board.items.get(id).x, line0.id);
  await win.mouse.up();
  const afterDrag = await win.evaluate(([lid, hid]) => ({ l: Board.items.get(lid), h: Board.items.get(hid) }), [line0.id, host.id]);
  await win.evaluate((hid) => { const h = Board.items.get(hid); Board.commit([{ id: hid, fields: { w: h.w * 2, x: h.x, y: h.y } }]); }, host.id);
  const afterScale = await win.evaluate((lid) => Board.items.get(lid).w, line0.id);
  await win.evaluate((hid) => Board.commit([{ id: hid, fields: { deleted: true } }]), host.id);
  const afterDel = await win.evaluate((lid) => !!Board.items.get(lid).deleted, line0.id);
  for (let i = 0; i < 3; i++) await win.evaluate(() => Board.undo());
  const afterUndo = await win.evaluate(([lid, hid]) => ({ l: Board.items.get(lid), h: Board.items.get(hid) }), [line0.id, host.id]);
  const dxL = afterDrag.l.x - line0.x, dxH = afterDrag.h.x - host.x;
  expect('line sticks to the picture it was drawn on', line0.on === host.id && Math.abs(dxL - dxH) < 0.5 && dxH > 10 && Math.abs(midDrag - line0.x) > 5 && Math.abs(afterScale - line0.w * 2) < 0.5 && afterDel && !afterUndo.l.deleted && Math.abs(afterUndo.l.x - line0.x) < 0.5 && Math.abs(afterUndo.h.x - host.x) < 0.5,
    { on: line0.on, host: host.id, dxL, dxH, midDrag, x0: line0.x, afterScale, w0: line0.w, afterDel, undoX: afterUndo.l.x });
  // A line from an older version (never linked) is linked when the board opens
  const adopt = await win.evaluate(async (hid) => {
    const h = Board.items.get(hid);
    const id = 'oldline';
    Board.items.set(id, { id, type: 'draw', pts: '0 0 10 10', nw: 20, nh: 20, w: 20, x: h.x + 20, y: h.y + 20, sw: 4, z: 9999, rot: 0, deleted: false, created: Date.now() });
    const items = Object.fromEntries([...Board.items.entries()]);
    Board.applyRemote(items);
    return Board.items.get(id).on;
  }, host.id);
  expect('old lines get linked to their picture', adopt === host.id, { adopt, host: host.id });
  // Scrolling always zooms, even a sideways swipe never moves the board
  const vz = await win.evaluate(() => ({ ...Board.view }));
  await win.mouse.move(720, 450);
  await win.mouse.wheel(0, -30);
  await sleep(100);
  const vz1 = await win.evaluate(() => ({ ...Board.view }));
  await win.mouse.wheel(60, 0);
  await sleep(100);
  const vz2 = await win.evaluate(() => ({ ...Board.view }));
  await win.evaluate((v) => { Object.assign(Board.view, v); Board.applyView(); }, vz);
  expect('scroll zooms, swipes never pan', vz1.s > vz.s && vz2.x === vz1.x && vz2.y === vz1.y && vz2.s === vz1.s, { vz, vz1, vz2 });
  // See through: the colour goes clear, the dots stay
  const seeRes = await win.evaluate(() => { document.body.classList.add('see'); const cs = getComputedStyle(document.querySelector('#canvas')); const r = { bg: cs.backgroundColor, img: cs.backgroundImage }; document.body.classList.remove('see'); return r; });
  expect('see through keeps dots and grid', seeRes.bg === 'rgba(0, 0, 0, 0)' && seeRes.img !== 'none', seeRes);
  // Settings: pattern and background are separate, so the pattern changes while see through stays on
  const setRes = await win.evaluate(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise((r) => setTimeout(r, 100));
    const labels = [...document.querySelectorAll('#settings .set-row .set-label')].map((n) => n.textContent);
    const btn = (row, text) => [...document.querySelectorAll('#settings .set-row')].find((r) => r.querySelector('.set-label').textContent === row).querySelector(`.seg`).querySelectorAll('button');
    document.body.classList.add('see'); // stands in for see through being on
    const grid = [...btn('Pattern')].find((b) => b.textContent === 'Grid'); grid.click();
    await new Promise((r) => setTimeout(r, 100));
    const r = { labels, grid: document.querySelector('#canvas').classList.contains('bg-grid'), stillSee: document.body.classList.contains('see') };
    [...btn('Pattern')].find((b) => b.textContent === 'Dots').click();
    document.body.classList.remove('see');
    document.querySelector('#settingsBtn').click();
    return r;
  });
  expect('pattern and background are separate', setRes.labels.includes('Pattern') && setRes.labels.includes('Background') && setRes.grid && setRes.stillSee, setRes);
  // Another app in front: selection boxes hide, and come back on return
  const awayRes = await win.evaluate(() => {
    const it = Board.live().find((x) => x.type === 'image'); Board.sel = new Set([it.id]); Board.render();
    window.dispatchEvent(new Event('blur'));
    const hidden = getComputedStyle(document.querySelector('#overlay')).visibility === 'hidden';
    window.dispatchEvent(new Event('focus'));
    const back = getComputedStyle(document.querySelector('#overlay')).visibility === 'visible';
    const kept = Board.sel.size === 1;
    Board.clearSel();
    return { hidden, back, kept };
  });
  expect('selection boxes hide while another app is in front', awayRes.hidden && awayRes.back && awayRes.kept, awayRes);
  // Shift draws a straight line
  await win.evaluate(() => Board.setTool('pen'));
  await win.keyboard.down('Shift');
  await win.mouse.move(500, 250); await win.mouse.down();
  for (let i = 0; i <= 15; i++) await win.mouse.move(500 + i * 12, 250 + Math.sin(i) * 10 + i * 0.5);
  await win.mouse.up();
  await win.keyboard.up('Shift');
  const straight = await win.evaluate(() => { const d = Board.live().filter((it) => it.type === 'draw').sort((a, b) => b.created - a.created)[0]; const n = d.pts.trim().split(/\s+/).length / 2; Board.undo(); return { points: n }; });
  await win.evaluate(() => Board.setTool('select'));
  expect('shift draws a straight line', straight.points === 2, straight);
  // Rulers: a pattern that follows the view
  const rul = await win.evaluate(async () => {
    const pick = (label) => [...document.querySelectorAll('#settings .set-row')].find((r) => r.querySelector('.set-label').textContent === 'Pattern').querySelectorAll('button');
    document.querySelector('#settingsBtn').click();
    await new Promise((r) => setTimeout(r, 100));
    [...pick()].find((b) => b.textContent === 'Rulers').click();
    await new Promise((r) => setTimeout(r, 100));
    const top = document.querySelector('#rulerTop');
    const shown = getComputedStyle(top).display !== 'none' && getComputedStyle(document.querySelector('#rulerLeft')).display !== 'none';
    const ink = (cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
    const a = top.toDataURL();
    Board.zoomAt(700, 400, 2);
    const b = top.toDataURL();
    Board.zoomAt(700, 400, 0.5);
    const r = { shown, ink: ink(top), changes: a !== b, noDots: !document.querySelector('#canvas').classList.contains('bg-dots') };
    [...pick()].find((b) => b.textContent === 'Dots').click();
    document.querySelector('#settingsBtn').click();
    return r;
  });
  expect('rulers show and follow the zoom', rul.shown && rul.ink > 50 && rul.changes && rul.noDots, rul);
  // Type straight onto a picture: text in the pen colour, no box, sticks to the picture
  const tHost = await win.evaluate(() => { const it = Board.live().filter((x) => x.type === 'image').sort((a, b) => b.w - a.w)[0]; const r = Board.toScreen(it.x + it.w / 3, it.y + it.w / 6); return { id: it.id, sx: r.x, sy: r.y, x: it.x }; });
  await win.evaluate(() => Board.setTool('pen'));
  await win.waitForSelector('#penText');
  await win.click('#penText');
  await win.mouse.click(tHost.sx, tHost.sy);
  await win.keyboard.type('Make it brighter'); // straight away, like a fast typist
  await win.screenshot({ path: `${OUT}/03f-text-typing.png` });
  await win.mouse.click(tHost.sx + 300, tHost.sy + 200);
  await sleep(200);
  const tRes = await win.evaluate(([hid, sx, sy]) => {
    const t = Board.live().filter((x) => x.plain).sort((a, b) => b.created - a.created)[0];
    if (!t) return { none: true };
    const node = Board.els.get(t.id);
    const bg = getComputedStyle(node).backgroundColor;
    const h = Board.items.get(hid);
    const tx0 = t.x;
    Board.commit([{ id: hid, fields: { x: h.x + 50 } }]);
    const moved = Board.items.get(t.id).x - tx0;
    Board.undo();
    const empties = Board.live().filter((x) => x.plain && !x.text).length;
    return { text: t.text, on: t.on, host: hid, bg, color: node.querySelector('.note-text').style.color, moved, empties };
  }, [tHost.id, tHost.sx, tHost.sy]);
  await win.evaluate(() => Board.setTool('select'));
  await win.screenshot({ path: `${OUT}/03g-text.png` });
  expect('type on the board, text sticks to its picture', tRes.text === 'Make it brighter' && tRes.on === tRes.host && tRes.bg === 'rgba(0, 0, 0, 0)' && !!tRes.color && Math.abs(tRes.moved - 50) < 0.5 && tRes.empties === 0, tRes);
  // A short text gets a box as small as its words
  const fit = await win.evaluate(async () => {
    Board.setTool('text');
    const c = Board.toWorld(700, 160);
    Board.addText(c);
    await new Promise((r) => setTimeout(r, 50));
    const id = Board.editingId;
    const t = Board.els.get(id).querySelector('.note-text');
    t.textContent = 'HI';
    Board.stopEditing();
    await new Promise((r) => setTimeout(r, 50));
    Board.sel = new Set([id]); Board.render();
    const it = Board.items.get(id);
    const box = document.querySelector('#overlay .sel, #overlay > div');
    const r = { w: Board.els.get(id).offsetWidth, fs: it.fs, overlayW: box ? box.getBoundingClientRect().width / Board.view.s : null };
    Board.undo(); Board.undo();
    Board.setTool('select');
    return r;
  });
  expect('text box is the size of the text', fit.w < fit.fs * 2.2 && fit.overlayW !== null && Math.abs(fit.overlayW - fit.w) < 6, fit);
  // Text is on the bottom toolbar too
  const tbText = await win.evaluate(() => { const b = document.querySelector('#toolbar [data-tool="text"]'); b.click(); const r = { exists: !!b, tool: Board.tool, on: b.classList.contains('on'), penBar: !document.querySelector('#penBar').hidden }; Board.setTool('select'); return r; });
  expect('text button on the bottom toolbar', tbText.exists && tbText.tool === 'text' && tbText.on && tbText.penBar, tbText);
  // Middle click drag moves the board
  const mv0 = await win.evaluate(() => ({ ...Board.view }));
  await win.mouse.move(700, 450); await win.mouse.down({ button: 'middle' }); await win.mouse.move(780, 500, { steps: 5 }); await win.mouse.up({ button: 'middle' });
  const mv1 = await win.evaluate(() => ({ ...Board.view }));
  await win.evaluate((v) => { Object.assign(Board.view, v); Board.applyView(); }, mv0);
  expect('middle click drag moves the board', Math.abs(mv1.x - mv0.x - 80) < 2 && Math.abs(mv1.y - mv0.y - 50) < 2 && mv1.s === mv0.s, { mv0, mv1 });
  // ...even with a picture selected and the left button still counted as held
  {
    const pic = await win.evaluate(() => { const id = [...Board.items.keys()].find((k) => Board.items.get(k).type === 'image'); Board.sel = new Set([id]); Board.render(); const r = Board.els.get(id).getBoundingClientRect(); return { id, x: r.x + r.width / 2, y: r.y + r.height / 2, ix: Board.items.get(id).x }; });
    const c0 = await win.evaluate(() => ({ ...Board.view }));
    await win.mouse.move(pic.x, pic.y); await win.mouse.down(); await win.mouse.down({ button: 'middle' });
    await win.mouse.move(pic.x + 80, pic.y + 50, { steps: 6 }); await win.mouse.up({ button: 'middle' }); await win.mouse.up();
    const c1 = await win.evaluate((id) => ({ ...Board.view, ix: Board.items.get(id).x }), pic.id);
    await win.evaluate((v) => { Object.assign(Board.view, v); Board.applyView(); Board.clearSel(); }, c0);
    expect('middle click pans even mid click on a selected picture', Math.abs(c1.x - c0.x - 80) < 2 && c1.ix === pic.ix, { c0, c1, pic });
  }
  // Top bar goes away when you switch to another app
  const topAway = await win.evaluate(async () => { document.body.classList.add('show-top', 'show-bottom'); window.dispatchEvent(new Event('blur')); await new Promise((r) => setTimeout(r, 700)); const r = !document.body.classList.contains('show-top') && !document.body.classList.contains('show-bottom'); window.dispatchEvent(new Event('focus')); return r; });
  expect('top and bottom bars hide when another app is in front', topAway, topAway);
  // Colour picker: a disc above the colour button at the right end of the pen bar.
  // Changes apply as you go, clicking away keeps it and adds it to Recent. Tip size is a slider.
  await win.evaluate(() => Board.setTool('pen'));
  await win.waitForSelector('#penBar:not([hidden])');
  await win.click('#penColor');
  await win.waitForSelector('#picker:not([hidden])');
  const geo = await win.evaluate(() => { const p = document.querySelector('#picker').getBoundingClientRect(), b = document.querySelector('#penBar').getBoundingClientRect(), c = document.querySelector('#penColor').getBoundingClientRect(); return { pRight: p.right, bRight: b.right, pBottom: p.bottom, bTop: b.top, cRight: c.right, cx: c.left }; });
  const disc = await win.evaluate(() => { const r = document.querySelector('#pkDisc').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 }; });
  // Pure blue sits at 240 degrees around the disc, right at the edge
  await win.mouse.click(disc.x + Math.cos(240 * Math.PI / 180) * disc.r * 0.99, disc.y + Math.sin(240 * Math.PI / 180) * disc.r * 0.99);
  await sleep(100);
  const picked = await win.evaluate(() => ({ color: Board.pen.color, hex: document.querySelector('#pkHex').value, dot: document.querySelector('#penColorDot').style.background }));
  await win.screenshot({ path: `${OUT}/03h-picker.png` });
  // A spot on the board clear of the picker, whatever the screen size
  const boardSpot = await win.evaluate(() => { const p = document.querySelector('#picker').getBoundingClientRect(); return { x: Math.max(40, p.left - 160), y: Math.max(120, p.top - 40) }; });
  const at700 = await win.evaluate((b) => { const e = document.elementFromPoint(b.x, b.y); return { el: e && (e.id || String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)), w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height }; }, boardSpot);
  await win.mouse.click(boardSpot.x, boardSpot.y); // drawing on the board leaves the picker open
  await sleep(150);
  const stillOpen = await win.evaluate(() => !document.querySelector('#picker').hidden);
  await win.click('#penColor'); // the wheel button tucks it away
  await sleep(150);
  const kept = await win.evaluate(() => ({ stillOpen: window.__x, closed: document.querySelector('#picker').hidden, recent: JSON.parse(localStorage.getItem('penRecent') || '[]')[0] }));
  kept.stillOpen = stillOpen;
  const sizeRes = await win.evaluate(() => { const bs = document.querySelectorAll('#penSizes button'); bs[2].click(); const r = { count: bs.length, size: Board.pen.size, on: document.querySelectorAll('#penSizes button')[2].classList.contains('on') }; document.querySelectorAll('#penSizes button')[1].click(); return r; });
  await win.evaluate(() => { Board.pen.color = '#D7F04A'; Board.setTool('select'); });
  const rgb = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/.exec(picked.color || '') || [];
  const blue = rgb.length && parseInt(rgb[3], 16) > 200 && parseInt(rgb[1], 16) < 40 && parseInt(rgb[2], 16) < 40;
  expect('colour disc sits above the right end of the pen bar', Math.abs(geo.pRight - geo.bRight) < 12 && geo.pBottom < geo.bTop - 10, geo);
  expect('colour disc picks the colour under the pointer', blue && picked.hex === picked.color.slice(1), picked);
  expect('picker stays open until the wheel is clicked, colour goes to Recent', kept.stillOpen && kept.closed && kept.recent && kept.recent.c === picked.color, { kept, at700 });
  // Select typed text: the pen bar shows, and size and colour change that text
  const restyled = await win.evaluate(async () => {
    const t = Board.live().find((x) => x.plain && x.text);
    if (!t) return { none: true };
    Board.setTool('select'); Board.sel = new Set([t.id]); Board.render();
    await new Promise((r) => setTimeout(r, 50));
    const bar = !document.querySelector('#penBar').hidden;
    const fs0 = t.fs, w0 = t.w, c0 = t.color;
    document.querySelectorAll('#penSizes button')[2].click();
    const fs1 = Board.items.get(t.id).fs, w1 = Board.items.get(t.id).w;
    if (document.querySelector('#picker').hidden) document.querySelector('#penColor').click();
    await new Promise((r) => setTimeout(r, 50));
    const sw = [...document.querySelectorAll('#pkRecent button')].find((b) => /F4F3EE/i.test(b.getAttribute('aria-label')));
    if (sw) sw.click();
    const c1 = Board.items.get(t.id).color;
    window.__restyleT = { id: t.id, bar, fs0, fs1, w0, w1, c0, c1 };
    return { pending: true };
  });
  await sleep(300);
  await win.screenshot({ path: `${OUT}/03i-restyle.png` });
  const restyled2 = await win.evaluate(async () => {
    const { id, bar, fs0, fs1, w0, w1, c0, c1 } = window.__restyleT;
    const t = { id };
    document.querySelector('#penColor').click();
    Board.undo(); Board.undo();
    const back = Board.items.get(t.id);
    const r = { bar, fs0, fs1, grew: fs1 > fs0 && w1 > w0, c0, c1, backFs: back.fs, backC: back.color };
    Board.clearSel();
    return r;
  });
  const restyledR = restyled2; expect('selected text takes the new size and colour, undo puts it back', restyledR.bar && restyledR.grew && /F4F3EE/i.test(restyledR.c1 || '') && Math.abs(restyledR.backFs - restyledR.fs0) < 0.01 && restyledR.backC === restyledR.c0, restyledR);
  expect('tip size is three dots', sizeRes.count === 3 && sizeRes.size === 10 && sizeRes.on, sizeRes);
  // Fade one picture on its own
  const fade = await win.evaluate(() => {
    const it = Board.live().find((x) => x.type === 'image');
    Board.commit([{ id: it.id, fields: { op: 0.5 } }]);
    const o = getComputedStyle(Board.els.get(it.id).querySelector('.clip')).opacity;
    const sel = getComputedStyle(Board.els.get(it.id)).opacity;
    Board.undo();
    return { o, sel, back: getComputedStyle(Board.els.get(it.id).querySelector('.clip')).opacity };
  });
  expect('one picture can be faded on its own', fade.o === '0.5' && fade.back === '1', fade);
  // Palette: the main colours of a picture, copy them or add the strip under it
  await win.evaluate(async () => {
    const it = Board.live().filter((x) => x.type === 'image').sort((a, b) => b.w - a.w)[0];
    let shown = null;
    const prev = Board.onPalette;
    Board.onPalette = (i, c) => { shown = c; prev(i, c); };
    await Board.getPalette(it.id);
    Board.onPalette = prev;
    await new Promise((r) => setTimeout(r, 200));
    const modal = !!document.querySelector('.palette');
    window.__pal = { it, shown, modal };
    return null;
  });
  await win.screenshot({ path: `${OUT}/03j-palette.png` });
  const pal = await win.evaluate(async () => {
    const { it, shown, modal } = window.__pal;
    const before = Board.live().filter((x) => x.type === 'image').length;
    document.querySelector('#modalWrap .actions .btn:not(.ghost)').click();
    for (let i = 0; i < 40 && Board.live().filter((x) => x.type === 'image').length === before; i++) await new Promise((r) => setTimeout(r, 100));
    const strip = Board.live().filter((x) => x.type === 'image').sort((a, b) => b.created - a.created)[0];
    const r = { colors: shown, modal, added: Board.live().filter((x) => x.type === 'image').length - before, below: strip.y >= it.y + 10, left: Math.abs(strip.x - it.x) < 1 };
    Board.undo();
    return r;
  });
  expect('palette gives five colours and adds the strip under the picture', pal.colors && pal.colors.length >= 3 && pal.colors.every((c) => /^#[0-9A-F]{6}$/.test(c.hex)) && pal.modal && pal.added === 1 && pal.below && pal.left, pal);
  // Export: the board as a sharp picture or a PDF, drawn from the original files
  const exp = await (async () => {
    const dir = path.join(OUT, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    await app.evaluate(({ dialog }, dir) => { dialog.showSaveDialog = async (w, o) => ({ canceled: false, filePath: dir + '/' + String(o.defaultPath).split(/[\\/]/).pop() }); }, dir);
    const info = await win.evaluate(async () => { const r = await Board.renderExport(null); const px = r.canvas.getContext('2d').getImageData(Math.round(r.w / 2), Math.round(r.h / 2), 1, 1).data; return { w: r.w, h: r.h, screenW: innerWidth, px: [...px] }; });
    await win.evaluate(() => Board.exportAs('png', false));
    await win.evaluate(() => Board.exportAs('pdf', false));
    await sleep(500);
    const files = fs.readdirSync(dir);
    const png = files.find((f) => f.endsWith('.png')), pdf = files.find((f) => f.endsWith('.pdf'));
    const pdfHead = pdf ? fs.readFileSync(path.join(dir, pdf)).slice(0, 8).toString() : '';
    return { ...info, files, pngBytes: png ? fs.statSync(path.join(dir, png)).size : 0, pdfHead };
  })();
  expect('export makes a sharp picture and a PDF of the board', exp.w > exp.screenW && exp.pngBytes > 50000 && exp.pdfHead.startsWith('%PDF-1.4'), exp);
  // Social links through Pluck: a stand in for Pluck's engine answers on its port
  const pluckRes = await (async () => {
    const http = require('http');
    const { execFileSync } = require('child_process');
    const jobsP = new Map();
    let mode = 'ok';
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const send = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers.host !== '127.0.0.1:47821') return send({ error: 'no' }, 403);
        if (req.url === '/api/state') return send({ jobs: [...jobsP.values()] });
        if (req.headers['x-pluck'] !== '1') return send({ error: 'no' }, 403);
        const b = JSON.parse(body || '{}');
        if (req.url === '/api/probe') {
          if (mode === 'private') return send({ error: "This post is private, so Pluck can't see it." }, 400);
          return send({ kind: 'video', title: 'Brunch reel', thumb: '', platform: { name: 'Instagram' }, items: [{ i: 0, type: 'video' }] });
        }
        if (req.url === '/api/download') {
          const id = 'j' + jobsP.size;
          const out = require('path').join(b.dir, 'Brunch reel.mp4');
          const j = { id, status: 'running', pct: 30, files: [] };
          jobsP.set(id, j);
          setTimeout(() => {
            execFileSync(require('ffmpeg-static') || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', out]);
            j.pct = 100; j.status = 'done'; j.files = [out];
          }, 1500);
          return send(j);
        }
        if (req.url === '/api/cancel') return send({ ok: true });
        send({ error: 'Unknown request' }, 404);
      });
    });
    await new Promise((r) => srv.listen(47821, '127.0.0.1', r));
    const before = await win.evaluate(() => Board.live().filter((x) => x.type === 'video').length);
    await win.evaluate(() => { Board.addSocial('https://www.instagram.com/reel/abc123/', Board.toWorld(720, 300)); });
    await sleep(700);
    let cardSeen = await win.evaluate(() => !!document.querySelector('.fetch-card'));
    await win.screenshot({ path: `${OUT}/03k-pluck.png` });
    await win.waitForFunction((n) => Board.live().filter((x) => x.type === 'video').length > n, before, { timeout: 30000 }).catch(() => {});
    const added = await win.evaluate((n) => Board.live().filter((x) => x.type === 'video').length - n, before);
    const cardGone = await win.evaluate(() => !document.querySelector('.fetch-card'));
    await sleep(300);
    const tmpLeft = fs.existsSync(require('os').tmpdir() + '/eye-refs-pluck') ? fs.readdirSync(require('os').tmpdir() + '/eye-refs-pluck').length : 0;
    await win.evaluate(() => Board.undo());
    // Pluck says no: the card says why, in its words
    mode = 'private';
    await win.evaluate(() => { Board.addSocial('https://www.instagram.com/p/private1/', Board.toWorld(720, 300)); });
    await win.waitForFunction(() => document.querySelector('.fetch-card.failed'), null, { timeout: 15000 }).catch(() => {});
    const errText = await win.evaluate(() => { const c = document.querySelector('.fetch-card.failed'); const t = c && c.querySelector('.fc-phase').textContent; if (c) c.querySelector('.fc-btn:last-child').click(); return t; });
    // No Pluck on this computer: a button to get it
    await new Promise((r) => srv.close(r));
    await win.evaluate(() => { Board.addSocial('https://youtu.be/xyz', Board.toWorld(720, 300)); });
    await win.waitForSelector('#modalWrap:not([hidden]) >> text=Download Pluck', { timeout: 15000 }).catch(() => {});
    const missing = await win.evaluate(() => { const m = document.querySelector('#modalWrap'); const r = { title: m.querySelector('h2') && m.querySelector('h2').textContent, get: [...m.querySelectorAll('.btn')].map((b) => b.textContent), card: !!document.querySelector('.fetch-card') }; const no = [...m.querySelectorAll('.btn')].find((b) => b.textContent === 'Not now'); if (no) no.click(); return r; });
    // A pasted social link goes to Pluck, not into a note
    const routed = await win.evaluate(() => { const notes = Board.live().filter((x) => x.type === 'note').length; return notes; });
    return { cardSeen, added, cardGone, tmpLeft, errText, missing, routed };
  })();
  expect('a social link comes in as a video through Pluck', pluckRes.cardSeen && pluckRes.added === 1 && pluckRes.cardGone && pluckRes.tmpLeft === 0, pluckRes);
  expect('when Pluck says no, the card says why', /private/.test(pluckRes.errText || ''), pluckRes.errText);
  expect('without Pluck, it asks to download Pluck', pluckRes.missing && pluckRes.missing.get.includes('Download Pluck') && !pluckRes.missing.card, pluckRes.missing);
  // The window strip at the top never covers the board while you work
  const stripRes = await win.evaluate(() => { const hit = document.elementFromPoint(innerWidth / 2, 30); return { id: hit && hit.id, cls: hit && hit.className && String(hit.className.baseVal !== undefined ? hit.className.baseVal : hit.className) }; });
  expect('the top of the board can be clicked while working', stripRes.id !== 'topbar', stripRes);
  // Sections: wrap some pictures, name it, move it and they come along
  const secRes = await (async () => {
    const ids = await win.evaluate(() => { const imgs = Board.live().filter((x) => x.type === 'image').slice(0, 2); Board.sel = new Set(imgs.map((x) => x.id)); Board.render(); Board.sectionFromSelection(); return imgs.map((x) => ({ id: x.id, x: x.x, y: x.y })); });
    await sleep(150);
    await win.keyboard.type('Lighting');
    await win.keyboard.press('Enter');
    await sleep(150);
    const sec = await win.evaluate(() => Board.sections()[0]);
    // Bring the section label clear of the title bar on small screens
    await win.evaluate((id) => { const r = Board.els.get(id).querySelector('.section-label').getBoundingClientRect(); if (r.top < 110) { Board.view.y += 140 - r.top; Board.applyView(); } }, sec.id);
    await sleep(100);
    const lab = await win.evaluate((id) => { const r = Board.els.get(id).querySelector('.section-label').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; }, sec.id);
    await win.screenshot({ path: `${OUT}/03l-section.png` });
    const labAt = await win.evaluate((p) => { const e = document.elementFromPoint(p.x, p.y); return { el: e && (e.id || String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)), p, w: innerWidth, h: innerHeight, modal: !!document.querySelector('#modalWrap:not([hidden])') }; }, lab);
    await win.mouse.move(lab.x, lab.y); await win.mouse.down(); await win.mouse.move(lab.x + 80, lab.y + 40, { steps: 6 }); await win.mouse.up();
    const after = await win.evaluate((ids) => ids.map((o) => ({ dx: Board.items.get(o.id).x - o.x, dy: Board.items.get(o.id).y - o.y })), ids);
    const secAfter = await win.evaluate((id) => Board.items.get(id), sec.id);
    const pill = await win.evaluate(() => ({ shown: !document.querySelector('#tSections').hidden, text: document.querySelector('#tSectionsN').textContent }));
    await win.evaluate(() => { Board.undo(); });
    const undone = await win.evaluate((ids) => ids.every((o) => Math.abs(Board.items.get(o.id).x - o.x) < 0.5), ids);
    // Remove the section again so later checks see the board as it was
    await win.evaluate((id) => { Board.commit([{ id, fields: { deleted: true } }]); }, sec.id);
    return { title: sec.title, moved: after, secMoved: secAfter.x - sec.x, pill, undone, wraps: ids.length, labAt };
  })();
  const sm = secRes.moved.every((m) => Math.abs(m.dx - secRes.secMoved) < 0.5 && Math.abs(secRes.secMoved) > 10);
  expect('a section holds pictures, has a name, and moves them with it', secRes.title === 'Lighting' && sm && secRes.pill.shown && secRes.pill.text === '1 section' && secRes.undone, secRes);
  // Saved versions: save, change things, go back, and undo the going back
  const verRes = await (async () => {
    const pid = await win.evaluate(() => Board.project.id);
    const snap = await win.evaluate(() => { const it = Board.live().find((x) => x.type === 'image'); return { id: it.id, x: it.x, count: Board.live().length }; });
    await win.evaluate(async (pid) => { await window.eyerefs.versionSave(pid, 'Before feedback', Board.versionItems()); }, pid);
    await win.evaluate((snap) => { Board.commit([{ id: snap.id, fields: { x: snap.x + 500 } }]); Board.addNote(Board.toWorld(700, 400), 'New idea'); }, snap);
    await sleep(200);
    await win.keyboard.press('Escape');
    const opened = await win.evaluate(async () => { const b = document.querySelector('#settingsBtn'); return !!b; });
    await win.evaluate(() => window.__openVersions && window.__openVersions());
    await win.waitForSelector('.versions', { timeout: 5000 });
    await win.screenshot({ path: `${OUT}/03m-versions.png` });
    await win.click('.versions .vrow:first-child .btn:text("Restore")');
    await sleep(400);
    const after = await win.evaluate((snap) => ({ x: Board.items.get(snap.id).x, count: Board.live().length, note: Board.live().some((x) => x.type === 'note' && x.text === 'New idea') }), snap);
    const list = await win.evaluate(async (pid) => (await window.eyerefs.versionsList(pid)).versions.map((v) => v.name), pid);
    await win.evaluate(() => Board.undo());
    const undone = await win.evaluate((snap) => ({ x: Board.items.get(snap.id).x, note: Board.live().some((x) => x.type === 'note' && x.text === 'New idea') }), snap);
    // Tidy up for the checks after this
    await win.evaluate((snap) => { Board.restoreVersion(Object.fromEntries(Board.live().filter((x) => !(x.type === 'note' && x.text === 'New idea')).map((x) => [x.id, x]))); Board.commit([{ id: snap.id, fields: { x: snap.x } }]); }, snap);
    return { snap, after, list, undone, opened };
  })();
  expect('a saved version brings the board back, and undo returns to before', Math.abs(verRes.after.x - verRes.snap.x) < 0.5 && !verRes.after.note && verRes.after.count === verRes.snap.count && verRes.list.includes('Before feedback') && verRes.list.some((n) => n.startsWith('Before restoring')) && verRes.undone.note && Math.abs(verRes.undone.x - verRes.snap.x - 500) < 0.5, verRes);
  // Comments: pin one on a picture, reply, it moves with the picture, resolve hides it
  const cm = await (async () => {
    const host = await win.evaluate(() => { const it = Board.live().filter((x) => x.type === 'image').sort((a, b) => b.w - a.w)[0]; const r = Board.toScreen(it.x + it.w * 0.3, it.y + it.w * 0.2); return { id: it.id, sx: r.x, sy: r.y, x: it.x }; });
    await win.click('#toolbar [data-tool="comment"]');
    await win.mouse.click(host.sx, host.sy);
    await win.waitForSelector('#thread:not([hidden]) textarea');
    await win.keyboard.type('Warmer grade, like this');
    await win.keyboard.press('Enter');
    await sleep(200);
    await win.keyboard.type('Agreed');
    await win.keyboard.press('Enter');
    await sleep(200);
    await win.screenshot({ path: `${OUT}/03n-comment.png` });
    const st = await win.evaluate((hid) => {
      const roots = Board.comments().filter((c) => !c.root && c.on === hid);
      const root = roots[roots.length - 1];
      const pin = document.querySelector(`.cpin[data-id="${root.id}"]`);
      const p0 = pin.style.transform;
      const h = Board.items.get(hid);
      Board.commit([{ id: hid, fields: { x: h.x + 300 } }]);
      const p1 = document.querySelector(`.cpin[data-id="${root.id}"]`).style.transform;
      Board.undo();
      const msgs = document.querySelectorAll('#thread .th-msg').length;
      const reply = [...document.querySelectorAll('#thread .th-text')].map((n) => n.textContent)[1];
      const box = document.querySelector('#thread textarea').value;
      return { root: root.id, text: root.text, msgs, reply, box, moved: p0 !== p1, tool: Board.tool, inLive: Board.live().some((x) => x.type === 'comment') };
    }, host.id);
    await win.click('#thread .th-btn:text("Resolve")');
    await sleep(150);
    const hidden = await win.evaluate((id) => !document.querySelector(`.cpin[data-id="${id}"]`) && document.querySelector('#thread').hidden, st.root);
    return { ...st, hidden };
  })();
  expect('comments pin to a picture, take replies, move with it, and resolve', cm.text === 'Warmer grade, like this' && cm.msgs === 2 && cm.reply === 'Agreed' && cm.box === '' && cm.moved && cm.tool === 'select' && !cm.inLive && cm.hidden, cm);
  // Loopholes found in review
  const holes = await win.evaluate(async () => {
    const out = {};
    // A section's new height is saved, and survives undo and redo
    const img = Board.live().find((x) => x.type === 'image');
    Board.sel = new Set([img.id]); Board.render();
    Board.sectionFromSelection();
    await new Promise((r) => setTimeout(r, 50));
    document.activeElement && document.activeElement.blur();
    const sec = Board.sections()[Board.sections().length - 1];
    const h0 = sec.h;
    Board.sel = new Set([sec.id]); Board.render();
    const hs = document.querySelector('#overlay .h[data-h="se"]');
    const r = hs.getBoundingClientRect();
    const ev = (t, x, y) => document.querySelector('#canvas').dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 7 }));
    hs.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 3, clientY: r.top + 3, button: 0, buttons: 1, pointerId: 7 }));
    ev('pointermove', r.left + 3, r.top + 83); ev('pointermove', r.left + 3, r.top + 123);
    document.querySelector('#canvas').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 3, clientY: r.top + 123, button: 0, pointerId: 7 }));
    const h1 = Board.items.get(sec.id).h;
    Board.undo(); const hu = Board.items.get(sec.id).h; Board.redo(); const hr = Board.items.get(sec.id).h;
    // Picture only actions leave sections alone
    Board.sel = new Set([sec.id, img.id]); Board.render();
    Board.resetTransform && Board.resetTransform();
    out.section = { h0, h1, hu, hr, wOk: Number.isFinite(Board.items.get(sec.id).w) };
    Board.commit([{ id: sec.id, fields: { deleted: true } }]);
    // Restoring a version clears a fade added after it was saved
    const snap = Board.versionItems();
    Board.commit([{ id: img.id, fields: { op: 0.25 } }]);
    const n = Board.restoreVersion(snap);
    out.version = { op: Board.items.get(img.id).op, changed: n, again: Board.restoreVersion(Board.versionItems()) };
    return out;
  });
  expect('a section keeps its new height through undo and redo', holes.section.h1 > holes.section.h0 + 20 && Math.abs(holes.section.hu - holes.section.h0) < 0.5 && Math.abs(holes.section.hr - holes.section.h1) < 0.5 && holes.section.wOk, holes.section);
  expect('a version clears changes made after it, and nothing changes when it already matches', holes.version.op == null && holes.version.changed === 1 && holes.version.again === 0, holes.version);
  // Patterns mix: dots and rulers together, then grid too, then none
  const pats = await win.evaluate(async () => {
    document.querySelector('#settingsBtn').click();
    await new Promise((r) => setTimeout(r, 80));
    const row = () => [...document.querySelectorAll('#settings .set-row')].find((r) => r.querySelector('.set-label').textContent === 'Pattern');
    const click = (t) => [...row().querySelectorAll('button')].find((b) => b.textContent === t).click();
    const c = document.querySelector('#canvas');
    const state = () => ({ dots: c.classList.contains('bg-dots'), grid: c.classList.contains('bg-grid'), rulers: document.body.classList.contains('rulers'), on: [...row().querySelectorAll('button.on')].map((b) => b.textContent) });
    click('None'); click('Dots'); click('Rulers');
    const a = state();
    click('Grid');
    const b = state();
    click('None');
    const n = state();
    click('Dots');
    document.querySelector('#settingsBtn').click();
    return { a, b, n };
  });
  expect('patterns can be mixed', pats.a.dots && pats.a.rulers && !pats.a.grid && pats.b.dots && pats.b.grid && pats.b.rulers && !pats.n.dots && !pats.n.grid && !pats.n.rulers && pats.n.on.join() === 'None', pats);
  // A locked canvas still lets you draw
  const lockDraw = await (async () => {
    await win.evaluate(() => { Board.setLockedCanvas(true); Board.setTool('pen'); });
    const n0 = await win.evaluate(() => Board.live().filter((x) => x.type === 'draw').length);
    await win.mouse.move(600, 300); await win.mouse.down();
    for (let i = 0; i <= 8; i++) await win.mouse.move(600 + i * 10, 300 + i * 4);
    await win.mouse.up();
    const n1 = await win.evaluate(() => Board.live().filter((x) => x.type === 'draw').length);
    await win.evaluate(() => { Board.undo(); Board.setTool('select'); Board.setLockedCanvas(false); });
    return { n0, n1 };
  })();
  expect('drawing works on a locked canvas', lockDraw.n1 === lockDraw.n0 + 1, lockDraw);
  // A drag whose release got lost ends as soon as no button is held, so the window never sticks to the mouse
  const stuck = await win.evaluate(() => {
    const c = document.querySelector('#canvas');
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 600, clientY: 400, button: 2, buttons: 2, pointerId: 9, pointerType: 'mouse', screenX: 600, screenY: 400 }));
    const during = Board.gesture && Board.gesture.type;
    c.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 620, clientY: 410, buttons: 0, pointerId: 9, pointerType: 'mouse', screenX: 620, screenY: 410 }));
    return { during, after: Board.gesture, menu: window.UI.menuOpen() };
  });
  expect('a lost release never leaves the window stuck to the mouse', stuck.during === 'right' && stuck.after === null && !stuck.menu, stuck);
  // The edge bars still show after a click whose release got lost
  const edge = await win.evaluate(async () => {
    const c = document.querySelector('#canvas');
    const clean = document.body.classList.contains('ui-auto') && !document.body.classList.contains('board-empty');
    c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 400, button: 0, buttons: 1, pointerId: 11, pointerType: 'mouse' }));
    Board.clearSel();
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 700, clientY: innerHeight - 5, buttons: 0, pointerType: 'mouse' }));
    await new Promise((r) => setTimeout(r, 50));
    const shown = document.body.classList.contains('show-bottom');
    document.body.classList.remove('show-bottom');
    return { clean, shown };
  });
  expect('edge bars still show after a lost release', !edge.clean || edge.shown, edge);
  // A message never sits on the pen bar
  await win.evaluate(() => Board.setTool('pen'));
  await win.waitForSelector('#penBar:not([hidden])');
  await win.evaluate(() => UI.toast('No longer on top'));
  await sleep(250);
  const tb = await win.evaluate(() => { const t = document.querySelector('#toast').getBoundingClientRect(); const p = document.querySelector('#penBar').getBoundingClientRect(); const b = document.querySelector('#toolbar').getBoundingClientRect(); return { toastBottom: t.bottom, penTop: p.top, barTop: b.top }; });
  await win.screenshot({ path: `${OUT}/03e-toast.png` });
  expect('message sits above the pen bar', tb.toastBottom <= Math.min(tb.penTop, tb.barTop) - 4, tb);
  await win.evaluate(() => Board.setTool('select'));
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
  await win.keyboard.press('ControlOrMeta+V');
  await win.waitForFunction((n) => Board.live().filter((it) => it.type !== 'draw').length > n, n0, { timeout: 15000 });
  await app.evaluate(({ clipboard, nativeImage }, f) => clipboard.writeImage(nativeImage.createFromPath(f)), `${SRC}/night.jpg`);
  await win.keyboard.press('ControlOrMeta+V');
  await win.waitForFunction((n) => Board.live().filter((it) => it.type !== 'draw').length > n + 1, n0, { timeout: 15000 });
  await app.evaluate(({ clipboard }) => clipboard.writeText('Warmer light, like the second shot'));
  await win.keyboard.press('ControlOrMeta+V');
  await win.waitForFunction(() => Board.live().some((it) => it.type === 'note' && /Warmer light/.test(it.text || '')), null, { timeout: 15000 });
  console.log('pasted', (await count()) - n0);
  imgSrv.close();
  await win.evaluate(() => { Board.arrange(); Board.focusAll(); Board.clearSel(); });
  await sleep(300);

  // Rotating a selection turns every item by the same amount, around the selection's centre
  await win.evaluate(() => {
    // The item the pointer would land on at a screen point
    window.__topAt = (x, y) => { for (const n of document.elementsFromPoint(x, y)) { const it = n.closest && n.closest('#world .item'); if (it) return it.dataset.id; if (n.id === 'canvas') break; } return null; };
    // A point inside an item, near (fx, fy) of its box, where nothing covers it
    window.__freePoint = (id, fx, fy) => {
      const r = Board.els.get(id).getBoundingClientRect();
      for (let dy = 0; dy <= 0.3; dy += 0.05) for (const s of [1, -1]) { const x = r.left + r.width * fx, y = r.top + r.height * (fy + s * dy); if (window.__topAt(x, y) === id) return { x, y }; }
      return null;
    };
  });
  const rotSetup = await win.evaluate(() => {
    const imgs = Board.live().filter((it) => it.type === 'image').slice(0, 2);
    Board.sel = new Set(imgs.map((i) => i.id)); Board.focusSelection();
    const centre = (it) => { const n = Board.els.get(it.id).getBoundingClientRect(); return { x: n.left + n.width / 2, y: n.top + n.height / 2 }; };
    const b = centre(imgs[1]);
    let a = null;
    for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) { a = window.__freePoint(imgs[0].id, fx, 0.5); if (a) break; }
    return { ids: imgs.map((i) => i.id), rot0: imgs.map((i) => i.rot || 0), a, g: { x: (centre(imgs[0]).x + b.x) / 2, y: (centre(imgs[0]).y + b.y) / 2 } };
  });
  {
    const { a, g } = rotSetup;
    // Start on the first item and swing a quarter turn around the group centre
    const R = Math.hypot(a.x - g.x, a.y - g.y), a0 = Math.atan2(a.y - g.y, a.x - g.x);
    await win.keyboard.down('ControlOrMeta');
    await win.mouse.move(a.x, a.y); await win.mouse.down();
    for (let i = 1; i <= 12; i++) { const t = a0 + (Math.PI / 6) * (i / 12); await win.mouse.move(g.x + Math.cos(t) * R, g.y + Math.sin(t) * R); }
    await win.mouse.up(); await win.keyboard.up('ControlOrMeta');
  }
  const rotRes = await win.evaluate((ids) => ids.map((id) => Board.items.get(id).rot || 0), rotSetup.ids);
  const deltas = rotRes.map((r, i) => (((r - rotSetup.rot0[i]) % 360) + 360) % 360);
  expect('multi rotate equal deltas', Math.abs(deltas[0] - deltas[1]) < 0.01 && deltas[0] > 10 && deltas[0] < 50, deltas);
  await win.evaluate(() => Board.undo());

  // Cropping a flipped picture: the edge you drag on screen is the one that moves
  const cropSetup = await win.evaluate(() => {
    for (const it of Board.live().filter((i) => i.type === 'image' && !(i.crop && (i.crop.l || i.crop.r || i.crop.t || i.crop.b)))) {
      Board.sel = new Set([it.id]); Board.focusSelection();
      // Pick the spot after flipping: text stuck to the picture flips along with it
      Board.toggleField('flipX'); Board.clearSel();
      const pt = window.__freePoint(it.id, 0.08, 0.5);
      if (!pt) { Board.sel = new Set([it.id]); Board.toggleField('flipX'); Board.clearSel(); continue; }
      const r = Board.els.get(it.id).getBoundingClientRect();
      return { id: it.id, pt, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    }
    return null;
  });
  await sleep(200);
  await win.mouse.move(cropSetup.pt.x, cropSetup.pt.y);
  await win.keyboard.down('c');
  await win.waitForFunction(() => Board.held.has('c'), null, { timeout: 2000 }).catch(() => {});
  const cropKey = await win.evaluate((p) => ({ tool: Board.tool, at: (() => { const e = document.elementFromPoint(p.x, p.y); return e && (e.id || String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })(), sel: [...Board.sel].length, locked: Board.lockedCanvas, held: [...Board.held], active: document.activeElement && (document.activeElement.id || document.activeElement.className), editing: Board.editingId, focus: document.hasFocus() }), cropSetup.pt);
  await win.mouse.down();
  await win.mouse.move(cropSetup.pt.x + cropSetup.w * 0.2, cropSetup.pt.y, { steps: 8 });
  await win.mouse.up();
  await win.keyboard.up('c');
  const cropRes = await win.evaluate((id) => { const r = Board.els.get(id).getBoundingClientRect(); return { left: r.left, right: r.right, crop: Board.items.get(id).crop }; }, cropSetup.id);
  const want = cropSetup.w * 0.2;
  expect('crop flipped image moves the dragged edge', Math.abs(cropRes.left - cropSetup.left - want) < 4 && Math.abs(cropRes.right - cropSetup.right) < 2 && cropRes.crop.r > 0.1 && !cropRes.crop.l, { before: cropSetup, after: cropRes, cropKey });
  // Reset cropping keeps the flipped picture where it is
  const resetRes = await win.evaluate((id) => { Board.sel = new Set([id]); Board.resetCrop(); Board.clearSel(); const r = Board.els.get(id).getBoundingClientRect(); return { left: r.left, right: r.right }; }, cropSetup.id);
  expect('reset crop on flipped image stays put', Math.abs(resetRes.left - cropSetup.left) < 2 && Math.abs(resetRes.right - cropSetup.right) < 2, resetRes);
  await win.evaluate(() => { Board.undo(); Board.undo(); Board.undo(); });
  const cropUndone = await win.evaluate((id) => { const it = Board.items.get(id); return !it.flipX && !(it.crop && it.crop.r); }, cropSetup.id);
  expect('crop test undone', cropUndone);

  // ---------- PureRef transform controls ----------
  {
    const pic = await win.evaluate(() => {
      const it = Board.live().find((i) => i.type === 'image' && !i.locked);
      Board.sel = new Set([it.id]); Board.focusSelection(); Board.render();
      return it.id;
    });
    await sleep(200);
    const centreOf = (id) => win.evaluate((i) => { const r = Board.els.get(i).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
    const st = (id) => win.evaluate((i) => { const it = Board.items.get(i); const c = it.crop || {}; return { x: it.x, y: it.y, w: it.w, rot: it.rot || 0, op: it.op == null ? 1 : it.op, crop: { l: c.l || 0, t: c.t || 0, r: c.r || 0, b: c.b || 0 } }; }, id);
    const box = () => win.evaluate(() => { const b = document.querySelector('#overlay .sel:not(.multi-item)').getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; });

    // Rotate by grabbing just outside a corner
    await win.screenshot({ path: `${OUT}/t1-gizmo.png` });
    const zone = await win.evaluate(() => { const z = document.querySelector('#overlay .r.se'); if (!z) return null; const r = z.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const c0 = await centreOf(pic), r0 = await st(pic);
    const R = Math.hypot(zone.x - c0.x, zone.y - c0.y), a0 = Math.atan2(zone.y - c0.y, zone.x - c0.x);
    await win.mouse.move(zone.x, zone.y); await win.mouse.down();
    for (let i = 1; i <= 10; i++) { const t = a0 + (Math.PI / 6) * (i / 10); await win.mouse.move(c0.x + Math.cos(t) * R, c0.y + Math.sin(t) * R); }
    await win.mouse.up();
    const r1 = await st(pic);
    expect('grabbing outside a corner rotates', zone && Math.abs(((r1.rot - r0.rot + 360) % 360) - 30) < 4, { zone, r0: r0.rot, r1: r1.rot });
    await win.evaluate(() => Board.undo());

    // ...with Shift, in 45 degree steps
    await win.mouse.move(zone.x, zone.y); await win.mouse.down(); await win.keyboard.down('Shift');
    for (let i = 1; i <= 10; i++) { const t = a0 + (Math.PI / 3.4) * (i / 10); await win.mouse.move(c0.x + Math.cos(t) * R, c0.y + Math.sin(t) * R); }
    await win.mouse.up(); await win.keyboard.up('Shift');
    const r2 = await st(pic);
    expect('Shift rotates in 45 degree steps', Math.abs(r2.rot % 45) < 0.01 && r2.rot !== r0.rot, { rot: r2.rot });
    await win.evaluate(() => Board.undo());

    // Alt on a corner: grows from the centre
    await win.evaluate((i) => { Board.sel = new Set([i]); Board.render(); }, pic);
    const h = await win.evaluate(() => { const r = document.querySelector('#overlay .h.se').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const cBefore = await centreOf(pic), sBefore = await st(pic);
    await win.keyboard.down('Alt'); await win.mouse.move(h.x, h.y); await win.mouse.down(); await win.mouse.move(h.x + 60, h.y + 40, { steps: 6 }); await win.mouse.up(); await win.keyboard.up('Alt');
    const cAfter = await centreOf(pic), sAfter = await st(pic);
    expect('Alt on a corner scales from the centre', sAfter.w > sBefore.w * 1.05 && Math.abs(cAfter.x - cBefore.x) < 2 && Math.abs(cAfter.y - cBefore.y) < 2, { cBefore, cAfter, w0: sBefore.w, w1: sAfter.w });
    await win.evaluate(() => Board.undo());

    // Shift+Alt with two pictures: each grows around its own centre
    const two = await win.evaluate(() => { const ids = Board.live().filter((i) => i.type === 'image' && !i.locked).slice(0, 2).map((i) => i.id); Board.sel = new Set(ids); Board.focusSelection(); Board.render(); return ids; });
    await sleep(200);
    const cc0 = await Promise.all(two.map(centreOf));
    const gh = await win.evaluate(() => { const hs = [...document.querySelectorAll('#overlay .h.se')]; const r = hs[hs.length - 1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await win.keyboard.down('Shift'); await win.keyboard.down('Alt');
    await win.mouse.move(gh.x, gh.y); await win.mouse.down(); await win.mouse.move(gh.x - 50, gh.y - 30, { steps: 6 }); await win.mouse.up();
    await win.keyboard.up('Alt'); await win.keyboard.up('Shift');
    const cc1 = await Promise.all(two.map(centreOf));
    const ws = await win.evaluate((ids) => ids.map((i) => Board.items.get(i).w), two);
    expect('Shift+Alt scales each piece from its own centre', cc0.every((c, i) => Math.abs(c.x - cc1[i].x) < 2 && Math.abs(c.y - cc1[i].y) < 2), { cc0, cc1, ws });
    await win.evaluate(() => Board.undo());

    // Crop with handles
    await win.evaluate((i) => { Board.sel = new Set([i]); Board.focusSelection(); Board.render(); }, pic);
    await sleep(200);
    await win.evaluate(() => document.querySelector('#canvas').focus());
    await win.keyboard.press('ControlOrMeta+Alt+Shift+C');
    await sleep(150);
    const handlesOn = await win.evaluate(() => document.querySelectorAll('#overlay .ch').length);
    expect('Cmd/Ctrl+Alt+Shift+C shows crop handles', handlesOn === 8, { handlesOn });
    await win.screenshot({ path: `${OUT}/t2-crop-mode.png` });
    const before = await st(pic), bx0 = await box();
    const eH = await win.evaluate(() => { const r = document.querySelector('#overlay .ch.e').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await win.mouse.move(eH.x, eH.y); await win.mouse.down(); await win.mouse.move(eH.x - 70, eH.y, { steps: 6 }); await win.mouse.up();
    const after = await st(pic), bx1 = await box();
    const croppedSide = after.crop.r > 0.02 || after.crop.l > 0.02;
    expect('dragging the right handle crops that side', croppedSide && Math.abs(bx1.l - bx0.l) < 2 && bx1.r < bx0.r - 40, { before: before.crop, after: after.crop, bx0, bx1 });
    const sq = await win.evaluate(() => { const r = document.querySelector('#overlay .ch.se').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await win.keyboard.down('Shift'); await win.keyboard.down('Alt');
    await win.mouse.move(sq.x - 2, sq.y - 2); await win.mouse.down(); await win.mouse.move(sq.x - 40, sq.y - 25, { steps: 6 }); await win.mouse.up();
    await win.keyboard.up('Alt'); await win.keyboard.up('Shift');
    const bsq = await box();
    expect('Shift+Alt makes the crop square', Math.abs((bsq.r - bsq.l) - (bsq.b - bsq.t)) < 3, bsq);
    await win.keyboard.press('Escape');
    expect('Escape leaves crop mode', await win.evaluate(() => !Board.cropMode && !document.querySelector('#overlay .ch')));
    await win.evaluate(() => { Board.undo(); Board.undo(); });

    // Shift+V zooms inside the crop; the frame stays put
    await win.evaluate((i) => { Board.sel = new Set([i]); Board.render(); }, pic);
    const zp = await win.evaluate((i) => { for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fy of [0.5, 0.3, 0.7]) { const p = window.__freePoint(i, fx, fy); if (p) return p; } return null; }, pic);
    const z0 = await st(pic), zb0 = await box();
    await win.keyboard.down('Shift'); await win.keyboard.down('v');
    await win.mouse.move(zp.x, zp.y); await win.mouse.down(); await win.mouse.move(zp.x + 120, zp.y, { steps: 8 }); await win.mouse.up();
    await win.keyboard.up('v'); await win.keyboard.up('Shift');
    const z1 = await st(pic), zb1 = await box();
    const win1 = 1 - z1.crop.l - z1.crop.r;
    expect('Shift+V drag zooms inside the crop', win1 < 0.8 && Math.abs(z1.w - z0.w) < 0.5 && Math.abs(zb1.l - zb0.l) < 2, { z0: z0.crop, z1: z1.crop, zb0, zb1 });
    await win.evaluate(() => Board.undo());

    // Cmd/Ctrl+Alt+Shift drag: opacity
    await win.keyboard.down('ControlOrMeta'); await win.keyboard.down('Alt'); await win.keyboard.down('Shift');
    await win.mouse.move(zp.x, zp.y); await win.mouse.down(); await win.mouse.move(zp.x - 120, zp.y, { steps: 8 });
    const hint = await win.evaluate(() => !document.querySelector('#hint').hidden && document.querySelector('#hint').textContent);
    await win.mouse.up();
    await win.keyboard.up('Shift'); await win.keyboard.up('Alt'); await win.keyboard.up('ControlOrMeta');
    const o1 = await st(pic);
    expect('Cmd/Ctrl+Alt+Shift drag changes opacity', o1.op < 0.7 && o1.op > 0.5, { op: o1.op, hint });
    expect('opacity readout shows while dragging', /Opacity \d+/.test(hint || ''), { hint });
    await win.evaluate(() => Board.undo());

    // Shift+Space while moving snaps to the edges of other pieces
    const snap = await win.evaluate(() => {
      const ids = Board.live().filter((i) => i.type === 'image' && !i.locked && !(i.rot % 360)).slice(0, 2).map((i) => i.id);
      if (ids.length < 2) return null;
      const [a, b] = ids;
      Board.commit([{ id: a, fields: { rot: 0 } }, { id: b, fields: { rot: 0 } }]);
      Board.sel = new Set([a, b]); Board.focusSelection(); Board.clearSel(); Board.sel = new Set([a]); Board.render();
      const ra = Board.els.get(a).getBoundingClientRect(), rb = Board.els.get(b).getBoundingClientRect();
      return { a, b, ra: { l: ra.left, r: ra.right, t: ra.top }, rb: { l: rb.left, r: rb.right, t: rb.top } };
    });
    if (snap) {
      const sp = await win.evaluate((i) => { for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fy of [0.5, 0.3, 0.7]) { const p = window.__freePoint(i, fx, fy); if (p) return p; } return null; }, snap.a);
      // Aim to land the left edge 5px off the other picture's left edge
      const want = snap.rb.l + 5 - snap.ra.l;
      await win.keyboard.down('Shift'); await win.keyboard.down('Space');
      await win.mouse.move(sp.x, sp.y); await win.mouse.down(); await win.mouse.move(sp.x + want, sp.y + 7, { steps: 10 }); await win.mouse.up();
      await win.keyboard.up('Space'); await win.keyboard.up('Shift');
      const landed = await win.evaluate((s) => {
        const ra = Board.els.get(s.a).getBoundingClientRect();
        const mine = [ra.left, ra.right, (ra.left + ra.right) / 2];
        const theirs = [];
        for (const o of Board.live()) { if (o.id === s.a || !Board.els.get(o.id)) continue; const r = Board.els.get(o.id).getBoundingClientRect(); theirs.push(r.left, r.right, (r.left + r.right) / 2); }
        const gap = Math.min(...mine.flatMap((m) => theirs.map((t) => Math.abs(m - t))));
        return { al: ra.left, gap };
      }, snap);
      expect('Shift+Space snaps to other pieces', landed.gap < 1 && Math.abs(landed.al - (snap.rb.l + 5)) < 12, { landed, sp, want, snap });
      await win.evaluate(() => { Board.undo(); Board.undo(); });
    }
    await win.evaluate(() => Board.clearSel());
  }


  // ---------- PDFs and other files ----------
  {
    const SRCD = SRC;
    const pdfId = await win.evaluate(async (f) => { const before = new Set(Board.items.keys()); await Board.addPaths([f]); return [...Board.items.keys()].find((k) => !before.has(k)); }, path.join(SRCD, 'brief.pdf'));
    const drawn = (id, page) => win.waitForFunction(([i, p]) => { const n = Board.els.get(i); const c = n && n.querySelector('canvas.media'); return c && c.dataset.drawn && c.dataset.drawn.split('|')[1] === String(p); }, [id, page], { timeout: 20000 }).catch(() => {});
    await drawn(pdfId, 1);
    const colour = (id) => win.evaluate((i) => { const c = Board.els.get(i).querySelector('canvas.media'); const px = c.getContext('2d').getImageData(Math.round(c.width * 0.9), Math.round(c.height * 0.9), 1, 1).data; return [px[0], px[1], px[2]]; }, id);
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 12);
    const p1 = await win.evaluate((i) => { const it = Board.items.get(i); return { type: it.type, page: it.page, pages: it.pages, nw: it.nw, nh: it.nh }; }, pdfId);
    const c1 = await colour(pdfId);
    expect('a PDF comes in as one item with its pages', p1.type === 'pdf' && p1.pages === 3 && p1.page === 1 && near(c1, [255, 217, 102]), { p1, c1 });
    await win.evaluate((i) => { Board.sel = new Set([i]); Board.focusSelection(); Board.render(); }, pdfId);
    await sleep(400);
    await win.screenshot({ path: `${OUT}/f1-pdf.png` });
    const pill = await win.evaluate(() => { const b = document.querySelector('#overlay .pdf-pages'); if (!b) return null; const n = b.querySelector('[data-pg="1"]').getBoundingClientRect(); return { text: b.querySelector('.pg-n').textContent, x: n.left + n.width / 2, y: n.top + n.height / 2 }; });
    expect('page arrows show under a selected PDF', pill && pill.text === '1 / 3', pill);
    await win.mouse.click(pill.x, pill.y);
    await win.waitForFunction((i) => Board.items.get(i).page === 2, pdfId, { timeout: 5000 }).catch(() => {});
    await drawn(pdfId, 2);
    const c2 = await colour(pdfId);
    expect('the next arrow turns the page', await win.evaluate((i) => Board.items.get(i).page, pdfId) === 2 && near(c2, [153, 204, 255]), { c2 });
    await win.evaluate(() => document.querySelector('#canvas').focus());
    await win.keyboard.press('Period');
    await win.waitForFunction((i) => Board.items.get(i).page === 3, pdfId, { timeout: 5000 }).catch(() => {});
    const p3 = await win.evaluate((i) => { const it = Board.items.get(i); return { page: it.page, land: it.nw > it.nh }; }, pdfId);
    expect('Period goes to the next page, and a wide page stays wide', p3.page === 3 && p3.land, p3);
    await win.evaluate(() => Board.undo());
    expect('undo goes back a page', await win.evaluate((i) => Board.items.get(i).page, pdfId) === 2);
    // Sharp when zoomed in
    const w0 = await win.evaluate((i) => Board.els.get(i).querySelector('canvas.media').width, pdfId);
    await win.evaluate(() => { const v = Board.view; Board.zoomAt(innerWidth / 2, innerHeight / 2, 3); });
    await sleep(900);
    const w1 = await win.evaluate((i) => Board.els.get(i).querySelector('canvas.media').width, pdfId);
    expect('the page redraws sharper when you zoom in', w1 > w0 * 1.8, { w0, w1 });
    await win.evaluate((i) => { Board.sel = new Set([i]); Board.focusSelection(); }, pdfId);
    // A page as its own picture
    const nImg = await win.evaluate(() => Board.live().filter((i) => i.type === 'image').length);
    await win.evaluate((i) => Board.pdfPageAsPicture(i), pdfId);
    await win.waitForFunction((n) => Board.live().filter((i) => i.type === 'image').length > n, nImg, { timeout: 10000 }).catch(() => {});
    const pic = await win.evaluate(() => { const it = Board.live().filter((i) => i.type === 'image').sort((a, b) => b.z - a.z)[0]; return { name: it.original, nw: it.nw }; });
    expect('Page as picture adds the page as a picture', /page 2\.png$/.test(pic.name) && pic.nw > 1000, pic);
    // Any other file: a card with its name, kind and size
    const cards = await win.evaluate(async (fs) => { const before = new Set(Board.items.keys()); await Board.addPaths(fs); return [...Board.items.keys()].filter((k) => !before.has(k)); }, ['notes.txt', 'deck.key', 'setup.sh'].map((n) => path.join(SRCD, n)));
    await sleep(400);
    const cardInfo = await win.evaluate((ids) => ids.map((i) => { const it = Board.items.get(i); const n = Board.els.get(i); return { type: it.type, name: n.querySelector('.fc-name') && n.querySelector('.fc-name').textContent, meta: n.querySelector('.fc-meta') && n.querySelector('.fc-meta').textContent, ext: it.ext, size: it.size }; }), cards);
    expect('other files come in as cards with name, kind and size', cardInfo.length === 3 && cardInfo.every((c) => c.type === 'file' && c.name && /·/.test(c.meta)) && cardInfo[1].name === 'deck.key' && /KEY/.test(cardInfo[1].meta) && cardInfo[1].size === 2048, cardInfo);
    // Mac previews text files itself; Windows only does for apps that add their own previews
    if (process.platform === 'darwin') {
      const pre = await win.evaluate((id) => { const it = Board.items.get(id); const im = Board.els.get(id).querySelector('.fc-pre'); return { preview: it.preview, shown: !!(im && im.naturalWidth) }; }, cards[0]);
      expect('a text file gets a real preview from the computer', !!pre.preview, pre);
    }
    await win.evaluate((ids) => { Board.sel = new Set(ids); Board.focusSelection(); Board.render(); }, cards);
    await sleep(300);
    await win.screenshot({ path: `${OUT}/f2-cards.png` });
    // On Linux, showing a folder starts a helper that outlives the test, so the rule is checked on its own there
    if (process.platform !== 'linux') {
      const opened = await win.evaluate(async (id) => { const it = Board.items.get(id); return window.eyerefs.openMedia(Board.project.id, it.src, it.original); }, cards[2]);
      expect('a file that runs code is only shown in its folder, never opened', opened && opened.shown === true, opened);
    } else {
      const media = require('../main/media');
      expect('a file that runs code is only shown in its folder, never opened', media.runsCode('setup.sh') && media.runsCode('Report.docm') && media.runsCode('noext') && !media.runsCode('deck.key') && !media.runsCode('brief.pdf'));
    }
    const sneaky = await win.evaluate(async () => window.eyerefs.openMedia(Board.project.id, '../../etc/passwd', 'x.txt'));
    expect('a card can only open files inside its board', sneaky && sneaky.error, sneaky);
    // They export with the board
    const ex = await win.evaluate(async (ids) => { const r = await Board.renderExport(ids); return r && { w: r.w, h: r.h, missing: r.missing }; }, [pdfId, ...cards]);
    expect('PDFs and cards export with the board', ex && ex.missing === 0 && ex.w > 100, ex);
    // ---------- decks and documents, page by page ----------
    const can = await win.evaluate(() => window.eyerefs.docCan('x.pptx'));
    const deckCard = await win.evaluate(async (f) => { const before = new Set(Board.items.keys()); await Board.addPaths([f]); return [...Board.items.keys()].find((k) => !before.has(k)); }, path.join(__dirname, 'fixtures', 'deck.pptx'));
    if (can.can) {
      await win.waitForFunction(() => Board.live().some((i) => i.type === 'pdf' && i.doc), null, { timeout: 60000 }).catch(() => {});
      const deck = await win.evaluate(() => { const it = Board.live().find((i) => i.type === 'pdf' && i.doc); return it && { id: it.id, pages: it.pages, videos: it.videos, original: it.original, ext: it.ext }; });
      const cardGone = await win.evaluate((id) => !Board.items.get(id) || Board.items.get(id).deleted, deckCard);
      expect('a dropped deck turns into pages', deck && deck.pages === 3 && cardGone && deck.original === 'deck.pptx', deck);
      const v = deck && deck.videos && deck.videos[0];
      expect('the video in the deck is found on its slide, in its spot', v && v.page === 2 && Math.abs(v.x - 0.4875) < 0.01 && Math.abs(v.y - 0.2667) < 0.01 && Math.abs(v.w - 0.42) < 0.01, deck && deck.videos);
      await win.evaluate((id) => { Board.sel = new Set([id]); Board.focusSelection(); Board.render(); }, deck.id);
      await sleep(300);
      const strip = await win.evaluate(() => [...document.querySelectorAll('#overlay .pg-th')].map((t) => ({ on: t.classList.contains('on'), vid: !!t.querySelector('.pg-vid') })));
      expect('a strip of pages shows, with the video slide marked', strip.length === 3 && strip[0].on && strip[1].vid && !strip[0].vid, strip);
      const second = await win.evaluate(() => { const t = document.querySelectorAll('#overlay .pg-th')[1].getBoundingClientRect(); return { x: t.left + t.width / 2, y: t.top + t.height / 2 }; });
      await win.mouse.click(second.x, second.y);
      await win.waitForFunction((id) => Board.items.get(id).page === 2, deck.id, { timeout: 5000 }).catch(() => {});
      await win.waitForFunction((id) => { const v = Board.els.get(id).querySelector('.slide-vid video'); return v && v.readyState >= 1; }, deck.id, { timeout: 10000 }).catch(() => {});
      const sv = await win.evaluate((id) => { const n = Board.els.get(id); const w = n.querySelector('.slide-vid'); const page = n.querySelector('canvas.media').getBoundingClientRect(); if (!w) return null; const r = w.getBoundingClientRect(); return { fx: (r.left - page.left) / page.width, fw: r.width / page.width, x: r.left + r.width / 2, y: r.top + r.height / 3, ready: w.querySelector('video').readyState }; }, deck.id);
      expect('on its slide, the video sits where the deck put it', sv && Math.abs(sv.fx - 0.4875) < 0.02 && Math.abs(sv.fw - 0.42) < 0.02 && sv.ready >= 1, sv);
      await win.screenshot({ path: `${OUT}/f3-deck.png` });
      await win.mouse.click(sv.x, sv.y);
      await sleep(700);
      const playing = await win.evaluate((id) => { const v = Board.els.get(id).querySelector('.slide-vid video'); return { paused: v.paused, t: v.currentTime }; }, deck.id);
      expect('clicking the video plays it right on the slide', !playing.paused && playing.t > 0, playing);
      await win.screenshot({ path: `${OUT}/f4-deck-playing.png` });
      await win.evaluate((id) => Board.els.get(id).querySelector('.slide-vid video').pause(), deck.id);
      // Everything inside, in slide order, in a section named after the deck
      const before = await win.evaluate(() => Board.live().length);
      await win.evaluate((id) => Board.pullOutMedia(id), deck.id);
      await win.waitForFunction((n) => Board.live().length > n + 1, before, { timeout: 20000 }).catch(() => {});
      const pulled = await win.evaluate(() => { const v = Board.live().filter((i) => i.tag).map((i) => ({ type: i.type, tag: i.tag })); const sec = Board.live().find((i) => i.type === 'section' && i.title === 'deck'); return { v, sec: !!sec }; });
      expect('Pull out puts the deck video on the board, tagged with its slide, in a section', pulled.sec && pulled.v.length === 1 && pulled.v[0].type === 'video' && pulled.v[0].tag === 'Slide 2', pulled);
      await win.evaluate(() => { const ids = Board.live().filter((i) => i.tag || (i.type === 'section' && i.title === 'deck')).map((i) => i.id); Board.sel = new Set(ids); Board.deleteSelection(); });
      // A Word file, page by page
      await win.evaluate(async (f) => Board.addPaths([f]), path.join(__dirname, 'fixtures', 'brief.docx'));
      await win.waitForFunction(() => Board.live().some((i) => i.type === 'pdf' && i.ext === 'docx'), null, { timeout: 60000 }).catch(() => {});
      const docx = await win.evaluate(() => { const it = Board.live().find((i) => i.type === 'pdf' && i.ext === 'docx'); return it && { pages: it.pages, videos: (it.videos || []).length }; });
      expect('a Word file turns into pages too', docx && docx.pages >= 2 && docx.videos === 0, docx);
      await win.evaluate(() => { const ids = Board.live().filter((i) => i.type === 'pdf' && i.doc).map((i) => i.id); Board.sel = new Set(ids); Board.deleteSelection(); Board.clearSel(); });
    } else {
      // No LibreOffice here: the deck stays a card, and Eye Refs offers to get it, once
      await win.waitForSelector('#modalWrap:not([hidden]) >> text=Get LibreOffice for decks and docs', { timeout: 15000 }).catch(() => {});
      const asked = await win.evaluate(() => !document.querySelector('#modalWrap').hidden && /LibreOffice/.test(document.querySelector('#modalWrap').textContent));
      const card = await win.evaluate((id) => Board.items.get(id) && Board.items.get(id).type, deckCard);
      expect('without a converter, the deck stays a card and Eye Refs offers LibreOffice', asked && card === 'file', { asked, card, can });
      await win.click('#modalWrap >> text=Not now');
      await win.evaluate((id) => { Board.sel = new Set([id]); Board.deleteSelection(); Board.clearSel(); }, deckCard);
    }
    await win.evaluate((ids) => { Board.sel = new Set(ids); Board.deleteSelection(); Board.clearSel(); }, [pdfId, ...cards]);
    await win.evaluate(() => { const it = Board.live().filter((i) => i.type === 'image').sort((a, b) => b.z - a.z)[0]; Board.sel = new Set([it.id]); Board.deleteSelection(); Board.clearSel(); });
  }
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
  const guest = (() => { gas.call({ action: 'auth.request', email: 'rami@freelancer.com', joinCode: code }); return gas.call({ action: 'auth.verify', email: 'rami@freelancer.com', code: codeFor('rami@freelancer.com'), name: 'Rami' }).data.token; })();
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
  // She adds a note and a line: the board says so
  await win.evaluate(() => { window.__toasts2 = []; new MutationObserver(() => window.__toasts2.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); });
  sB.write([
    { id: 'nb-note', fields: { type: 'note', text: 'Love this one', x: 0, y: -300, w: 200, fs: 16, z: 500, rot: 0, deleted: false, created: Date.now(), by: 'Nousaiba' } },
    { id: 'nb-line', fields: { type: 'draw', pts: '0 0 40 40', nw: 50, nh: 50, w: 50, x: 10, y: -250, sw: 4, z: 501, rot: 0, deleted: false, created: Date.now(), by: 'Nousaiba' } },
  ]);
  await sB.flush(); await syncB.tick();
  await win.waitForFunction(() => (window.__toasts2 || []).some((t) => /Nousaiba added/.test(t)), null, { timeout: 40000 }).catch(() => {});
  const told = await win.evaluate(() => window.__toasts2);
  expect('teammate additions are announced on the board', told.some((t) => t === 'Nousaiba added a note and a line'), told);
  // She leaves a comment: you're told what she said
  await win.evaluate(() => { window.__toasts2 = []; });
  sB.write([{ id: 'nb-c1', fields: { type: 'comment', root: null, on: null, x: 0, y: -400, text: 'Love the light here', author: 'Nousaiba', authorEmail: 'nousaiba@eyestudio.ae', by: 'Nousaiba', at: Date.now(), created: Date.now(), deleted: false, resolved: false } }]);
  await sB.flush(); await syncB.tick();
  await win.waitForFunction(() => (window.__toasts2 || []).some((t) => /commented/.test(t)), null, { timeout: 40000 }).catch(() => {});
  const told3 = await win.evaluate(() => ({ toasts: window.__toasts2, pin: !!document.querySelector('.cpin[data-id="nb-c1"]') }));
  // You resolve her comment: it still says she wrote it
  await win.evaluate(() => Board.commit([{ id: 'nb-c1', fields: { resolved: true } }]));
  const author = await win.evaluate(() => { Board.setShowResolved(true); const t = document.querySelector('.cpin[data-id="nb-c1"]').title; Board.setShowResolved(false); return { by: Board.items.get('nb-c1').by, title: t }; });
  await win.evaluate(() => Board.commit([{ id: 'nb-c1', fields: { resolved: false } }]));
  expect('a comment keeps its writer when someone else resolves it', /^Nousaiba:/.test(author.title), author);
  expect('a teammate comment is announced and pinned', told3.toasts.includes('Nousaiba commented: "Love the light here"') && told3.pin, told3);
  // She shares a new board with you: you're told
  gas.call({ action: 'projects.create', token: tB, id: 'nousaiba-board-0001', name: 'Brunch Edit' });
  gas.call({ action: 'projects.invite', token: tB, id: 'nousaiba-board-0001', emails: ['chamath@eyestudio.ae'] });
  await win.evaluate(() => { window.__toasts2 = []; window.dispatchEvent(new Event('focus')); });
  await win.waitForFunction(() => (window.__toasts2 || []).some((t) => /shared/.test(t)), null, { timeout: 20000 }).catch(() => {});
  await win.waitForFunction(() => [...document.querySelectorAll('#tree .row .name')].some((n) => n.textContent === 'Brunch Edit'), null, { timeout: 15000 }).catch(() => {});
  const told2 = await win.evaluate(() => ({ toasts: window.__toasts2, row: [...document.querySelectorAll('#tree .row .name')].some((n) => n.textContent === 'Brunch Edit') }));
  const order = await win.evaluate(() => [...document.querySelectorAll('#tree .row .name')].map((n) => n.textContent));
  // Pin a board: it moves to a Pinned group at the top and stays after a restart of the list
  const pinRes = await win.evaluate(async () => {
    const row = [...document.querySelectorAll('#tree .row')].find((r) => r.querySelector('.name').textContent === 'Brunch Edit');
    row.querySelector('.pin').click();
    await new Promise((r) => setTimeout(r, 300));
    const labels = [...document.querySelectorAll('#tree > *')].map((n) => n.classList.contains('tree-label') ? '#' + n.textContent : n.querySelector('.name') && n.querySelector('.name').textContent);
    const saved = (await window.eyerefs.setPrefs({})).pins;
    const r2 = [...document.querySelectorAll('#tree .row')].find((r) => r.querySelector('.name').textContent === 'Brunch Edit');
    r2.querySelector('.pin').click();
    await new Promise((r) => setTimeout(r, 300));
    const after = [...document.querySelectorAll('#tree .tree-label')].length;
    return { labels, saved, after };
  });
  expect('pinned boards sit at the top and are remembered', pinRes.labels[0] === '#Pinned' && pinRes.labels[1] === 'Brunch Edit' && pinRes.labels[2] === '#Boards' && pinRes.saved.length === 1 && pinRes.after === 0, pinRes);
  // Each board brings back its own window size and place
  const boundsRes = await (async () => {
    const setB = (b) => app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), b);
    const getB = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    const cur = await win.evaluate(() => document.querySelector('#tName').textContent);
    await setB({ x: 40, y: 40, width: 900, height: 600 });
    await sleep(900);
    await win.click('#tree >> text=Brunch Edit');
    await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Brunch Edit', null, { timeout: 20000 });
    await setB({ x: 120, y: 90, width: 800, height: 540 });
    await sleep(900);
    await win.click(`#tree >> text=${cur}`);
    await win.waitForFunction((n) => document.querySelector('#tName').textContent === n, cur, { timeout: 20000 });
    await sleep(500);
    const back = await getB();
    await setB({ x: 0, y: 0, width: 1440, height: 900 });
    await sleep(900);
    return { cur, back };
  })();
  expect('each board brings back its own window size and place', boundsRes.back.width === 900 && boundsRes.back.height === 600 && boundsRes.back.x === 40, boundsRes);
  expect('sidebar lists the latest edited first', order.indexOf('Spring Campaign') > -1 && order.indexOf('Spring Campaign') < order.indexOf('Brunch Edit'), order);
  expect('a board shared with you is announced', told2.toasts.includes('Nousaiba shared "Brunch Edit" with you') && told2.row, told2);

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

  // An import still running when you switch boards must not land on the new board,
  // and a teammate's update held back during a gesture must not follow you there
  await win.evaluate((src) => {
    window.__toasts = [];
    new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true });
    // Hold back the size check so the import is still busy when the board changes
    const RealImage = window.Image;
    window.__RealImage = RealImage;
    window.Image = function () {
      const i = new RealImage(); let f = null;
      Object.defineProperty(i, 'onload', { set(v) { f = v; i.addEventListener('load', () => setTimeout(() => f && f(), 1500)); }, get() { return f; } });
      return i;
    };
    window.__importDone = Board.addPaths([`${src}/pattern.png`], { x: 0, y: 0 }).then(() => true);
    Board.gesture = { type: 'pan', v0: { ...Board.view } };
    Board.applyRemote({ ghost: { id: 'ghost', type: 'note', text: 'ghost', x: 0, y: 0, w: 100, z: 1 } });
    window.__pendingBefore = !!Board.pendingRemote;
  }, SRC);
  await sleep(300);
  // New board: back to a blank untitled one, saved board stays in the list
  await win.keyboard.press('ControlOrMeta+K');
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Untitled');
  await win.waitForFunction(() => window.__importDone, null, { timeout: 15000 });
  await win.evaluate(() => window.__importDone);
  const switchRes = await win.evaluate(() => { window.Image = window.__RealImage; return { pendingBefore: window.__pendingBefore, pending: Board.pendingRemote, ghost: Board.items.has('ghost'), count: Board.live().length, toasts: window.__toasts }; });
  expect('import after board switch skipped', switchRes.count === 0 && switchRes.toasts.includes('That finished after you left the board.'), switchRes);
  expect('pending remote cleared on board switch', switchRes.pendingBefore && switchRes.pending === null && !switchRes.ghost, switchRes);
  // Start screen on a fresh board, like PureRef: drop zone plus recent boards
  await win.waitForFunction(() => document.querySelectorAll('#startCards .start-card:not(.start-new)').length > 0, null, { timeout: 8000 });
  const startRes = await win.evaluate(() => ({ shown: getComputedStyle(document.querySelector('#start')).display !== 'none' && !document.querySelector('#start').hidden, cards: [...document.querySelectorAll('#startCards .start-card .nm')].map((n) => n.textContent), pics: document.querySelectorAll('#startCards img').length, sidebar: !document.querySelector('#sidebar').hidden }));
  await win.screenshot({ path: `${OUT}/09-new.png` });
  expect('start screen shows recent boards', startRes.shown && startRes.cards.includes('Spring Campaign') && startRes.pics > 0 && !startRes.sidebar, startRes);
  await win.hover('#startCards .start-card:not(.start-new)');
  await sleep(400);
  const hov = await win.evaluate(() => { const c = document.querySelector('#startCards .start-card:not(.start-new)'); return { card: getComputedStyle(c).transform, mini: getComputedStyle(c.querySelector('.mini-in')).transform }; });
  await win.screenshot({ path: `${OUT}/09c-hover.png` });
  expect('recent card hover lifts and zooms', hov.card !== 'none' && hov.mini !== 'none', hov);
  await win.mouse.move(720, 200);
  // Tab does nothing on the start screen: it always shows in full
  await win.mouse.click(720, 200);
  await win.keyboard.press('Tab');
  await sleep(150);
  const tabStart = await win.evaluate(() => ({ hidden: document.body.classList.contains('ui-hidden'), start: getComputedStyle(document.querySelector('#start')).display !== 'none', bar: getComputedStyle(document.querySelector('#toolbar')).opacity }));
  expect('Tab leaves the start screen alone', !tabStart.hidden && tabStart.start && tabStart.bar === '1', tabStart);
  const startNewBtn = await win.evaluate(() => { const b = document.querySelector('#startNew'); return !!b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 40; });
  expect('the start screen has a New board button', startNewBtn);
  const tiles = await win.evaluate(() => { const cs = [...document.querySelectorAll('#startCards .start-card')]; const n = document.querySelector('#startNew'); const r0 = cs[0].getBoundingClientRect(), rn = n.getBoundingClientRect(); return { count: cs.length, newIndex: cs.indexOf(n), sameRow: Math.abs(r0.top - rn.top) < 2, more: !document.querySelector('#startMore').hidden }; });
  expect('start screen opens on the short view', await win.evaluate(() => !document.querySelector('#startRecent').classList.contains('open')));
  expect('New board is the first tile, beside up to four recent boards', tiles.newIndex === 0 && tiles.sameRow && tiles.count <= 5, tiles);
  await win.evaluate(() => { const c = document.querySelector('#startCards'); const f = c.querySelector('.start-card:not(.start-new)'); for (let i = 0; i < 7; i++) c.append(f.cloneNode(true)); document.querySelector('#startMore').hidden = false; document.querySelector('#startMore .lbl').textContent = 'Fewer'; document.querySelector('#startRecent').classList.add('open'); });
  await win.screenshot({ path: `${OUT}/s2-start-open.png` });
  await win.evaluate(() => document.querySelector('#startMore').click());
  await sleep(300);
  await win.screenshot({ path: `${OUT}/s1-start.png` });
  const startDrag = await win.evaluate(() => { const t = document.querySelector('#topbar'); const cs = getComputedStyle(t); return { region: cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion, h: t.getBoundingClientRect().height, w: t.getBoundingClientRect().width }; });
  expect('start screen window can be moved from the top', startDrag.region === 'drag' && startDrag.h >= 40 && startDrag.w > 1000, startDrag);
  const fresh = await win.evaluate(() => Board.live().length);
  // Something on the untitled board: leaving it asks first, and "Don't save" throws it away
  await win.evaluate(() => Board.addNote());
  await win.keyboard.press('Escape');
  await sleep(500);
  const startGone = await win.evaluate(() => getComputedStyle(document.querySelector('#start')).display === 'none');
  const sideTimes = await win.evaluate(() => ({ sidebar: !document.querySelector('#sidebar').hidden, times: [...document.querySelectorAll('#tree .row .when')].map((n) => n.textContent) }));
  expect('sidebar back with edit times once the board has something', sideTimes.sidebar && sideTimes.times.length > 0 && sideTimes.times.every((t) => /^(Now|\d+[mhd]|\d+ \w+|\w+ \d+)$/.test(t)), sideTimes);
  await win.click('#tree >> text=Spring Campaign');
  await win.waitForSelector('#modal >> text=Save this board?', { timeout: 5000 }).catch(() => {});
  const asked = await win.evaluate(() => !!document.querySelector('.modal, #modal') && document.body.textContent.includes('Save this board?'));
  await win.screenshot({ path: `${OUT}/09b-ask.png` });
  // Slow the board opening down so the opening note can be seen
  const slowed = await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('projects:open');
    if (!h) return false;
    ipcMain._invokeHandlers.set('projects:open', async (...a) => { await new Promise((r) => setTimeout(r, 900)); return h(...a); });
    return true;
  });
  await win.click("#modalWrap button:has-text(\"Don't save\")");
  let openingSeen = null;
  if (slowed) {
    await win.waitForFunction(() => document.body.classList.contains('is-opening'), null, { timeout: 3000 }).catch(() => {});
    openingSeen = await win.evaluate(() => ({ on: document.body.classList.contains('is-opening'), text: document.querySelector('#openingName').textContent, fade: getComputedStyle(document.querySelector('#world')).opacity }));
    await sleep(250);
    await win.screenshot({ path: `${OUT}/09d-opening.png` });
  }
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Spring Campaign');
  await sleep(800);
  const unsavedLeft = await win.evaluate(() => [...document.querySelectorAll('#tree .row .name')].filter((n) => n.textContent === 'Untitled').length);
  const openingGone = await win.evaluate(() => !document.body.classList.contains('is-opening'));
  expect('switching boards shows what is opening, then clears', !slowed || (openingSeen && openingSeen.on && openingSeen.text === 'Spring Campaign' && openingGone), { slowed, openingSeen, openingGone });
  expect('leaving an unsaved board asks, and Don\'t save removes it', startGone && asked && unsavedLeft === 0, { startGone, asked, unsavedLeft });
  // ---------- deleting boards ----------
  {
    const rowOf = (name) => win.evaluate((n) => { const r = [...document.querySelectorAll('#tree .row')].find((x) => x.querySelector('.name') && x.querySelector('.name').textContent === n); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; }, name);
    const menuItems = () => win.evaluate(() => [...document.querySelectorAll('#menu button')].map((b) => b.textContent.trim()));
    // A board of your own goes to the Trash
    // Made behind the app's back, so open the current board again in the main process
    await win.evaluate(async () => { const cur = Board.project.id; await window.eyerefs.createProject('Throwaway'); await window.eyerefs.openProject(cur); });
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await win.waitForFunction(() => [...document.querySelectorAll('#tree .row .name')].some((n) => n.textContent === 'Throwaway'), null, { timeout: 8000 }).catch(() => {});
    let row = await rowOf('Throwaway');
    if (!row) { await win.keyboard.press('Escape'); await sleep(200); row = await rowOf('Throwaway'); }
    await win.mouse.click(row.x, row.y, { button: 'right' });
    await sleep(200);
    const items1 = await menuItems();
    expect('right clicking a board in the sidebar opens its menu', items1.includes('Pin to top') && items1.includes('Rename') && items1.includes('Delete board'), items1);
    await win.click('#menu >> text=Delete board');
    await win.waitForSelector('#modalWrap:not([hidden]) >> text=Delete "Throwaway"?');
    const askText = await win.evaluate(() => document.querySelector('#modalWrap p').textContent);
    await win.click('#modalWrap >> button.danger');
    await win.waitForFunction(() => ![...document.querySelectorAll('#tree .row .name')].some((n) => n.textContent === 'Throwaway'), null, { timeout: 10000 }).catch(() => {});
    const throwDir = path.join(tmp, 'Documents', 'Eye Refs', 'Throwaway');
    expect('deleting your own board moves it to the Trash', !fs.existsSync(throwDir) && /Trash|Recycle Bin/.test(askText) && !(await rowOf('Throwaway')), { askText, still: fs.existsSync(throwDir) });
    // A board shared with you: you leave it, everyone else keeps it
    row = await rowOf('Brunch Edit');
    await win.mouse.click(row.x, row.y, { button: 'right' });
    await sleep(200);
    const items2 = await menuItems();
    await win.click('#menu >> text=Leave board');
    await win.waitForSelector('#modalWrap:not([hidden]) >> text=Leave "Brunch Edit"?');
    await win.click('#modalWrap >> text=Leave and remove');
    await win.waitForFunction(() => ![...document.querySelectorAll('#tree .row .name')].some((n) => n.textContent === 'Brunch Edit'), null, { timeout: 10000 }).catch(() => {});
    const stillMember = gas.call({ action: 'projects.members', token: tB, id: 'nousaiba-board-0001' }).data.members.map((m) => m.email);
    expect('leaving a shared board removes you only; the owner keeps it', items2.includes('Leave board') && !stillMember.includes('chamath@eyestudio.ae') && stillMember.length >= 1 && !(await rowOf('Brunch Edit')), { items2, stillMember });
    await win.screenshot({ path: `${OUT}/d1-after-delete.png` });
  }
  const result = await win.evaluate((fresh) => ({ fresh, items: Board.live().length, status: document.querySelector('#tStatus').textContent, rows: [...document.querySelectorAll('#tree .row')].map((r) => r.textContent) }), fresh);
  await syncB.stop(); await sB.close();
  await app.close();
  const driveDir = path.join(tmp, 'drive', 'Eye Refs', 'Spring Campaign');
  console.log(JSON.stringify({
    result, request: reqRes.ok, checks,
    driveMedia: fs.readdirSync(path.join(driveDir, 'media')).length,
    driveChanges: fs.readdirSync(path.join(driveDir, 'changes')),
    local: fs.readdirSync(path.join(tmp, 'Documents', 'Eye Refs')),
    unsaved: fs.readdirSync(path.join(tmp, 'cfg', 'Eye Refs', 'unsaved')),
    members: gas.call({ action: 'projects.members', token: tB, id: remote.id }).data.members.map((m) => m.email),
    errors,
  }, null, 1));
  srv.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
