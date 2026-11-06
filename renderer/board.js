// The canvas: items, selection, gestures, video playback, undo.
(function () {
  const { $, el, toast, openMenu, IS_MAC, fmtTime, modalOpen, menuOpen, initials } = window.UI;
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
    pen: { color: '#D7F04A', size: 4, style: 'solid', op: 1 },
  };

  // ---------- geometry ----------
  const toScreen = (x, y) => ({ x: x * B.view.s + B.view.x, y: y * B.view.s + B.view.y });
  const toWorld = (sx, sy) => ({ x: (sx - B.view.x) / B.view.s, y: (sy - B.view.y) / B.view.s });

  function dims(it) {
    if (it.type === 'section') return { w: it.w, h: it.h || 400, k: 1 };
    if (it.type === 'note') {
      const e = B.els.get(it.id);
      const h = e ? e.offsetHeight : (it.fs || 16) * 3;
      // Typed text is as wide as its words
      const w = it.plain && e && e.offsetWidth ? e.offsetWidth : it.w;
      return { w, h: h || (it.fs || 16) * 3, k: 1 };
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

  // Comments live beside the board, not on it, so they're left out here
  const live = () => [...B.items.values()].filter((it) => !it.deleted && it.type && it.type !== 'comment');
  const comments = () => [...B.items.values()].filter((it) => !it.deleted && it.type === 'comment');
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
    const failed = () => { unconfirmed.delete(writes); toast("Couldn't save that change.", true); };
    api.write(B.project.id, writes).then((r) => {
      if (r && r.readOnly) { unconfirmed.delete(writes); B.readOnly = true; B.onChange('readonly'); return; }
      if (r && r.error) return failed();
      unconfirmed.delete(writes);
    }, failed);
  }

  // changes: [{ id, fields }]; before: optional snapshot taken at gesture start
  function commit(changes, before, opts) {
    if (!changes.length || !canEdit()) return;
    changes = changes.map((c) => ({ id: c.id, fields: { ...c.fields } }));
    const prev = (before || changes.map((c) => ({ id: c.id, fields: pick(B.items.get(c.id), Object.keys(c.fields)) }))).map((p) => ({ id: p.id, fields: { ...p.fields } }));
    if (!(opts && opts.exact)) addFollowers(changes, prev);
    applyLocal(changes);
    send(changes);
    B.undoStack.push({ before: prev, after: clone(changes) });
    if (B.undoStack.length > 300) B.undoStack.shift();
    B.redoStack = [];
    render();
  }

  function undo() {
    if (!B.undoStack.length || !canEdit()) return;
    const e = B.undoStack.pop();
    applyLocal(e.before); send(e.before); B.redoStack.push(e); render();
  }
  function redo() {
    if (!B.redoStack.length || !canEdit()) return;
    const e = B.redoStack.pop();
    applyLocal(e.after); send(e.after); B.undoStack.push(e); render();
  }

  // ---------- rendering ----------
  function makeEl(it) {
    const node = el('div', { class: 'item', 'data-id': it.id });
    if (it.type === 'section') {
      node.classList.add('section');
      const label = el('div', { class: 'section-label' });
      label.addEventListener('dblclick', (e) => { e.stopPropagation(); editSectionTitle(it.id); });
      node.append(label);
    } else if (it.type === 'note') {
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
      } else if (it.type === 'pdf') {
        node.classList.add('pdf');
        clip.append(el('canvas', { class: 'media' }));
        node.append(clip);
      } else if (it.type === 'file') {
        node.classList.add('filecard');
        clip.append(el('div', { class: 'media file-card' }));
        node.append(clip);
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

  // mz: the lowest z on the board, worked out once per render or gesture frame
  function updateEl(node, it, mz) {
    if (!node) return;
    node.style.zIndex = String(Math.round((it.z || 0) - (mz === undefined ? minZ() : mz) + 1));
    node.classList.toggle('gray', !!it.gray);
    if (it.type === 'section') {
      node.style.width = it.w + 'px';
      node.style.height = (it.h || 400) + 'px';
      node.style.transform = `translate(${it.x}px, ${it.y}px)`;
      const label = node.firstChild;
      if (B.sectionEditing !== it.id && label.textContent !== (it.title || 'Section')) label.textContent = it.title || 'Section';
      return;
    }
    if (it.type === 'note') {
      node.style.width = it.plain ? 'max-content' : it.w + 'px';
      node.style.height = '';
      node.style.fontSize = (it.fs || 16) + 'px';
      node.classList.toggle('plain', !!it.plain);
      const t = node.firstChild;
      t.style.color = it.plain ? (it.color || '#D7F04A') : '';
      const fade = it.op != null && it.op < 1 ? String(it.op) : '';
      t.style.opacity = it.plain ? fade : '';
      node.style.opacity = it.plain ? '' : fade;
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
    // Each picture can be faded on its own; lines carry it on the stroke instead
    clip.style.opacity = it.type !== 'draw' && it.op != null && it.op < 1 ? String(it.op) : '';
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
        path.setAttribute('stroke-opacity', it.op == null ? 1 : it.op);
        if (it.style === 'dotted') path.setAttribute('stroke-dasharray', `0 ${(it.sw || 4) * 2}`); else path.removeAttribute('stroke-dasharray');
        return;
      }
      if (it.type === 'pdf') { queuePdf(it.id); return; }
      if (it.type === 'file') { fillCard(m, it); return; }
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

  // Files that are on disk but can't be decoded. Retrying them never helps.
  const undecodable = new Set();
  const decodeKey = (it) => it.id + '|' + it.src;
  async function markMissing(id) {
    const it = B.items.get(id);
    const node = B.els.get(id);
    if (!B.project || !it || !node || node.classList.contains('missing')) return;
    const pid = B.project.id;
    const state = await api.mediaState(pid, it.src);
    if (!B.project || B.project.id !== pid || B.els.get(id) !== node) return;
    if (state === 'here') undecodable.add(decodeKey(it));
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
      if (it && undecodable.has(decodeKey(it))) continue;
      if (!it || !B.project || (await api.mediaState(B.project.id, it.src)) !== 'here') { if (it && B.project) { node.classList.remove('missing'); markMissing(id); } continue; }
      node.classList.remove('missing');
      const m = node.querySelector('.media');
      const lab = node.querySelector('.missing-label');
      if (lab) lab.remove();
      if (m) { m.style.display = ''; m.dataset.src = ''; }
      if (B.els.get(id) === node) updateEl(node, it);
    }
  }, 4000);

  function render() {
    document.body.classList.toggle('board-empty', !live().length);
    const seen = new Set();
    const mz = minZ();
    for (const it of B.items.values()) {
      if (it.deleted || !it.type || it.type === 'comment') continue;
      seen.add(it.id);
      const node = B.els.get(it.id) || makeEl(it);
      updateEl(node, it, mz);
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
    renderPins();
    B.onChange('items');
  }

  function renderOverlay() {
    if (B.onSel) B.onSel();
    overlay.innerHTML = '';
    const ids = [...B.sel].filter((id) => B.items.get(id) && !B.items.get(id).deleted);
    // Crop mode ends when the picture is no longer the only thing selected
    if (B.cropMode && (ids.length !== 1 || ids[0] !== B.cropMode)) B.cropMode = null;
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
    // Corner handles resize; just outside each corner, grab to rotate (like PureRef)
    const turnable = (list) => list.some((id) => { const t = B.items.get(id); return t && t.type !== 'section' && !t.locked; });
    const handles = (b, list) => {
      if (B.readOnly) return;
      for (const k of ['nw', 'ne', 'sw', 'se']) {
        if (turnable(list)) b.append(el('div', { class: 'r ' + k, 'data-r': k }));
        b.append(el('div', { class: 'h ' + k, 'data-h': k }));
      }
    };
    // Crop mode: handles on every edge and corner crop the picture instead
    if (ids.length === 1 && B.cropMode === ids[0]) {
      const b = box(B.items.get(ids[0]), false);
      b.classList.add('cropping');
      for (const k of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) b.append(el('div', { class: 'ch ' + k, 'data-c': k }));
      overlay.append(b);
    } else if (ids.length === 1) {
      const one = B.items.get(ids[0]);
      const b = box(one, false);
      handles(b, ids);
      overlay.append(b);
      if (one.type === 'pdf' && (one.pages || 1) > 1) {
        // Page arrows under the PDF, at screen size
        const d = dims(one);
        const c = toScreen(one.x + d.w / 2, one.y + d.h / 2);
        const r = (Math.abs(Math.sin(((one.rot || 0) * Math.PI) / 180)) * d.w + Math.abs(Math.cos(((one.rot || 0) * Math.PI) / 180)) * d.h) * B.view.s / 2;
        const n = one.page || 1, total = one.pages || 1;
        const prev = el('button', { class: 'pg-btn', 'data-pg': '-1', title: 'Previous page', html: ICONS.chev, disabled: n <= 1 || B.readOnly });
        const next = el('button', { class: 'pg-btn', 'data-pg': '1', title: 'Next page', html: ICONS.chev, disabled: n >= total || B.readOnly });
        const bar = el('div', { class: 'pdf-pages' }, prev, el('span', { class: 'pg-n', text: `${n} / ${total}` }), next);
        // Always reachable: on screen and clear of the toolbar, even when the page fills the view
        bar.style.left = Math.max(80, Math.min(innerWidth - 80, c.x)) + 'px';
        bar.style.top = Math.max(70, Math.min(innerHeight - 110, c.y + r + 14)) + 'px';
        for (const btn of [prev, next]) btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); if (!btn.disabled) setPdfPage(one.id, n + Number(btn.dataset.pg)); });
        overlay.append(bar);
      }
    } else {
      for (const id of ids) overlay.append(box(B.items.get(id), true));
      const bb = bbox(ids);
      const a = toScreen(bb.x, bb.y);
      const g = el('div', { class: 'sel' });
      Object.assign(g.style, { left: a.x + 'px', top: a.y + 'px', width: bb.w * s + 'px', height: bb.h * s + 'px' });
      handles(g, ids);
      overlay.append(g);
    }
    syncVideoBar();
  }

  let viewTimer = null;
  function applyView() {
    const v = B.view;
    world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    // Section labels and outlines stay the same size on screen at any zoom
    world.style.setProperty('--ls', String(1 / Math.max(0.02, v.s)));
    canvas.style.backgroundSize = `${28 * v.s}px ${28 * v.s}px`;
    canvas.style.backgroundPosition = `${v.x}px ${v.y}px`;
    $('#zVal').textContent = Math.round(v.s * 100) + '%';
    if (B.onView) B.onView(v);
    placeThread();
    renderOverlay();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      pauseOffscreen();
      refreshPdfs();
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
    if (b.contains('ui-hidden') || (b.contains('ui-auto') && !b.contains('board-empty'))) return { left: 16, top: 16, right: window.innerWidth - 16, bottom: window.innerHeight - 16 };
    const side = b.contains('has-sidebar') && window.innerWidth > 760 ? 304 : 16; // small windows hide the sidebar
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
  // ---------- lines stick to the picture they're drawn on ----------
  // A picture's whole content frame (centre, width, turn, flips), so cropping
  // never shifts a line drawn on it.
  function frameOf(it) {
    const d = dims(it);
    const c = { ...ZC, ...(it.crop || {}) };
    const W = it.type === 'note' || !it.nw ? d.w : it.nw * d.k;
    const H = it.type === 'note' || !it.nh ? d.h : it.nh * d.k;
    const fx = it.flipX ? -1 : 1, fy = it.flipY ? -1 : 1;
    const ox = fx * (W / 2 - c.l * W - d.w / 2), oy = fy * (H / 2 - c.t * H - d.h / 2);
    const rot = it.rot || 0, a = (rot * Math.PI) / 180;
    return { cx: it.x + d.w / 2 + ox * Math.cos(a) - oy * Math.sin(a), cy: it.y + d.h / 2 + ox * Math.sin(a) + oy * Math.cos(a), W: Math.max(1, W), a, rot, fx, fy };
  }
  // Where a line goes when its picture changes from hOld to hNew
  function followFields(hOld, hNew, st) {
    const F0 = frameOf(hOld), F1 = frameOf(hNew);
    const sd = dims(st);
    const dx = st.x + sd.w / 2 - F0.cx, dy = st.y + sd.h / 2 - F0.cy;
    const u = ((dx * Math.cos(F0.a) + dy * Math.sin(F0.a)) / F0.W) * F0.fx;
    const v = ((-dx * Math.sin(F0.a) + dy * Math.cos(F0.a)) / F0.W) * F0.fy;
    const lx = u * F1.W * F1.fx, ly = v * F1.W * F1.fy;
    const cx = F1.cx + lx * Math.cos(F1.a) - ly * Math.sin(F1.a), cy = F1.cy + lx * Math.sin(F1.a) + ly * Math.cos(F1.a);
    const k = F1.W / F0.W;
    const rc = ((st.rot || 0) - F0.rot) * F0.fx * F0.fy;
    const rot = (((F1.rot + rc * F1.fx * F1.fy) % 360) + 360) % 360;
    const w = st.w * k, h = sd.h * k;
    const out = { x: cx - w / 2, y: cy - h / 2, w, rot };
    const fxc = !!st.flipX !== (F0.fx < 0), fyc = !!st.flipY !== (F0.fy < 0);
    const nfx = fxc !== (F1.fx < 0), nfy = fyc !== (F1.fy < 0);
    if (nfx !== !!st.flipX) out.flipX = nfx;
    if (nfy !== !!st.flipY) out.flipY = nfy;
    return out;
  }
  // The picture a line was drawn on: the selected one if it touches it, otherwise
  // the top one covering at least half of the line
  function hostForBox(box, keep) {
    const area = Math.max(1, box.w * box.h);
    let best = null, bestZ = -Infinity;
    const cover = (it) => { const r = bbox([it.id]); if (!r) return 0; const ix = Math.max(0, Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x)); const iy = Math.max(0, Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y)); return (ix * iy) / area; };
    const k = keep && B.items.get(keep);
    if (k && !k.deleted && cover(k) >= 0.5) return keep;
    for (const it of live()) {
      if (it.type === 'draw' || it.plain || it.type === 'section') continue;
      const r = bbox([it.id]);
      if (!r) continue;
      const ix = Math.max(0, Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x));
      const iy = Math.max(0, Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y));
      const share = (ix * iy) / area;
      if (B.sel.has(it.id) && share > 0) return it.id;
      if (share >= 0.5 && (it.z || 0) > bestZ) { best = it.id; bestZ = it.z || 0; }
    }
    return best;
  }
  // Lines from before 1.0.10, or from a teammate on an older version, were never
  // linked to a picture. Link each one to the picture it sits on, once.
  function adoptLines() {
    if (!canEdit()) return;
    const ch = [];
    for (const it of live()) {
      if (it.type !== 'draw' || 'on' in it) continue;
      const d = dims(it);
      ch.push({ id: it.id, fields: { on: hostForBox({ x: it.x, y: it.y, w: d.w, h: d.h }) || null } });
    }
    if (ch.length) { applyLocal(ch); send(ch); }
  }
  const followBase = new Map(); // line id -> where it was when a gesture began
  const GEO = ['x', 'y', 'w', 'rot', 'flipX', 'flipY', 'crop', 'fs'];
  // Any change to a picture carries the lines on it along, in the same undo step
  function addFollowers(changes, prev) {
    const ids = new Set(changes.map((c) => c.id));
    const strokes = [...B.items.values()].filter((it) => it.on && (it.type === 'draw' || it.plain));
    const add = (id, fields, old) => {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      const ex = changes.find((c) => c.id === id);
      if (ex) { Object.assign(ex.fields, fields); const pb = prev.find((p) => p.id === id); if (pb) for (const k of keys) if (!(k in pb.fields)) pb.fields[k] = pick(old, [k])[k]; return; }
      changes.push({ id, fields });
      prev.push({ id, fields: pick(old, keys) });
    };
    for (const c of [...changes]) {
      const host = B.items.get(c.id);
      if (!host) continue;
      const f = c.fields;
      if (host.type === 'draw' || host.plain) {
        // A line moved on its own comes loose, or sticks to the picture it lands on
        if (('x' in f || 'y' in f) && !(host.on && ids.has(host.on))) {
          const n = { ...host, ...f }, d = dims(n);
          const on = hostForBox({ x: n.x, y: n.y, w: d.w, h: d.h }, host.on) || null;
          if (on !== (host.on || null)) add(c.id, { on }, followBase.get(c.id) || host);
        }
        continue;
      }
      const geo = GEO.some((k) => k in f), del = 'deleted' in f;
      if (!geo && !del) continue;
      const pb = prev.find((p) => p.id === c.id);
      const hOld = { ...host, ...(pb ? pb.fields : {}) }, hNew = { ...host, ...f };
      for (const st of strokes) {
        if (st.on !== c.id || ids.has(st.id)) continue;
        const old = followBase.get(st.id) || st;
        const fields = {};
        if (geo && !old.deleted) Object.assign(fields, followFields(hOld, hNew, old));
        if (del && f.deleted && !old.deleted) { fields.deleted = true; fields.delWith = c.id; }
        if (del && !f.deleted && old.deleted && old.delWith === c.id) { fields.deleted = false; fields.delWith = null; }
        add(st.id, fields, old);
      }
    }
  }
  // While a picture is dragged, scaled or turned, its lines move with it live
  function followLive(g, mz) {
    if (!g.fol) {
      const hosts = Array.isArray(g.ids) ? g.ids : g.ids instanceof Set ? [...g.ids] : g.id ? [g.id] : [];
      const moving = new Set(hosts);
      g.fol = [];
      for (const hid of hosts) {
        const h = B.items.get(hid);
        if (!h || h.type === 'draw' || h.plain) continue;
        const pb = (g.before || []).find((p) => p.id === hid);
        const h0 = { ...clone(h), ...(pb ? clone(pb.fields) : {}) };
        const st = live().filter((x) => (x.type === 'draw' || x.plain) && x.on === hid && !moving.has(x.id)).map((x) => ({ id: x.id, s0: clone(x) }));
        if (st.length) g.fol.push({ hid, h0, st });
      }
    }
    for (const f of g.fol) {
      const h = B.items.get(f.hid);
      for (const { id, s0 } of f.st) {
        followBase.set(id, s0);
        const it = B.items.get(id);
        Object.assign(it, followFields(f.h0, h, s0));
        const node = B.els.get(id);
        if (node) updateEl(node, it, mz);
      }
    }
  }

  function snapshot(ids, keys) {
    return ids.map((id) => ({ id, fields: pick(B.items.get(id), keys) }));
  }

  function startGesture(g, e) {
    B.gesture = g;
    g.sx0 = e.clientX; g.sy0 = e.clientY;
    g.w0 = toWorld(e.clientX, e.clientY);
    g.moved = false;
    g.pointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }

  // Middle click always moves the board: selected or not, over anything,
  // even while typing. It runs first so nothing on the board can swallow it.
  const startMiddlePan = (e) => {
    if (B.editingId) stopEditing();
    startGesture({ type: 'pan', mid: true, v0: { ...B.view } }, e);
    canvas.classList.add('panning');
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!B.project || e.button !== 1) return;
    e.preventDefault(); e.stopPropagation();
    if (B.gesture) { if (B.gesture.type === 'right') B.gesture.moved = true; endGesture(e); }
    startMiddlePan(e);
  }, true);
  // Windows would start its own scrolling on a middle press
  canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }, true);

  canvas.addEventListener('pointerdown', (e) => {
    if (!B.project) return;
    if (e.target.closest('.note-text[contenteditable]')) return;
    // A click that only finishes typing shouldn't start a new text box
    const wasTyping = !!B.editingId || Date.now() - lastStopAt < 400;
    if (B.editingId) stopEditing();
    canvas.focus({ preventScroll: true });
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    let button = e.button;
    if (IS_MAC && e.ctrlKey && button === 0) button = 2;

    if (button === 2) { startGesture({ type: 'right', lastX: e.screenX, lastY: e.screenY, screen0: { x: e.screenX, y: e.screenY } }, e); return; }
    if (button !== 0) return;

    const handle = e.target.closest && e.target.closest('#overlay .h');
    const turn = e.target.closest && e.target.closest('#overlay .r');
    const cropH = e.target.closest && e.target.closest('#overlay .ch');
    const unlocked = (ids) => ids.filter((id) => B.items.get(id) && !B.items.get(id).locked);
    // Just outside a corner: turn the selection. Shift for 45° steps, Shift+Alt
    // turns each piece around its own centre.
    if (turn && canEdit(true)) {
      const ids = noSections(unlocked([...B.sel]));
      if (!ids.length) return;
      const bb = bbox(ids);
      startGesture({ type: 'rotate', ids, own: e.shiftKey && e.altKey, start: ids.map((id) => clone(B.items.get(id))), before: snapshot(ids, ['rot', 'x', 'y']), c: { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } }, e);
      return;
    }
    // Crop mode handles: drag an edge or corner to crop. Shift keeps the shape,
    // Shift+Alt makes it square.
    if (cropH && canEdit(true) && B.cropMode && B.items.get(B.cropMode)) {
      const it = B.items.get(B.cropMode);
      const k = cropH.dataset.c;
      // The handle is on screen; the crop edge is in the picture, which may be flipped
      const edges = { l: k.includes('w'), r: k.includes('e'), t: k.includes('n'), b: k.includes('s') };
      if (it.flipX) [edges.l, edges.r] = [edges.r, edges.l];
      if (it.flipY) [edges.t, edges.b] = [edges.b, edges.t];
      startGesture({ type: 'crop', id: it.id, edges, gizmo: true, start: clone(it), before: snapshot([it.id], ['x', 'y', 'w', 'crop']) }, e);
      return;
    }
    if (handle && canEdit(true)) {
      let ids = unlocked([...B.sel]);
      // A section only resizes on its own; with other pieces it stays as it is
      if (ids.length > 1) ids = noSections(ids);
      if (!ids.length) return;
      startGesture({ type: 'resize', corner: handle.dataset.h, ids, before: snapshot(ids, ['x', 'y', 'w', 'h', 'fs']), start: ids.map((id) => clone(B.items.get(id))), bb: bbox(ids) }, e);
      return;
    }
    const hit = itemAt(e.clientX, e.clientY);
    // A locked canvas only stops moving pieces; drawing, typing and comments still work
    const drawingTool = ['pen', 'eraser', 'text', 'comment'].includes(B.tool);
    if (B.tool === 'hand' || (B.lockedCanvas && !drawingTool) || (e.altKey && !mod && !e.shiftKey) || (B.held.has(' ') && !hit)) {
      startGesture({ type: 'pan', v0: { ...B.view } }, e); canvas.classList.add('panning'); return;
    }
    if (B.tool === 'comment' && !B.held.has('z')) {
      e.preventDefault();
      if (!canEdit()) return;
      const hit = itemAt(e.clientX, e.clientY);
      const host = hit && B.items.get(hit);
      startComment(host && host.type !== 'section' ? host : null, toWorld(e.clientX, e.clientY));
      return;
    }
    if (B.tool === 'text' && !B.held.has('z')) {
      if (!canEdit()) return;
      e.preventDefault();
      const id = itemAt(e.clientX, e.clientY);
      const it = id && B.items.get(id);
      if (it && it.plain) editNote(id);
      else if (wasTyping) return; else addText(toWorld(e.clientX, e.clientY));
      return;
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
      // Thickness belongs to the board, like ink on paper, so lines always match the
      // pictures at any zoom. Never thinner than one screen pixel while drawing.
      const sw = Math.max(B.pen.size, 1 / B.view.s);
      path.setAttribute('fill', 'none'); path.setAttribute('stroke', B.pen.color); path.setAttribute('stroke-width', sw);
      path.setAttribute('stroke-opacity', B.pen.op == null ? 1 : B.pen.op);
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
      const croppable = hitItem.type !== 'note' && hitItem.type !== 'draw' && hitItem.type !== 'section' && hitItem.type !== 'file' && !hitItem.locked;
      // Shift+V and drag left or right: zoom the picture inside its crop
      if (B.held.has('v') && e.shiftKey && croppable && canEdit()) {
        B.sel = new Set([hit]);
        startGesture({ type: 'cropzoom', id: hit, start: clone(hitItem), before: snapshot([hit], ['crop']) }, e);
        renderOverlay(); return;
      }
      if ((B.held.has('c') || B.held.has('v')) && croppable && canEdit()) {
        B.sel = new Set([hit]);
        startGesture({ type: 'crop', id: hit, pan: B.held.has('v'), start: clone(hitItem), before: snapshot([hit], ['x', 'y', 'w', 'crop']) }, e);
        renderOverlay(); return;
      }
      const snapMove = e.shiftKey && B.held.has(' ');
      if (!B.sel.has(hit)) { if (!e.shiftKey || snapMove) B.sel.clear(); B.sel.add(hit); }
      else if (e.shiftKey && !mod && !snapMove) { B.sel.delete(hit); renderOverlay(); return; }
      const ids = [...B.sel];
      const all = unlocked(ids);
      // Turning, scaling and flipping are for pictures; a section only moves and resizes
      const free = noSections(all);
      // Cmd/Ctrl+Alt+Shift and drag left or right: opacity
      if (mod && e.altKey && e.shiftKey && canEdit()) {
        const fade = all.filter((id) => B.items.get(id).type !== 'section');
        if (fade.length) startGesture({ type: 'opacity', ids: fade, start: fade.map((id) => ({ id, op: B.items.get(id).op == null ? 1 : B.items.get(id).op })), before: snapshot(fade, ['op']) }, e);
        renderOverlay(); return;
      }
      if (mod && e.altKey && canEdit()) { if (free.length) startGesture({ type: 'scale', ids: free, start: free.map((id) => clone(B.items.get(id))), before: snapshot(free, ['x', 'y', 'w', 'fs']), bb: bbox(free) }, e); renderOverlay(); return; }
      if (mod && canEdit()) {
        // One turn for the whole selection, around the centre of its box
        if (free.length) { const bb = bbox(free); startGesture({ type: 'rotate', ids: free, start: free.map((id) => clone(B.items.get(id))), before: snapshot(free, ['rot', 'x', 'y']), c: { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 } }, e); }
        renderOverlay(); return;
      }
      if (e.altKey && e.shiftKey && canEdit()) { if (free.length) startGesture({ type: 'flip', ids: free }, e); renderOverlay(); return; }
      // View only boards still select, they just don't move
      const movable = B.readOnly ? [] : withSectionContents(all);
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
    // The release can get lost (a menu opened, the window moved under the pointer):
    // if no button is held any more, the drag is over
    if (g && e.buttons === 0 && e.pointerType === 'mouse') { if (g.type === 'right') g.moved = true; endGesture(e); return; }
    // A middle press while another button still counts as held only shows up
    // as a move. Treat it as a middle click: stop what was going on and pan.
    if (B.project && e.pointerType === 'mouse' && (e.buttons & 4) && !(g && g.mid)) {
      if (g) { if (g.type === 'right') g.moved = true; endGesture(e); }
      startMiddlePan(e);
      return;
    }
    // ...and letting go of the middle button ends that pan
    if (g && g.mid && e.pointerType === 'mouse' && !(e.buttons & 4)) { endGesture(e); return; }
    if (!g) {
      const id = itemAt(e.clientX, e.clientY);
      B.hoverId = id;
      return;
    }
    const dxS = e.clientX - g.sx0, dyS = e.clientY - g.sy0;
    if (g.type === 'draw') {
      let p = toWorld(e.clientX, e.clientY);
      // Hold Shift for a straight line from where Shift went down. It snaps to
      // flat, upright and diagonal when close. Let go of Shift to carry on freehand.
      if (e.shiftKey) {
        if (g.anchor == null) g.anchor = g.pts.length - 1;
        const a = g.pts[g.anchor];
        const ang = Math.atan2(p.y - a.y, p.x - a.x), len = Math.hypot(p.x - a.x, p.y - a.y);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        if (Math.abs(ang - snap) < (5 * Math.PI) / 180) p = { x: a.x + Math.cos(snap) * len, y: a.y + Math.sin(snap) * len };
        g.pts.length = g.anchor + 1;
        if (len * B.view.s >= 1.5) { g.pts.push(p); g.moved = true; }
        g.path.setAttribute('d', strokePath(g.pts, B.pen.style === 'arrow' ? g.sw : 0));
        return;
      }
      if (g.anchor != null) g.anchor = null;
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
    const mz = ['move', 'resize', 'scale', 'rotate', 'crop', 'cropzoom', 'opacity'].includes(g.type) ? minZ() : 0;

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
        if (e.shiftKey && B.held.has(' ')) {
          // Shift+Space: line up with the edges of nearby pieces
          if (!g.snap) {
            const mine = new Set(g.ids);
            const xs = [], ys = [];
            for (const o of live()) { if (mine.has(o.id)) continue; const b = bbox([o.id]); xs.push(b.x, b.x + b.w, b.x + b.w / 2); ys.push(b.y, b.y + b.h, b.y + b.h / 2); }
            g.snap = { xs, ys, bb: bbox(g.ids) };
          }
          const thr = 8 / B.view.s, bb = g.snap.bb;
          const near = (mine, list, d) => { let best = null; for (const m of mine) for (const o of list) { const k = o - (m + d); if (Math.abs(k) < thr && (best === null || Math.abs(k) < Math.abs(best))) best = k; } return best; };
          const sx = near([bb.x, bb.x + bb.w, bb.x + bb.w / 2], g.snap.xs, mx); if (sx !== null) mx += sx;
          const sy = near([bb.y, bb.y + bb.h, bb.y + bb.h / 2], g.snap.ys, my); if (sy !== null) my += sy;
        } else if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; }
        for (const s of g.start) { const it = B.items.get(s.id); it.x = s.x + mx; it.y = s.y + my; updateEl(B.els.get(s.id), it, mz); }
        renderOverlay();
        break;
      }
      case 'resize': {
        const bb = g.bb;
        const ax = g.corner.includes('w') ? bb.x + bb.w : bb.x;
        const ay = g.corner.includes('n') ? bb.y + bb.h : bb.y;
        let f;
        if (g.ids.length === 1 && g.start[0].type === 'section') {
          // A section's frame resizes freely; what's in it stays as it is
          const it = B.items.get(g.ids[0]);
          const minS = 80;
          const x0 = Math.min(ax, p.x), y0 = Math.min(ay, p.y);
          it.w = Math.max(minS, Math.abs(p.x - ax)); it.h = Math.max(minS, Math.abs(p.y - ay));
          it.x = p.x < ax ? Math.min(x0, ax - minS) : ax; it.y = p.y < ay ? Math.min(y0, ay - minS) : ay;
          updateEl(B.els.get(it.id), it, mz);
          renderOverlay();
          break;
        }
        if (e.altKey && g.start[0].type !== 'section') {
          // Alt: grow from the centre. Shift+Alt: each piece from its own centre.
          const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
          f = Math.max(0.01, Math.max(Math.abs(p.x - cx) / Math.max(1, bb.w / 2), Math.abs(p.y - cy) / Math.max(1, bb.h / 2)));
          const own = e.shiftKey;
          g.start.forEach((s0) => {
            const it = B.items.get(s0.id);
            const d0 = dims(s0);
            it.w = Math.max(MIN_SIZE, s0.w * f);
            if (s0.fs) it.fs = Math.max(4, s0.fs * f);
            const k = it.w / s0.w;
            const ox = s0.x + d0.w / 2, oy = s0.y + d0.h / 2;
            const nx = own ? ox : cx + (ox - cx) * k, ny = own ? oy : cy + (oy - cy) * k;
            it.x = nx - (d0.w * k) / 2; it.y = ny - (d0.h * k) / 2;
            updateEl(B.els.get(s0.id), it, mz);
          });
        } else if (g.ids.length === 1 && (g.start[0].rot || 0) % 360 !== 0) {
          const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
          f = Math.hypot(p.x - cx, p.y - cy) / Math.max(1, Math.hypot(g.w0.x - cx, g.w0.y - cy));
          g.start.forEach((s0) => { const it = B.items.get(s0.id); const d0 = dims(s0); it.w = Math.max(MIN_SIZE, s0.w * f); if (s0.fs) it.fs = s0.fs * f; it.x = cx - (d0.w * f) / 2; it.y = cy - (d0.h * f) / 2; updateEl(B.els.get(s0.id), it, mz); });
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
            updateEl(B.els.get(s0.id), it, mz);
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
          updateEl(B.els.get(s0.id), it, mz);
        });
        renderOverlay();
        break;
      }
      case 'rotate': {
        const G = g.c;
        const a0 = Math.atan2(g.w0.y - G.y, g.w0.x - G.x), a1 = Math.atan2(p.y - G.y, p.x - G.x);
        let delta = ((a1 - a0) * 180) / Math.PI;
        // Shift+Alt on the gizmo: each piece turns around its own centre
        const own = g.own || (g.ids.length > 1 && e.shiftKey && e.altKey);
        if (e.shiftKey && !own) {
          // 45° steps, like PureRef. One item snaps its own angle, a group snaps the turn.
          if (g.start.length === 1) { const r0 = g.start[0].rot || 0; delta = Math.round((r0 + delta) / 45) * 45 - r0; }
          else delta = Math.round(delta / 45) * 45;
        }
        const rad = (delta * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        g.start.forEach((s0) => {
          const it = B.items.get(s0.id);
          const d = dims(s0);
          if (own) { it.rot = ((((s0.rot || 0) + delta) % 360) + 360) % 360; it.x = s0.x; it.y = s0.y; updateEl(B.els.get(s0.id), it, mz); return; }
          const ox = s0.x + d.w / 2 - G.x, oy = s0.y + d.h / 2 - G.y;
          it.rot = ((((s0.rot || 0) + delta) % 360) + 360) % 360;
          it.x = G.x + ox * cos - oy * sin - d.w / 2;
          it.y = G.y + ox * sin + oy * cos - d.h / 2;
          updateEl(B.els.get(s0.id), it, mz);
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
      case 'crop': cropMove(g, dx, dy, p, mz, e); break;
      case 'cropzoom': {
        // Right zooms in, left zooms out. The frame stays put; the picture inside grows.
        const it = B.items.get(g.id), s0 = g.start;
        const c0 = { ...ZC, ...(s0.crop || {}) };
        const cw0 = 1 - c0.l - c0.r, ch0 = 1 - c0.t - c0.b;
        const q = Math.min(1 / cw0, 1 / ch0, Math.max(0.02 / Math.min(cw0, ch0), Math.exp(-dxS / 250)));
        const cw = cw0 * q, ch = ch0 * q;
        const mx = c0.l + cw0 / 2, my = c0.t + ch0 / 2;
        const l = Math.max(0, Math.min(1 - cw, mx - cw / 2)), t = Math.max(0, Math.min(1 - ch, my - ch / 2));
        it.crop = { l, t, r: Math.max(0, 1 - l - cw), b: Math.max(0, 1 - t - ch) };
        // Same frame on the board: keep its width, so the picture scales inside
        it.w = s0.w; it.x = s0.x; it.y = s0.y;
        updateEl(B.els.get(g.id), it, mz);
        renderOverlay();
        break;
      }
      case 'opacity': {
        const d = dxS / 300;
        for (const s0 of g.start) { const it = B.items.get(s0.id); it.op = Math.round(Math.max(0.05, Math.min(1, s0.op + d)) * 100) / 100; updateEl(B.els.get(s0.id), it, mz); }
        if (B.onHint) B.onHint('Opacity ' + Math.round(B.items.get(g.start[0].id).op * 100));
        break;
      }
      case 'marquee': {
        const x = Math.min(g.sx0, e.clientX), y = Math.min(g.sy0, e.clientY);
        const w = Math.abs(dxS), h = Math.abs(dyS);
        Object.assign(marquee.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        marquee.hidden = false;
        const a = toWorld(x, y), b = toWorld(x + w, y + h);
        B.sel = new Set(g.base);
        for (const it of live()) {
          const r = bbox([it.id]);
          if (it.type === 'section' ? (r.x >= a.x && r.y >= a.y && r.x + r.w <= b.x && r.y + r.h <= b.y) : (r.x < b.x && r.x + r.w > a.x && r.y < b.y && r.y + r.h > a.y)) B.sel.add(it.id);
        }
        renderOverlay();
        break;
      }
    }
    if (g.moved && ['move', 'resize', 'scale', 'rotate', 'crop'].includes(g.type)) followLive(g, mz);
  });

  // Where the frame sits once the crop changes from s0.crop to c1, so the picture
  // itself stays where it was. Worked out in the item's own space (its rotation and
  // flips) and turned back into board space.
  function reframe(s0, c1) {
    const d0 = dims(s0);
    const c0 = { ...ZC, ...(s0.crop || {}) };
    const W = s0.nw * d0.k, H = s0.nh * d0.k;
    const w1 = (1 - c1.l - c1.r) * W, h1 = (1 - c1.t - c1.b) * H;
    const fx = s0.flipX ? -1 : 1, fy = s0.flipY ? -1 : 1;
    // The picture's top left corner, seen from the frame centre, before and after
    const ex = fx * ((-c0.l * W - d0.w / 2) - (-c1.l * W - w1 / 2));
    const ey = fy * ((-c0.t * H - d0.h / 2) - (-c1.t * H - h1 / 2));
    const a = ((s0.rot || 0) * Math.PI) / 180;
    const cx = s0.x + d0.w / 2 + ex * Math.cos(a) - ey * Math.sin(a);
    const cy = s0.y + d0.h / 2 + ex * Math.sin(a) + ey * Math.cos(a);
    return { x: cx - w1 / 2, y: cy - h1 / 2, w: w1 };
  }

  // A board point in the item's own space: 0..1 across the picture's frame, measured
  // along the picture itself (so the left of a flipped picture is its right side on screen)
  function localUV(s0, pt) {
    const d0 = dims(s0);
    const a = (-(s0.rot || 0) * Math.PI) / 180;
    const dx = pt.x - (s0.x + d0.w / 2), dy = pt.y - (s0.y + d0.h / 2);
    let u = (dx * Math.cos(a) - dy * Math.sin(a)) / d0.w + 0.5;
    let v = (dx * Math.sin(a) + dy * Math.cos(a)) / d0.h + 0.5;
    if (s0.flipX) u = 1 - u;
    if (s0.flipY) v = 1 - v;
    return { u, v };
  }

  function cropMove(g, dx, dy, p, mz, e) {
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
      const { u, v } = localUV(s0, g.w0);
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
      // Shift keeps the shape of the frame, Shift+Alt makes it square
      if (e && e.shiftKey) {
        const W = s0.nw, H = s0.nh;
        const R = e.altKey ? 1 : (1 - c0.l - c0.r) * W / Math.max(1e-6, (1 - c0.t - c0.b) * H);
        const cw = 1 - c.l - c.r, ch = 1 - c.t - c.b;
        const horiz = g.edges.l || g.edges.r, vert = g.edges.t || g.edges.b;
        const byWidth = () => {
          const o = { ...c }, nh = (cw * W) / R / H;
          if (vert) { if (g.edges.t) o.t = 1 - o.b - nh; else o.b = 1 - o.t - nh; }
          else { const mid = o.t + ch / 2; o.t = mid - nh / 2; o.b = 1 - mid - nh / 2; }
          return o;
        };
        const byHeight = () => {
          const o = { ...c }, nw = (ch * H * R) / W;
          if (horiz) { if (g.edges.l) o.l = 1 - o.r - nw; else o.r = 1 - o.l - nw; }
          else { const mid = o.l + cw / 2; o.l = mid - nw / 2; o.r = 1 - mid - nw / 2; }
          return o;
        };
        const fits = (o) => o.l > -1e-6 && o.r > -1e-6 && o.t > -1e-6 && o.b > -1e-6;
        // A corner follows the side that keeps the frame inside the picture
        const tries = !vert ? [byWidth] : !horiz ? [byHeight] : ((cw * W) / R >= ch * H ? [byHeight, byWidth] : [byWidth, byHeight]);
        const ok = tries.map((f) => f()).find(fits);
        // Past the picture's edge: hold where it was
        if (!ok) return;
        for (const k of ['l', 'r', 't', 'b']) c[k] = Math.max(0, ok[k]);
      }
    }
    it.crop = c;
    // Keep the picture itself still while its frame changes
    if (!g.pan) Object.assign(it, reframe(s0, c));
    updateEl(B.els.get(g.id), it, mz);
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
        if (g.moved) commit(g.ids.map((id) => { const it = B.items.get(id); const f = { x: it.x, y: it.y, w: it.w }; if (it.type === 'note') f.fs = it.fs; if (it.type === 'section') f.h = it.h; return { id, fields: f }; }), g.before);
        break;
      case 'rotate':
        if (g.moved) commit(g.ids.map((id) => { const it = B.items.get(id); return { id, fields: { rot: it.rot, x: it.x, y: it.y } }; }), g.before);
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
      case 'cropzoom':
        if (g.moved) commit([{ id: g.id, fields: { crop: B.items.get(g.id).crop } }], g.before);
        break;
      case 'opacity':
        if (g.moved) commit(g.ids.map((id) => ({ id, fields: { op: B.items.get(id).op } })), g.before);
        if (B.onHint) B.onHint('');
        break;
    }
    followBase.clear();
    if (B.pendingRemote) { const p = B.pendingRemote; B.pendingRemote = null; applyRemote(p); }
    renderOverlay();
  }
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);
  canvas.addEventListener('lostpointercapture', (e) => { if (B.gesture && B.gesture.type === 'right' && B.gesture.moved) endGesture(e); });
  window.addEventListener('blur', () => { if (B.gesture && B.gesture.type === 'right') { B.gesture.moved = true; endGesture({}); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('auxclick', (e) => e.preventDefault());

  canvas.addEventListener('dblclick', (e) => {
    const id = itemAt(e.clientX, e.clientY);
    const it = id && B.items.get(id);
    if (it && it.type === 'note') editNote(id);
    else if (it && it.type === 'video') togglePlay(id);
    else if (it && (it.type === 'file' || it.type === 'pdf')) openFile(id);
  });

  // Mouse wheel zooms like PureRef; trackpad two finger scroll pans, pinch zooms.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!B.project) return;
    // Like PureRef: scrolling always zooms, on a wheel, a Magic Mouse or a trackpad.
    // Sideways swipes never move the board; middle click drag or Alt drag moves it.
    const mouseLike = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    if (!dy) return;
    const rate = e.ctrlKey && !mouseLike ? 0.01 : mouseLike ? 0.0018 : 0.004;
    zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-200, Math.min(200, dy)) * rate));
  }, { passive: false });

  window.addEventListener('resize', () => applyView());

  // ---------- notes ----------
  function editNote(id, opts = {}) {
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
    // The click that made a new text box can pull focus back as it finishes:
    // keep typing in the box instead of closing it
    const keepUntil = opts.fresh ? Date.now() + 400 : 0;
    t.onblur = () => setTimeout(() => {
      if (B.editingId !== id) return;
      if (Date.now() < keepUntil && !document.querySelector('#modalWrap:not([hidden])')) { t.focus(); const r2 = document.createRange(); r2.selectNodeContents(t); r2.collapse(false); const s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r2); return; }
      stopEditing();
    }, 0);
    renderOverlay();
  }

  // Restyle selected lines and text live (size, colour, opacity) and make it one
  // undo step when the change is done
  let styleBefore = null, styleKey = '';
  function restyle(ids, fieldsFor, final) {
    if (!canEdit() || !ids.length) return;
    const key = ids.join(',');
    if (styleBefore && styleKey !== key) restyleDone();
    if (!styleBefore) {
      styleKey = key;
      styleBefore = ids.map((id) => { const it = B.items.get(id); return { id, fields: pick(it, it.type === 'draw' ? ['sw', 'color', 'op'] : ['fs', 'w', 'color', 'op']) }; });
    }
    for (const id of ids) {
      const it = B.items.get(id);
      if (!it) continue;
      Object.assign(it, fieldsFor(it));
      const node = B.els.get(id);
      if (node) updateEl(node, it);
    }
    renderOverlay();
    if (final) restyleDone();
  }
  function restyleDone() {
    if (!styleBefore) return;
    const before = styleBefore;
    styleBefore = null; styleKey = '';
    const changes = before.map((b) => ({ id: b.id, fields: pick(B.items.get(b.id), Object.keys(b.fields)) }));
    if (changes.some((c, i) => JSON.stringify(c.fields) !== JSON.stringify(before[i].fields))) commit(changes, before);
  }

  let lastStopAt = 0;
  function stopEditing() {
    const id = B.editingId;
    if (!id) return;
    lastStopAt = Date.now();
    B.editingId = null;
    const node = B.els.get(id);
    if (!node) return;
    const t = node.querySelector('.note-text');
    t.contentEditable = 'false';
    t.removeAttribute('contenteditable');
    node.classList.remove('editing');
    const text = t.innerText.replace(/\n$/, '');
    const it = B.items.get(id);
    if (it && it.plain) {
      // Typed text fits its words; text left empty simply goes
      if (!text.trim()) { commit([{ id, fields: { deleted: true } }]); renderOverlay(); return; }
      const w = node.offsetWidth || it.w;
      if (text !== (it.text || '') || Math.abs(w - it.w) > 0.5) commit([{ id, fields: { text, w } }]);
    } else if (it && text !== (it.text || '')) commit([{ id, fields: { text } }]);
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
    const on = hostForBox({ x: x0, y: y0, w: nw, h: nh });
    commit([{ id, fields: { type: 'draw', on: on || null, pts, nw, nh, w: nw, x: x0, y: y0, sw: r(g.sw), color: B.pen.color, op: B.pen.op == null ? 1 : B.pen.op, style: B.pen.style, z: maxZ() + 1, rot: 0, deleted: false, created: Date.now(), addedBy: B.me.name } }]);
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

  // Type straight onto the board, in the pen colour. Sticks to the picture under it.
  function addText(at) {
    if (!canEdit()) return;
    const fs = (12 + (B.pen.size || 4) * 2) / B.view.s;
    const id = uid();
    const on = hostForBox({ x: at.x, y: at.y - fs * 0.7, w: fs, h: fs });
    commit([{ id, fields: { type: 'note', plain: true, color: B.pen.color, on: on || null, text: '', x: at.x - fs * 0.15, y: at.y - fs * 0.8, w: fs * 6, fs, z: maxZ() + 1, rot: 0, deleted: false, created: Date.now(), addedBy: B.me.name } }]);
    B.sel = new Set([id]);
    // Ready to type at once, so the first letters of a fast typist aren't lost
    editNote(id, { fresh: true });
    renderOverlay();
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
  // ---------- PDFs: one item, any page, sharp at any zoom ----------
  let pdfLib = null;
  const pdfjs = () => (pdfLib = pdfLib || import('./vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  }));
  const pdfDocs = new Map(); // board + file -> loading document
  function pdfDoc(src) {
    const key = (B.project ? B.project.id : '') + '|' + src;
    if (!pdfDocs.has(key)) {
      const pid = B.project && B.project.id;
      pdfDocs.set(key, (async () => {
        const bytes = await api.mediaBytes(pid, src, 0, 'pdf');
        if (!bytes) { pdfDocs.delete(key); throw new Error('missing'); }
        const lib = await pdfjs();
        return lib.getDocument({
          data: new Uint8Array(bytes), isEvalSupported: false,
          cMapUrl: './vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
        }).promise;
      })().catch((e) => { pdfDocs.delete(key); throw e; }));
    }
    return pdfDocs.get(key);
  }
  const pdfJobs = new Map(); // id -> { key, task }
  let pdfQueued = new Set(), pdfTimer = null;
  function queuePdf(id) {
    pdfQueued.add(id);
    if (!pdfTimer) pdfTimer = requestAnimationFrame(() => { pdfTimer = null; const ids = pdfQueued; pdfQueued = new Set(); for (const i of ids) renderPdf(i); });
  }
  async function renderPdf(id) {
    const it = B.items.get(id), node = B.els.get(id);
    if (!it || !node || it.type !== 'pdf') return;
    const cv = node.querySelector('canvas.media');
    if (!cv) return;
    const d = dims(it);
    // Pixels for how big the page shows right now, in steps so a small zoom doesn't redraw
    const want = it.nw * d.k * B.view.s * (window.devicePixelRatio || 1);
    const step = Math.pow(1.5, Math.ceil(Math.log(Math.max(64, want)) / Math.log(1.5)));
    const scaleK = Math.min(step, 4096 * Math.min(1, it.nw / Math.max(it.nw, it.nh))) / it.nw;
    const key = `${it.src}|${it.page || 1}|${Math.round(scaleK * 1000)}`;
    const job = pdfJobs.get(id);
    if (job && job.key === key) return;
    if (job && job.task) try { job.task.cancel(); } catch (_) {}
    const mine = { key, task: null };
    pdfJobs.set(id, mine);
    try {
      const doc = await pdfDoc(it.src);
      if (pdfJobs.get(id) !== mine) return;
      const page = await doc.getPage(Math.min(doc.numPages, Math.max(1, it.page || 1)));
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: scaleK * (it.nw / base.width) });
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(vp.width)); off.height = Math.max(1, Math.round(vp.height));
      const ctx = off.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, off.width, off.height);
      mine.task = page.render({ canvasContext: ctx, viewport: vp });
      await mine.task.promise;
      if (pdfJobs.get(id) !== mine) return;
      // Swap in the finished page in one go, so it never flashes blank
      cv.width = off.width; cv.height = off.height;
      cv.getContext('2d').drawImage(off, 0, 0);
      cv.dataset.drawn = key;
      node.classList.remove('missing');
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      if (pdfJobs.get(id) === mine) { pdfJobs.delete(id); node.classList.add('missing'); }
    }
  }
  function refreshPdfs() {
    const W = window.innerWidth, H = window.innerHeight;
    for (const [id, node] of B.els) {
      if (!node.classList.contains('pdf')) continue;
      const r = node.getBoundingClientRect();
      if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
      renderPdf(id);
    }
  }
  // Turn to another page. The page keeps the width it has on the board.
  async function setPdfPage(id, n) {
    const it = B.items.get(id);
    if (!it || it.type !== 'pdf' || !canEdit()) return;
    try {
      const doc = await pdfDoc(it.src);
      const p = Math.min(doc.numPages, Math.max(1, n));
      if (p === (it.page || 1)) return;
      const vp = (await doc.getPage(p)).getViewport({ scale: 1 });
      const cur = B.items.get(id);
      if (!cur) return;
      const before = [{ id, fields: pick(cur, ['page', 'nw', 'nh', 'crop', 'pages']) }];
      commit([{ id, fields: { page: p, pages: doc.numPages, nw: Math.round(vp.width * 2), nh: Math.round(vp.height * 2), crop: { ...ZC } } }], before);
      renderOverlay();
    } catch (_) { toast("That PDF hasn't arrived on this computer yet.", true); }
  }
  function pdfStep(dir) {
    const ids = selIds();
    const it = ids.length === 1 && B.items.get(ids[0]);
    if (!it || it.type !== 'pdf') return false;
    setPdfPage(it.id, (it.page || 1) + dir);
    return true;
  }
  // The page you're on, as a picture of its own beside the PDF
  async function pdfPageAsPicture(id) {
    const it = B.items.get(id);
    if (!it || !canEdit()) return;
    try {
      const doc = await pdfDoc(it.src);
      const page = await doc.getPage(it.page || 1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, 3000 / Math.max(base.width, base.height)) });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const name = `${String(it.original || 'PDF').replace(/\.pdf$/i, '')} page ${it.page || 1}.png`;
      const d = dims(it);
      await addBytes([new File([blob], name, { type: 'image/png' })], { x: it.x + d.w + 40, y: it.y }, { exact: true, width: d.w });
    } catch (_) { toast("Couldn't make a picture of that page.", true); }
  }

  // ---------- file cards: anything else, opening in its own app ----------
  const sizeText = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : (n || 0) + ' bytes');
  function fillCard(m, it) {
    const key = [it.src, it.preview || '', it.original || ''].join('|');
    if (m.dataset.key === key) return;
    m.dataset.key = key;
    m.innerHTML = '';
    const ext = String(it.ext || (it.original || '').split('.').pop() || 'file').toUpperCase().slice(0, 6);
    const top = el('div', { class: 'fc-top' });
    if (it.preview) {
      const img = el('img', { class: 'fc-pre', draggable: 'false', alt: '' });
      img.onerror = () => { img.remove(); top.append(el('div', { class: 'fc-ext', text: ext })); };
      img.src = mediaUrl(it.preview);
      top.append(img);
    } else top.append(el('div', { class: 'fc-ext', text: ext }));
    m.append(top, el('div', { class: 'fc-foot' },
      el('div', { class: 'fc-name', text: it.original || it.src }),
      el('div', { class: 'fc-meta', text: `${ext}  ·  ${sizeText(it.size)}` })));
  }
  async function openFile(id) {
    const it = B.items.get(id);
    if (!it || !B.project) return;
    const r = await api.openMedia(B.project.id, it.src, it.original);
    if (r && r.error) toast(r.error, true);
    else if (r && r.shown) toast('Shown in its folder. Files that run programs never open straight from a board.');
  }

  function measure(src, kind, r) {
    if (kind === 'pdf') return pdfDoc(src).then(async (doc) => { const vp = (await doc.getPage(1)).getViewport({ scale: 1 }); return { nw: Math.round(vp.width * 2), nh: Math.round(vp.height * 2), pages: doc.numPages }; }).catch(() => ({ nw: 1224, nh: 1584, pages: 1, failed: true }));
    if (kind === 'file') return Promise.resolve({ nw: 640, nh: 520 });
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

  // An import started on one board must not land on another. Remember the board
  // when the work starts and check it before placing anything.
  let goneToastAt = 0;
  function leftBoard(pid) {
    if (B.project && B.project.id === pid) return false;
    if (Date.now() - goneToastAt > 1500) { goneToastAt = Date.now(); toast('That finished after you left the board.'); }
    return true;
  }
  const boardId = () => (B.project ? B.project.id : null);

  // results from the main process import → items on the board, laid out from point p
  async function placeResults(results, p, opts = {}) {
    const pid = opts.pid || boardId();
    const ok = [];
    for (const r of results) {
      if (!r) continue;
      if (r.error) { toast(r.error, true); continue; }
      const m = await measure(r.src, r.kind);
      ok.push({ r, m });
    }
    if (!ok.length || leftBoard(pid)) return [];
    const sizes = ok.map(({ r, m }) => {
      const f = Math.min(1, (r.kind === 'file' ? 400 : r.kind === 'pdf' ? 700 : MAX_PLACE) / Math.max(m.nw, m.nh));
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
        ...(r.kind === 'pdf' ? { page: 1, pages: m.pages || 1 } : {}),
        ...(r.kind === 'file' ? { size: r.size || 0, ext: r.ext || '', preview: (r.preview && r.preview.src) || (r.reused ? (live().find((o) => o.src === r.src && o.preview) || {}).preview || null : null) } : {}),
      },
    }));
    commit(changes);
    B.sel = new Set(changes.map((c) => c.id));
    renderOverlay();
    const reused = ok.filter(({ r }) => r.reused).length;
    const converted = ok.filter(({ r }) => r.reason === 'format' || r.converted).length;
    if (converted) toast(converted === 1 ? 'Converted so it plays on the board. Your original is untouched.' : `${converted} files converted so they play on the board.`);
    else if (reused) toast(reused === 1 ? 'Already in this project, so the same file was reused.' : `${reused} files were already in this project and were reused.`);
    return changes.map((c) => c.id);
  }

  async function addPaths(paths, at) {
    if (!paths || !paths.length || !canEdit()) return;
    const p = at || viewCenter();
    const pid = boardId();
    const results = await api.importPaths(pid, paths);
    if (leftBoard(pid)) return;
    if (results && results.error) return toast(results.error, true);
    await placeResults(results, p, { pid });
  }

  async function addBytes(files, at, place) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const pid = boardId();
    const results = [];
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace('quicktime', 'mov');
      if (leftBoard(pid)) return;
      results.push(await api.importBytes(pid, buf, f.name && /\.[a-z0-9]+$/i.test(f.name) ? f.name : `pasted.${ext}`));
    }
    if (leftBoard(pid)) return;
    await placeResults(results, p, { pid, ...(place || {}) });
  }

  async function addUrl(url, at) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const pid = boardId();
    const r = await api.importUrl(pid, url);
    if (leftBoard(pid)) return;
    await placeResults([r], p, { pid });
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
      // A link dragged from the browser's address bar or a post
      const link = (e.dataTransfer.getData('text/uri-list') || '').split('\n').map((l) => l.trim()).find((l) => /^https?:/.test(l)) || (e.dataTransfer.getData('text/plain') || '').trim();
      const html = e.dataTransfer.getData('text/html');
      const pic = html && /<img[^>]+src="(https?:[^"]+)"/i.exec(html);
      if (isSocial(link)) return addSocial(link, at, pic ? pic[1].replace(/&amp;/g, '&') : null);
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
    const pid = boardId();
    const items = B.clip.items;
    const p = at || viewCenter();
    const bb = (() => { let x0 = Infinity, y0 = Infinity; for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); } return { x: x0, y: y0 }; })();
    let srcMap = new Map();
    if (B.clip.from !== B.project.id) {
      // Copy the files into this project's media folder
      const srcs = [...new Set(items.filter((it) => it.src).map((it) => it.src))];
      const paths = srcs.map((s) => decodeURIComponent(new URL(B.clip.base + encodeURIComponent(s)).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
      const res = await api.importPaths(pid, paths);
      if (leftBoard(pid)) return;
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
    const pid = boardId();
    const files = [], urls = [];
    for (let i = 0; i < srcs.length; i++) {
      if (srcs[i].startsWith('data:')) files.push(await dataUrlFile(srcs[i], i)); else urls.push(srcs[i]);
    }
    if (files.length) await addBytes(files, at);
    if (urls.length) {
      if (leftBoard(pid)) return;
      const p = at || viewCenter();
      const results = [];
      for (const u of urls) { if (leftBoard(pid)) return; results.push(await api.importUrl(pid, u)); }
      if (leftBoard(pid)) return;
      const ok = results.filter((r) => r && !r.error);
      if (!ok.length) return toast((results[0] && results[0].error) || "Couldn't paste that.", true);
      await placeResults(ok, p, { pid });
    }
  }
  const IMAGE_LINK = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|heic|mp4|webm|mov)(\?\S*)?$/i;
  // Social posts and videos: Pluck fetches these
  const SOCIAL_LINK = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:instagram\.com|instagr\.am|tiktok\.com|youtube\.com|youtu\.be|x\.com|twitter\.com|facebook\.com|fb\.watch|vimeo\.com|reddit\.com|redd\.it|pinterest\.[a-z.]+|pin\.it|threads\.net|threads\.com|linkedin\.com|snapchat\.com|twitch\.tv|dailymotion\.com|dai\.ly|tumblr\.com|bsky\.app|imgur\.com|flickr\.com)\/\S*$/i;

  // ---------- links through Pluck ----------
  // A card sits where the video will land, with a preview and progress, until
  // Pluck hands the files over. Then they go on the board like a normal drop.
  const fetchCards = new Map();
  api.onPluck((p) => {
    const c = fetchCards.get(p.key);
    if (!c) return;
    c.token = p.token || c.token;
    if (p.title) c.node.querySelector('.fc-title').textContent = p.title;
    if (p.platform) c.node.querySelector('.fc-from').textContent = p.platform;
    if (p.thumb && !c.node.querySelector('.fc-thumb img')) c.node.querySelector('.fc-thumb').append(el('img', { src: p.thumb, alt: '' }));
    const many = p.items > 1 ? ` (${p.item || 1} of ${p.items})` : '';
    c.node.querySelector('.fc-phase').textContent = (p.phase || 'Getting it') + many;
    const bar = c.node.querySelector('.fc-bar i');
    bar.style.width = Math.max(4, Math.min(100, p.pct || 0)) + '%';
    c.node.classList.toggle('waiting', !(p.pct > 0));
  });
  async function addSocial(url, at, fallbackImg) {
    if (!canEdit()) return;
    const p = at || viewCenter();
    const pid = boardId();
    const key = uid();
    const s = 1 / B.view.s;
    const node = el('div', { class: 'fetch-card waiting', style: `transform: translate(${p.x}px, ${p.y}px) scale(${s}) translate(-50%, -50%)` },
      el('div', { class: 'fc-thumb' }),
      el('div', { class: 'fc-body' },
        el('div', { class: 'fc-from', text: 'Pluck' }),
        el('div', { class: 'fc-title', text: url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60) }),
        el('div', { class: 'fc-phase', text: 'Looking at the link' }),
        el('div', { class: 'fc-bar' }, el('i')),
        el('div', { class: 'fc-actions' })));
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    world.append(node);
    const card = { node, token: null, pid };
    fetchCards.set(key, card);
    const actions = node.querySelector('.fc-actions');
    const close = () => { fetchCards.delete(key); node.remove(); };
    const cancelBtn = el('button', { class: 'fc-btn', text: 'Cancel' });
    cancelBtn.onclick = () => { if (card.token) api.pluckCancel(card.token); close(); };
    actions.append(cancelBtn);
    const r = await api.pluckFetch(pid, url, key);
    if (!fetchCards.has(key) || leftBoard(pid)) { if (r && r.token) api.pluckCleanup(r.token); fetchCards.delete(key); node.remove(); return; }
    if (r && r.files && r.files.length && !leftBoard(pid)) {
      close();
      await addPaths(r.files, p);
      api.pluckCleanup(r.token);
      return;
    }
    if (r && r.token) api.pluckCleanup(r.token);
    if (r && r.canceled) return close();
    node.classList.remove('waiting');
    node.classList.add('failed');
    actions.innerHTML = '';
    if (r && r.missing && fallbackImg) { close(); return addUrl(fallbackImg, p); }
    if (r && r.missing) {
      close();
      if (B.onNeedPluck) B.onNeedPluck(url, p);
      return;
    } else {
      node.querySelector('.fc-phase').textContent = (r && r.error) || "Couldn't get that one.";
      const again = el('button', { class: 'fc-btn primary', text: 'Try again' });
      again.onclick = () => { close(); addSocial(url, p); };
      actions.append(again);
    }
    const x = el('button', { class: 'fc-btn', text: 'Close' });
    x.onclick = close;
    actions.append(x);
  }
  const isSocial = (t) => SOCIAL_LINK.test(String(t || '').trim()) && !IMAGE_LINK.test(String(t || '').trim());
  let pasteTimer = null;
  async function pasteNative(at) {
    if (!B.project || !canEdit()) return;
    const c = await api.readClipboard();
    if (!c || c.error) return;
    if (B.clipMarker && c.text === B.clipMarker) return pasteInternal(at);
    if (c.files && c.files.length) return addPaths(c.files, at);
    if (isSocial((c.text || '').trim())) return addSocial(c.text.trim(), at);
    const srcs = imgSources(c.html);
    if (srcs.length) return pasteSources(srcs, at);
    if (c.png) return addBytes([new File([c.png], 'pasted.png', { type: 'image/png' })], at);
    const text = (c.text || '').trim();
    if (isSocial(text)) return addSocial(text, at);
    if (IMAGE_LINK.test(text)) return addUrl(text, at);
    if (text) addNote(at, text);
  }
  // Windows has no Edit menu, so Ctrl+V may not raise a paste event. If none
  // comes, read the clipboard directly.
  function pasteKey() {
    if (modalOpen() || menuOpen()) return;
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => pasteNative(null), 120);
  }

  document.addEventListener('paste', async (e) => {
    if (!B.project || B.editingId || modalOpen() || menuOpen() || e.target.closest('input, textarea, [contenteditable]')) return;
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
    if (isSocial(text)) return addSocial(text.trim(), at);
    const srcs = imgSources(cd.getData('text/html'));
    if (srcs.length) return pasteSources(srcs, at);
    // Nothing the page can read (a picture from another app, a copied file): ask the system
    return pasteNative(at);
  });

  // ---------- selection actions ----------
  const selIds = () => [...B.sel].filter((id) => B.items.get(id) && !B.items.get(id).deleted);
  const selOrAll = () => (B.sel.size ? selIds() : live().map((it) => it.id));
  // Locked items keep their place, size, turn, flip and crop
  const notLocked = (ids) => ids.filter((id) => !B.items.get(id).locked);
  const LOCK_KEYS = ['flipX', 'flipY'];

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
  const toggleField = (key) => { const ids = LOCK_KEYS.includes(key) ? notLocked(selIds()) : selIds(); if (!ids.length) return; const v = !ids.every((id) => B.items.get(id)[key]); commit(ids.map((id) => ({ id, fields: { [key]: v } }))); };
  function resetCrop() {
    const ids = notLocked(selIds()).filter((id) => B.items.get(id).type !== 'note' && B.items.get(id).type !== 'draw');
    commit(ids.map((id) => ({ id, fields: { crop: { ...ZC }, ...reframe(B.items.get(id), ZC) } })));
  }
  const noSections = (ids) => ids.filter((id) => B.items.get(id) && B.items.get(id).type !== 'section');
  function resetTransform() {
    const ids = noSections(notLocked(selIds()));
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
    const ids = noSections(notLocked(selIds()));
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
    const ids = noSections(notLocked(selIds())).filter((id) => B.items.get(id).type !== 'note');
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
    const ids = noSections(notLocked(selOrAll()));
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
  function step(dir) { if (pdfStep(dir)) return; const id = activeVideoId(); const v = id && videoEl(id); if (v) { v.pause(); v.currentTime = Math.max(0, v.currentTime + dir / 30); } }
  async function grabFrame() {
    const id = activeVideoId(); const v = id && videoEl(id);
    if (!v || !canEdit()) return;
    const it = B.items.get(id);
    const d = dims(it);
    const pid = boardId();
    const t = v.currentTime;
    const r = await api.grabFrame(pid, it.src, t);
    if (leftBoard(pid)) return;
    if (r && r.error) return toast(r.error, true);
    const placed = await placeResults([r], { x: it.x + d.w + 20, y: it.y }, { exact: true, width: d.w, pid });
    if (placed.length) toast(`Frame at ${fmtTime(t)} saved as an image.`);
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
    // Inside the part of the window the sidebar and bars leave free
    const vp = viewport();
    let x = r.left + r.width / 2 - bw / 2;
    // Just under the video when there's room. Otherwise inside it, along the
    // bottom of the part you can see, like a video player. Never above it.
    let y = r.bottom + 8;
    if (y + bh > vp.bottom) y = Math.min(r.bottom, vp.bottom) - bh - 12;
    y = Math.max(Math.max(vp.top, r.top + 8), Math.min(vp.bottom - bh, y));
    x = Math.max(vp.left, Math.min(vp.right - bw, x));
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
    // New things a teammate added since you opened the board, by who added them
    const added = {};
    for (const id in merged) {
      const n = merged[id];
      if (B.items.has(id) || n.deleted || !n.type || !n.by || n.by === B.me.name || (n._dev && n._dev === B.me.deviceKey)) continue;
      if (!(n.created > B.openedAt - 5000)) continue;
      const kind = n.type === 'image' ? 'picture' : n.type === 'video' ? 'video' : n.type === 'draw' ? 'line' : n.type === 'section' ? 'section' : n.type === 'comment' ? 'comment' : n.plain ? 'text' : 'note';
      const a = added[n.by] || (added[n.by] = {});
      a[kind] = (a[kind] || 0) + 1;
      if (kind === 'comment') a._said = String(n.text || '').slice(0, 80);
    }
    B.items = new Map(Object.entries(merged));
    adoptLines();
    render();
    if (Object.keys(added).length) B.onChange('added', added);
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

  // ---------- sections ----------
  // A labelled area behind references. Moving it carries everything inside it.
  const sections = () => live().filter((it) => it.type === 'section').sort((a, b) => (a.y - b.y) || (a.x - b.x));
  function inside(sec, it) {
    const r = bbox([it.id]);
    return r && r.x >= sec.x - 1 && r.y >= sec.y - 1 && r.x + r.w <= sec.x + sec.w + 1 && r.y + r.h <= sec.y + (sec.h || 400) + 1;
  }
  function withSectionContents(ids) {
    const out = new Set(ids);
    for (const id of ids) {
      const sec = B.items.get(id);
      if (!sec || sec.type !== 'section') continue;
      for (const it of live()) if (!out.has(it.id) && !it.locked && it.id !== sec.id && inside(sec, it)) out.add(it.id);
    }
    return [...out];
  }
  function addSection(rect, title) {
    if (!canEdit()) return;
    const id = uid();
    commit([{ id, fields: { type: 'section', title: title || 'Section', x: rect.x, y: rect.y, w: Math.max(120, rect.w), h: Math.max(80, rect.h), z: minZ() - 1, rot: 0, deleted: false, created: Date.now(), addedBy: B.me.name } }]);
    B.sel = new Set([id]);
    renderOverlay();
    setTimeout(() => editSectionTitle(id), 0);
    return id;
  }
  function sectionFromSelection() {
    const ids = selIds().filter((id) => B.items.get(id).type !== 'section');
    const bb = ids.length ? bbox(ids) : null;
    if (!bb) return;
    const pad = Math.max(30, Math.min(bb.w, bb.h) * 0.06) , top = 64 / B.view.s;
    addSection({ x: bb.x - pad, y: bb.y - pad - top, w: bb.w + pad * 2, h: bb.h + pad * 2 + top });
  }
  function editSectionTitle(id) {
    const it = B.items.get(id);
    const node = B.els.get(id);
    if (!it || !node || !canEdit(true)) return;
    const label = node.firstChild;
    B.sectionEditing = id;
    label.contentEditable = 'plaintext-only';
    label.focus();
    const range = document.createRange(); range.selectNodeContents(label);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const done = (save) => {
      label.contentEditable = 'false';
      label.removeEventListener('keydown', onKey); label.removeEventListener('blur', onBlur);
      B.sectionEditing = null;
      const t = label.textContent.trim().slice(0, 80) || 'Section';
      if (save && t !== (it.title || 'Section')) commit([{ id, fields: { title: t } }]);
      else label.textContent = it.title || 'Section';
      canvas.focus({ preventScroll: true });
    };
    const onKey = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    const onBlur = () => done(true);
    label.addEventListener('keydown', onKey); label.addEventListener('blur', onBlur);
  }
  function goToSection(id) {
    const it = B.items.get(id);
    if (!it) return;
    B.sel = new Set([id]);
    fitRect(bbox([id]), 40);
    renderOverlay();
  }

  // ---------- comments ----------
  // A comment is pinned to a spot on a picture and moves with it. Each message
  // is its own record, so two people replying at once never lose a reply.
  const pins = el('div', { id: 'pins' });
  world.append(pins);
  function toContent(host, p) {
    const F = frameOf(host), dx = p.x - F.cx, dy = p.y - F.cy;
    return { u: ((dx * Math.cos(F.a) + dy * Math.sin(F.a)) / F.W) * F.fx, v: ((-dx * Math.sin(F.a) + dy * Math.cos(F.a)) / F.W) * F.fy };
  }
  function fromContent(host, u, v) {
    const F = frameOf(host), lx = u * F.W * F.fx, ly = v * F.W * F.fy;
    return { x: F.cx + lx * Math.cos(F.a) - ly * Math.sin(F.a), y: F.cy + lx * Math.sin(F.a) + ly * Math.cos(F.a) };
  }
  function pinPoint(c) {
    if (!c.on) return { x: c.x || 0, y: c.y || 0 };
    const host = B.items.get(c.on);
    if (!host || host.deleted) return null;
    return fromContent(host, c.u || 0, c.v || 0);
  }
  const who = (c) => c.author || c.by || 'Someone';
  const threadOf = (rootId) => comments().filter((c) => c.id === rootId || c.root === rootId).sort((a, b) => (a.at || 0) - (b.at || 0));
  const roots = () => comments().filter((c) => !c.root);
  let openRoot = null, draft = null;
  function renderPins() {
    pins.innerHTML = '';
    if (!B.project) return;
    for (const c of roots()) {
      if (c.resolved && !B.showResolved && openRoot !== c.id) continue;
      const p = pinPoint(c);
      if (!p) continue;
      const n = threadOf(c.id).length;
      const pin = el('button', { class: 'cpin' + (c.resolved ? ' resolved' : '') + (openRoot === c.id ? ' open' : ''), 'data-id': c.id, title: `${who(c)}: ${String(c.text || '').slice(0, 80)}`, style: `transform: translate(${p.x}px, ${p.y}px) scale(var(--ls, 1))` },
        el('span', { class: 'cpin-face', text: initials(who(c)) }), n > 1 ? el('span', { class: 'cpin-n', text: String(n) }) : null);
      pin.addEventListener('pointerdown', (e) => e.stopPropagation());
      pin.addEventListener('click', (e) => { e.stopPropagation(); openThread(c.id); });
      pins.append(pin);
    }
    if (draft) {
      const p = draft.on ? fromContent(B.items.get(draft.on), draft.u, draft.v) : { x: draft.x, y: draft.y };
      pins.append(el('div', { class: 'cpin draft open', style: `transform: translate(${p.x}px, ${p.y}px) scale(var(--ls, 1))` }, el('span', { class: 'cpin-face', text: initials(B.me.name || '?') })));
    }
    drawThread();
  }
  function startComment(host, at) {
    openRoot = null;
    draft = host ? { on: host.id, ...toContent(host, at) } : { on: null, x: at.x, y: at.y };
    renderPins();
  }
  function openThread(id) { draft = null; openRoot = id; renderPins(); }
  function closeThread() { draft = null; openRoot = null; renderPins(); }
  const thread = el('div', { id: 'thread', hidden: true });
  document.body.append(thread);
  thread.addEventListener('pointerdown', (e) => e.stopPropagation());
  function placeThread() {
    if (thread.hidden) return;
    const c = draft || (openRoot && B.items.get(openRoot));
    if (!c) return;
    const p = draft ? (draft.on ? fromContent(B.items.get(draft.on), draft.u, draft.v) : { x: draft.x, y: draft.y }) : pinPoint(c);
    if (!p) return;
    const sp = toScreen(p.x, p.y);
    const w = 300, h = thread.offsetHeight || 200;
    let x = sp.x + 40, y = sp.y - 34;
    if (x + w > innerWidth - 12) x = sp.x - w - 12;
    y = Math.max(12, Math.min(innerHeight - h - 12, y));
    thread.style.left = Math.max(12, x) + 'px';
    thread.style.top = y + 'px';
  }
  function drawThread() {
    if (!draft && !openRoot) { thread.hidden = true; thread.innerHTML = ''; return; }
    const root = openRoot && B.items.get(openRoot);
    if (openRoot && (!root || root.deleted)) { openRoot = null; thread.hidden = true; return; }
    const keepText = thread.querySelector('textarea') ? thread.querySelector('textarea').value : '';
    const hadFocus = thread.contains(document.activeElement);
    thread.innerHTML = '';
    thread.hidden = false;
    const head = el('div', { class: 'th-head' });
    if (root) {
      const res = el('button', { class: 'th-btn', text: root.resolved ? 'Reopen' : 'Resolve', disabled: !canEdit(true) });
      res.onclick = () => { const was = !!root.resolved; commit([{ id: root.id, fields: { resolved: !was } }]); if (!was) closeThread(); else renderPins(); };
      head.append(el('span', { class: 'th-title', text: root.resolved ? 'Resolved' : 'Comment' }), res);
    } else head.append(el('span', { class: 'th-title', text: 'New comment' }));
    const x = el('button', { class: 'th-btn', 'aria-label': 'Close', text: 'Close' });
    x.onclick = closeThread;
    head.append(x);
    thread.append(head);
    if (root) {
      const list = el('div', { class: 'th-list' });
      for (const m of threadOf(root.id)) {
        const em = m.authorEmail || m.email;
        const mine = em && B.me.email ? em === B.me.email : who(m) === B.me.name;
        const row = el('div', { class: 'th-msg' },
          el('span', { class: 'th-face', text: initials(who(m)) }),
          el('div', { class: 'th-body' },
            el('div', { class: 'th-meta' }, el('b', { text: who(m) }), el('span', { text: fmtAgo(m.at) })),
            el('div', { class: 'th-text', text: m.text || '' })));
        if (mine && canEdit(true)) {
          const del = el('button', { class: 'th-del', text: 'Delete', 'aria-label': 'Delete this message' });
          del.onclick = () => {
            // Deleting the first message removes the whole thread
            const ids = m.id === root.id ? threadOf(root.id).map((t) => t.id) : [m.id];
            commit(ids.map((id) => ({ id, fields: { deleted: true } })));
            if (m.id === root.id) closeThread();
          };
          row.append(del);
        }
        list.append(row);
      }
      thread.append(list);
    }
    if (canEdit(true)) {
      const box = el('textarea', { class: 'th-input', rows: 2, placeholder: root ? 'Reply' : 'Say what you think', 'aria-label': root ? 'Reply' : 'Comment' });
      box.value = keepText;
      const send = el('button', { class: 'th-send', text: root ? 'Reply' : 'Comment' });
      const post = () => {
        const text = box.value.trim().slice(0, 2000);
        if (!text) return;
        box.value = '';
        const id = uid();
        // The writer of a comment is kept apart from 'by', which records whoever touched it last
        const base = { type: 'comment', text, author: B.me.name || 'Someone', authorEmail: B.me.email || '', at: Date.now(), deleted: false, created: Date.now() };
        if (root) commit([{ id, fields: { ...base, root: root.id } }]);
        else { commit([{ id, fields: { ...base, root: null, on: draft.on, u: draft.u ?? null, v: draft.v ?? null, x: draft.x ?? null, y: draft.y ?? null, resolved: false } }]); draft = null; openRoot = id; if (B.tool === 'comment') setTool('select'); }
        box.value = '';
        renderPins();
        const t = thread.querySelector('textarea'); if (t) t.focus();
      };
      send.onclick = post;
      box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post(); } if (e.key === 'Escape') { e.preventDefault(); closeThread(); } });
      thread.append(el('div', { class: 'th-compose' }, box, send));
      if (hadFocus || !root) setTimeout(() => { if (document.activeElement !== box) box.focus(); }, 0);
    }
    placeThread();
  }
  function fmtAgo(t) {
    const m = Math.floor((Date.now() - (t || 0)) / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function setShowResolved(on) { B.showResolved = !!on; renderPins(); }
  function commentCount() { return roots().filter((c) => !c.resolved).length; }

  // ---------- saved versions ----------
  const plainFields = (it) => { const o = {}; for (const k in it) if (k[0] !== '_' && k !== 'id') o[k] = it[k]; return o; };
  function versionItems() {
    const out = {};
    for (const it of live()) out[it.id] = clone(plainFields(it));
    return out;
  }
  // Put the board back as it was: one undo step, and teammates see it too
  function restoreVersion(items) {
    if (!canEdit() || !items) return 0;
    const changes = [];
    for (const id in items) {
      const want = { ...plainFields(items[id]), deleted: false };
      const cur = B.items.get(id);
      // Anything added to a piece since (a fade, a crop, a lock) goes back to empty
      if (cur) for (const k in plainFields(cur)) if (!(k in want) && cur[k] != null) want[k] = null;
      const diff = {};
      for (const k in want) if (!cur || JSON.stringify(cur[k] == null ? null : cur[k]) !== JSON.stringify(want[k] == null ? null : want[k])) diff[k] = want[k];
      if (Object.keys(diff).length) changes.push({ id, fields: diff });
    }
    for (const it of live()) if (!items[it.id]) changes.push({ id: it.id, fields: { deleted: true } });
    // Exactly as saved: lines and pictures are already where they were
    if (changes.length) commit(changes, null, { exact: true });
    B.sel.clear();
    renderOverlay();
    return changes.length;
  }

  // ---------- export ----------
  // Draws the board (or the chosen pieces) into one big picture at full quality:
  // each picture is drawn from its own file, so nothing is limited to screen size.
  async function renderExport(ids, opts = {}) {
    const list = (ids && ids.length ? ids.map((id) => B.items.get(id)) : live()).filter((it) => it && !it.deleted && it.type);
    if (!list.length) return null;
    list.sort((a, b) => (a.z || 0) - (b.z || 0));
    const box = bbox(list.map((it) => it.id));
    const pad = Math.max(24, Math.min(box.w, box.h) * 0.03);
    // As sharp as the sharpest picture, within a size a computer can handle
    let k = 1;
    for (const it of list) if ((it.type === 'image' || it.type === 'video') && it.nw && it.w) k = Math.max(k, Math.min(4, it.nw / it.w));
    const W0 = box.w + pad * 2, H0 = box.h + pad * 2;
    k = Math.min(k, 12000 / Math.max(W0, H0), Math.sqrt(120e6 / (W0 * H0)));
    const W = Math.max(1, Math.round(W0 * k)), H = Math.max(1, Math.round(H0 * k));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.imageSmoothingQuality = 'high';
    if (!opts.clear) { x.fillStyle = '#1C1B1A'; x.fillRect(0, 0, W, H); }
    x.scale(k, k);
    x.translate(pad - box.x, pad - box.y);
    const loadImg = async (it) => {
      const v = it.type === 'video' ? videoEl(it.id) : null;
      const bytes = await api.mediaBytes(B.project.id, it.src, v ? v.currentTime : (it.vin || 0), it.type);
      if (!bytes) return null;
      const type = it.type === 'video' ? 'image/png' : /\.svg$/i.test(it.src) ? 'image/svg+xml' : '';
      const url = URL.createObjectURL(new Blob([bytes], type ? { type } : {}));
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } catch (_) { return null; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    };
    let missingN = 0;
    for (const it of list) {
      const d = dims(it);
      x.save();
      x.translate(it.x + d.w / 2, it.y + d.h / 2);
      x.rotate(((it.rot || 0) * Math.PI) / 180);
      x.translate(-d.w / 2, -d.h / 2);
      const op = it.op == null ? 1 : it.op;
      if (it.type === 'section') {
        x.fillStyle = 'rgba(255,255,255,0.035)'; x.fillRect(0, 0, d.w, d.h);
        x.strokeStyle = 'rgba(255,255,255,0.14)'; x.lineWidth = 2 / k; x.strokeRect(0, 0, d.w, d.h);
        const fs = Math.max(18, Math.min(d.w, d.h) * 0.035);
        x.fillStyle = '#F4F3EE'; x.font = `600 ${fs}px Inter, system-ui, sans-serif`; x.textBaseline = 'top';
        x.fillText(it.title || 'Section', fs * 0.8, fs * 0.7);
      } else if (it.type === 'image' || it.type === 'video') {
        const img = await loadImg(it);
        x.globalAlpha = op;
        if (it.gray) x.filter = 'grayscale(1)';
        if (img) {
          const c = { ...ZC, ...(it.crop || {}) };
          const iw = img.naturalWidth || it.nw, ih = img.naturalHeight || it.nh;
          x.save();
          x.translate(d.w / 2, d.h / 2); x.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1); x.translate(-d.w / 2, -d.h / 2);
          x.drawImage(img, c.l * iw, c.t * ih, iw * (1 - c.l - c.r), ih * (1 - c.t - c.b), 0, 0, d.w, d.h);
          x.restore();
        } else { missingN++; x.fillStyle = '#2A2927'; x.fillRect(0, 0, d.w, d.h); }
      } else if (it.type === 'pdf') {
        // The page as drawn on the board, sharpened for the export size first
        x.globalAlpha = op;
        if (it.gray) x.filter = 'grayscale(1)';
        let pg = null;
        try {
          const doc = await pdfDoc(it.src);
          const page = await doc.getPage(it.page || 1);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: Math.min(4096 / Math.max(base.width, base.height), (it.nw * k * 1.2) / base.width) });
          pg = document.createElement('canvas'); pg.width = Math.round(vp.width); pg.height = Math.round(vp.height);
          const pc = pg.getContext('2d'); pc.fillStyle = '#fff'; pc.fillRect(0, 0, pg.width, pg.height);
          await page.render({ canvasContext: pc, viewport: vp }).promise;
        } catch (_) { pg = null; }
        if (pg) {
          const c = { ...ZC, ...(it.crop || {}) };
          x.save();
          x.translate(d.w / 2, d.h / 2); x.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1); x.translate(-d.w / 2, -d.h / 2);
          x.drawImage(pg, c.l * pg.width, c.t * pg.height, pg.width * (1 - c.l - c.r), pg.height * (1 - c.t - c.b), 0, 0, d.w, d.h);
          x.restore();
        } else { missingN++; x.fillStyle = '#2A2927'; x.fillRect(0, 0, d.w, d.h); }
      } else if (it.type === 'file') {
        x.globalAlpha = op;
        const u = d.w / 100; // the card is laid out in hundredths of its width
        const foot = 18 * u;
        x.fillStyle = '#232220'; x.fillRect(0, 0, d.w, d.h);
        x.fillStyle = '#1b1a18'; x.fillRect(0, 0, d.w, d.h - foot);
        let pre = null;
        if (it.preview) pre = await loadImg({ ...it, type: 'image', src: it.preview });
        const ext = String(it.ext || (it.original || '').split('.').pop() || 'file').toUpperCase().slice(0, 6);
        if (pre) {
          const ah = d.h - foot, f = Math.min(d.w / pre.naturalWidth, ah / pre.naturalHeight);
          x.drawImage(pre, (d.w - pre.naturalWidth * f) / 2, (ah - pre.naturalHeight * f) / 2, pre.naturalWidth * f, pre.naturalHeight * f);
        } else {
          x.fillStyle = '#D7F04A'; x.font = `700 ${9 * u}px Inter, system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText(ext, d.w / 2, (d.h - foot) / 2); x.textAlign = 'left';
        }
        x.textBaseline = 'top';
        x.fillStyle = '#F4F3EE'; x.font = `600 ${4.6 * u}px Inter, system-ui, sans-serif`;
        let nm = String(it.original || it.src);
        while (nm.length > 4 && x.measureText(nm).width > d.w - 8 * u) nm = nm.slice(0, -2);
        if (nm !== String(it.original || it.src)) nm = nm.slice(0, -1) + '…';
        x.fillText(nm, 4 * u, d.h - foot + 3.4 * u);
        x.fillStyle = '#8F8D86'; x.font = `500 ${3.3 * u}px Inter, system-ui, sans-serif`;
        x.fillText(`${ext}  ·  ${sizeText(it.size)}`, 4 * u, d.h - foot + 10 * u);
      } else if (it.type === 'draw') {
        const kk = d.k || (it.nw ? it.w / it.nw : 1);
        x.scale(kk, kk);
        x.translate(-((it.crop || ZC).l || 0) * it.nw, -((it.crop || ZC).t || 0) * it.nh);
        x.strokeStyle = it.color || '#D7F04A'; x.globalAlpha = op;
        x.lineWidth = it.sw || 4; x.lineCap = 'round'; x.lineJoin = 'round';
        if (it.style === 'dotted') x.setLineDash([0, (it.sw || 4) * 2]);
        x.stroke(new Path2D(strokePath(parsePts(it.pts), it.style === 'arrow' ? (it.sw || 4) : 0)));
      } else if (it.type === 'note') {
        const fs = it.fs || 16;
        const node = B.els.get(it.id);
        const t = node && node.querySelector('.note-text');
        const cs = t ? getComputedStyle(t) : null;
        x.globalAlpha = op;
        if (!it.plain) { x.fillStyle = '#2A2927'; x.fillRect(0, 0, d.w, d.h); }
        x.fillStyle = it.plain ? (it.color || '#D7F04A') : (cs ? cs.color : '#F4F3EE');
        x.font = `${it.plain ? 600 : 400} ${fs}px Inter, system-ui, sans-serif`;
        x.textBaseline = 'top';
        const padX = it.plain ? fs * 0.15 : fs * 0.95, padY = it.plain ? fs * 0.1 : fs * 0.8;
        const lh = fs * (it.plain ? 1.25 : 1.45);
        const maxW = d.w - padX * 2;
        let yy = padY;
        for (const para of String(it.text || '').split('\n')) {
          if (it.plain) { x.fillText(para, padX, yy + (lh - fs) / 2); yy += lh; continue; }
          let line = '';
          for (const word of para.split(/(\s+)/)) {
            const test = line + word;
            if (line && x.measureText(test).width > maxW) { x.fillText(line.trimEnd(), padX, yy + (lh - fs) / 2); yy += lh; line = word.trimStart(); }
            else line = test;
          }
          x.fillText(line, padX, yy + (lh - fs) / 2); yy += lh;
        }
      }
      x.restore();
    }
    return { canvas: cv, w: W, h: H, missing: missingN };
  }

  async function exportAs(kind, onlySelection) {
    if (!B.project) return;
    const ids = onlySelection ? withSectionContents(selIds()) : null;
    toast('Getting the export ready');
    const r = await renderExport(ids);
    if (!r) return toast('Nothing to export yet.', true);
    const blob = await new Promise((res) => r.canvas.toBlob(res, kind === 'pdf' ? 'image/jpeg' : 'image/png', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = (B.project.name || 'Eye Refs') + (onlySelection ? ' selection' : '');
    const res = await api.exportSave({ kind, bytes, w: r.w, h: r.h, name });
    if (res && res.saved) toast(r.missing ? `Saved ${res.name}. ${r.missing === 1 ? 'One picture' : r.missing + ' pictures'} hadn't downloaded yet, so ${r.missing === 1 ? 'it shows' : 'they show'} as grey boxes.` : `Saved ${res.name}`);
    else if (res && res.error) toast(res.error, true);
  }

  // ---------- colour palette ----------
  async function getPalette(id) {
    const it = B.items.get(id);
    if (!it || !B.project) return;
    const v = it.type === 'video' ? videoEl(id) : null;
    const r = await api.palette(B.project.id, it.src, v ? v.currentTime : 0);
    if (!r || !r.colors || !r.colors.length) return toast("Couldn't read the colours of this one.", true);
    if (B.onPalette) B.onPalette(it, r.colors);
  }
  // A strip of the colours, added under the picture as a normal reference
  async function addPaletteStrip(it, colors) {
    if (!canEdit()) return;
    const S = 200, L = 56, cv = document.createElement('canvas');
    cv.width = S * colors.length; cv.height = S + L;
    const x = cv.getContext('2d');
    x.fillStyle = '#1C1B1A'; x.fillRect(0, 0, cv.width, cv.height);
    colors.forEach((c, i) => {
      x.fillStyle = c.hex; x.fillRect(i * S, 0, S, S);
      x.fillStyle = '#F4F3EE'; x.font = '600 26px Inter, system-ui, sans-serif'; x.textBaseline = 'middle';
      x.fillText(c.hex, i * S + 18, S + L / 2);
    });
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = new File([blob], 'palette.png', { type: 'image/png' });
    const d = dims(it);
    const w = Math.min(d.w, 1000);
    await addBytes([file], { x: it.x, y: it.y + d.h + 24 }, { width: w, exact: true });
  }

  // ---------- context menu ----------
  const PEN_OPACITY = [1, 0.75, 0.5, 0.25, 0.1];
  function contextMenu(x, y) {
    if (!B.project) return;
    const hit = itemAt(x, y);
    if (hit && !B.sel.has(hit)) { B.sel = new Set([hit]); renderOverlay(); }
    const ids = selIds();
    const one = ids.length === 1 ? B.items.get(ids[0]) : null;
    const at = toWorld(x, y);
    const ed = !B.readOnly;
    const items = [];
    // Kept short like PureRef: the main actions on top, the rest in side menus
    if (one && one.type === 'pdf') {
      const n = one.page || 1, total = one.pages || 1;
      items.push(
        { label: 'Next page', key: 'Period', onClick: () => setPdfPage(one.id, n + 1), disabled: !ed || n >= total },
        { label: 'Previous page', key: 'Comma', onClick: () => setPdfPage(one.id, n - 1), disabled: !ed || n <= 1 },
        { label: 'Page as picture', onClick: () => pdfPageAsPicture(one.id), disabled: !ed },
        { label: 'Open in its app', onClick: () => openFile(one.id) },
        '-');
    }
    if (one && one.type === 'file') items.push({ label: 'Open', onClick: () => openFile(one.id) }, '-');
    if (one && one.type === 'video') {
      const v = videoEl(one.id);
      items.push(
        { label: v && !v.paused ? 'Pause' : 'Play', key: 'K', onClick: () => togglePlay(one.id) },
        { label: 'Video', sub: [
          { label: 'Grab frame', key: 'F', onClick: grabFrame, disabled: !ed },
          { label: 'Set start here', key: 'I', onClick: () => setInOut('in'), disabled: !ed },
          { label: 'Set end here', key: 'O', onClick: () => setInOut('out'), disabled: !ed },
          { label: 'Loop', checked: one.loop !== false, onClick: toggleLoop, disabled: !ed },
          { label: v && !v.muted ? 'Mute' : 'Play sound', key: 'M', onClick: toggleMute },
        ] });
    }
    const fadeable = ids.filter((id) => B.items.get(id).type !== 'section');
    if (fadeable.length) {
      const cur = B.items.get(fadeable[0]).op == null ? 1 : B.items.get(fadeable[0]).op;
      items.push({ label: 'Opacity', sub: PEN_OPACITY.map((o) => ({ label: Math.round(o * 100) + ' percent', checked: Math.abs(cur - o) < 0.01, disabled: !ed, onClick: () => commit(fadeable.map((id) => ({ id, fields: { op: o } }))) })) });
    }
    if (one && one.type === 'note') items.push({ label: 'Edit note', key: 'Enter', onClick: () => editNote(one.id), disabled: !ed });
    if (ids.length) {
      items.push(
        { label: 'Image', sub: [
          ...(one && (one.type === 'image' || one.type === 'video') ? [{ label: 'Get palette', onClick: () => getPalette(one.id) }, '-'] : []),
          { label: 'Grayscale', key: 'Alt+G', checked: ids.every((id) => B.items.get(id).gray), onClick: () => toggleField('gray'), disabled: !ed },
          { label: 'Flip horizontal', key: 'Alt+Shift+H', onClick: () => toggleField('flipX'), disabled: !ed },
          { label: 'Flip vertical', key: 'Alt+Shift+V', onClick: () => toggleField('flipY'), disabled: !ed },
          '-',
          { label: 'Crop with handles', key: 'Mod+Alt+Shift+C', onClick: () => { B.sel = new Set([one.id]); toggleCropMode(true); }, disabled: !ed || !one || (one.type !== 'image' && one.type !== 'video') },
          { label: 'Reset cropping', key: 'Mod+Shift+C', onClick: resetCrop, disabled: !ed },
          { label: 'Reset transform', key: 'Mod+Shift+T', onClick: resetTransform, disabled: !ed },
        ] },
        { label: 'Order', sub: [
          { label: 'Bring to front', key: 'Up', onClick: front, disabled: !ed },
          { label: 'Send to back', key: 'Down', onClick: back, disabled: !ed },
        ] },
        { label: 'Edit', sub: [
          { label: 'Copy', key: 'Mod+C', onClick: () => copySelection(false) },
          { label: 'Cut', key: 'Mod+X', onClick: () => copySelection(true), disabled: !ed },
          { label: 'Paste', key: 'Mod+V', onClick: () => pasteNative(at), disabled: !ed },
          { label: 'Duplicate', onClick: duplicate, disabled: !ed },
          '-',
          { label: 'Export as picture', onClick: () => exportAs('png', true) },
          { label: 'Export as PDF', onClick: () => exportAs('pdf', true) },
        ] },
        ...(one && one.type !== 'section' ? [{ label: 'Comment here', onClick: () => startComment(one, at), disabled: !ed }] : []),
        ...(one && one.type === 'section' ? [{ label: 'Rename section', onClick: () => editSectionTitle(one.id), disabled: !ed }] : [{ label: 'Make a section', onClick: sectionFromSelection, disabled: !ed }]),
        { label: 'Locked', key: 'Alt+L', checked: ids.every((id) => B.items.get(id).locked), onClick: () => toggleField('locked'), disabled: !ed },
        { label: 'Delete', key: 'Delete', onClick: deleteSelection, disabled: !ed },
        '-');
    } else {
      items.push(
        { label: 'Paste', key: 'Mod+V', onClick: () => pasteNative(at), disabled: !ed },
        { label: 'Add', sub: [
          { label: 'Images and videos', key: 'Mod+I', onClick: async () => addPaths(await api.openImagesDialog(), at), disabled: !ed },
          { label: 'A folder of images', onClick: async () => addPaths(await api.importFolderDialog(), at), disabled: !ed },
          { label: 'Note', key: 'Mod+N', onClick: () => addNote(at), disabled: !ed },
          { label: 'Section', onClick: () => addSection({ x: at.x - 400 / B.view.s, y: at.y - 260 / B.view.s, w: 800 / B.view.s, h: 520 / B.view.s }), disabled: !ed },
        ] },
        { label: 'Select all', key: 'Mod+A', onClick: selectAll },
        '-');
    }
    for (const x of B.extraMenu ? B.extraMenu({ ed, at }) : []) items.push(x);
    openMenu(items, x, y);
  }

  // ---------- load / unload ----------
  function load(p) {
    unconfirmed.clear();
    unload();
    // Per board state starts fresh
    B.lockedCanvas = false;
    B.grayCanvas = false; world.classList.remove('gray');
    B.hoverId = null;
    undecodable.clear();
    if (B.tool !== 'select') setTool('select');
    B.project = p.record;
    B.mediaBase = p.mediaBase;
    B.readOnly = !!p.readOnly;
    B.items = new Map(Object.entries(p.items || {}));
    B.undoStack = []; B.redoStack = [];
    B.openedAt = Date.now();
    let v = null;
    try { v = JSON.parse(localStorage.getItem('view:' + p.record.id) || 'null'); } catch (_) {}
    adoptLines();
    render();
    if (v && isFinite(v.s)) { B.view = v; applyView(); }
    else if (live().length) focusAll();
    else { B.view = { x: window.innerWidth / 2, y: window.innerHeight / 2, s: 1 }; applyView(); }
  }

  function unload() {
    const g = B.gesture;
    if (g && g.pointerId !== undefined) { try { canvas.releasePointerCapture(g.pointerId); } catch (_) {} }
    for (const svg of world.querySelectorAll('svg.live')) svg.remove();
    for (const node of B.els.values()) { const vv = node.querySelector('video'); if (vv) { vv.pause(); vv.removeAttribute('src'); vv.load(); } node.remove(); }
    B.els.clear(); B.items.clear(); B.sel.clear();
    for (const j of pdfJobs.values()) if (j.task) try { j.task.cancel(); } catch (_) {}
    pdfJobs.clear();
    for (const d of pdfDocs.values()) d.then((doc) => doc.destroy()).catch(() => {});
    pdfDocs.clear();
    B.project = null; B.editingId = null; B.gesture = null; B.pendingRemote = null; B.hoverId = null;
    draft = null; openRoot = null; thread.hidden = true; thread.innerHTML = ''; pins.innerHTML = '';
    for (const c of fetchCards.values()) { if (c.token) api.pluckCancel(c.token); c.node.remove(); }
    fetchCards.clear();
    clearTimeout(pasteTimer);
    canvas.classList.remove('panning');
    marquee.hidden = true;
    overlay.innerHTML = ''; vbar.hidden = true;
  }

  function setTool(t) {
    B.tool = t;
    canvas.classList.toggle('tool-hand', t === 'hand');
    canvas.classList.toggle('tool-pen', t === 'pen');
    canvas.classList.toggle('tool-eraser', t === 'eraser');
    canvas.classList.toggle('tool-text', t === 'text');
    canvas.classList.toggle('tool-comment', t === 'comment');
    if (t === 'pen' || t === 'eraser' || t === 'text' || t === 'comment') { if (B.editingId) stopEditing(); clearSel(); }
    B.onChange('tool');
  }
  function setGrid(on) { B.grid = on; canvas.classList.toggle('grid', on); }
  function setGrayCanvas(on) { B.grayCanvas = on; world.classList.toggle('gray', on); }
  function setLockedCanvas(on) { B.lockedCanvas = on; B.onChange('lock'); }

  // Crop with handles on one picture (Cmd/Ctrl+Alt+Shift+C toggles, like PureRef)
  function toggleCropMode(on) {
    const ids = selIds();
    const it = ids.length === 1 && B.items.get(ids[0]);
    const can = it && (it.type === 'image' || it.type === 'video' || it.type === 'pdf') && !it.locked && canEdit();
    B.cropMode = (on === undefined ? !B.cropMode : on) && can ? it.id : null;
    renderOverlay();
    return !!B.cropMode;
  }

  function binItems() { return [...B.items.values()].filter((it) => it.deleted && it.type && it.type !== 'comment').sort((a, b) => (b._t || 0) - (a._t || 0)); }
  function restore(ids) { commit(ids.map((id) => ({ id, fields: { deleted: false } }))); B.sel = new Set(ids); renderOverlay(); }

  Object.assign(B, {
    startComment, openThread, closeThread, setShowResolved, commentCount, comments, versionItems, restoreVersion, addSection, sectionFromSelection, sections, goToSection, editSectionTitle, addSocial, addText, restyle, restyleDone, getPalette, addPaletteStrip, renderExport, exportAs, load, unload, applyRemote, render, applyView, zoomAt, fitRect, toWorld, toScreen,
    commit, undo, redo, addPaths, addBytes, addUrl, addNote, editNote, stopEditing,
    copySelection, pasteInternal, pasteNative, pasteKey, deleteSelection, duplicate, toggleField, resetCrop, resetTransform, toggleCropMode, front, back,
    align, normalize, arrange, focusSelection, focusAll, focusStep, selectAll, clearSel, selIds,
    togglePlay, setInOut, toggleLoop, cycleSpeed, toggleMute, step, grabFrame, activeVideoId,
    setTool, setGrid, setGrayCanvas, setLockedCanvas, binItems, restore, mediaUrl, contextMenu, live, setPdfPage, pdfStep, pdfPageAsPicture, openFile,
  });
  window.Board = B;
})();
