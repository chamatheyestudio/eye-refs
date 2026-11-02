// App shell: setup, sidebar, top bar, presence, toolbar, shortcuts, dialogs.
(function () {
  const { $, $$, el, toast, openMenu, closeMenu, menuOpen, openModal, modalOpen, closeModal, keyLabel, IS_MAC, avatarColor, initials } = window.UI;
  const api = window.eyerefs;
  const B = window.Board;
  fillIcons();

  const S = {
    me: null, team: null, projects: [], current: null, status: 'saved', readOnly: false,
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
    s.append(card, el('div', { class: 'credit', text: 'Eye Refs Beta by Matte Black' }));
    s.hidden = false;
    const f = s.querySelector('input'); if (f) f.focus();
  }

  function screenFor(r) {
    if (r.screen === 'no-drive') {
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Eye Refs' }), el('span', { class: 'beta', text: 'Beta' }),
        el('p', { text: 'Eye Refs saves everything in Google Drive. Install Google Drive for desktop and sign in with your eyestudio.ae account.' }),
        el('div', { class: 'btns' },
          el('button', { class: 'btn', text: 'Get Google Drive for desktop', onclick: () => api.downloadDrive() }),
          el('button', { class: 'btn ghost', text: 'Try again', onclick: start })),
        el('button', { class: 'linkish', text: 'Choose my Drive folder myself', onclick: async () => route(await api.chooseDrive()) })));
    } else if (r.screen === 'wrong-account') {
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Use your studio account' }),
        el('p', { text: `Google Drive is signed in as ${(r.emails || []).join(', ') || 'another account'}. Add your eyestudio.ae account in Google Drive for desktop, then try again.` }),
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Try again', onclick: start }))));
    } else if (r.screen === 'who') {
      const input = el('input', { class: 'input', type: 'email', placeholder: 'name@eyestudio.ae', id: 'whoEmail', 'aria-label': 'Your eyestudio.ae email' });
      const err = el('div', { class: 'err' });
      const go = async () => { const res = await api.setIdentity(input.value.trim()); if (res && res.error) err.textContent = res.error; else route(res); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Eye Refs' }),
        el('p', { text: 'Enter the eyestudio.ae email you use in Google Drive.' }),
        input, err,
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Continue', onclick: go }))));
    } else if (r.screen === 'no-team') {
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Add the team folder' }),
        el('ol', null,
          el('li', { text: 'Open the email sharing "Eye Refs Team" with you.' }),
          el('li', { text: 'Choose Add shortcut to Drive, then My Drive.' }),
          el('li', { text: 'Come back and press Try again.' })),
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Try again', onclick: start })),
        el('button', { class: 'linkish', text: 'Set up a new team as admin', onclick: async () => route(await api.createTeam()) })));
    } else {
      screen(() => el('div', { style: 'display:contents' },
        el('h1', { text: 'Something went wrong' }),
        el('p', { text: r.error || 'Eye Refs could not start.' }),
        el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Try again', onclick: start }))));
    }
  }

  async function start() { route(await api.boot()); }

  async function route(r) {
    if (!r || r.error || r.screen !== 'app') return screenFor(r || { error: 'No response' });
    $('#screen').hidden = true;
    S.me = r.me; S.team = r.team; S.projects = r.projects;
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
    if (r.openFile) return openResult(await api.openProjectFile(r.openFile));
    if (S.current) return;
    const last = r.lastProject && S.projects.find((p) => p.id === r.lastProject);
    if (last) openResult(await api.openProject(last.id));
    else if (!S.projects.length) newProjectModal();
    syncChrome();
  }

  // ---------- projects ----------
  function openResult(res) {
    if (!res || res.error) { toast((res && res.error) || 'Could not open that project.', true); return; }
    S.current = res.record;
    S.status = res.status;
    S.readOnly = res.readOnly;
    S.here = res.record.here || [];
    if (!S.projects.find((p) => p.id === res.record.id)) S.projects.push(res.record);
    S.expanded.add(res.record.client);
    saveExpanded();
    B.load(res);
    syncChrome();
    renderSidebar();
  }

  async function rescan() {
    const r = await api.scan();
    if (!r || r.error) return;
    S.team = r.team || S.team;
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
      if (S.filter === 'shared' && p.mine) return false;
      if (q && !(`${p.name} ${p.client} ${p.owner ? p.owner.name : ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const clients = [...new Set([...(S.team ? S.team.clients : []), ...S.projects.map((p) => p.client)])].sort((a, b) => a.localeCompare(b));
    for (const c of clients) {
      const list = shown.filter((p) => p.client === c).sort((a, b) => a.name.localeCompare(b.name));
      if ((q || S.filter !== 'all') && !list.length) continue;
      const open = q ? true : S.expanded.has(c);
      const row = el('button', { class: 'row' + (open && list.length ? ' open' : '') + (list.length ? '' : ' empty-client'), role: 'treeitem', 'aria-expanded': String(open) },
        el('span', { html: ICONS.chev, style: 'display:flex;visibility:' + (list.length ? 'visible' : 'hidden') }),
        el('span', { class: 'name', text: c }));
      row.addEventListener('click', () => {
        if (!list.length) return newProjectModal(c);
        if (S.expanded.has(c)) S.expanded.delete(c); else S.expanded.add(c);
        saveExpanded(); renderSidebar();
      });
      tree.append(row);
      if (!open) continue;
      for (const p of list) {
        const n = others(p.here).length;
        const meta = n
          ? el('span', { class: 'meta here', html: ICONS.people + `<span>${n} here</span>` })
          : !p.mine && p.owner ? el('span', { class: 'meta', text: `${p.owner.name}'s` }) : null;
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
  $('#newProject').addEventListener('click', () => newProjectModal());
  $('#hideSidebar').addEventListener('click', () => setSidebar(false));
  $('#showSidebar').addEventListener('click', () => setSidebar(true));
  $('#account').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const isAdmin = S.team && S.team.admin && S.team.admin.email === S.me.email;
    openMenu([
      { label: 'Manage clients', onClick: manageClients, disabled: !isAdmin },
      { label: 'Keyboard shortcuts', key: IS_MAC ? 'Ctrl+H' : 'Mod+H', onClick: shortcutsModal },
      '-',
      { label: 'Show project in folder', onClick: () => api.reveal(), disabled: !S.current },
      { label: 'Choose Drive folder', onClick: async () => route(await api.chooseDrive()) },
      '-',
      { label: `Eye Refs ${versionLabel()}`, disabled: true },
    ], r.left, r.top - 190);
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
    $('#tClient').textContent = p.client;
    $('#tLock').hidden = !B.lockedCanvas;
    const st = $('#tStatus');
    st.classList.remove('warn');
    if (S.readOnly || S.status === 'readonly') { st.innerHTML = ''; st.append(el('span', { html: ICONS.lock }), 'View only'); }
    else if (S.status === 'saving') { st.textContent = 'Saving'; }
    else if (S.status === 'local') { st.textContent = 'Saved on this computer'; st.classList.add('warn'); st.title = "Couldn't reach your Drive folder. Your work is safe on this computer and will sync once Drive is back."; }
    else { st.innerHTML = ICONS.check; st.append('Saved'); }
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

  $('#tName').addEventListener('dblclick', () => { if (S.current && S.current.mine) renameModal(); });
  $('#share').addEventListener('click', async () => {
    const r = await api.share();
    if (r && r.opened === 'folder') toast('Right click the project folder and choose Share with Google Drive.');
    else if (r && r.opened === 'drive') toast('Opened in Google Drive. Add your teammates there with edit access.');
  });
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
    { label: 'Share', onClick: () => $('#share').click(), disabled: S.readOnly },
    { label: 'Rename project', onClick: renameModal, disabled: !S.current || !S.current.mine },
    { label: 'Show in folder', onClick: () => api.reveal() },
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
  function newProjectModal(presetClient) {
    const clients = S.team ? S.team.clients : [];
    const isAdmin = S.team && S.team.admin && S.team.admin.email === S.me.email;
    if (!clients.length) {
      return openModal((close) => [
        el('h2', { text: 'No clients yet' }),
        el('p', { text: isAdmin ? 'Add your clients first. Everyone in the studio picks from this list.' : `Ask ${S.team && S.team.admin ? S.team.admin.name : 'the admin'} to add clients to Eye Refs.` }),
        el('div', { class: 'actions' },
          el('button', { class: 'btn ghost', text: 'Close', onclick: close }),
          isAdmin ? el('button', { class: 'btn', text: 'Add clients', onclick: () => { close(); manageClients(); } }) : null),
      ]);
    }
    openModal((close) => {
      const name = el('input', { class: 'input', id: 'npName', placeholder: 'Spring Campaign', maxlength: '60' });
      const client = el('select', { class: 'input', id: 'npClient' }, clients.map((c) => el('option', { value: c, text: c, selected: c === (presetClient || (S.current && S.current.client)) })));
      const err = el('p', { style: 'color:#F2C9B8;font-size:12px' });
      const go = async () => {
        if (!name.value.trim()) { err.textContent = 'Give the project a name.'; return; }
        const res = await api.createProject(name.value.trim(), client.value);
        if (res && res.error) { err.textContent = res.error; return; }
        close();
        openResult(res);
        rescan();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      return [
        el('h2', { text: 'New project' }),
        el('div', { class: 'field' }, el('label', { for: 'npName', text: 'Name' }), name),
        el('div', { class: 'field' }, el('label', { for: 'npClient', text: 'Client' }), client),
        err,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn', text: 'Create project', onclick: go })),
      ];
    });
  }

  function manageClients() {
    let list = [...(S.team ? S.team.clients : [])];
    openModal((close) => {
      const box = el('div', { class: 'list' });
      const draw = () => {
        box.innerHTML = '';
        for (const c of list) box.append(el('div', { class: 'li' }, el('span', { class: 'grow', text: c }), el('button', { class: 'btn ghost', style: 'height:32px;padding:0 12px', text: 'Remove', onclick: () => { list = list.filter((x) => x !== c); draw(); } })));
        if (!list.length) box.append(el('p', { text: 'No clients yet.' }));
      };
      draw();
      const input = el('input', { class: 'input', id: 'mcName', placeholder: 'Client name', maxlength: '60' });
      const add = () => { const v = input.value.trim(); if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) { list.push(v); list.sort((a, b) => a.localeCompare(b)); draw(); } input.value = ''; input.focus(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      const save = async () => {
        const r = await api.saveClients(list);
        if (r && r.error) return toast(r.error, true);
        S.team = r; close(); renderSidebar(); toast('Client list saved');
      };
      return [
        el('h2', { text: 'Clients' }),
        el('p', { text: 'Everyone sees these folders. Removing a client hides it from the list but keeps its folder and projects.' }),
        el('div', { style: 'display:flex;gap:8px' }, input, el('button', { class: 'btn ghost', text: 'Add', onclick: add })),
        box,
        el('div', { class: 'actions' }, el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }), el('button', { class: 'btn', text: 'Save', onclick: save })),
      ];
    });
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
    ['Window', [['Always on top', 'Mod+Shift+A'], ['Click through', 'Mod+T'], ['See through', 'Mod+Shift+-  /  Mod+Shift+='], ['Lock window', 'Mod+W'], ['New project', 'Mod+K'], ['Search projects', 'Mod+Shift+P'], ['Add images', 'Mod+I']]],
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
    'Mod+K': () => newProjectModal(),
    'Mod+L': () => { setSidebar(true); $('#search').focus(); },
    'Mod+Shift+P': () => { setSidebar(true); $('#search').focus(); },
    'Mod+S': async () => { await api.flush(); toast('Saved'); },
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
