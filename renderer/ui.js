// Small UI helpers shared by the board and the app shell.
(function () {
  const IS_MAC = (window.eyerefs && window.eyerefs.platform === 'darwin') || /Mac/.test(navigator.platform);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }

  // Shortcut labels in each platform's own style
  function keyLabel(combo) {
    if (!combo) return '';
    return combo.split('+').map((p) => {
      if (p === 'Mod') return IS_MAC ? '⌘' : 'Ctrl';
      if (p === 'Alt') return IS_MAC ? '⌥' : 'Alt';
      if (p === 'Shift') return IS_MAC ? '⇧' : 'Shift';
      const names = { Up: '↑', Down: '↓', Left: '←', Right: '→', Equal: '=', Minus: '-', Space: 'Space', Delete: IS_MAC ? '⌫' : 'Del', Escape: 'Esc', Enter: '↩', Tab: 'Tab' };
      return names[p] || p;
    }).join(IS_MAC ? '' : '+');
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    // Sit just above whichever bars are showing at the bottom, never on top of them
    let top = window.innerHeight - 16;
    for (const id of ['toolbar', 'penBar', 'videoBar', 'zoom']) {
      const b = document.getElementById(id);
      if (!b || b.hidden) continue;
      const cs = getComputedStyle(b);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue;
      const r = b.getBoundingClientRect();
      if (r.height && r.top > window.innerHeight / 2) top = Math.min(top, r.top);
    }
    t.style.bottom = Math.max(16, window.innerHeight - top + 12) + 'px';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2600);
  }

  // items: [{ label, key, onClick, disabled, checked, sub: [items] } | '-']
  // An item with `sub` opens a side menu on hover, like PureRef's menu.
  function fill(m, items, depth) {
    m.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(el('hr')); continue; }
      const b = el('button', { role: 'menuitem', class: it.danger ? 'danger' : null, disabled: it.disabled, 'aria-haspopup': it.sub ? 'menu' : null },
        el('span', null, it.checked ? el('span', { class: 'check', text: '✓ ' }) : null, it.label),
        it.sub ? el('span', { class: 'k sub', text: '›' }) : it.key ? el('span', { class: 'k', text: keyLabel(it.key) }) : null);
      if (it.sub) {
        const open = () => openSub(b, it.sub, depth + 1);
        b.addEventListener('mouseenter', open);
        b.addEventListener('click', open);
        b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { open(); const f = subEl(depth + 1).querySelector('button:not(:disabled)'); if (f) f.focus(); e.preventDefault(); } });
      } else {
        b.addEventListener('mouseenter', () => closeSubs(depth + 1));
        b.addEventListener('click', () => { closeMenu(); if (!it.disabled) it.onClick && it.onClick(); });
      }
      m.append(b);
    }
    if (m.lastChild && m.lastChild.tagName === 'HR') m.lastChild.remove();
  }
  const subs = [];
  function subEl(depth) {
    let m = subs[depth];
    if (!m) { m = el('div', { class: 'menu submenu', role: 'menu', hidden: true }); document.body.append(m); subs[depth] = m; }
    return m;
  }
  function closeSubs(from) { for (let d = from; d < subs.length; d++) if (subs[d]) subs[d].hidden = true; }
  function place(m, x, y, alt) {
    m.hidden = false;
    const r = m.getBoundingClientRect();
    let px = x;
    if (px + r.width > window.innerWidth - 8) px = alt != null ? alt - r.width : window.innerWidth - r.width - 8;
    const py = Math.min(y, window.innerHeight - r.height - 8);
    m.style.left = Math.max(8, px) + 'px';
    m.style.top = Math.max(8, py) + 'px';
  }
  function openSub(btn, items, depth) {
    closeSubs(depth);
    const m = subEl(depth);
    fill(m, items, depth);
    const r = btn.getBoundingClientRect();
    place(m, r.right + 4, r.top - 6, r.left - 4);
  }
  function openMenu(items, x, y) {
    const m = $('#menu');
    closeSubs(1);
    fill(m, items, 0);
    place(m, x, y);
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() { $('#menu').hidden = true; closeSubs(1); }
  function menuOpen() { return !$('#menu').hidden; }

  document.addEventListener('pointerdown', (e) => {
    if (menuOpen() && !e.target.closest('.menu')) closeMenu();
  }, true);

  // Modal: build(close) returns the modal content element
  function openModal(build) {
    const wrap = $('#modalWrap');
    wrap.innerHTML = '';
    const close = () => { wrap.hidden = true; wrap.innerHTML = ''; };
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
    const content = build(close);
    if (Array.isArray(content)) box.append(...content); else box.append(content);
    wrap.append(box);
    wrap.hidden = false;
    wrap.onpointerdown = (e) => { if (e.target === wrap) close(); };
    const f = box.querySelector('input, select, button.btn');
    if (f) setTimeout(() => f.focus(), 0);
    return close;
  }
  function modalOpen() { return !$('#modalWrap').hidden; }
  function closeModal() { const w = $('#modalWrap'); w.hidden = true; w.innerHTML = ''; }

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function avatarColor(email) {
    const tones = ['#3A3936', '#4A4844', '#57544D', '#45433E', '#3F4A2A', '#4E5530'];
    let h = 0;
    for (const c of String(email || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return tones[h % tones.length];
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '?')[1] || '')).toUpperCase();
  }

  window.UI = { IS_MAC, $, $$, el, keyLabel, toast, openMenu, closeMenu, menuOpen, openModal, modalOpen, closeModal, fmtTime, avatarColor, initials };
})();
