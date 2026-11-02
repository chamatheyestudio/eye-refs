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
      return p;
    }).join(IS_MAC ? '' : '+');
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2600);
  }

  // items: [{ label, key, onClick, disabled, checked } | '-']
  function openMenu(items, x, y) {
    const m = $('#menu');
    m.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(el('hr')); continue; }
      const b = el('button', { role: 'menuitem', disabled: it.disabled },
        el('span', null, it.checked ? el('span', { class: 'check', text: '✓ ' }) : null, it.label),
        it.key ? el('span', { class: 'k', text: keyLabel(it.key) }) : null);
      b.addEventListener('click', () => { closeMenu(); if (!it.disabled) it.onClick && it.onClick(); });
      m.append(b);
    }
    if (m.lastChild && m.lastChild.tagName === 'HR') m.lastChild.remove();
    m.hidden = false;
    const r = m.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    m.style.left = Math.max(8, px) + 'px';
    m.style.top = Math.max(8, py) + 'px';
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu() { $('#menu').hidden = true; }
  function menuOpen() { return !$('#menu').hidden; }

  document.addEventListener('pointerdown', (e) => {
    if (menuOpen() && !e.target.closest('#menu')) closeMenu();
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
