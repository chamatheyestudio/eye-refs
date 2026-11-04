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
  await win.keyboard.press('Control+Shift+P');
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
  await win.keyboard.press('Control+D');
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
    await win.keyboard.press('Control+Z');
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
  await sleep(150);
  await win.keyboard.type('Make it brighter');
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
  await win.mouse.click(700, 300); // drawing on the board leaves the picker open
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
  expect('picker stays open until the wheel is clicked, colour goes to Recent', kept.stillOpen && kept.closed && kept.recent && kept.recent.c === picked.color, kept);
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
    await win.keyboard.down('Control');
    await win.mouse.move(a.x, a.y); await win.mouse.down();
    for (let i = 1; i <= 12; i++) { const t = a0 + (Math.PI / 6) * (i / 12); await win.mouse.move(g.x + Math.cos(t) * R, g.y + Math.sin(t) * R); }
    await win.mouse.up(); await win.keyboard.up('Control');
  }
  const rotRes = await win.evaluate((ids) => ids.map((id) => Board.items.get(id).rot || 0), rotSetup.ids);
  const deltas = rotRes.map((r, i) => (((r - rotSetup.rot0[i]) % 360) + 360) % 360);
  expect('multi rotate equal deltas', Math.abs(deltas[0] - deltas[1]) < 0.01 && deltas[0] > 10 && deltas[0] < 50, deltas);
  await win.evaluate(() => Board.undo());

  // Cropping a flipped picture: the edge you drag on screen is the one that moves
  const cropSetup = await win.evaluate(() => {
    for (const it of Board.live().filter((i) => i.type === 'image' && !(i.crop && (i.crop.l || i.crop.r || i.crop.t || i.crop.b)))) {
      Board.sel = new Set([it.id]); Board.focusSelection();
      const pt = window.__freePoint(it.id, 0.08, 0.5);
      if (!pt) continue;
      Board.toggleField('flipX'); Board.clearSel();
      const r = Board.els.get(it.id).getBoundingClientRect();
      return { id: it.id, pt, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    }
    return null;
  });
  await sleep(200);
  await win.mouse.move(cropSetup.pt.x, cropSetup.pt.y);
  await win.keyboard.down('c');
  await win.mouse.down();
  await win.mouse.move(cropSetup.pt.x + cropSetup.w * 0.2, cropSetup.pt.y, { steps: 8 });
  await win.mouse.up();
  await win.keyboard.up('c');
  const cropRes = await win.evaluate((id) => { const r = Board.els.get(id).getBoundingClientRect(); return { left: r.left, right: r.right, crop: Board.items.get(id).crop }; }, cropSetup.id);
  const want = cropSetup.w * 0.2;
  expect('crop flipped image moves the dragged edge', Math.abs(cropRes.left - cropSetup.left - want) < 4 && Math.abs(cropRes.right - cropSetup.right) < 2 && cropRes.crop.r > 0.1 && !cropRes.crop.l, { before: cropSetup, after: cropRes });
  // Reset cropping keeps the flipped picture where it is
  const resetRes = await win.evaluate((id) => { Board.sel = new Set([id]); Board.resetCrop(); Board.clearSel(); const r = Board.els.get(id).getBoundingClientRect(); return { left: r.left, right: r.right }; }, cropSetup.id);
  expect('reset crop on flipped image stays put', Math.abs(resetRes.left - cropSetup.left) < 2 && Math.abs(resetRes.right - cropSetup.right) < 2, resetRes);
  await win.evaluate(() => { Board.undo(); Board.undo(); Board.undo(); });
  const cropUndone = await win.evaluate((id) => { const it = Board.items.get(id); return !it.flipX && !(it.crop && it.crop.r); }, cropSetup.id);
  expect('crop test undone', cropUndone);

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
    await setB({ x: 40, y: 40, width: 1200, height: 760 });
    await sleep(900);
    await win.click('#tree >> text=Brunch Edit');
    await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Brunch Edit', null, { timeout: 20000 });
    await setB({ x: 120, y: 90, width: 1000, height: 640 });
    await sleep(900);
    await win.click(`#tree >> text=${cur}`);
    await win.waitForFunction((n) => document.querySelector('#tName').textContent === n, cur, { timeout: 20000 });
    await sleep(500);
    const back = await getB();
    await setB({ x: 0, y: 0, width: 1440, height: 900 });
    await sleep(900);
    return { cur, back };
  })();
  expect('each board brings back its own window size and place', boundsRes.back.width === 1200 && boundsRes.back.height === 760 && boundsRes.back.x === 40, boundsRes);
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
  await win.keyboard.press('Control+K');
  await win.waitForFunction(() => document.querySelector('#tName').textContent === 'Untitled');
  await win.waitForFunction(() => window.__importDone, null, { timeout: 15000 });
  await win.evaluate(() => window.__importDone);
  const switchRes = await win.evaluate(() => { window.Image = window.__RealImage; return { pendingBefore: window.__pendingBefore, pending: Board.pendingRemote, ghost: Board.items.has('ghost'), count: Board.live().length, toasts: window.__toasts }; });
  expect('import after board switch skipped', switchRes.count === 0 && switchRes.toasts.includes('That finished after you left the board.'), switchRes);
  expect('pending remote cleared on board switch', switchRes.pendingBefore && switchRes.pending === null && !switchRes.ghost, switchRes);
  // Start screen on a fresh board, like PureRef: drop zone plus recent boards
  await win.waitForFunction(() => document.querySelectorAll('#startCards .start-card').length > 0, null, { timeout: 8000 });
  const startRes = await win.evaluate(() => ({ shown: getComputedStyle(document.querySelector('#start')).display !== 'none' && !document.querySelector('#start').hidden, cards: [...document.querySelectorAll('#startCards .start-card .nm')].map((n) => n.textContent), pics: document.querySelectorAll('#startCards img').length, sidebar: !document.querySelector('#sidebar').hidden }));
  await win.screenshot({ path: `${OUT}/09-new.png` });
  expect('start screen shows recent boards', startRes.shown && startRes.cards.includes('Spring Campaign') && startRes.pics > 0 && !startRes.sidebar, startRes);
  await win.hover('#startCards .start-card');
  await sleep(400);
  const hov = await win.evaluate(() => { const c = document.querySelector('#startCards .start-card'); return { card: getComputedStyle(c).transform, mini: getComputedStyle(c.querySelector('.mini-in')).transform }; });
  await win.screenshot({ path: `${OUT}/09c-hover.png` });
  expect('recent card hover lifts and zooms', hov.card !== 'none' && hov.mini !== 'none', hov);
  await win.mouse.move(720, 200);
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
})().catch((e) => { console.error(e); process.exit(1); });
