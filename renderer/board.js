// The canvas: items, selection, gestures, video playback, undo.
(function () {
  const { $, el, toast, openMenu, IS_MAC, fmtTime } = window.UI;
  const api = window.eyerefs;
  const ZC = { l: 0, t: 0, r: 0, b: 0 };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MAX_PLACE = 1000; // longest side of a newly placed image, in board units
  const MIN_SIZE = 12;

  const canvas = $('#canvas');
  const world = $('#world');
  const overlay = $('#overlay');
  const marquee = $('#marquee');
  const vbar = $('#videoBar');

  const B = {
    me: null,
    project: null,
    mediaBase: '',
    readOnly: false,
    items: new Map(),
    els: new Map(),
    sel: new Set(),
    view: { x: 0, y: 0, s: 1 },
    tool: 'select',
    lockedCanvas: false,
    grayCanvas: false,
    grid: true,
    undoStack: [],
    redoStack: [],
    held: new Set(),
    gesture: null,
    pendingRemote: null,
    muted: new Map(), // id -> bool (local only)
    hoverId: null,
    editingId: null,
    clip: null,
    clipMarker: null,
    onChange: () => {},
    pen: { color: '#D7F04A', size: 4, style: 'solid' },
  };

  // ---------- geometry ----------
  const toScreen = (x, y) => ({ x: x * B.view.s + B.view.x, y: y * B.view.s + B.view.y });
  const toWorld = (sx, sy) => ({ x: (sx - B.view.x) / B.view.s, y: (sy - B.view.y) / B.view.s });

  function dims(it) {
    if (it.type === 'note') {
      const e = B.els.get(it.id);
      const h = e ? e.offsetHeight : (it.fs || 16) * 3;
      return { w: it.w, h: h || (it.fs || 16) * 3, k: 1 };
    }
    const c = it.crop || ZC;
    const vw = Math.max(1, it.nw * (1 - c.l - c.r));
    const vh = Math.max(1, it.nh * (1 - c.t - c.b));
    const k = it.w / vw;
    return { w: it.w, h: vh * k, k, vw, vh };
  }

  function corners(it) {
    const { w, h } = dims(it);
    const cx = it.x + w / 2, cy = it.y + h / 2;
    const a = ((it.rot || 0) * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([px, py]) => ({ x: cx + px * cos - py * sin, y: cy + px * sin + py * cos }));
  }

  function bbox(ids) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      const it = B.items.get(id);
      if (!it) continue;
      for (const p of corners(it)) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    }
    return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  const live = () => [...B.items.values()].filter((it) => !it.deleted && it.type);
  const maxZ = () => live().reduce((m, it) => Math.max(m, it.z || 0), 0);
  const minZ = () => live().reduce((m, it) => Math.min(m, it.z || 0), 0);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const mediaUrl = (src) => B.mediaBase + encodeURIComponent(src);

  function canEdit(quiet) {
    if (!B.project) return false;
    if (B.readOnly) { if (!quiet) toast('This project is view only.'); return false; }
    return true;
  }

  // ---------- writes and undo ----------
  function pick(it, keys) {
    const o = {};
    for (const k of keys) o[k] = it && k in it ? clone(it[k]) : (k === 'deleted' ? true : null);
    if (!it) o.deleted = true;
    return o;
  }
  const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

  function applyLocal(changes) {
    for (const c of changes) {
      const it = B.items.get(c.id) || { id: c.id };
      for (const k in c.fields) it[k] = clone(c.fields[k]);
      B.items.set(c.id, it);
    }
  }

  // Writes the main process hasn't confirmed yet. A board update that left before
  // them must not wipe them, so they are laid back on top until confirmed.
  const unconfirmed = new Set();
  function send(changes) {
    const writes = changes.map((c) => ({ id: c.id, fields: { ...c.fields, by: B.me.name } }));
    unconfirmed.add(writes);
    api.write(B.project.id, writes).then((r) => {
      unconfirmed.delete(writes);
      if (r && r.readOnly) { B.readOnly = true; B.onChange('readonly'); }
    });
  }

  // changes: [{ id, fields }]; before: optional snapshot taken at gesture start
  function commit(changes, before) {
    if (!changes.length || !canEdit()) return;
    const prev = before || changes.map((c) => ({ id: c.id, fields: pick(B.items.get(c.id), Object.keys(c.fields)) }));
    applyLocal(changes);
    send(changes);
    B.undoStack.push({ before: prev, after: clone(changes) });
    if (B.undoStack.length > 300) B.undoStack.shift();
    B.redoStack = [];
    render();
  }

  function undo() {
    const e = B.undoStack.pop();
    if (!e || !canEdit()) return;
    applyLocal(e.before); send(e.before); B.redoStack.push(e); render();
  }
  function redo() {
    const e = B.redoStack.pop();
    if (!e || !canEdit()) return;
    applyLocal(e.after); send(e.after); B.undoStack.push(e); render();
  }

  // ---------- rendering ----------
  function makeEl(it) {
    const node = el('div', { class: 'item', 'data-id': it.id });
    if (it.type === 'note') {
      node.classList.add('note');
      node.append(el('div', { class: 'note-text' }));
    } else if (it.type === 'draw') {
      node.classList.add('draw');
      const clip = el('div', { class: 'clip' });
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'media');
      svg.setAttribute('preserveAspectRatio', 'none');
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
      clip.append(svg);
      node.append(clip);
    } else {
      const clip = el('div', { class: 'clip' });
      if (it.type === 'video') {
        const v = el('video', { class: 'media', preload: 'metadata', playsinline: true, muted: true });
        v.muted = true;
        v.addEventListener('loadedmetadata', () => {
          const cur = B.items.get(it.id);
          if (cur) v.currentTime = cur.vin || 0;
        });
        v.addEventListener('play', () => { updateBadge(it.id); syncVideoBar(); startLoopWatch(); });
        v.addEventListener('pause', () => { updateBadge(it.id); syncVideoBar(); });
        v.addEventListener('timeupdate', () => { if (B.sel.size === 1 && B.sel.has(it.id)) syncVideoBar(); });
        v.addEventListener('error', () => markMissing(it.id));
        clip.append(v);
        node.append(clip, el('div', { class: 'play-badge', html: ICONS.smallPlay }));
      } else {
        const img = el('img', { class: 'media', draggable: 'false', decoding: 'async', alt: '' });
        img.addEventListener('error', () => markMissing(it.id));
        img.addEventListener('load', () => node.classList.remove('missing'));
        clip.append(img);
        node.append(clip);
      }
    }
    node.append(el('div', { class: 'who' }));
    world.append(node);
    B.els.set(it.id, node);
    return node;
  }

  function updateEl(node, it) {
    node.style.zIndex = String(Math.round((it.z || 0) - minZ() + 1));
    node.classList.toggle('gray', !!it.gray);
    if (it.type === 'note') {
      node.style.width = it.w + 'px';
      node.style.height = '';
      node.style.fontSize = (it.fs || 16) + 'px';
      const t = node.firstChild;
      if (B.editingId !== it.id && t.textContent !== (it.text || '')) t.textContent = it.text || '';
      node.style.transform = `translate(${it.x}px, ${it.y}px) rotate(${it.rot || 0}deg)`;
      return;
    }
    const d = dims(it);
    const c = it.crop || ZC;
    node.style.width = d.w + 'px';
    node.style.height = d.h + 'px';
    node.style.transform = `translate(${it.x}px, ${it.y}px) rotate(${it.rot || 0}deg)`;
    const clip = node.querySelector('.clip');
    clip.style.transform = `scale(${it.flipX ? -1 : 1}, ${it.flipY ? -1 : 1})`;
    const m = clip.querySelector('.media');
    if (m) {
      m.style.width = it.nw * d.k + 'px';
      m.style.height = it.nh * d.k + 'px';
      m.style.left = -c.l * it.nw * d.k + 'px';
      m.style.top = -c.t * it.nh * d.k + 'px';
      if (it.type === 'draw') {
        m.setAttribute('viewBox', `0 0 ${it.nw} ${it.nh}`);
        const path = m.firstChild;
        const key = it.pts + (it.style || '');
        if (path.dataset.key !== key) { path.dataset.key = key; path.setAttribute('d', strokePath(parsePts(it.pts), it.style === 'arrow' ? (it.sw || 4) : 0)); }
        path.setAttribute('stroke', it.color || '#D7F04A');
        path.setAttribute('stroke-width', it.sw || 4);
        if (it.style === 'dotted') path.setAttribute('stroke-dasharray', `0 ${(it.sw || 4) * 2}`); else path.removeAttribute('stroke-dasharray');
        return;
      }
      const url = mediaUrl(it.src);
      if (m.dataset.src !== url && !node.classList.contains('missing')) { m.dataset.src = url; m.src = url; }
      if (it.type === 'video') m.playbackRate = it.speed || 1;
    }
  }

  function updateBadge(id) {
    const node = B.els.get(id);
    if (!node) return;
    const v = node.querySelector('video');
    const b = node.querySelector('.play-badge');
    if (v && b) b.hidden = !v.paused;
  }

  async function markMissing(id) {
    const it = B.items.get(id);
    const node = B.els.get(id);
    if (!it || !node || node.classList.contains('missing')) return;
    const state = await api.mediaState(B.project.id, it.src);
    node.classList.add('missing');
    const clip = node.querySelector('.clip');
    const m = clip.querySelector('.media');
    if (m) m.style.display = 'none';
    let label = clip.querySelector('.missing-label');
    if (!label) { label = el('div', { class: 'missing-label' }); clip.append(label); }
    const name = it.original || it.src;
    label.textContent = state === 'downloading' ? `Downloading\n${name}` : state === 'here' ? `Can't show this file\n${name}` : `Missing\n${name}`;
    label.style.whiteSpace = 'pre-line';
  }

  // Missing files may arrive later through Drive. Check again now and then.
  setInterval(async () => {
    for (const [id, node] of B.els) {
      if (!node.classList.contains('missing')) continue;
      const it = B.items.get(id);
      if (!it || !B.project || (await api.mediaState(B.project.id, it.src)) !== 'here') { if (it && B.project) { node.classList.remove('missing'); markMissing(id); } continue; }
      node.classList.remove('missing');
      const m = node.querySelector('.media');
      const lab = node.querySelector('.missing-label');
      if (lab) lab.remove();
      if (m) { m.style.display = ''; m.dataset.src = ''; }
      updateEl(node, it);
    }
  }, 4000);

  function render() {
    document.body.classList.toggle('board-empty', !live().length);
    const seen = new Set();
    for (const it of B.items.values()) {
      if (it.deleted || !it.type) continue;
      seen.add(it.id);
      const node = B.els.get(it.id) || makeEl(it);
      updateEl(node, it);
    }
    for (const [id, node] of B.els) {
      if (!seen.has(id)) {
        const v = node.querySelector('video');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        node.remove();
        B.els.delete(id);
        B.sel.delete(id);
      }
    }
    renderOverlay();
    B.onChange('items');
  }

  function renderOverlay() {
    overlay.innerHTML = '';
    const ids = [...B.sel].filter((id) => B.items.get(id) && !B.items.get(id).deleted);
    if (!ids.length || (B.gesture && B.gesture.type === 'pan')) { syncVideoBar(); return; }
    const s = B.view.s;
    const box = (it, multi) => {
      const { w, h } = dims(it);
      const c = toScreen(it.x + w / 2, it.y + h / 2);
      const b = el('div', { class: 'sel' + (multi ? ' multi-item' : '') });
      b.style.width = w * s + 'px';
      b.style.height = h * s + 'px';
      b.style.left = c.x - (w * s) / 2 + 'px';
      b.style.top = c.y - (h * s) / 2 + 'px';
      b.style.transform = `rotate(${it.rot || 0}deg)`;
      return b;
    };
    const handles = (b) => { if (!B.readOnly) for (const k of ['nw', 'ne', 'sw', 'se']) b.append(el('div', { class: 'h ' + k, 'data-h': k })); };
    if (ids.length === 1) {
      const b = box(B.items.get(ids[0]), false);
      handles(b);
      overlay.append(b);
    } else {
      for (const id of ids) overlay.append(box(B.items.get(id), true));
      const bb = bbox(ids);
      const a = toScreen(bb.x, bb.y);
      const g = el('div', { class: 'sel' });
      Object.assign(g.style, { left: a.x + 'px', top: a.y + 'px', width: bb.w * s + 'px', height: bb.h * s + 'px' });
      handles(g);
      overlay.append(g);
    }
    syncVideoBar();
  }

  let viewTimer = null;
  function applyView() {
    const v = B.view;
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    canvas.style.backgroundSize = `${28 * v.s}px ${28 * v.s}px`;
    canvas.style.backgroundPosition = `${v.x}px ${v.y}px`;
    $('#zVal').textContent = Math.round(v.s * 100) + '%';
    renderOverlay();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      pauseOffscreen();
      if (B.project) try { localStorage.setItem('view:' + B.project.id, JSON.stringify(B.view)); } catch (_) {}
    }, 250);
  }

  function pauseOffscreen() {
    const W = window.innerWidth, H = window.innerHeight;
    for (const [id, node] of B.els) {
      const v = node.querySelector('video');
      if (!v || v.paused) continue;
      const r = node.getBoundingClientRect();
      if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) v.pause();
    }
  }

  function zoomAt(sx, sy, f) {
    const p = toWorld(sx, sy);
    const s = Math.max(0.02, Math.min(40, B.view.s * f));
    B.view.s = s;
    B.view.x = sx - p.x * s;
    B.view.y = sy - p.y * s;
    applyView();
  }

  // The part of the window not covered by the sidebar and floating bars
  function viewport() {
    const b = document.body.classList;
    if (b.contains('clean') && !b.contains('board-empty')) return { left: 16, top: 16, right: window.innerWidth - 16, bottom: window.innerHeight - 16 };
    const side = b.contains('has-sidebar') ? 304 : 16;
    return { left: side, top: 76, right: window.innerWidth - 16, bottom: window.innerHeight - 76 };
  }

  function fitRect(r, pad = 24) {
    if (!r) return;
    const vp = viewport();
    const W = Math.max(80, vp.right - vp.left - pad * 2), H = Math.max(80, vp.bottom - vp.top - pad * 2);
    const s = Math.max(0.02, Math.min(8, Math.min(W / Math.max(r.w, 1), H / Math.max(r.h, 1))));
    B.view.s = s;
    B.view.x = (vp.left + vp.right) / 2 - (r.x + r.w / 2) * s;
    B.view.y = (vp.top + vp.bottom) / 2 - (r.y + r.h / 2) * s;
    applyView();
  }
  const viewCenter = () => { const vp = viewport(); return toWorld((vp.left + vp.right) / 2, (vp.top + vp.bottom) / 2); };

  // ---------- hit testing ----------
  function itemAt(cx, cy) {
    const stack = document.elementsFromPoint(cx, cy);
    for (const n of stack) {
      if (n.closest && n.closest('#overlay .h')) return null;
      const node = n.closest && n.closest('.item');
      if (node && world.contains(node)) return node.dataset.id;
      if (n === canvas) break;
    }
    return null;
  }

  // ---------- gestures ----------
  function snapshot(ids, keys) {
    return ids.map((id) => ({ id, fields: pick(B.items.get(id), keys) }));
  }

  function startGesture(g, e) {
    B.gesture = g;
    g.sx0 = e.clientX; g.sy0 = e.clientY;
    g.w0 = toWorld(e.clientX, e.clientY);
    g.moved = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!B.project) return;
    if (e.target.closest('.note-text[contenteditable]')) return;
    if (B.editingId) stopEditing();
    canvas.focus({ preventScroll: true });
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    let button = e.button;
    if (IS_MAC && e.ctrlKey && button === 0) button = 2;

    if (button === 2) { startGesture({ type: 'right', lastX: e.screenX, lastY: e.screenY, screen0: { x: e.screenX, y: e.screenY } }, e); return; }
    if (button === 1) { e.preventDefault(); startGesture({ type: 'pan', v0: { ...B.view } }, e); canvas.classList.add('panning'); return; }
    if (button !== 0) return;

    const handle = e.target.closest && e.target.closest('#overlay .h');
    if (handle && canEdit(true)) {
      const ids = [...B.sel];
      startGesture({ type: 'resize', corner: handle.dataset.h, ids, before: snapshot(ids, ['x', 'y', 'w', 'fs']), start: ids.map((id) => clone(B.items.get(id))), bb: bbox(ids) }, e);
      return;
    }
    const hit = itemAt(e.clientX, e.clientY);
    if (B.tool === 'hand' || B.lockedCanvas || (e.altKey && !mod && !e.shiftKey) || (B.held.has(' ') && !hit)) {
      startGesture({ type: 'pan', v0: { ...B.view } }, e); canvas.classList.add('panning'); return;
    }
    if (B.tool === 'eraser' && !B.held.has('z')) {
      if (!canEdit()) return;
      startGesture({ type: 'erase', ids: new Set(), before: [] }, e);
      eraseAt(B.gesture, e.clientX, e.clientY);
      return;
    }
    if (B.tool === 'pen' && !B.held.has('z')) {
      if (!canEdit()) return;
      const live = document.createElementNS(SVGNS, 'svg');
      live.setAttribute('class', 'live');
      const path = document.createElementNS(SVGNS, 'path');
      const sw = B.pen.size / B.view.s;
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', B.pen.color); path.setAttribute('stroke-width', sw);
      path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
      if (B.pen.style === 'dotted') path.setAttribute('stroke-dasharray', `0 ${sw * 2}`);
      live.append(path); world.append(live);
      startGesture({ type: 'draw', live, path, sw, pts: [] }, e);
      B.gesture.pts.push(B.gesture.w0);
      return;
    }
    if (B.held.has('z')) { startGesture({ type: 'zoomdrag', s0: B.view.s, anchor: { x: e.clientX, y: e.clientY }, v0: { ...B.view } }, e); return; }

    if (hit) {
      const hitItem = B.items.get(hit);
      if ((B.held.has('c') || B.held.has('v')) && hitItem.type !== 'note' && hitItem.type !== 'draw' && canEdit()) {
        B.sel = new Set([hit]);
        startGesture({ type: 'crop', id: hit, pan: B.held.has('v'), start: clone(hitItem), before: snapshot([hit], ['x', 'y', 'w', 'crop']) }, e);
        renderOverlay(); return;
      }
      if (!B.sel.has(hit)) { if (!e.shiftKey) B.sel.clear(); B.sel.add(hit); }
      else if (e.shiftKey && !mod) { B.sel.delete(hit); renderOverlay(); return; }
      const ids = [...B.sel];
      if (mod && e.altKey && canEdit()) { startGesture({ type: 'scale', ids, start: ids.map((id) => clone(B.items.get(id))), before: snapshot(ids, ['x', 'y', 'w', 'fs']), bb: bbox(ids) }, e); renderOverlay(); return; }
      if (mod && canEdit()) { startGesture({ type: 'rotate', ids, start: ids.map((id) => clone(B.items.get(id))), before: snapshot(ids, ['rot']) }, e); renderOverlay(); return; }
      if (e.altKey && e.shiftKey && canEdit()) { startGesture({ type: 'flip', ids }, e); renderOverlay(); return; }
      const movable = ids.filter((id) => !B.items.get(id).locked);
      startGesture({ type: 'move', hit, ids: movable, start: movable.map((id) => ({ id, x: B.items.get(id).x, y: B.items.get(id).y })), before: snapshot(movable, ['x', 'y']) }, e);
      renderOverlay();
      return;
    }
    if (!e.shiftKey) B.sel.clear();
    startGesture({ type: 'marquee', base: new Set(B.sel) }, e);
    renderOverlay();
  });

  canvas.addEventListener('pointermove', (e) => {
    const g = B.gesture;
    if (!g) {
      const id = itemAt(e.clientX, e.clientY);
      B.hoverId = id;
      return;
    }
    const dxS = e.clientX - g.sx0, dyS = e.clientY - g.sy0;
    if (g.type === 'draw') {
      const p = toWorld(e.clientX, e.clientY);
      const last = g.pts[g.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * B.view.s < 1.5) return;
      g.moved = true;
      g.pts.push(p);
      g.path.setAttribute('d', strokePath(g.pts, B.pen.style === 'arrow' ? g.sw : 0));
      return;
    }
    if (g.type === 'erase') { eraseAt(g, e.clientX, e.clientY); return; }
    if (!g.moved && Math.hypot(dxS, dyS) < 3) return;
    g.moved = true;
    const p = toWorld(e.clientX, e.clientY);
    const dx = p.x - g.w0.x, dy = p.y - g.w0.y;

    switch (g.type) {
      case 'right': {
        api.moveWindowBy(e.screenX - g.lastX, e.screenY - g.lastY);
        g.lastX = e.screenX; g.lastY = e.screenY;
        break;
      }
      case 'pan':
        B.view.x = g.v0.x + dxS; B.view.y = g.v0.y + dyS; applyView(); break;
      case 'zoomdrag': {
        const f = Math.exp(-dyS / 150);
        B.view = { ...g.v0 };
        zoomAt(g.anchor.x, g.anchor.y, f);
        break;
      }
      case 'move': {
        let mx = dx, my = dy;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; }
        for (const s of g.start) { const it = B.items.get(s.id); it.x = s.x + mx; it.y = s.y + my; updateEl(B.els.get(s.id), it); }
        renderOverlay();
        break;
      }
      case 'resize': {
        const bb = g.bb;
        const ax = g.corner.includes('w') ? bb.x + bb.w : bb.x;
        const ay = g.corner.includes('n') ? bb.y + bb.h : bb.y;
        let f;
        if (g.ids.length === 1 && (g.start[0].rot || 0) % 360 !== 0) {
          const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
          f = Math.hypot(p.x - cx, p.y - cy) / Math.max(1, Math.hypot(g.w0.x - cx, g.w0.y - cy));
          g.start.forEach((s0) => { const it = B.items.get(s0.id); const d0 = dims(s0); it.w = Math.max(MIN_SIZE, s0.w * f); if (s0.fs) it.fs = s0.fs * f; it.x = cx - (d0.w * f) / 2; it.y = cy - (d0.h * f) / 2; updateEl(B.els.get(s0.id), it); });
        } else {
          const fx = Math.abs(p.x - ax) / Math.max(1, bb.w);
          const fy = Math.abs(p.y - ay) / Math.max(1, bb.h);
          f = Math.max(0.01, Math.max(fx, fy));
          g.start.forEach((s0) => {
            const it = B.items.get(s0.id);
            it.w = Math.max(MIN_SIZE, s0.w * f);
            if (s0.fs) it.fs = Math.max(4, s0.fs * f);
            it.x = ax + (s0.x - ax) * f;
            it.y = ay + (s0.y - ay) * f;
            updateEl(B.els.get(s0.id), it);
          });
        }
        renderOverlay();
        break;
      }
      case 'scale': {
        const f = Math.exp((dxS - dyS) / 300);
        const cx = g.bb.x + g.bb.w / 2, cy = g.bb.y + g.bb.h / 2;
        g.start.forEach((s0) => {
          const it = B.items.get(s0.id);
          it.w = Math.max(MIN_SIZE, s0.w * f);
          if (s0.fs) it.fs = Math.max(4, s0.fs * f);
          it.x = cx + (s0.x - cx) * f; it.y = cy + (s0.y - cy) * f;
          updateEl(B.els.get(s0.id), it);
        });
        renderOverlay();
        break;
      }
      case 'rotate': {
        g.start.forEach((s0) => {
          const it = B.items.get(s0.id);
          const d = dims(s0);
          const c = { x: s0.x + d.w / 2, y: s0.y + d.h / 2 };
          const a0 = Math.atan2(g.w0.y - c.y, g.w0.x - c.x), a1 = Math.atan2(p.y - c.y, p.x - c.x);
          let r = (s0.rot || 0) + ((a1 - a0) * 180) / Math.PI;
          if (e.shiftKey) r = Math.round(r / 15) * 15;
          it.rot = ((r % 360) + 360) % 360;
          updateEl(B.els.get(s0.id), it);
        });
        renderOverlay();
        break;
      }
      case 'flip': {
        if (g.done || Math.hypot(dxS, dyS) < 24) break;
        g.done = true;
        const key = Math.abs(dxS) > Math.abs(dyS) ? 'flipX' : 'flipY';
        commit(g.ids.map((id) => ({ id, fields: { [key]: !B.items.get(id)[key] } })));
        break;
      }
      case 'crop': cropMove(g, dx, dy); break;
      case 'marquee': {
        const x = Math.min(g.sx0, e.clientX), y = Math.min(g.sy0, e.clientY);
        const w = Math.abs(dxS), h = Math.abs(dyS);
        Object.assign(marquee.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        marquee.hidden = false;
        const a = toWorld(x, y), b = toWorld(x + w, y + h);
        B.sel = new Set(g.base);
        for (const it of live()) {
          const r = bbox([it.id]);
          if (r.x < b.x && r.x + r.w > a.x && r.y < b.y && r.y + r.h > a.y) B.sel.add(it.id);
        }
        renderOverlay();
        break;
      }
    }
  });

  function cropMove(g, dx, dy) {
    const s0 = g.start;
    const it = B.items.get(g.id);
    const d0 = dims(s0);
    const c0 = { ...ZC, ...(s0.crop || {}) };
    // Drag in the item's own (rotated, flipped) frame
    const a = (-(s0.rot || 0) * Math.PI) / 180;
    let lx = dx * Math.cos(a) - dy * Math.sin(a);
    let ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (s0.flipX) lx = -lx;
    if (s0.flipY) ly = -ly;
    const nx = lx / d0.k / s0.nw, ny = ly / d0.k / s0.nh;
    const MINF = 0.02;
    const c = { ...c0 };
    if (!g.edges) {
      const u = (g.w0.x - s0.x) / d0.w, v = (g.w0.y - s0.y) / d0.h;
      g.edges = g.pan ? {} : { l: u < 0.33, r: u > 0.67, t: v < 0.33, b: v > 0.67 };
      if (!g.edges.l && !g.edges.r && !g.edges.t && !g.edges.b) g.pan = true;
    }
    if (g.pan) {
      const sl = Math.max(-c0.l, Math.min(c0.r, -nx));
      const st = Math.max(-c0.t, Math.min(c0.b, -ny));
      c.l = c0.l + sl; c.r = c0.r - sl; c.t = c0.t + st; c.b = c0.b - st;
    } else {
      if (g.edges.l) c.l = Math.max(0, Math.min(1 - c0.r - MINF, c0.l + nx));
      if (g.edges.r) c.r = Math.max(0, Math.min(1 - c0.l - MINF, c0.r - nx));
      if (g.edges.t) c.t = Math.max(0, Math.min(1 - c0.b - MINF, c0.t + ny));
      if (g.edges.b) c.b = Math.max(0, Math.min(1 - c0.t - MINF, c0.b - ny));
    }
    it.crop = c;
    // Keep the picture itself still while its frame changes
    const ox = s0.x - c0.l * s0.nw * d0.k, oy = s0.y - c0.t * s0.nh * d0.k;
    if (!g.pan) {
      it.x = s0.flipX ? s0.x + (c0.r - c.r) * s0.nw * d0.k : ox + c.l * s0.nw * d0.k;
      it.y = s0.flipY ? s0.y + (c0.b - c.b) * s0.nh * d0.k : oy + c.t * s0.nh * d0.k;
      it.w = (1 - c.l - c.r) * s0.nw * d0.k;
    }
    updateEl(B.els.get(g.id), it);
    renderOverlay();
  }

  function endGesture(e) {
    const g = B.gesture;
    if (!g) return;
    B.gesture = null;
    canvas.classList.remove('panning');
    marquee.hidden = true;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    switch (g.type) {
      case 'right':
        if (!g.moved) contextMenu(e.clientX, e.clientY);
        break;
      case 'move':
        if (g.moved && g.ids.length) commit(g.ids.map((id) => ({ id, fields: { x: B.items.get(id).x, y: B.items.get(id).y } })), g.before);
        else if (!g.moved && !e.shiftKey && B.sel.size > 1) { B.sel = new Set([g.hit]); renderOverlay(); }
        break;
      case 'resize':
      case 'scale':
        if (g.moved) commit(g.ids.map((id) => { const it = B.items.get(id); const f = { x: it.x, y: it.y, w: it.w }; if (it.type === 'note') f.fs = it.fs; return { id, fields: f }; }), g.before);
        break;
      case 'rotate':
        if (g.moved) commit(g.ids.map((id) => ({ id, fields: { rot: B.items.get(id).rot } })), g.before);
        break;
      case 'erase':
        if (g.ids.size) commit([...g.ids].map((id) => ({ id, fields: { deleted: true } })), [...g.ids].map((id) => ({ id, fields: { deleted: false } })));
        break;
      case 'draw':
        g.live.remove();
        if (g.pts.length > 1) finishStroke(g);
        break;
      case 'crop':
        if (g.moved) { const it = B.items.get(g.id); commit([{ id: g.id, fields: { x: it.x, y: it.y, w: it.w, crop: it.crop } }], g.before); }
        break;
    }
    if (B.pendingRemote) { const p = B.pendingRemote; B.pendingRemote = null; applyRemote(p); }
    renderOverlay();
  }
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('auxclick', (e) => e.preventDefault());

  canvas.addEventListener('dblclick', (e) => {
    const id = itemAt(e.clientX, e.clientY);
    const it = id && B.items.get(id);
    if (it && it.type === 'note') editNote(id);
    else if (it && it.type === 'video') togglePlay(id);
  });

  // Mouse wheel zooms like PureRef; trackpad two finger scroll pans, pinch zooms.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!B.project) return;
    const mouseLike = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    if (e.ctrlKey || e.metaKey || mouseLike) {
      const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey && !mouseLike ? 0.01 : 0.0018)));
    } else {
      B.view.x -= e.deltaX; B.view.y -= e.deltaY; applyView();
    }
  }, { passive: false });

  window.addEventListener('resize', () => applyView());

  // ---------- notes ----------
  function editNote(id) {
    if (!canEdit()) return;
    const node = B.els.get(id);
    if (!node) return;
    stopEditing();
    B.editingId = id;
    B.sel = new Set([id]);
    const t = node.querySelector('.note-text');
    try { t.contentEditable = 'plaintext-only'; } catch (_) { t.contentEditable = 'true'; }
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    node.classList.add('editing');
    t.focus();
    const r = document.createRange();
    r.selectNodeContents(t); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    t.oninput = () => renderOverlay();
    t.onblur = () => setTimeout(() => { if (B.editingId === id) stopEditing(); }, 0);
    renderOverlay();
  }

  function stopEditing() {
    const id = B.editingId;
    if (!id) return;
    B.editingId = null;
    const node = B.els.get(id);
    if (!node) return;
    const t = node.querySelector('.note-text');
    t.contentEditable = 'false';
    t.removeAttribute('contenteditable');
    node.classList.remove('editing');
    const text = t.innerText.replace(/\n$/, '');
    const it = B.items.get(id);
    if (it && text !== (it.text || '')) commit([{ id, fields: { text } }]);
    renderOverlay();
  }

  // ---------- drawing ----------
  // A stroke is an ordinary item: it moves, scales, rotates, syncs and undoes like an image.
  function parsePts(s) {
    const n = String(s || '').split(' ').map(Number);
    const out = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i], y: n[i + 1] });
    return out;
  }
  function strokePath(pts, arrow) {
    if (!pts.length) return '';
    if (arrow && pts.length > 1) {
      // Head points back along the last stretch of the line
      const tip = pts[pts.length - 1];
      let back = pts[0];
      for (let i = pts.length - 2; i >= 0; i--) { if (Math.hypot(tip.x - pts[i].x, tip.y - pts[i].y) > arrow * 4) { back = pts[i]; break; } }
      const a = Math.atan2(tip.y - back.y, tip.x - back.x), L = arrow * 4.5;
      const h1 = { x: tip.x - L * Math.cos(a - 0.5), y: tip.y - L * Math.sin(a - 0.5) };
      const h2 = { x: tip.x - L * Math.cos(a + 0.5), y: tip.y - L * Math.sin(a + 0.5) };
      return strokePath(pts) + ` M${h1.x} ${h1.y} L${tip.x} ${tip.y} L${h2.x} ${h2.y}`;
    }
    if (pts.length < 3) return `M${pts[0].x} ${pts[0].y}` + pts.slice(1).map((p) => ` L${p.x} ${p.y}`).join('');
    let d = `M${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
    }
    const l = pts[pts.length - 1];
    return d + ` L${l.x} ${l.y}`;
  }
  function finishStroke(g) {
    const pad = g.sw / 2 + 1 + (B.pen.style === 'arrow' ? g.sw * 4.5 : 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const r = (v) => Math.round(v * 10) / 10;
    const pts = g.pts.map((p) => `${r(p.x - x0)} ${r(p.y - y0)}`).join(' ');
    const nw = r(x1 - x0), nh = r(y1 - y0);
    const id = uid();
    commit([{ id, fields: { type: 'draw', pts, nw, nh, w: nw, x: x0, y: y0, sw: r(g.sw), color: B.pen.color, style: B.pen.style, z: maxZ() + 1, rot: 0, deleted: false, created: Date.now(), addedBy: B.me.name } }]);
  }

  // Eraser: anything drawn that the pointer passes over goes, as one undo step
  // Checked along the whole pointer path, so a fast swipe still catches thin lines.
  function eraseAt(g, cx, cy) {
    const from = g.last || { x: cx, y: cy };
    g.last = { x: cx, y: cy };
    const steps = Math.max(1, Math.ceil(Math.hypot(cx - from.x, cy - from.y) / 3));
    const strokes = live().filter((it) => it.type === 'draw' && !g.ids.has(it.id));
    for (let s = 0; s <= steps && strokes.length; s++) {
      const p = toWorld(from.x + (cx - from.x) * (s / steps), from.y + (cy - from.y) * (s / steps));
      for (let i = strokes.length - 1; i >= 0; i--) {
        const it = strokes[i];
        if (!strokeHit(it, p, 6 / B.view.s)) continue;
        g.ids.add(it.id);
        const node = B.els.get(it.id);
        if (node) node.style.opacity = '0.25';
        strokes.splice(i, 1);
      }
    }
  }
  function strokeHit(it, p, tol) {
    const k = it.w / it.nw;
    const h = it.nh * k;
    // Into the stroke's own space: undo rotation about its centre, then scale and flips
    const cx = it.x + it.w / 2, cy = it.y + h / 2;
    const a = -(it.rot || 0) * Math.PI / 180;
    const dx = p.x - cx, dy = p.y - cy;
    let lx = (dx * Math.cos(a) - dy * Math.sin(a) + it.w / 2) / k;
    let ly = (dx * Math.sin(a) + dy * Math.cos(a) + h / 2) / k;
    if (it.flipX) lx = it.nw - lx;
    if (it.flipY) ly = it.nh - ly;
    const r = (it.sw || 4) / 2 + tol / k;
    if (lx < -r || ly < -r || lx > it.nw + r || ly > it.nh + r) return false;
    const pts = parsePts(it.pts);
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], Bp = pts[i + 1];
      const vx = Bp.x - A.x, vy = Bp.y - A.y;
      const t = Math.max(0, Math.min(1, ((lx - A.x) * vx + (ly - A.y) * vy) / (vx * vx + vy * vy || 1)));
      if (Math.hypot(lx - (A.x + t * vx), ly - (A.y + t * vy)) <= r) return true;
    }
    return false;
  }

  function addNote(at, text) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const fs = Math.max(8, Math.round(16 / Math.max(0.25, Math.min(4, B.view.s))));
    const id = uid();
    commit([{ id, fields: { type: 'note', text: text || '', x: p.x - fs * 9, y: p.y - fs * 2, w: fs * 18, fs, z: maxZ() + 1, rot: 0, deleted: false, created: Date.now(), addedBy: B.me.name } }]);
    B.sel = new Set([id]);
    if (!text) setTimeout(() => editNote(id), 0);
    renderOverlay();
  }

  // ---------- adding media ----------
  function measure(src, kind) {
    return new Promise((resolve) => {
      const url = mediaUrl(src);
      if (kind === 'video') {
        const v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true;
        v.onloadedmetadata = () => { resolve({ nw: v.videoWidth || 1280, nh: v.videoHeight || 720, duration: v.duration || 0 }); v.removeAttribute('src'); v.load(); };
        v.onerror = () => resolve({ nw: 1280, nh: 720, duration: 0, failed: true });
        v.src = url;
      } else {
        const i = new Image();
        i.onload = () => resolve({ nw: i.naturalWidth || 800, nh: i.naturalHeight || 600 });
        i.onerror = () => resolve({ nw: 800, nh: 600, failed: true });
        i.src = url;
      }
    });
  }

  // results from the main process import → items on the board, laid out from point p
  async function placeResults(results, p, opts = {}) {
    const ok = [];
    for (const r of results) {
      if (!r) continue;
      if (r.error) { toast(r.error, true); continue; }
      const m = await measure(r.src, r.kind);
      ok.push({ r, m });
    }
    if (!ok.length) return [];
    const sizes = ok.map(({ m }) => {
      const f = Math.min(1, MAX_PLACE / Math.max(m.nw, m.nh));
      return { w: (opts.width ? opts.width : m.nw * f), h: (opts.width ? opts.width * (m.nh / m.nw) : m.nh * f) };
    });
    const gap = 20;
    const rowMax = 2600;
    let x = 0, y = 0, rowH = 0;
    const pos = sizes.map((s) => {
      if (x > 0 && x + s.w > rowMax) { x = 0; y += rowH + gap; rowH = 0; }
      const at = { x, y };
      x += s.w + gap; rowH = Math.max(rowH, s.h);
      return at;
    });
    const totalW = Math.max(...pos.map((q, i) => q.x + sizes[i].w));
    const totalH = Math.max(...pos.map((q, i) => q.y + sizes[i].h));
    const ox = opts.exact ? p.x : p.x - totalW / 2, oy = opts.exact ? p.y : p.y - totalH / 2;
    let z = maxZ();
    const changes = ok.map(({ r, m }, i) => ({
      id: uid(),
      fields: {
        type: r.kind, src: r.src, hash: r.hash || null, original: r.original || r.src,
        nw: m.nw, nh: m.nh, x: ox + pos[i].x, y: oy + pos[i].y, w: sizes[i].w,
        crop: { ...ZC }, rot: 0, flipX: false, flipY: false, gray: false, locked: false, deleted: false,
        z: ++z, created: Date.now(), addedBy: B.me.name,
        ...(r.kind === 'video' ? { vin: 0, vout: m.duration || r.duration || 0, loop: true, speed: 1 } : {}),
      },
    }));
    commit(changes);
    B.sel = new Set(changes.map((c) => c.id));
    renderOverlay();
    const reused = ok.filter(({ r }) => r.reused).length;
    const big = ok.filter(({ r }) => r.reason === 'size').length;
    const converted = ok.filter(({ r }) => r.reason === 'format' || r.converted).length;
    if (big) toast(big === 1 ? 'Video was over 500MB, so a high quality copy was saved.' : `${big} videos over 500MB were saved as high quality copies.`);
    else if (converted) toast(converted === 1 ? 'Converted so it plays on the board. Your original is untouched.' : `${converted} files converted so they play on the board.`);
    else if (reused) toast(reused === 1 ? 'Already in this project, so the same file was reused.' : `${reused} files were already in this project and were reused.`);
    return changes.map((c) => c.id);
  }

  async function addPaths(paths, at) {
    if (!paths || !paths.length || !canEdit()) return;
    const p = at || viewCenter();
    const results = await api.importPaths(B.project.id, paths);
    if (results && results.error) return toast(results.error, true);
    await placeResults(results, p);
  }

  async function addBytes(files, at) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const results = [];
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace('quicktime', 'mov');
      results.push(await api.importBytes(B.project.id, buf, f.name && /\.[a-z0-9]+$/i.test(f.name) ? f.name : `pasted.${ext}`));
    }
    await placeResults(results, p);
  }

  async function addUrl(url, at) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const r = await api.importUrl(B.project.id, url);
    await placeResults([r], p);
  }

  // Drag and drop from Finder, Explorer or a browser
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!B.project || !canEdit()) return;
    const at = toWorld(e.clientX, e.clientY);
    const files = [...(e.dataTransfer.files || [])];
    const paths = [], blobs = [];
    for (const f of files) { const p = api.pathForFile(f); if (p) paths.push(p); else blobs.push(f); }
    if (paths.length) await addPaths(paths, at);
    if (blobs.length) await addBytes(blobs, at);
    if (!files.length) {
      const html = e.dataTransfer.getData('text/html');
      const m = html && /<img[^>]+src="([^"]+)"/i.exec(html);
      const url = (m && m[1]) || (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => /^https?:/.test(l));
      if (url) await addUrl(url, at);
    }
  });

  // ---------- clipboard ----------
  function copySelection(cut) {
    const ids = [...B.sel];
    if (!ids.length) return;
    B.clip = { from: B.project.id, base: B.mediaBase, items: ids.map((id) => clone(B.items.get(id))) };
    B.clipMarker = 'eyerefs:' + uid();
    try { navigator.clipboard.writeText(B.clipMarker); } catch (_) {}
    if (cut) deleteSelection();
  }

  async function pasteInternal(at) {
    if (!B.clip || !canEdit()) return;
    const items = B.clip.items;
    const p = at || viewCenter();
    const bb = (() => { let x0 = Infinity, y0 = Infinity; for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); } return { x: x0, y: y0 }; })();
    let srcMap = new Map();
    if (B.clip.from !== B.project.id) {
      // Copy the files into this project's media folder
      const srcs = [...new Set(items.filter((it) => it.src).map((it) => it.src))];
      const paths = srcs.map((s) => decodeURIComponent(new URL(B.clip.base + encodeURIComponent(s)).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      const res = await api.importPaths(B.project.id, paths);
      if (res && res.error) return toast(res.error, true);
      srcs.forEach((s, i) => { if (res[i] && res[i].src) srcMap.set(s, res[i].src); });
    }
    let z = maxZ();
    const changes = items.map((it) => {
      const f = clone(it);
      delete f.id; delete f._t; delete f._dev; delete f.by;
      f.x = p.x + (it.x - bb.x); f.y = p.y + (it.y - bb.y); f.z = ++z; f.deleted = false; f.created = Date.now(); f.addedBy = B.me.name;
      if (f.src && srcMap.size) f.src = srcMap.get(f.src) || f.src;
      return { id: uid(), fields: f };
    });
    commit(changes);
    B.sel = new Set(changes.map((c) => c.id));
    renderOverlay();
  }

  // Paste anything: images copied in a browser or Google Slides, screenshots,
  // pictures from other apps, files from Finder or Explorer, image links, or text
  // (which becomes a note). Several images paste as a row.
  function imgSources(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('img')].map((i) => i.getAttribute('src') || '').filter((s) => /^(https?:|data:image\/)/i.test(s));
  }
  async function dataUrlFile(src, i) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    const type = (m && m[1]) || 'image/png';
    const raw = m ? (m[2] ? atob(m[3]) : decodeURIComponent(m[3])) : '';
    const bytes = new Uint8Array(raw.length);
    for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j);
    const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    return new File([bytes], `pasted-${i + 1}.${ext}`, { type });
  }
  async function pasteSources(srcs, at) {
    const files = [], urls = [];
    for (let i = 0; i < srcs.length; i++) {
      if (srcs[i].startsWith('data:')) files.push(await dataUrlFile(srcs[i], i)); else urls.push(srcs[i]);
    }
    if (files.length) await addBytes(files, at);
    if (urls.length) {
      const p = at || viewCenter();
      const results = [];
      for (const u of urls) results.push(await api.importUrl(B.project.id, u));
      const ok = results.filter((r) => r && !r.error);
      if (!ok.length) return toast((results[0] && results[0].error) || "Couldn't paste that.", true);
      await placeResults(ok, p);
    }
  }
  const IMAGE_LINK = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|heic|mp4|webm|mov)(\?\S*)?$/i;
  let pasteTimer = null;
  async function pasteNative(at) {
    if (!B.project || !canEdit()) return;
    const c = await api.readClipboard();
    if (!c || c.error) return;
    if (B.clipMarker && c.text === B.clipMarker) return pasteInternal(at);
    if (c.files && c.files.length) return addPaths(c.files, at);
    const srcs = imgSources(c.html);
    if (srcs.length) return pasteSources(srcs, at);
    if (c.png) return addBytes([new File([c.png], 'pasted.png', { type: 'image/png' })], at);
    const text = (c.text || '').trim();
    if (IMAGE_LINK.test(text)) return addUrl(text, at);
    if (text) addNote(at, text);
  }
  // Windows has no Edit menu, so Ctrl+V may not raise a paste event. If none
  // comes, read the clipboard directly.
  function pasteKey() {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => pasteNative(null), 120);
  }

  document.addEventListener('paste', async (e) => {
    if (!B.project || B.editingId || e.target.closest('input, textarea, [contenteditable]')) return;
    clearTimeout(pasteTimer);
    e.preventDefault();
    const at = null;
    const cd = e.clipboardData;
    const text = cd.getData('text/plain');
    if (B.clipMarker && text === B.clipMarker) return pasteInternal(at);
    const files = [...(cd.files || [])];
    if (files.length) {
      const paths = [], blobs = [];
      for (const f of files) { const p = api.pathForFile(f); if (p) paths.push(p); else blobs.push(f); }
      if (paths.length) await addPaths(paths, at);
      if (blobs.length) await addBytes(blobs, at);
      return;
    }
    const srcs = imgSources(cd.getData('text/html'));
    if (srcs.length) return pasteSources(srcs, at);
    // Nothing the page can read (a picture from another app, a copied file): ask the system
    return pasteNative(at);
  });

  // ---------- selection actions ----------
  const selIds = () => [...B.sel].filter((id) => B.items.get(id) && !B.items.get(id).deleted);
  const selOrAll = () => (B.sel.size ? selIds() : live().map((it) => it.id));

  function deleteSelection() {
    const ids = selIds();
    if (!ids.length) return;
    commit(ids.map((id) => ({ id, fields: { deleted: true } })));
    B.sel.clear(); render();
  }
  function duplicate() {
    const ids = selIds();
    if (!ids.length || !canEdit()) return;
    let z = maxZ();
    const changes = ids.map((id) => {
      const f = clone(B.items.get(id));
      delete f.id; delete f._t; delete f._dev; delete f.by;
      f.x += 24; f.y += 24; f.z = ++z; f.created = Date.now(); f.addedBy = B.me.name;
      return { id: uid(), fields: f };
    });
    commit(changes);
    B.sel = new Set(changes.map((c) => c.id)); renderOverlay();
  }
  const toggleField = (key) => { const ids = selIds(); if (!ids.length) return; const v = !ids.every((id) => B.items.get(id)[key]); commit(ids.map((id) => ({ id, fields: { [key]: v } }))); };
  function resetCrop() {
    const ids = selIds().filter((id) => B.items.get(id).type !== 'note');
    commit(ids.map((id) => { const it = B.items.get(id); const d = dims(it); const c = it.crop || ZC; return { id, fields: { crop: { ...ZC }, x: it.x - c.l * it.nw * d.k, y: it.y - c.t * it.nh * d.k, w: it.nw * d.k } }; }));
  }
  function resetTransform() {
    const ids = selIds();
    commit(ids.map((id) => {
      const it = B.items.get(id);
      if (it.type === 'note') return { id, fields: { rot: 0 } };
      const f = Math.min(1, MAX_PLACE / Math.max(it.nw, it.nh));
      return { id, fields: { rot: 0, flipX: false, flipY: false, w: (it.nw * (1 - (it.crop || ZC).l - (it.crop || ZC).r)) * f } };
    }));
  }
  function front() { const ids = selIds(); let z = maxZ(); commit(ids.map((id) => ({ id, fields: { z: ++z } }))); }
  function back() { const ids = selIds(); let z = minZ(); commit(ids.map((id) => ({ id, fields: { z: --z } }))); }

  function align(dir) {
    const ids = selIds();
    if (ids.length < 2) return;
    const bb = bbox(ids);
    commit(ids.map((id) => {
      const it = B.items.get(id); const d = dims(it);
      if (dir === 'left') return { id, fields: { x: bb.x } };
      if (dir === 'right') return { id, fields: { x: bb.x + bb.w - d.w } };
      if (dir === 'top') return { id, fields: { y: bb.y } };
      return { id, fields: { y: bb.y + bb.h - d.h } };
    }));
  }

  function normalize(kind) {
    const ids = selIds().filter((id) => B.items.get(id).type !== 'note');
    if (ids.length < 2) return;
    const ds = ids.map((id) => ({ id, it: B.items.get(id), d: dims(B.items.get(id)) }));
    const avg = (f) => ds.reduce((a, x) => a + f(x), 0) / ds.length;
    let fn;
    if (kind === 'height') { const t = avg((x) => x.d.h); fn = (x) => x.it.w * (t / x.d.h); }
    else if (kind === 'width') { const t = avg((x) => x.d.w); fn = () => t; }
    else if (kind === 'size') { const t = avg((x) => x.d.w * x.d.h); fn = (x) => x.it.w * Math.sqrt(t / (x.d.w * x.d.h)); }
    else { const t = avg((x) => x.d.k); fn = (x) => x.d.vw * t; }
    commit(ds.map((x) => ({ id: x.id, fields: { w: fn(x) } })));
  }

  // Arrange optimal: pack into a tidy block, largest first
  function arrange() {
    const ids = selOrAll();
    if (ids.length < 2 || !canEdit()) return;
    const bb = bbox(ids);
    const boxes = ids.map((id) => ({ id, ...dims(B.items.get(id)) })).sort((a, b) => b.h - a.h);
    const area = boxes.reduce((a, b) => a + b.w * b.h, 0);
    const target = Math.max(Math.sqrt(area) * 1.2, Math.max(...boxes.map((b) => b.w)));
    let x = 0, y = 0, rowH = 0;
    const changes = boxes.map((b) => {
      if (x > 0 && x + b.w > target) { x = 0; y += rowH; rowH = 0; }
      const f = { x: bb.x + x, y: bb.y + y, rot: 0 };
      x += b.w; rowH = Math.max(rowH, b.h);
      return { id: b.id, fields: f };
    });
    commit(changes);
  }

  function focusSelection() {
    const ids = selIds().length ? selIds() : (B.hoverId ? [B.hoverId] : []);
    if (ids.length) fitRect(bbox(ids), 40);
  }
  function focusAll() { const ids = live().map((it) => it.id); if (ids.length) fitRect(bbox(ids)); }
  function focusStep(dir) {
    const list = live().sort((a, b) => (a.created || 0) - (b.created || 0) || (a.z || 0) - (b.z || 0));
    if (!list.length) return;
    const cur = selIds()[0];
    let i = list.findIndex((it) => it.id === cur);
    i = i < 0 ? 0 : (i + dir + list.length) % list.length;
    B.sel = new Set([list[i].id]);
    fitRect(bbox([list[i].id]), 40);
  }

  function selectAll() { B.sel = new Set(live().map((it) => it.id)); renderOverlay(); }
  function clearSel() { B.sel.clear(); renderOverlay(); }

  // ---------- video ----------
  function activeVideoId() {
    const ids = selIds();
    if (ids.length === 1 && B.items.get(ids[0]).type === 'video') return ids[0];
    return null;
  }
  const videoEl = (id) => { const n = B.els.get(id); return n && n.querySelector('video'); };

  function togglePlay(id) {
    id = id || activeVideoId();
    const v = id && videoEl(id);
    if (!v) return;
    const it = B.items.get(id);
    if (v.paused) {
      if (it.vout && v.currentTime >= it.vout - 0.05) v.currentTime = it.vin || 0;
      v.play().catch(() => {});
    } else v.pause();
  }

  let loopRunning = false;
  function startLoopWatch() {
    if (loopRunning) return;
    loopRunning = true;
    const tick = () => {
      let any = false;
      for (const [id, node] of B.els) {
        const v = node.querySelector('video');
        if (!v || v.paused) continue;
        any = true;
        const it = B.items.get(id);
        if (!it) continue;
        const vin = it.vin || 0;
        const vout = it.vout && it.vout > vin ? it.vout : v.duration || 0;
        if (vout && v.currentTime >= vout - 0.02) {
          if (it.loop !== false) v.currentTime = vin; else { v.pause(); v.currentTime = vout; }
        } else if (v.currentTime < vin - 0.05) v.currentTime = vin;
      }
      if (any) requestAnimationFrame(tick); else loopRunning = false;
    };
    requestAnimationFrame(tick);
  }

  function setInOut(which) {
    const id = activeVideoId(); const v = id && videoEl(id);
    if (!v || !canEdit()) return;
    const it = B.items.get(id);
    const t = v.currentTime;
    if (which === 'in') commit([{ id, fields: { vin: Math.min(t, (it.vout || v.duration) - 0.1) } }]);
    else commit([{ id, fields: { vout: Math.max(t, (it.vin || 0) + 0.1) } }]);
    syncVideoBar();
  }
  function toggleLoop() { const id = activeVideoId(); if (id) commit([{ id, fields: { loop: B.items.get(id).loop === false } }]); syncVideoBar(); }
  function cycleSpeed() {
    const id = activeVideoId(); if (!id) return;
    const steps = [0.25, 0.5, 1, 1.5, 2];
    const cur = B.items.get(id).speed || 1;
    const next = steps[(steps.indexOf(cur) + 1) % steps.length] || 1;
    commit([{ id, fields: { speed: next } }]);
    syncVideoBar();
  }
  function toggleMute() {
    const id = activeVideoId(); const v = id && videoEl(id); if (!v) return;
    const unmute = v.muted;
    if (unmute) for (const [oid, node] of B.els) { const ov = node.querySelector('video'); if (ov && oid !== id) ov.muted = true; }
    v.muted = !unmute;
    syncVideoBar();
  }
  function step(dir) { const id = activeVideoId(); const v = id && videoEl(id); if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime + dir / 30); } }
  async function grabFrame() {
    const id = activeVideoId(); const v = id && videoEl(id);
    if (!v || !canEdit()) return;
    const it = B.items.get(id);
    const d = dims(it);
    const r = await api.grabFrame(B.project.id, it.src, v.currentTime);
    if (r && r.error) return toast(r.error, true);
    await placeResults([r], { x: it.x + d.w + 20, y: it.y }, { exact: true, width: d.w });
    toast(`Frame at ${fmtTime(v.currentTime)} saved as an image.`);
  }

  function syncVideoBar() {
    const id = activeVideoId();
    const v = id && videoEl(id);
    if (!v || B.gesture || B.editingId) { vbar.hidden = true; return; }
    const it = B.items.get(id);
    const dur = v.duration || it.vout || 0;
    vbar.hidden = false;
    $('#vPlay').innerHTML = v.paused ? ICONS.play : ICONS.pause;
    $('#vPlay').setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
    $('#vTime').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur)}`;
    const pct = (t) => (dur ? Math.max(0, Math.min(100, (t / dur) * 100)) : 0);
    const vin = it.vin || 0, vout = it.vout && it.vout > vin ? it.vout : dur;
    $('#vHead').style.left = pct(v.currentTime) + '%';
    $('#vIn').style.left = pct(vin) + '%';
    $('#vOut').style.left = pct(vout) + '%';
    $('#vRange').style.left = pct(vin) + '%';
    $('#vRange').style.width = pct(vout) - pct(vin) + '%';
    $('#vLoop').classList.toggle('on', it.loop !== false);
    $('#vSpeed').textContent = (it.speed || 1) + 'x';
    $('#vMute').innerHTML = v.muted ? ICONS.muted : ICONS.sound;
    $('#vMute').classList.toggle('on', !v.muted);
    for (const b of [$('#vLoop'), $('#vSpeed'), $('#vGrab')]) b.disabled = B.readOnly;
    // Place under the video, kept inside the window
    const r = B.els.get(id).getBoundingClientRect();
    // The scrubber stretches with the video, so the bar never outgrows it by much
    $('#vTrack').style.width = Math.round(Math.max(70, Math.min(220, r.width - 230))) + 'px';
    const bw = vbar.offsetWidth || 400, bh = 32;
    let x = r.left + r.width / 2 - bw / 2;
    let y = r.bottom + 8;
    if (y + bh > window.innerHeight - 76) y = Math.max(76, r.top - bh - 8);
    if (y + bh > window.innerHeight - 76 || y < 76) y = window.innerHeight - 76 - bh;
    x = Math.max(16, Math.min(window.innerWidth - bw - 16, x));
    vbar.style.left = x + 'px';
    vbar.style.top = y + 'px';
  }

  // Video bar controls
  $('#vPlay').addEventListener('click', () => togglePlay());
  $('#vLoop').addEventListener('click', toggleLoop);
  $('#vSpeed').addEventListener('click', cycleSpeed);
  $('#vMute').addEventListener('click', toggleMute);
  $('#vGrab').addEventListener('click', grabFrame);
  (function trackDrag() {
    const track = $('#vTrack');
    let mode = null, before = null;
    const timeAt = (e) => { const id = activeVideoId(); const v = id && videoEl(id); const r = track.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); return f * ((v && v.duration) || 0); };
    track.addEventListener('pointerdown', (e) => {
      const id = activeVideoId(); if (!id) return;
      mode = e.target.id === 'vIn' ? 'in' : e.target.id === 'vOut' ? 'out' : 'seek';
      if (mode !== 'seek' && !canEdit()) mode = 'seek';
      before = [{ id, fields: pick(B.items.get(id), ['vin', 'vout']) }];
      track.setPointerCapture(e.pointerId);
      move(e);
    });
    const move = (e) => {
      if (!mode) return;
      const id = activeVideoId(); const v = id && videoEl(id); if (!v) return;
      const it = B.items.get(id); const t = timeAt(e);
      const dur = v.duration || 0;
      if (mode === 'seek') v.currentTime = t;
      else if (mode === 'in') { it.vin = Math.min(t, (it.vout || dur) - 0.1); v.currentTime = it.vin; }
      else { it.vout = Math.max(t, (it.vin || 0) + 0.1); v.currentTime = it.vout; }
      syncVideoBar();
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', () => {
      const id = activeVideoId();
      if (id && mode && mode !== 'seek') { const it = B.items.get(id); commit([{ id, fields: { vin: it.vin || 0, vout: it.vout || 0 } }], before); }
      mode = null;
    });
  })();

  // ---------- remote changes from teammates ----------
  function applyRemote(merged) {
    if (B.gesture) { B.pendingRemote = merged; return; }
    for (const id in merged) {
      const n = merged[id];
      const old = B.items.get(id);
      if (old && n._dev && n._dev !== B.me.deviceKey && n.by && n.by !== B.me.name && !n.deleted) {
        const moved = ['x', 'y', 'w', 'rot', 'crop', 'z'].some((k) => JSON.stringify(old[k]) !== JSON.stringify(n[k]));
        if (moved) flashWho(id, n.by);
      }
      if (B.editingId === id) n.text = old ? old.text : n.text;
    }
    for (const writes of unconfirmed) {
      for (const w of writes) merged[w.id] = { ...(merged[w.id] || { id: w.id }), ...w.fields };
    }
    B.items = new Map(Object.entries(merged));
    render();
  }

  function flashWho(id, name) {
    setTimeout(() => {
      const node = B.els.get(id);
      if (!node) return;
      const w = node.querySelector('.who');
      w.textContent = name;
      w.style.transform = `scale(${1 / B.view.s})`;
      w.style.top = -22 / B.view.s + 'px';
      w.classList.add('show');
      clearTimeout(w._t);
      w._t = setTimeout(() => w.classList.remove('show'), 2500);
    }, 0);
  }

  // ---------- context menu ----------
  function contextMenu(x, y) {
    if (!B.project) return;
    const hit = itemAt(x, y);
    if (hit && !B.sel.has(hit)) { B.sel = new Set([hit]); renderOverlay(); }
    const ids = selIds();
    const one = ids.length === 1 ? B.items.get(ids[0]) : null;
    const at = toWorld(x, y);
    const ed = !B.readOnly;
    const items = [];
    if (one && one.type === 'video') {
      const v = videoEl(one.id);
      items.push(
        { label: v && !v.paused ? 'Pause' : 'Play', key: 'K', onClick: () => togglePlay(one.id) },
        { label: 'Grab frame', key: 'F', onClick: grabFrame, disabled: !ed },
        { label: 'Set start here', key: 'I', onClick: () => setInOut('in'), disabled: !ed },
        { label: 'Set end here', key: 'O', onClick: () => setInOut('out'), disabled: !ed },
        { label: 'Loop', checked: one.loop !== false, onClick: toggleLoop, disabled: !ed },
        { label: v && !v.muted ? 'Mute' : 'Play sound', key: 'M', onClick: toggleMute },
        '-');
    }
    if (one && one.type === 'note') items.push({ label: 'Edit note', key: 'Enter', onClick: () => editNote(one.id), disabled: !ed }, '-');
    if (ids.length) {
      items.push(
        { label: 'Grayscale', key: 'Alt+G', checked: ids.every((id) => B.items.get(id).gray), onClick: () => toggleField('gray'), disabled: !ed },
        { label: 'Flip horizontal', key: 'Alt+Shift+H', onClick: () => toggleField('flipX'), disabled: !ed },
        { label: 'Flip vertical', key: 'Alt+Shift+V', onClick: () => toggleField('flipY'), disabled: !ed },
        { label: 'Reset cropping', key: 'Mod+Shift+C', onClick: resetCrop, disabled: !ed },
        { label: 'Reset transform', key: 'Mod+Shift+T', onClick: resetTransform, disabled: !ed },
        { label: 'Locked', key: 'Alt+L', checked: ids.every((id) => B.items.get(id).locked), onClick: () => toggleField('locked'), disabled: !ed },
        '-',
        { label: 'Bring to front', key: '↑', onClick: front, disabled: !ed },
        { label: 'Send to back', key: '↓', onClick: back, disabled: !ed },
        { label: 'Duplicate', onClick: duplicate, disabled: !ed },
        { label: 'Copy', key: 'Mod+C', onClick: () => copySelection(false) },
        { label: 'Delete', key: 'Del', onClick: deleteSelection, disabled: !ed },
        '-');
    } else {
      items.push(
        { label: 'Add images and videos', key: 'Mod+I', onClick: async () => addPaths(await api.openImagesDialog(), at), disabled: !ed },
        { label: 'Import a folder of images', onClick: async () => addPaths(await api.importFolderDialog(), at), disabled: !ed },
        { label: 'New note', key: 'Mod+N', onClick: () => addNote(at), disabled: !ed },
        { label: 'Paste', key: 'Mod+V', onClick: () => pasteNative(at), disabled: !ed },
        '-');
    }
    items.push(
      { label: 'Arrange optimal', key: 'Mod+P', onClick: arrange, disabled: !ed },
      { label: `Bin (${binItems().length})`, onClick: () => B.onChange('bin') },
      '-');
    for (const x of B.extraMenu ? B.extraMenu() : []) items.push(x);
    openMenu(items, x, y);
  }

  // ---------- load / unload ----------
  function load(p) {
    unconfirmed.clear();
    unload();
    B.project = p.record;
    B.mediaBase = p.mediaBase;
    B.readOnly = !!p.readOnly;
    B.items = new Map(Object.entries(p.items || {}));
    B.undoStack = []; B.redoStack = [];
    let v = null;
    try { v = JSON.parse(localStorage.getItem('view:' + p.record.id) || 'null'); } catch (_) {}
    render();
    if (v && isFinite(v.s)) { B.view = v; applyView(); }
    else if (live().length) focusAll();
    else { B.view = { x: window.innerWidth / 2, y: window.innerHeight / 2, s: 1 }; applyView(); }
  }

  function unload() {
    for (const node of B.els.values()) { const vv = node.querySelector('video'); if (vv) { vv.pause(); vv.removeAttribute('src'); vv.load(); } node.remove(); }
    B.els.clear(); B.items.clear(); B.sel.clear();
    B.project = null; B.editingId = null; B.gesture = null;
    overlay.innerHTML = ''; vbar.hidden = true;
  }

  function setTool(t) {
    B.tool = t;
    canvas.classList.toggle('tool-hand', t === 'hand');
    canvas.classList.toggle('tool-pen', t === 'pen');
    canvas.classList.toggle('tool-eraser', t === 'eraser');
    if (t === 'pen' || t === 'eraser') clearSel();
    B.onChange('tool');
  }
  function setGrid(on) { B.grid = on; canvas.classList.toggle('grid', on); }
  function setGrayCanvas(on) { B.grayCanvas = on; world.classList.toggle('gray', on); }
  function setLockedCanvas(on) { B.lockedCanvas = on; B.onChange('lock'); }

  function binItems() { return [...B.items.values()].filter((it) => it.deleted && it.type).sort((a, b) => (b._t || 0) - (a._t || 0)); }
  function restore(ids) { commit(ids.map((id) => ({ id, fields: { deleted: false } }))); B.sel = new Set(ids); renderOverlay(); }

  Object.assign(B, {
    load, unload, applyRemote, render, applyView, zoomAt, fitRect, toWorld, toScreen,
    commit, undo, redo, addPaths, addBytes, addUrl, addNote, editNote, stopEditing,
    copySelection, pasteInternal, pasteNative, pasteKey, deleteSelection, duplicate, toggleField, resetCrop, resetTransform, front, back,
    align, normalize, arrange, focusSelection, focusAll, focusStep, selectAll, clearSel, selIds,
    togglePlay, setInOut, toggleLoop, cycleSpeed, toggleMute, step, grabFrame, activeVideoId,
    setTool, setGrid, setGrayCanvas, setLockedCanvas, binItems, restore, mediaUrl, contextMenu, live,
  });
  window.Board = B;
})();
