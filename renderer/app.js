// App shell: setup, sidebar, top bar, presence, toolbar, shortcuts, dialogs.
(function () {
  const { $, $$, el, toast, openMenu, closeMenu, menuOpen, openModal, modalOpen, closeModal, keyLabel, IS_MAC, avatarColor, initials } = window.UI;
  const api = window.eyerefs;
  const B = window.Board;
  fillIcons();

  const S = {
    me: null, admin: false, teamMember: false, online: true, cloud: null,
    projects: [], current: null, status: 'saved', readOnly: false,
    here: [], filter: 'all', search: '', expanded: new Set(), sidebar: true,
    alwaysOnTop: false, clickThrough: false, lockedWindow: false,
  };
  try { S.expanded = new Set(JSON.parse(localStorage.getItem('expanded') || '[]')); } catch (_) {}
  $('#searchKbd').textContent = keyLabel('Mod+Shift+P');
  if (IS_MAC) document.body.classList.add('mac');

  // ---------- setup screens ----------
  function screen(build) {
    const s = $('#screen');
    s.innerHTML = '';
    const card = el('div', { class: 'card' }, el('span', { class: 'logo', html: ICONS.logo.replace('width="14" height="14"', 'width="26" height="26"') }), build());
    s.append(card, el('div', { class: 'credit', text: 'Eye Refs by Matte Black' }));
    s.hidden = false;
    const f = s.querySelector('input'); if (f) f.focus();
  }

  function screenFor(r) {
    if (r.screen === 'connect') {
      const input = el('input', { class: 'input', id: 'cLink', placeholder: 'https://script.google.com/macros/s/.../exec', 'aria-label': 'EyeStudio connection link', spellcheck: 'false' });
      const err = el('div', { class: 'err' });
      const go = async () => { err.textContent = ''; const res = await api.connect(input.value); if (res && res.error) err.textContent = res.error; else route(res); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Eye Refs' }),
        el('p', { text: 'Paste the EyeStudio connection link. You only do this once.' }),
        input, err,
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Connect', onclick: go }))));
    } else if (r.screen === 'signin') {
      signInScreen(r.email || '');
    } else {
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Something went wrong' }),
        el('p', { text: r.error || 'Eye Refs could not start.' }),
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Try again', onclick: start }))));
    }
  }

  function signInScreen(email) {
    // EyeStudio people only type their name; anyone else types a full email
    const DOMAIN = '@eyestudio.ae';
    const start = email.endsWith(DOMAIN) ? email.slice(0, -DOMAIN.length) : email;
    const input = el('input', { class: 'input', id: 'siEmail', type: 'text', value: start, placeholder: 'name', 'aria-label': 'Email', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'username' });
    const suffix = el('span', { class: 'suffix', text: DOMAIN });
    const field = el('label', { class: 'email-field' }, input, suffix);
    const full = () => { const v = input.value.trim().toLowerCase(); return v.includes('@') ? v : v + DOMAIN; };
    const syncSuffix = () => {
      const free = input.value.includes('@');
      suffix.hidden = free;
      input.classList.toggle('free', free);
      if (!free && suffix.offsetWidth) input.style.paddingRight = (suffix.offsetWidth + 19) + 'px';
      else input.style.paddingRight = '';
    };
    requestAnimationFrame(syncSuffix);
    input.addEventListener('input', syncSuffix);
    syncSuffix();
    const err = el('div', { class: 'err' });
    const btn = el('button', { class: 'btn', text: 'Send me a code' });
    const go = async () => {
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Sending';
      if (!input.value.trim()) { btn.disabled = false; btn.textContent = 'Send me a code'; err.textContent = 'Type your name.'; return; }
      const res = await api.requestCode(full());
      btn.disabled = false; btn.textContent = 'Send me a code';
      if (res && res.error) err.textContent = res.error; else codeScreen(full());
    };
    btn.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    screen(() => el('div', { style: 'display:contents' },
      el('h1', { text: 'Eye Refs' }),
      el('p', { text: 'Sign in with your EyeStudio email. We send you a 6 digit code, no password.' }),
      field, err, el('div', { class: 'btns' }, btn)));
  }

  function codeScreen(email) {
    const code = el('input', { class: 'input', id: 'siCode', inputmode: 'numeric', maxlength: '6', placeholder: '6 digit code', 'aria-label': 'Code', style: 'text-align:center;letter-spacing:0.3em;font-size:18px' });
    const guess = email.split('@')[0].split(/[._-]+/)[0];
    const name = el('input', { class: 'input', id: 'siName', value: guess ? guess[0].toUpperCase() + guess.slice(1) : '', placeholder: 'Your name', 'aria-label': 'Your name', maxlength: '40' });
    const err = el('div', { class: 'err' });
    const btn = el('button', { class: 'btn', text: 'Sign in' });
    const go = async () => {
      err.textContent = '';
      btn.disabled = true;
      const res = await api.verifyCode(code.value, name.value.trim());
      btn.disabled = false;
      if (res && res.error) err.textContent = res.error; else route(res);
    };
    btn.onclick = go;
    for (const i of [code, name]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    screen(() => el('div', { style: 'display:contents' },
      el('h1', { text: 'Check your email' }),
      el('p', { text: `We sent a code to ${email}.` }),
      code, name, err,
      el('div', { class: 'btns' }, btn),
      el('button', { class: 'linkish', text: 'Use a different email', onclick: () => signInScreen(email) })));
  }

  async function start() { route(await api.boot()); }

  async function route(r) {
    if (!r || r.error || r.screen !== 'app') return screenFor(r || { error: 'No response' });
    $('#screen').hidden = true;
    S.me = r.me; S.projects = r.projects;
    S.admin = !!r.admin; S.teamMember = !!r.team; S.online = r.online !== false;
    S.version = r.version || '';
    $$('.beta').forEach((b) => { b.title = versionLabel(); });
    B.me = r.me;
    $('#meName').textContent = r.me.name;
    $('#meAvatar').textContent = r.me.initials;
    $('#meAvatar').style.background = avatarColor(r.me.email);
    S.alwaysOnTop = r.prefs.alwaysOnTop;
    setSidebar(r.prefs.sidebar, true);
    syncToolbar();
    renderSidebar();
    if (!S.online) toast("Working offline. Shared boards will catch up when you're back online.");
    if (r.openFile) return openResult(await api.openProjectFile(r.openFile));
    if (S.current) return;
    const last = r.lastProject && S.projects.find((p) => p.id === r.lastProject);
    if (last) openResult(await api.openProject(last.id));
    else openResult(await api.newBoard());
    syncChrome();
  }

  // ---------- projects ----------
  function openResult(res) {
    if (!res || res.error) { toast((res && res.error) || 'Could not open that project.', true); return; }
    const leftScratch = S.current && S.current.scratch && S.current.id !== res.record.id;
    S.current = res.record;
    if (leftScratch) setTimeout(rescan, 50);
    S.status = res.status;
    S.readOnly = res.readOnly;
    S.here = [];
    S.cloud = null;
    if (res.unpacked) toast('Opened as your own copy.');
    if (!S.projects.find((p) => p.id === res.record.id)) S.projects.push(res.record);
    B.load(res);
    syncChrome();
    renderSidebar();
  }

  async function rescan() {
    const r = await api.scan();
    if (!r || r.error) return;
    S.projects = r.projects;
    if (S.current) {
      const cur = S.projects.find((p) => p.id === S.current.id);
      if (cur) S.current = { ...S.current, ...cur };
    }
    renderSidebar();
    syncChrome();
  }
  setInterval(rescan, 60 * 1000);
  window.addEventListener('focus', () => { if (S.me) rescan(); });

  // ---------- sidebar ----------
  function saveExpanded() { try { localStorage.setItem('expanded', JSON.stringify([...S.expanded])); } catch (_) {} }

  function others(here) { return (here || []).filter((h) => !h.self); }

  function renderSidebar() {
    const tree = $('#tree');
    tree.innerHTML = '';
    if (!S.me) return;
    const q = S.search.trim().toLowerCase();
    const shown = S.projects.filter((p) => {
      if (S.filter === 'mine' && !p.mine) return false;
      if (S.filter === 'shared' && !p.shared) return false;
      if (q && !(`${p.name} ${p.owner ? p.owner.name : ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const list = shown.sort((a, b) => (b.scratch - a.scratch) || a.name.localeCompare(b.name));
    {
      for (const p of list) {
        const isCurrent = S.current && S.current.id === p.id;
        const n = isCurrent ? others(S.here).length : 0;
        let meta = null;
        if (p.scratch) meta = el('span', { class: 'meta', text: 'Not saved' });
        else if (n) meta = el('span', { class: 'meta here', html: ICONS.people + `<span>${n} here</span>` });
        else if (p.requests) meta = el('span', { class: 'meta here', text: p.requests === 1 ? '1 request' : `${p.requests} requests` });
        else if (p.cloudOnly) meta = el('span', { class: 'meta', html: ICONS.cloud + '<span>Shared</span>' });
        else if (!p.mine && p.owner) meta = el('span', { class: 'meta', text: `${p.owner.name}'s` });
        else if (p.shared) meta = el('span', { class: 'meta', html: ICONS.people });
        const pr = el('button', { class: 'row project' + (S.current && S.current.id === p.id ? ' current' : ''), role: 'treeitem', title: p.mine ? p.name : `${p.name}, owned by ${p.owner ? p.owner.name : 'someone else'}` },
          el('span', { class: 'name', text: p.name }), meta);
        pr.addEventListener('click', async () => { if (!S.current || S.current.id !== p.id) openResult(await api.openProject(p.id)); });
        tree.append(pr);
      }
    }
  }

  $('#search').addEventListener('input', (e) => { S.search = e.target.value; renderSidebar(); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; S.search = ''; renderSidebar(); e.target.blur(); } });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    S.filter = b.dataset.filter;
    $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    renderSidebar();
  }));
  $('#newProject').addEventListener('click', () => newBoard());
  $('#joinBoard').addEventListener('click', () => joinModal());
  $('#hideSidebar').addEventListener('click', () => setSidebar(false));
  $('#showSidebar').addEventListener('click', () => setSidebar(true));
  $('#account').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu([
      { label: 'Join a board', onClick: joinModal },
      { label: 'Open a file', onClick: openFile },
      { label: 'Save as one file', onClick: packCurrent, disabled: !S.current },
      { label: 'Show in folder', onClick: () => api.reveal(), disabled: S.current && S.current.scratch },
      '-',
      { label: 'Keyboard shortcuts', key: IS_MAC ? 'Ctrl+H' : 'Mod+H', onClick: shortcutsModal },
      '-',
      { label: `Sign out ${S.me.email}`, onClick: async () => { S.current = null; B.unload(); route(await api.signOut()); } },
      { label: `Eye Refs ${versionLabel()}`, disabled: true },
    ], r.left, r.top - 300);
  });

  // "1.0.0-beta.2" reads as "Version 1.0.0 beta 2"
  function versionLabel() {
    const m = /^(\d+\.\d+\.\d+)(?:-([a-z]+)\.?(\d+)?)?/.exec(S.version || '');
    if (!m) return 'Version ' + (S.version || '');
    return `Version ${m[1]}${m[2] ? ` ${m[2]}${m[3] ? ' ' + m[3] : ''}` : ''}`;
  }

  function setSidebar(on, quiet) {
    S.sidebar = on;
    $('#sidebar').hidden = !on;
    $('#showSidebar').hidden = on;
    document.body.classList.toggle('has-sidebar', on);
    document.body.classList.toggle('no-sidebar', !on);
    if (!quiet) api.setSidebarPref(on);
  }

  // ---------- top bar ----------
  function syncChrome() {
    const p = S.current;
    $('#title').hidden = !p;
    $('#share').hidden = !p || S.readOnly;
    $('#toolbar').style.visibility = p ? 'visible' : 'hidden';
    $('#zoom').style.visibility = p ? 'visible' : 'hidden';
    if (!p) { $('#presence').hidden = true; return; }
    $('#tName').textContent = p.name;
    $('#tLock').hidden = !B.lockedCanvas;
    const st = $('#tStatus');
    st.classList.remove('warn');
    if (S.readOnly || S.status === 'readonly') { st.innerHTML = ''; st.append(el('span', { html: ICONS.lock }), 'View only'); }
    else if (p.scratch) { st.textContent = 'Not saved'; }
    else if (S.status === 'saving') { st.textContent = 'Saving'; }
    else if (S.status === 'local') { st.textContent = 'Saved on this computer'; st.classList.add('warn'); }
    else if (p.shared && S.cloud && S.cloud.state === 'offline') { st.textContent = 'Saved here, will sync'; st.classList.add('warn'); st.title = S.cloud.message || ''; }
    else if (p.shared && S.cloud && S.cloud.state === 'error') { st.textContent = 'Sync paused'; st.classList.add('warn'); st.title = S.cloud.message || ''; }
    else if (p.shared && S.cloud && (S.cloud.up || S.cloud.down)) {
      const parts = [];
      if (S.cloud.down) parts.push(`${S.cloud.down} coming in`);
      if (S.cloud.up) parts.push(`${S.cloud.up} going up`);
      st.textContent = 'Syncing, ' + parts.join(', ');
    }
    else { st.innerHTML = ICONS.check; st.append(p.shared ? 'Synced' : 'Saved'); }
    renderPresence();
    for (const b of [$('#tAddImage'), $('#tAddVideo'), $('#tNote')]) b.disabled = S.readOnly;
  }

  function renderPresence() {
    const list = S.here || [];
    const people = others(list);
    const selfElsewhere = list.some((h) => h.self);
    const box = $('#presence');
    if (!people.length && !selfElsewhere) { box.hidden = true; return; }
    const stack = $('#pStack');
    stack.innerHTML = '';
    for (const h of people.slice(0, 3)) {
      const a = el('span', { class: 'avatar', text: initials(h.name), title: h.name });
      a.style.background = avatarColor(h.email);
      stack.append(a);
    }
    const names = people.map((h) => h.name);
    let text;
    if (!names.length) text = 'You, on another computer';
    else if (names.length === 1) text = `${names[0]} is here`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are here`;
    else text = `${names[0]}, ${names[1]} and ${names.length - 2} more are here`;
    $('#pText').textContent = text;
    box.hidden = false;
  }

  $('#tName').addEventListener('dblclick', () => { if (S.current && S.current.scratch) saveModal(); else if (S.current && S.current.mine) renameModal(); });
  $('#share').addEventListener('click', () => shareModal());
  $('#wMin').addEventListener('click', () => api.minimize());
  $('#wMax').addEventListener('click', () => api.maximize());
  $('#wClose').addEventListener('click', () => api.close());

  // ---------- toolbar ----------
  function syncToolbar() {
    $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === B.tool));
    $('#tTop').classList.toggle('on', S.alwaysOnTop);
    $('#tThrough').classList.toggle('on', S.clickThrough);
  }
  $$('#toolbar [data-tool]').forEach((b) => b.addEventListener('click', () => B.setTool(b.dataset.tool)));
  const addDialog = async () => B.addPaths(await api.openImagesDialog());
  $('#tAddImage').addEventListener('click', addDialog);
  $('#tAddVideo').addEventListener('click', addDialog);
  $('#tNote').addEventListener('click', () => B.addNote());
  $('#tTop').addEventListener('click', toggleTop);
  $('#tThrough').addEventListener('click', () => setThrough(true));
  $('#zIn').addEventListener('click', () => B.zoomAt(innerWidth / 2, innerHeight / 2, 1.25));
  $('#zOut').addEventListener('click', () => B.zoomAt(innerWidth / 2, innerHeight / 2, 0.8));
  $('#zVal').addEventListener('click', () => B.focusAll());

  async function toggleTop() {
    S.alwaysOnTop = await api.setAlwaysOnTop(!S.alwaysOnTop);
    syncToolbar();
    toast(S.alwaysOnTop ? 'Always on top' : 'No longer on top');
  }
  async function setThrough(on) {
    S.clickThrough = await api.setClickThrough(on);
    document.body.classList.toggle('clickthrough', S.clickThrough);
    syncToolbar();
    if (S.clickThrough) toast(`Clicks pass through. Press ${keyLabel('Mod+T')} to come back.`);
  }
  async function opacity(delta) {
    const o = await api.changeOpacity(delta);
    toast(`Window ${Math.round(o * 100)} percent visible`);
  }

  // Menu items the board adds to its right click menu
  B.extraMenu = () => [
    { label: 'Always on top', key: 'Mod+Shift+A', checked: S.alwaysOnTop, onClick: toggleTop },
    { label: 'Click through', key: 'Mod+T', onClick: () => setThrough(true) },
    { label: 'Lock canvas', key: 'Mod+R', checked: B.lockedCanvas, onClick: () => B.setLockedCanvas(!B.lockedCanvas) },
    { label: 'Lock window', key: 'Mod+W', checked: S.lockedWindow, onClick: toggleWindowLock },
    { label: 'More see through', key: 'Mod+Shift+-', onClick: () => opacity(-0.1) },
    { label: 'Less see through', key: 'Mod+Shift+=', onClick: () => opacity(0.1) },
    '-',
    { label: 'Share', onClick: () => shareModal(), disabled: S.readOnly },
    { label: 'Save as one file', onClick: packCurrent },
    S.current && S.current.scratch
      ? { label: 'Save', key: 'Mod+S', onClick: () => saveModal() }
      : { label: 'Rename project', onClick: renameModal, disabled: !S.current || !S.current.mine },
    { label: 'Show in folder', onClick: () => api.reveal(), disabled: S.current && S.current.scratch },
    '-',
    { label: 'Minimize', key: 'Mod+M', onClick: () => api.minimize() },
    { label: 'Maximize', key: 'Mod+F', onClick: () => api.maximize() },
    { label: 'Close', key: 'Mod+Q', onClick: () => api.close() },
  ];

  async function toggleWindowLock() { S.lockedWindow = !S.lockedWindow; await api.lockWindow(S.lockedWindow); toast(S.lockedWindow ? 'Window locked in place' : 'Window unlocked'); }

  B.onChange = (what) => {
    if (what === 'tool') syncToolbar();
    if (what === 'lock') { syncChrome(); toast(B.lockedCanvas ? 'Canvas locked' : 'Canvas unlocked'); }
    if (what === 'bin') binModal();
    if (what === 'readonly') { S.readOnly = true; syncChrome(); }
  };

  // ---------- events from the main process ----------
  api.onState((p) => { if (S.current && p.projectId === S.current.id) B.applyRemote(p.items); });
  api.onStatus((p) => { if (S.current && p.projectId === S.current.id) { S.status = p.status; if (p.status === 'readonly') S.readOnly = true; syncChrome(); } });
  api.onPresence((p) => {
    if (!S.current || p.projectId !== S.current.id) return;
    S.here = p.here;
    const rec = S.projects.find((x) => x.id === p.projectId);
    if (rec) rec.here = p.here;
    renderPresence(); renderSidebar();
  });
  api.onOpenFile(async (file) => openResult(await api.openProjectFile(file)));
  api.onCloud((st) => {
    if (!S.current || st.projectId !== S.current.id) return;
    S.cloud = st;
    syncChrome();
  });
  api.onPackProgress((p) => {
    const box = $('#jobs');
    if (p.fraction >= 1) { box.hidden = true; return; }
    $('#jobText').textContent = `Saving as one file ${Math.round(p.fraction * 100)}%`;
    box.hidden = false;
  });
  api.onClickThrough((on) => { S.clickThrough = on; document.body.classList.toggle('clickthrough', on); syncToolbar(); });
  api.onImportProgress((p) => {
    const box = $('#jobs');
    if (p.done && p.index === p.total - 1) { box.hidden = true; return; }
    if (p.done) return;
    const what = p.mode === 'compress' ? 'Making a high quality copy of' : p.mode === 'remux' ? 'Preparing' : 'Adding';
    const pct = typeof p.fraction === 'number' && p.mode ? ` ${Math.round(p.fraction * 100)}%` : '';
    $('#jobText').textContent = `${what} ${p.name}${pct}${p.total > 1 ? `  (${p.index + 1} of ${p.total})` : ''}`;
    box.hidden = false;
  });

  // ---------- dialogs ----------
  // PureRef style: start on a blank untitled board, name it when saving
  async function newBoard() {
    if (S.current && S.current.scratch && B.live().length) {
      return openModal((close) => [
        el('h2', { text: 'Save this board?' }),
        el('p', { text: "It isn't saved yet. If you don't save it, it's gone." }),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', text: "Don't save", onclick: async () => { close(); openResult(await api.newBoard({ discard: true })); rescan(); } }),
          el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
          el('button', { class: 'btn', text: 'Save', onclick: () => { close(); saveModal(async () => { openResult(await api.newBoard()); rescan(); }); } })),
      ]);
    }
    openResult(await api.newBoard());
    rescan();
  }

  function saveModal(then) {
    if (!S.current || !S.current.scratch) return;
    openModal((close) => {
      const name = el('input', { class: 'input', id: 'svName', placeholder: 'Spring Campaign', maxlength: '60' });
      const err = el('p', { style: 'color:#F2C9B8;font-size:12px' });
      const go = async () => {
        if (!name.value.trim()) { err.textContent = 'Give the board a name.'; return; }
        const res = await api.saveBoard(S.current.id, name.value.trim());
        if (res && res.error) { err.textContent = res.error; return; }
        close();
        openResult(res);
        await rescan();
        toast(`Saved in Documents / Eye Refs / ${res.record.name}`);
        if (then) then();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => name.focus(), 30);
      return [
        el('h2', { text: 'Save board' }),
        el('div', { class: 'field' }, el('label', { for: 'svName', text: 'Name' }), name),
        err,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn', text: 'Save', onclick: go })),
      ];
    });
  }

  // Share: upload to the EyeStudio Drive, invite people, approve requests
  async function shareModal() {
    if (!S.current) return;
    if (S.current.scratch) return saveModal(() => shareModal());
    const p = S.current;
    if (!S.online) return toast("You're offline. Sharing needs a connection.", true);
    if (!p.shared && !S.teamMember) return toast('Only EyeStudio accounts can share boards.', true);
    let data = p.shared ? await api.members(p.id) : null;
    if (data && data.error) return toast(data.error, true);
    openModal((close) => {
      const box = el('div', { style: 'display:flex;flex-direction:column;gap:14px' });
      // Names get @eyestudio.ae added; a full email works for anyone outside
      const emails = el('input', { class: 'input', id: 'shEmails', placeholder: 'nousaiba, shoaib', spellcheck: 'false', autocapitalize: 'off' });
      const err = el('p', { style: 'color:#F2C9B8;font-size:12px' });
      const parse = () => [...new Set(emails.value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => (x.includes('@') ? x : x + '@eyestudio.ae')))];
      const preview = el('div', { class: 'invite-preview' });
      const showPreview = () => { preview.textContent = parse().join(', '); };
      emails.addEventListener('input', showPreview);
      const draw = () => {
        box.innerHTML = '';
        if (!p.shared) {
          box.append(el('p', { text: `This uploads "${p.name}" to the EyeStudio Google Drive at Eye Refs / ${p.name}. Everyone you invite gets a synced copy in their Documents folder.` }));
          return;
        }
        const canManage = data.role !== 'member';
        if (data.code && canManage) {
          const copy = el('button', { class: 'btn ghost', style: 'height:32px;padding:0 12px', text: 'Copy' });
          copy.onclick = async () => { try { await navigator.clipboard.writeText(data.code); toast('Join code copied'); } catch (_) { toast(`Join code: ${data.code}`); } };
          box.append(el('div', { class: 'li', style: 'display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;border-radius:14px;background:rgba(255,255,255,0.04)' },
            el('span', { class: 'grow', style: 'flex:1', html: `Join code <b style="font-family:var(--mono);letter-spacing:0.12em;margin-left:6px">${data.code}</b>` }), copy));
        }
        if (data.requests && data.requests.length) {
          box.append(el('div', { style: 'font-size:12px;color:var(--muted);font-weight:500', text: 'Asking to join' }));
          const list = el('div', { class: 'list' });
          for (const r of data.requests) {
            list.append(el('div', { class: 'li' }, el('span', { class: 'grow', text: `${r.name}  ·  ${r.email}` }),
              el('button', { class: 'btn ghost', style: 'height:32px;padding:0 12px', text: 'Decline', onclick: () => decide(r.email, false) }),
              el('button', { class: 'btn lime', style: 'height:32px;padding:0 12px', text: 'Approve', onclick: () => decide(r.email, true) })));
          }
          box.append(list);
        }
        box.append(el('div', { style: 'font-size:12px;color:var(--muted);font-weight:500', text: 'People on this board' }));
        const list = el('div', { class: 'list' });
        for (const m of data.members) {
          const remove = canManage && !m.owner ? el('button', { class: 'btn ghost', style: 'height:32px;padding:0 12px', text: 'Remove', onclick: () => removeMember(m.email) }) : null;
          list.append(el('div', { class: 'li' }, el('span', { class: 'grow', text: `${m.name}  ·  ${m.email}` }), m.owner ? el('span', { class: 'kbd', style: 'padding-right:10px', text: 'Owner' }) : remove));
        }
        box.append(list);
      };
      const refresh = async () => { const d = await api.members(p.id); if (d && !d.error) { data = d; draw(); } };
      const decide = async (email, allow) => { const r = await api.decide(p.id, email, allow); if (r && r.error) toast(r.error, true); await refresh(); rescan(); };
      const removeMember = async (email) => { const r = await api.removeMember(p.id, email); if (r && r.error) toast(r.error, true); await refresh(); };
      const btn = el('button', { class: 'btn', text: p.shared ? 'Invite' : 'Share board' });
      btn.onclick = async () => {
        err.textContent = '';
        const list = parse();
        if (p.shared && !list.length) { err.textContent = 'Type a name.'; return; }
        btn.disabled = true; btn.textContent = p.shared ? 'Inviting' : 'Uploading';
        const r = p.shared ? await api.invite(p.id, list) : await api.share(p.id, list);
        btn.disabled = false; btn.textContent = 'Invite';
        if (r && r.error) { err.textContent = r.error; return; }
        if (!p.shared) { p.shared = r.shared; data = r.members; toast(list.length ? 'Shared. Invites sent, and the board is uploading.' : 'Shared. The board is uploading to the EyeStudio Drive.'); }
        else toast(list.length === 1 ? 'Invite sent' : `${list.length} invites sent`);
        emails.value = '';
        showPreview();
        await refresh(); rescan(); syncChrome();
      };
      emails.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      draw();
      const canInvite = !data || data.role !== 'member';
      return [
        el('h2', { text: p.shared ? 'Share' : `Share "${p.name}"` }),
        box,
        canInvite ? el('div', { class: 'field' }, el('label', { for: 'shEmails', text: 'Invite people' }), emails, preview) : null,
        err,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Done', onclick: close }), canInvite ? btn : null),
      ];
    });
  }

  function joinModal() {
    openModal((close) => {
      const code = el('input', { class: 'input', id: 'jnCode', placeholder: 'ABC123', maxlength: '6', style: 'text-transform:uppercase;letter-spacing:0.2em;font-family:var(--mono)' });
      const err = el('p', { style: 'color:#F2C9B8;font-size:12px' });
      const go = async () => {
        err.textContent = '';
        const r = await api.join(code.value.trim());
        if (r && r.error) { err.textContent = r.error; return; }
        close();
        toast(r.already ? `You're already on "${r.name}".` : `Request sent to ${r.owner}. "${r.name}" appears here once they approve.`);
        rescan();
      };
      code.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return [el('h2', { text: 'Join a board' }), el('p', { text: 'Enter the join code from whoever shared the board. They approve your request, then it appears in your sidebar.' }), code, err,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn', text: 'Send request', onclick: go }))];
    });
  }

  async function openFile() {
    const f = await api.openFileDialog();
    if (f) openResult(await api.openProjectFile(f));
  }

  async function packCurrent() {
    if (!S.current) return;
    const r = await api.packProject(S.current.id);
    $('#jobs').hidden = true;
    if (r && r.error) return toast(r.error, true);
    if (r && r.file) toast(`Saved as one file with ${r.files} items. Send it anywhere.`);
  }

  function renameModal() {
    if (!S.current || !S.current.mine) return;
    openModal((close) => {
      const input = el('input', { class: 'input', id: 'rnName', value: S.current.name, maxlength: '60' });
      const go = async () => {
        const r = await api.renameProject(input.value.trim());
        if (r && r.error) return toast(r.error, true);
        S.current.name = r.name; close(); syncChrome(); rescan();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return [el('h2', { text: 'Rename project' }), input,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn', text: 'Rename', onclick: go }))];
    });
  }

  function binModal() {
    const items = B.binItems();
    openModal((close) => {
      const box = el('div', { class: 'list' });
      for (const it of items.slice(0, 200)) {
        const thumb = it.type === 'image'
          ? el('img', { class: 'thumb', src: B.mediaUrl(it.src), alt: '' })
          : it.type === 'video'
            ? el('video', { class: 'thumb', src: B.mediaUrl(it.src) + '#t=0.1', muted: true, preload: 'metadata' })
            : el('span', { class: 'thumb', style: 'display:flex;align-items:center;justify-content:center', html: ICONS.note });
        box.append(el('div', { class: 'li' }, thumb,
          el('span', { class: 'grow', text: it.type === 'note' ? (it.text || 'Note').slice(0, 60) : it.original || it.src }),
          el('button', { class: 'btn ghost', style: 'height:32px;padding:0 12px', text: 'Restore', disabled: S.readOnly, onclick: () => { B.restore([it.id]); close(); } })));
      }
      if (!items.length) box.append(el('p', { text: 'Nothing deleted on this board.' }));
      return [
        el('h2', { text: 'Bin' }),
        el('p', { text: 'Deleted items stay here, and their files stay in the project folder.' }),
        box,
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', text: 'Close', onclick: close }),
          items.length ? el('button', { class: 'btn', text: 'Restore all', disabled: S.readOnly, onclick: () => { B.restore(items.map((i) => i.id)); close(); } }) : null),
      ];
    });
  }

  const SHORTCUTS = [
    ['Board', [['Pan', 'Alt + drag, or middle mouse'], ['Zoom', 'Scroll, or hold Z and drag'], ['Move window', 'Right mouse drag'], ['Menu', 'Right click'], ['Focus image', 'Space'], ['Fit everything', 'Mod+Space'], ['Reset zoom', 'Mod+0'], ['Next or previous image', '→  ←'], ['Lock canvas', 'Mod+R'], ['Grid', 'G']]],
    ['Items', [['Crop', 'Hold C and drag an edge'], ['Move inside crop', 'Hold V and drag'], ['Reset cropping', 'Mod+Shift+C'], ['Rotate', 'Mod + drag'], ['Scale', 'Mod+Alt + drag'], ['Flip', 'Alt+Shift+H  /  Alt+Shift+V'], ['Grayscale', 'Alt+G'], ['Reset transform', 'Mod+Shift+T'], ['Arrange optimal', 'Mod+P'], ['Align', 'Mod + arrows'], ['Normalize size', 'Mod+Alt + arrows'], ['Bring to front or back', '↑  ↓'], ['Lock item', 'Alt+L'], ['Duplicate', 'Mod+D'], ['Note', 'Mod+N'], ['Undo / Redo', 'Mod+Z  /  Mod+Shift+Z']]],
    ['Video', [['Play or pause', 'K'], ['Set start / end', 'I  /  O'], ['Step a frame', ',  .'], ['Grab frame', 'F'], ['Sound', 'M']]],
    ['Window', [['Always on top', 'Mod+Shift+A'], ['Click through', 'Mod+T'], ['See through', 'Mod+Shift+-  /  Mod+Shift+='], ['Lock window', 'Mod+W'], ['New board', 'Mod+K'], ['Save', 'Mod+S'], ['Search projects', 'Mod+Shift+P'], ['Add images', 'Mod+I']]],
  ];
  function shortcutsModal() {
    openModal((close) => {
      const g = el('div', { class: 'shortcuts' });
      for (const [title, rows] of SHORTCUTS) {
        g.append(el('h3', { text: title }));
        for (const [a, k] of rows) g.append(el('span', { text: a }), el('span', { class: 'k', text: k.replace(/Mod\+Alt/g, keyLabel('Mod+Alt')).replace(/Mod\+Shift/g, keyLabel('Mod+Shift')).replace(/Alt\+Shift/g, keyLabel('Alt+Shift')).replace(/Mod/g, keyLabel('Mod')).replace(/\bAlt\b/g, keyLabel('Alt')) }));
      }
      return [el('h2', { text: 'Shortcuts' }), g, el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Done', onclick: close }))];
    });
  }

  // ---------- keyboard (PureRef defaults) ----------
  const keyName = (e) => {
    if (e.code.startsWith('Key')) return e.code.slice(3);
    if (e.code.startsWith('Digit')) return e.code.slice(5);
    const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Minus: 'Minus', Equal: 'Equal', NumpadAdd: 'Equal', NumpadSubtract: 'Minus', Comma: 'Comma', Period: 'Period', Space: 'Space', Delete: 'Delete', Backspace: 'Backspace', Escape: 'Escape', Enter: 'Enter', NumpadEnter: 'Enter' };
    return map[e.code] || e.key;
  };
  const combo = (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    return [mod && 'Mod', e.altKey && 'Alt', e.shiftKey && 'Shift', keyName(e)].filter(Boolean).join('+');
  };

  let lastCopy = 0;
  const doCopy = (cut) => { if (Date.now() - lastCopy < 150) return; lastCopy = Date.now(); B.copySelection(cut); };
  document.addEventListener('copy', (e) => { if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return; if (!B.selIds().length) return; e.preventDefault(); doCopy(false); if (B.clipMarker) e.clipboardData.setData('text/plain', B.clipMarker); });
  document.addEventListener('cut', (e) => { if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return; if (!B.selIds().length) return; e.preventDefault(); doCopy(true); if (B.clipMarker) e.clipboardData.setData('text/plain', B.clipMarker); });

  let spaceUsed = false;
  const actions = {
    'Mod+Shift+A': toggleTop,
    'Mod+Shift+Minus': () => opacity(-0.1),
    'Mod+Shift+Equal': () => opacity(0.1),
    'Mod+T': () => setThrough(!S.clickThrough),
    'Mod+P': () => B.arrange(),
    'Mod+Z': () => B.undo(),
    'Mod+Shift+Z': () => B.redo(),
    'Mod+C': () => doCopy(false),
    'Mod+X': () => doCopy(true),
    'Mod+D': () => B.duplicate(),
    'Delete': () => B.deleteSelection(),
    'Backspace': () => B.deleteSelection(),
    'Mod+A': () => B.selectAll(),
    'Alt+G': () => B.toggleField('gray'),
    'Mod+Alt+G': () => B.setGrayCanvas(!B.grayCanvas),
    'Alt+Shift+H': () => B.toggleField('flipX'),
    'Alt+Shift+V': () => B.toggleField('flipY'),
    'Mod+Shift+C': () => B.resetCrop(),
    'Mod+Shift+T': () => B.resetTransform(),
    'Mod+R': () => B.setLockedCanvas(!B.lockedCanvas),
    'Mod+W': toggleWindowLock,
    'Alt+L': () => B.toggleField('locked'),
    'Mod+N': () => B.addNote(),
    'Mod+I': addDialog,
    'Mod+K': () => newBoard(),
    'Mod+L': () => { setSidebar(true); $('#search').focus(); },
    'Mod+Shift+P': () => { setSidebar(true); $('#search').focus(); },
    'Mod+S': async () => { if (S.current && S.current.scratch) return saveModal(); await api.flush(); toast('Saved'); },
    'Mod+Q': () => api.close(),
    'Mod+M': () => api.minimize(),
    'Mod+F': () => api.maximize(),
    'Mod+0': () => { const c = B.toWorld(innerWidth / 2, innerHeight / 2); B.view = { s: 1, x: innerWidth / 2 - c.x, y: innerHeight / 2 - c.y }; B.applyView(); },
    'Mod+Equal': () => B.zoomAt(innerWidth / 2, innerHeight / 2, 1.25),
    'Mod+Minus': () => B.zoomAt(innerWidth / 2, innerHeight / 2, 0.8),
    'Mod+Space': () => B.focusAll(),
    'Left': () => B.focusStep(-1),
    'Right': () => B.focusStep(1),
    'Up': () => B.front(),
    'Down': () => B.back(),
    'Mod+Up': () => B.align('top'),
    'Mod+Down': () => B.align('bottom'),
    'Mod+Left': () => B.align('left'),
    'Mod+Right': () => B.align('right'),
    'Mod+Alt+Left': () => B.normalize('height'),
    'Mod+Alt+Right': () => B.normalize('width'),
    'Mod+Alt+Up': () => B.normalize('size'),
    'Mod+Alt+Down': () => B.normalize('scale'),
    'G': () => B.setGrid(!B.grid),
    'Enter': () => { const ids = B.selIds(); if (ids.length === 1 && B.items.get(ids[0]).type === 'note') B.editNote(ids[0]); },
    'K': () => B.togglePlay(),
    'I': () => B.setInOut('in'),
    'O': () => B.setInOut('out'),
    'F': () => B.grabFrame(),
    'M': () => B.toggleMute(),
    'Comma': () => B.step(-1),
    'Period': () => B.step(1),
  };

  window.addEventListener('keydown', (e) => {
    const c = combo(e);
    if (modalOpen()) { if (e.key === 'Escape') closeModal(); return; }
    if (menuOpen()) {
      if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btns = $$('#menu button:not(:disabled)');
        const i = btns.indexOf(document.activeElement);
        const n = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
        if (n) n.focus();
        e.preventDefault();
      }
      return;
    }
    if (B.editingId) { if (e.key === 'Escape') { B.stopEditing(); e.preventDefault(); } return; }
    const inField = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (inField) return;
    if (!S.current && !['Mod+K', 'Mod+Q', 'Mod+M', 'Mod+F', 'Mod+L', 'Mod+Shift+P'].includes(c)) return;

    // Held keys for drag tools (PureRef: C crop, V pan crop, Z zoom, Space)
    if (!e.metaKey && !e.ctrlKey && !e.altKey && ['KeyC', 'KeyV', 'KeyZ', 'Space'].includes(e.code)) {
      const k = e.code === 'Space' ? ' ' : e.code.slice(3).toLowerCase();
      if (!B.held.has(k)) { B.held.add(k); if (k === ' ') spaceUsed = false; canvasCursor(); }
      if (k === ' ') e.preventDefault();
      return;
    }
    const helpCombo = IS_MAC ? (e.ctrlKey && !e.metaKey && e.code === 'KeyH') : c === 'Mod+H';
    if (helpCombo) { e.preventDefault(); return shortcutsModal(); }
    if (c === 'Escape') { if (S.clickThrough) return setThrough(false); B.clearSel(); return; }
    const fn = actions[c];
    if (fn) { e.preventDefault(); fn(); }
  });

  window.addEventListener('keyup', (e) => {
    if (['KeyC', 'KeyV', 'KeyZ', 'Space'].includes(e.code)) {
      const k = e.code === 'Space' ? ' ' : e.code.slice(3).toLowerCase();
      const had = B.held.delete(k);
      canvasCursor();
      if (k === ' ' && had && !spaceUsed && !B.editingId && !(e.target.closest && e.target.closest('input, textarea, [contenteditable]')) && S.current) B.focusSelection();
    }
  });
  window.addEventListener('blur', () => { B.held.clear(); canvasCursor(); });
  $('#canvas').addEventListener('pointerdown', () => { if (B.held.has(' ')) spaceUsed = true; }, true);
  function canvasCursor() { $('#canvas').classList.toggle('crop-mode', B.held.has('c') || B.held.has('v')); }

  start();
})();
