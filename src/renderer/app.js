/* Trantor — renderer
   Schede + pannelli divisi (stile tmux), barra laterale cartelle, salto rapido, palette comandi. */
'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Palette ANSI coerente con Yaru Dark (github.com/ubuntu/yaru):
// accenti ufficiali blue #0073E5, purple #7764D8, red #DA3450, yellow #C88800,
// prussiangreen #308280; varianti chiare per lo sfondo scuro; verdi del profilo Ubuntu.
const TERM_THEME = {
  background: '#1D1D1D', foreground: '#F7F7F7', cursor: '#F7F7F7', cursorAccent: '#1D1D1D',
  selectionBackground: 'rgba(0, 115, 229, 0.45)', selectionInactiveBackground: 'rgba(0, 115, 229, 0.25)',
  black: '#3D3D3D', red: '#DA3450', green: '#26A269', yellow: '#C88800', blue: '#0073E5', magenta: '#7764D8', cyan: '#308280', white: '#CCCCCC',
  brightBlack: '#878787', brightRed: '#FF7A71', brightGreen: '#33DA7A', brightYellow: '#F99B11', brightBlue: '#389AFE', brightMagenta: '#A597EC', brightCyan: '#58C7F5', brightWhite: '#FFFFFF'
};

const S = {
  cfg: null, info: null, profiles: [],
  tabs: [], activeTab: null,
  panes: new Map(),
  sidebarDir: null, sidebarEntries: [], sidebarSel: -1
};
let uid = 0;
// identificativi unici anche tra finestre diverse (un pannello può passare da una finestra all'altra)
const WIN_TOKEN = Math.random().toString(36).slice(2, 7);
const nextId = (p) => `${p}${WIN_TOKEN}${++uid}`;
const isWin = () => S.info.platform === 'win32';
const sep = () => S.info.sep;

// =========================================================================
// Utilità percorsi
// =========================================================================
function baseName(p) {
  if (!p) return '';
  const t = p.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(t)) return t + '\\';
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  return i >= 0 ? t.slice(i + 1) || p : t;
}
function prettyPath(p) {
  if (!p) return '';
  const h = S.info.home;
  if (p.toLowerCase() === h.toLowerCase()) return '~';
  if (p.toLowerCase().startsWith((h + sep()).toLowerCase())) return '~' + sep() + p.slice(h.length + 1);
  return p;
}
function samePath(a, b) {
  if (!a || !b) return false;
  const n = (x) => x.replace(/[\\/]+$/, '');
  return isWin() ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}
function joinPath(dir, name) {
  return dir.endsWith(sep()) ? dir + name : dir + sep() + name;
}
// Divide un percorso in segmenti cliccabili: [{label, path}]
function splitCrumbs(p) {
  const out = [];
  if (!p) return out;
  if (isWin()) {
    let rest = p;
    let root = '';
    const unc = p.match(/^(\\\\[^\\]+\\[^\\]+)(\\|$)/);
    if (unc) { root = unc[1] + '\\'; rest = p.slice(unc[0].length); }
    else { const m = p.match(/^[A-Za-z]:\\?/); if (m) { root = m[0].endsWith('\\') ? m[0] : m[0] + '\\'; rest = p.slice(m[0].length); } }
    out.push({ label: root.replace(/\\$/, '') || root, path: root });
    let acc = root;
    for (const part of rest.split('\\').filter(Boolean)) { acc = acc.endsWith('\\') ? acc + part : acc + '\\' + part; out.push({ label: part, path: acc }); }
  } else {
    out.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of p.split('/').filter(Boolean)) { acc += '/' + part; out.push({ label: part, path: acc }); }
  }
  return out;
}
function toPosix(p, kind) {
  if (kind === 'wsl') {
    const unc = p.match(/^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$/i);
    if (unc) return (unc[1] || '/').replace(/\\/g, '/');
    const d = p.match(/^([A-Za-z]):\\?(.*)$/);
    if (d) return `/mnt/${d[1].toLowerCase()}/${d[2].replace(/\\/g, '/')}`;
  }
  if (kind === 'gitbash') {
    const d = p.match(/^([A-Za-z]):\\?(.*)$/);
    if (d) return `/${d[1].toLowerCase()}/${d[2].replace(/\\/g, '/')}`;
  }
  return p.replace(/\\/g, '/');
}
// Comando "cd" corretto per ogni tipo di shell
function cdCommand(kind, p) {
  switch (kind) {
    case 'powershell': return `Set-Location -LiteralPath '${p.replace(/'/g, "''")}'\r`;
    case 'cmd': return `cd /d "${p}"\r`;
    case 'gitbash': case 'wsl': case 'bash': return ` cd '${toPosix(p, kind).replace(/'/g, `'\\''`)}'\r`;
    default: return `cd "${p}"\r`;
  }
}
function quoteForShell(kind, p) {
  if (kind === 'gitbash' || kind === 'wsl' || kind === 'bash') return `'${toPosix(p, kind).replace(/'/g, `'\\''`)}'`;
  if (kind === 'powershell') return /[\s'`$(){}&;]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p;
  return /\s/.test(p) ? `"${p}"` : p;
}

// =========================================================================
// Pannello terminale
// =========================================================================
class Pane {
  constructor(profile, cwd, opts = {}) {
    this.id = opts.id || nextId('p');
    this.profile = profile;
    this.cwd = cwd || S.info.home;
    this.title = '';
    this.alive = false;
    this.integ = { cwd: 0, start: 0, cmd: 0 }; // eventi ricevuti dalla shell (diagnostica)

    this.el = document.createElement('div');
    this.el.className = 'pane';
    this.el.innerHTML = `
      <div class="pane-header">
        <span class="shell-ico">${icon(profile.icon || 'terminal')}</span>
        <div class="p-path"></div>
        <span class="p-git"></span>
        <span class="p-title"></span>
        <div class="p-actions">
          <button class="icon-btn" data-act="split-h" title="Dividi a destra (Ctrl+Shift+D)">${icon('splitH')}</button>
          <button class="icon-btn" data-act="split-v" title="Dividi in basso (Ctrl+Shift+E)">${icon('splitV')}</button>
          <button class="icon-btn" data-act="zoom" title="Ingrandisci pannello (Ctrl+Shift+Z)">${icon('zoom')}</button>
          <button class="icon-btn" data-act="close" title="Chiudi pannello (Ctrl+Shift+W)">${icon('close')}</button>
        </div>
      </div>
      <div class="pane-term"></div>`;
    this.termEl = this.el.querySelector('.pane-term');
    this.pathEl = this.el.querySelector('.p-path');
    this.titleEl = this.el.querySelector('.p-title');
    this.gitEl = this.el.querySelector('.p-git');
    this.gitEl.addEventListener('click', (e) => { e.stopPropagation(); focusPane(this.id); if (!S.cfg.sidebarVisible) toggleSidebar(true); });

    this.el.addEventListener('mousedown', () => focusPane(this.id, false), true);
    this.el.querySelector('.p-actions').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'split-h') splitPane(this.id, 'h');
      if (act === 'split-v') splitPane(this.id, 'v');
      if (act === 'zoom') toggleZoom();
      if (act === 'close') closePane(this.id);
    });
    this.pathEl.addEventListener('click', (e) => {
      const c = e.target.closest('.crumb'); if (c) { this.cd(c.dataset.path); }
    });
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); paneMenu(this, e.clientX, e.clientY); });

    // Trascina una cartella da Esplora file → cd
    this.el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); this.el.classList.add('drop-target'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-target'));
    this.el.addEventListener('drop', async (e) => {
      e.preventDefault(); this.el.classList.remove('drop-target');
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      const paths = files.map((f) => window.yt.pathForFile(f));
      if (paths.length === 1 && await window.yt.isDir(paths[0])) this.cd(paths[0]);
      else this.term.paste(paths.map((p) => quoteForShell(this.profile.kind, p)).join(' ') + ' ');
    });

    this.term = new Terminal({
      fontFamily: S.cfg.fontFamily,
      fontSize: S.cfg.fontSize,
      lineHeight: 1.12,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 10000,
      theme: TERM_THEME,
      windowsPty: isWin() ? { backend: 'conpty' } : undefined,
      macOptionIsMeta: true
    });
    this.fit = new FitAddon.FitAddon();
    this.search = new SearchAddon.SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.serializer = new SerializeAddon.SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.yt.openUrl(uri)));
    const u11 = new Unicode11Addon.Unicode11Addon();
    this.term.loadAddon(u11);
    this.term.unicode.activeVersion = '11';

    // OSC 9;9 (Windows Terminal) e OSC 7 per conoscere la cartella corrente
    this.term.parser.registerOscHandler(9, (data) => {
      if (data.startsWith('9;')) { this.integ.cwd++; this.setCwd(data.slice(2).replace(/^"|"$/g, '')); return true; }
      return false;
    });
    this.term.parser.registerOscHandler(7, (data) => {
      try { const u = new URL(data); let p = decodeURIComponent(u.pathname); if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\'); this.setCwd(p); } catch {}
      return true;
    });
    // OSC 7777: comandi avviati/terminati (cronologia per cartella, disposizioni)
    this.term.parser.registerOscHandler(7777, (data) => { onShellEvent(this, data); return true; });
    this.term.onTitleChange((t) => { this.title = t; this.titleEl.textContent = t; this.titleEl.title = t; renderTabs(); });
    this.term.onData((d) => window.yt.write(this.id, d));
    this.term.attachCustomKeyEventHandler((e) => !handleShortcut(e, this));

    this.ro = new ResizeObserver(debounce(() => this.doFit(), 30));
    this.renderPath();
    setupPaneDrag(this);
  }

  async start(adopt) {
    this.term.open(this.termEl);
    if (window.WebglAddon) {
      try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); this.term.loadAddon(gl); } catch {}
    }
    this.ro.observe(this.termEl);
    this.doFit();
    if (adopt) {
      // shell già avviata in un'altra finestra: ripristina il contenuto e ricevi i dati in coda
      if (adopt.serialized) this.term.write(adopt.serialized);
      this.alive = true;
      window.yt.adopted(this.id);
      window.yt.resize(this.id, this.term.cols, this.term.rows);
      this.setCwd(adopt.cwd, true);
      return;
    }
    const res = await window.yt.spawn({ id: this.id, profile: this.profile, cwd: this.cwd, cols: this.term.cols, rows: this.term.rows, enhance: S.cfg.shellEnhancements !== false });
    this.alive = true;
    if (res && res.cwd) this.setCwd(res.cwd, true);
  }

  doFit() {
    if (!this.termEl.isConnected || this.termEl.offsetWidth < 20 || this.termEl.offsetHeight < 20) return;
    try { this.fit.fit(); } catch {}
    if (this.alive) window.yt.resize(this.id, this.term.cols, this.term.rows);
  }

  setCwd(p, initial) {
    if (!p) return;
    const changed = !samePath(p, this.cwd);
    this.cwd = p;
    this.renderPath();
    if (changed || initial) {
      recordVisit(p);
      paneCwdChanged(this);
      const tab = tabOfPane(this.id);
      if (tab && tab.focused === this.id) { if (tab === activeTab()) syncSidebar(); renderTabs(); }
      saveSessionSoon();
    }
  }

  renderPath() {
    const crumbs = splitCrumbs(this.cwd);
    const home = S.info.home;
    let html = '';
    let list = crumbs;
    // Accorcia: se dentro la home mostra "~"
    const hi = crumbs.findIndex((c) => samePath(c.path, home));
    if (hi >= 0) list = [{ label: '~', path: home }, ...crumbs.slice(hi + 1)];
    if (list.length > 5) list = [list[0], { label: '…', path: list[list.length - 4].path }, ...list.slice(-3)];
    list.forEach((c, i) => {
      if (i) html += `<span class="crumb-sep">${icon('chevronRight')}</span>`;
      html += `<button class="crumb ${i === list.length - 1 ? 'last' : ''}" data-path="${esc(c.path)}" title="${esc(c.path)}">${esc(c.label)}</button>`;
    });
    this.pathEl.innerHTML = html;
    this.pathEl.querySelectorAll('.crumb-sep .ico').forEach((s) => { s.setAttribute('width', 10); s.setAttribute('height', 10); });
  }

  cd(p) {
    if (!this.alive) return;
    window.yt.write(this.id, cdCommand(this.profile.kind, p));
    this.setCwd(p);
    this.term.focus();
  }

  dispose(keepShell) {
    this.ro.disconnect();
    if (!keepShell) window.yt.kill(this.id);
    this.term.dispose();
    this.el.remove();
  }
}

// =========================================================================
// Schede e albero dei pannelli
//  nodo: { type:'pane', id } | { type:'split', dir:'h'|'v', ratio, a, b }
// =========================================================================
function activeTab() { return S.tabs.find((t) => t.id === S.activeTab); }
function focusedPane() { const t = activeTab(); return t ? S.panes.get(t.focused) : null; }
function tabOfPane(pid) { return S.tabs.find((t) => findNode(t.root, pid)); }
function findNode(node, pid, parent = null) {
  if (!node) return null;
  if (node.type === 'pane') return node.id === pid ? { node, parent } : null;
  return findNode(node.a, pid, node) || findNode(node.b, pid, node);
}
function panesOf(node, out = []) {
  if (!node) return out;
  if (node.type === 'pane') out.push(node.id); else { panesOf(node.a, out); panesOf(node.b, out); }
  return out;
}
function profileById(id) { return S.profiles.find((p) => p.id === id) || defaultProfile(); }
function defaultProfile() { return S.profiles.find((p) => p.id === S.cfg.defaultProfile) || S.profiles[0]; }

async function newTab(profile, cwd, tree) {
  const tab = { id: nextId('t'), root: null, focused: null, zoomed: null, view: document.createElement('div') };
  tab.view.className = 'tab-view';
  $('#workspace').appendChild(tab.view);
  S.tabs.push(tab);
  const created = [];
  const build = (n) => {
    if (n.type === 'split') return { type: 'split', dir: n.dir, ratio: n.ratio || 0.5, a: build(n.a), b: build(n.b) };
    const p = new Pane(profileById(n.profile), n.cwd);
    p.startCmd = n.cmd || null;
    S.panes.set(p.id, p); created.push(p);
    return { type: 'pane', id: p.id };
  };
  tab.root = build(tree || { type: 'pane', profile: (profile || defaultProfile()).id, cwd: cwd || (focusedPane() && focusedPane().cwd) || S.info.home });
  tab.focused = panesOf(tab.root)[0];
  activateTab(tab.id);
  for (const p of created) {
    await p.start();
    if (p.startCmd) window.yt.write(p.id, p.startCmd + '\r');
  }
  focusPane(tab.focused);
  saveSessionSoon();
  return tab;
}

function activateTab(id) {
  S.activeTab = id;
  for (const t of S.tabs) t.view.classList.toggle('hidden', t.id !== id);
  const t = activeTab();
  renderTab(t);
  renderTabs();
  syncSidebar();
  const p = focusedPane();
  if (p) requestAnimationFrame(() => { p.doFit(); p.term.focus(); });
}

function closeTab(id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  for (const pid of panesOf(t.root)) { S.panes.get(pid)?.dispose(); S.panes.delete(pid); }
  t.view.remove();
  const idx = S.tabs.indexOf(t);
  S.tabs.splice(idx, 1);
  if (!S.tabs.length) { saveSessionNow(); window.yt.close(); return; }
  if (S.activeTab === id) activateTab(S.tabs[Math.min(idx, S.tabs.length - 1)].id); else renderTabs();
  saveSessionSoon();
}

function renderTab(tab) {
  if (!tab) return;
  const view = tab.view;
  view.innerHTML = '';
  const all = panesOf(tab.root);
  view.classList.toggle('single', all.length === 1);
  const build = (node) => {
    if (node.type === 'pane') return S.panes.get(node.id).el;
    const box = document.createElement('div');
    box.className = `split ${node.dir}`;
    const sa = document.createElement('div'); sa.className = 'slot';
    const sb = document.createElement('div'); sb.className = 'slot';
    sa.style.flex = `${node.ratio} 1 0`; sb.style.flex = `${1 - node.ratio} 1 0`;
    sa.appendChild(build(node.a)); sb.appendChild(build(node.b));
    const div = document.createElement('div'); div.className = 'divider';
    div.addEventListener('mousedown', (e) => startDividerDrag(e, node, box, sa, sb, div));
    div.addEventListener('dblclick', () => { node.ratio = 0.5; renderTab(tab); });
    box.append(sa, div, sb);
    return box;
  };
  if (tab.zoomed && S.panes.get(tab.zoomed)) view.appendChild(S.panes.get(tab.zoomed).el);
  else { tab.zoomed = null; view.appendChild(build(tab.root)); }
  for (const pid of all) S.panes.get(pid).el.classList.toggle('focused', pid === tab.focused);
  requestAnimationFrame(() => all.forEach((pid) => S.panes.get(pid).doFit()));
}

function startDividerDrag(e, node, box, sa, sb, div) {
  e.preventDefault();
  div.classList.add('dragging');
  const rect = box.getBoundingClientRect();
  const move = (ev) => {
    const r = node.dir === 'h' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    node.ratio = Math.min(0.9, Math.max(0.1, r));
    sa.style.flex = `${node.ratio} 1 0`; sb.style.flex = `${1 - node.ratio} 1 0`;
  };
  const up = () => { div.classList.remove('dragging'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveSessionSoon(); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function focusPane(pid, takeFocus = true) {
  const tab = tabOfPane(pid);
  if (!tab) return;
  const changed = tab.focused !== pid;
  tab.focused = pid;
  for (const id of panesOf(tab.root)) S.panes.get(id).el.classList.toggle('focused', id === pid);
  if (tab.id !== S.activeTab) activateTab(tab.id);
  if (takeFocus) S.panes.get(pid).term.focus();
  if (changed) { renderTabs(); syncSidebar(); renderDirCommands(); }
}

async function splitPane(pid, dir, cwd, profile) {
  const tab = tabOfPane(pid || (focusedPane() && focusedPane().id));
  if (!tab) return;
  pid = pid || tab.focused;
  const src = S.panes.get(pid);
  const hit = findNode(tab.root, pid);
  const p = new Pane(profile || src.profile, cwd || src.cwd);
  S.panes.set(p.id, p);
  const newSplit = { type: 'split', dir, ratio: 0.5, a: { type: 'pane', id: pid }, b: { type: 'pane', id: p.id } };
  if (!hit.parent) tab.root = newSplit;
  else if (hit.parent.a === hit.node) hit.parent.a = newSplit; else hit.parent.b = newSplit;
  tab.zoomed = null;
  tab.focused = p.id;
  renderTab(tab);
  await p.start();
  focusPane(p.id);
  saveSessionSoon();
  return p;
}

function closePane(pid) {
  const tab = tabOfPane(pid);
  if (!tab) return;
  const hit = findNode(tab.root, pid);
  if (!hit.parent) { closeTab(tab.id); return; }
  // trova il nonno per sostituire il padre con il fratello
  const sibling = hit.parent.a === hit.node ? hit.parent.b : hit.parent.a;
  const replaceIn = (node) => {
    if (node.type !== 'split') return false;
    if (node.a === hit.parent) { node.a = sibling; return true; }
    if (node.b === hit.parent) { node.b = sibling; return true; }
    return replaceIn(node.a) || replaceIn(node.b);
  };
  if (tab.root === hit.parent) tab.root = sibling; else replaceIn(tab.root);
  S.panes.get(pid)?.dispose();
  S.panes.delete(pid);
  if (tab.zoomed === pid) tab.zoomed = null;
  if (tab.focused === pid) tab.focused = panesOf(sibling)[0];
  renderTab(tab);
  focusPane(tab.focused);
  renderTabs();
  saveSessionSoon();
}

function toggleZoom() {
  const tab = activeTab(); if (!tab) return;
  if (panesOf(tab.root).length < 2) return;
  tab.zoomed = tab.zoomed ? null : tab.focused;
  renderTab(tab);
  renderTabs();
  focusedPane()?.term.focus();
}

// Sposta il focus nella direzione indicata, in base alla posizione dei pannelli
function moveFocus(dir) {
  const tab = activeTab(); if (!tab || tab.zoomed) return;
  const cur = S.panes.get(tab.focused).el.getBoundingClientRect();
  const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
  let best = null, bestD = Infinity;
  for (const pid of panesOf(tab.root)) {
    if (pid === tab.focused) continue;
    const r = S.panes.get(pid).el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ok = (dir === 'left' && r.right <= cur.left + 4) || (dir === 'right' && r.left >= cur.right - 4) ||
               (dir === 'up' && r.bottom <= cur.top + 4) || (dir === 'down' && r.top >= cur.bottom - 4);
    if (!ok) continue;
    const d = (dir === 'left' || dir === 'right') ? Math.abs(x - cx) + Math.abs(y - cy) * 2 : Math.abs(y - cy) + Math.abs(x - cx) * 2;
    if (d < bestD) { bestD = d; best = pid; }
  }
  if (best) focusPane(best);
}

// Ridimensiona il pannello attivo con la tastiera
function resizeFocused(dir) {
  const tab = activeTab(); if (!tab) return;
  const want = (dir === 'left' || dir === 'right') ? 'h' : 'v';
  const delta = (dir === 'right' || dir === 'down') ? 0.05 : -0.05;
  // cerca il primo antenato split con la giusta direzione
  const path = [];
  const walk = (node) => {
    if (node.type === 'pane') return node.id === tab.focused;
    path.push(node);
    if (walk(node.a) || walk(node.b)) return true;
    path.pop(); return false;
  };
  walk(tab.root);
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].dir === want) { path[i].ratio = Math.min(0.9, Math.max(0.1, path[i].ratio + delta)); renderTab(tab); saveSessionSoon(); return; }
  }
}

function cycleTab(step) {
  if (S.tabs.length < 2) return;
  const i = S.tabs.findIndex((t) => t.id === S.activeTab);
  activateTab(S.tabs[(i + step + S.tabs.length) % S.tabs.length].id);
}

// =========================================================================
// Barra delle schede
// =========================================================================
let dragTabId = null;
function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  for (const t of S.tabs) {
    const fp = S.panes.get(t.focused);
    const n = panesOf(t.root).length;
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === S.activeTab ? ' active' : '');
    el.draggable = true;
    el.title = fp ? `${fp.profile.name} — ${fp.cwd}` : '';
    el.innerHTML = `${icon(fp ? fp.profile.icon : 'terminal')}<span class="tab-title">${esc(fp ? (baseName(fp.cwd) || fp.title) : 'Terminale')}</span>` +
      (n > 1 ? `<span class="tab-badge" title="${n} pannelli">${t.zoomed ? '⤢ ' : ''}${n}</span>` : '') +
      `<button class="tab-close" title="Chiudi scheda (Ctrl+Shift+Q)">${icon('close')}</button>`;
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    el.addEventListener('click', (e) => { if (e.target.closest('.tab-close')) closeTab(t.id); else activateTab(t.id); });
    el.addEventListener('dragstart', () => { dragTabId = t.id; });
    el.addEventListener('dragover', (e) => { if (dragTabId) { e.preventDefault(); el.classList.add('drag-over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('drag-over');
      if (!dragTabId || dragTabId === t.id) return;
      const from = S.tabs.findIndex((x) => x.id === dragTabId);
      const [moved] = S.tabs.splice(from, 1);
      S.tabs.splice(S.tabs.indexOf(t), 0, moved);
      dragTabId = null; renderTabs(); saveSessionSoon();
    });
    box.appendChild(el);
  }
  const fp = focusedPane();
  document.title = fp ? `${baseName(fp.cwd)} — Trantor` : 'Trantor';
}

// =========================================================================
// Cronologia cartelle (frecency) e preferiti
// =========================================================================
function recordVisit(p) {
  const h = S.cfg.history;
  const key = Object.keys(h).find((k) => samePath(k, p)) || p;
  h[key] = { count: (h[key]?.count || 0) + 1, last: Date.now() };
  const keys = Object.keys(h);
  if (keys.length > 400) {
    keys.sort((a, b) => frecency(h[a]) - frecency(h[b])).slice(0, keys.length - 400).forEach((k) => delete h[k]);
  }
  saveCfgSoon();
  renderRecent();
}
function frecency(e) {
  const age = Date.now() - e.last;
  const w = age < 3600e3 ? 4 : age < 86400e3 ? 2 : age < 7 * 86400e3 ? 1 : 0.4;
  return e.count * w;
}
function recentDirs(n = 8) {
  return Object.entries(S.cfg.history).sort((a, b) => frecency(b[1]) - frecency(a[1])).map(([p]) => p).slice(0, n);
}
function isBookmarked(p) { return S.cfg.bookmarks.some((b) => samePath(b, p)); }
function toggleBookmark(p) {
  if (!p) return;
  if (isBookmarked(p)) { S.cfg.bookmarks = S.cfg.bookmarks.filter((b) => !samePath(b, p)); toast('Rimosso dai preferiti'); }
  else { S.cfg.bookmarks.push(p); toast(`★ ${baseName(p)} aggiunto ai preferiti`); }
  saveCfgSoon();
  renderBookmarks();
  renderLocation();
}

const saveCfgSoon = debounce(() => window.yt.saveConfig({ history: S.cfg.history, bookmarks: S.cfg.bookmarks }), 800);

// =========================================================================
// Sessione (layout + cartelle) salvata e ripristinata
// =========================================================================
function serializeSession() {
  const ser = (n) => n.type === 'pane'
    ? { type: 'pane', profile: S.panes.get(n.id).profile.id, cwd: S.panes.get(n.id).cwd }
    : { type: 'split', dir: n.dir, ratio: n.ratio, a: ser(n.a), b: ser(n.b) };
  return { tabs: S.tabs.map((t) => ser(t.root)), active: S.tabs.findIndex((t) => t.id === S.activeTab) };
}
function saveSessionNow() { if (S.info && S.info.secondary) return; if (S.tabs.length) window.yt.saveConfig({ session: serializeSession(), history: S.cfg.history, bookmarks: S.cfg.bookmarks }); }
const saveSessionSoon = debounce(saveSessionNow, 1000);
window.addEventListener('beforeunload', saveSessionNow);

// =========================================================================
// Barra laterale: navigazione cartelle
// =========================================================================
async function syncSidebar(force) {
  const p = focusedPane();
  if (!p) return;
  if (!force && samePath(S.sidebarDir, p.cwd)) { renderLocation(); return; }
  S.sidebarDir = p.cwd;
  renderLocation();
  S.project = null; S.gitIndex = null;
  renderDirCommands();
  await loadSidebarList();
  renderBookmarks();
  renderRecent();
  refreshProject();
}

function renderLocation() {
  const dir = S.sidebarDir;
  const crumbs = splitCrumbs(dir);
  $('#sb-crumbs').innerHTML = '<div class="crumbs-inner">' + crumbs.map((c, i) =>
    (i ? `<span class="crumb-sep">›</span>` : '') +
    `<button class="crumb ${i === crumbs.length - 1 ? 'last' : ''}" data-path="${esc(c.path)}" title="${esc(c.path)}">${esc(c.label)}</button>`).join('') + '</div>';
  const star = $('#sb-star');
  const on = isBookmarked(dir);
  star.innerHTML = icon(on ? 'starFilled' : 'star');
  star.classList.toggle('on', on);
  star.title = on ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
}

async function loadSidebarList() {
  const dir = S.sidebarDir;
  const res = await window.yt.list(dir, S.cfg.showHidden);
  if (dir !== S.sidebarDir) return;
  S.sidebarEntries = res.ok ? res.entries : [];
  S.sidebarError = res.ok ? null : res.error;
  renderSidebarList();
}

function filteredEntries() {
  const q = $('#sb-filter').value.trim().toLowerCase();
  if (!q || looksLikePath(q)) return S.sidebarEntries;
  return S.sidebarEntries
    .map((e) => ({ e, s: fuzzyScore(e.name, q) }))
    .filter((x) => x.s > -Infinity)
    .sort((a, b) => (b.e.isDir - a.e.isDir) || (b.s - a.s))
    .map((x) => x.e);
}

function renderSidebarList() {
  const ul = $('#sb-list');
  const list = filteredEntries();
  if (S.sidebarSel >= list.length) S.sidebarSel = list.length - 1;
  if (S.sidebarError) { ul.innerHTML = `<div class="sb-empty">Impossibile leggere la cartella (${esc(S.sidebarError)})</div>`; return; }
  if (!list.length) { ul.innerHTML = `<div class="sb-empty">${$('#sb-filter').value ? 'Nessuna corrispondenza' : 'Cartella vuota'}</div>`; return; }
  const max = 600;
  ul.innerHTML = list.slice(0, max).map((e, i) =>
    `<li class="${e.isDir ? 'dir' : 'file'} ${e.hidden ? 'hidden-entry' : ''} ${i === S.sidebarSel ? 'sel' : ''}" data-i="${i}" title="${esc(e.name)}">${icon(e.isDir ? 'folder' : 'file')}<span class="lbl">${esc(e.name)}</span>${gitMark(e)}</li>`
  ).join('') + (list.length > max ? `<div class="sb-empty">…altri ${list.length - max} elementi</div>` : '');
  ul.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
}

function renderBookmarks() {
  const ul = $('#sb-bookmarks');
  if (!S.cfg.bookmarks.length) { ul.innerHTML = '<div class="sb-empty">Usa ☆ per salvare una cartella</div>'; return; }
  ul.innerHTML = S.cfg.bookmarks.map((b, i) =>
    `<li data-path="${esc(b)}" class="${samePath(b, S.sidebarDir) ? 'current' : ''}" title="${esc(b)}">${icon(samePath(b, S.info.home) ? 'home' : 'starFilled')}<span class="lbl">${esc(baseName(b) || b)}</span>${i < 9 ? `<span class="sub">Alt+${i + 1}</span>` : ''}<button class="rm" data-rm="${esc(b)}" title="Rimuovi">${icon('close')}</button></li>`
  ).join('');
}

function renderRecent() {
  const ul = $('#sb-recent');
  const rec = recentDirs(10).filter((p) => !samePath(p, S.sidebarDir) && !isBookmarked(p)).slice(0, 6);
  if (!rec.length) { ul.innerHTML = '<div class="sb-empty">Nessuna cartella recente</div>'; return; }
  ul.innerHTML = rec.map((p) => `<li data-path="${esc(p)}" title="${esc(p)}">${icon('clock')}<span class="lbl">${esc(baseName(p))}</span><span class="sub">${esc(prettyPath(p.slice(0, Math.max(0, p.length - baseName(p).length - 1))))}</span></li>`).join('');
}

async function renderDrives() {
  const drives = await window.yt.drives();
  $('#sb-drives').innerHTML = drives.map((d) => `<li data-path="${esc(d)}" title="${esc(d)}">${icon('drive')}<span class="lbl">${esc(d.replace(/\\$/, ''))}</span></li>`).join('');
}

function looksLikePath(q) { return /^([a-z]:|\\\\|\/|~|\.\.?([\\/]|$))/i.test(q); }

async function sidebarSubmit(mode) {
  const p = focusedPane(); if (!p) return;
  const q = $('#sb-filter').value.trim();
  if (q && looksLikePath(q)) {
    let target = q.startsWith('~') ? S.info.home + q.slice(1) : q;
    target = await window.yt.resolve(S.sidebarDir, target);
    if (await window.yt.isDir(target)) { clearSidebarFilter(); openDir(target, mode); }
    else toast('Cartella non trovata');
    return;
  }
  const list = filteredEntries();
  const e = list[S.sidebarSel >= 0 ? S.sidebarSel : list.findIndex((x) => x.isDir)];
  if (!e) return;
  const full = joinPath(S.sidebarDir, e.name);
  clearSidebarFilter();
  if (e.isDir) openDir(full, mode); else { p.term.paste(quoteForShell(p.profile.kind, full) + ' '); p.term.focus(); }
}
function clearSidebarFilter() { $('#sb-filter').value = ''; S.sidebarSel = -1; renderSidebarList(); }

// mode: 'cd' | 'tab' | 'h' | 'v'
function openDir(dir, mode = 'cd') {
  const p = focusedPane();
  if (mode === 'tab' && layoutFor(dir)) return openLayout(layoutFor(dir));
  if (mode === 'tab' || !p) return newTab(p ? p.profile : null, dir);
  if (mode === 'h' || mode === 'v') return splitPane(p.id, mode, dir);
  p.cd(dir);
}

function dirMenu(path, x, y) {
  showMenu([
    { label: 'Entra qui', icon: 'jump', run: () => openDir(path, 'cd') },
    { label: 'Apri in nuova scheda', icon: 'plus', kbd: 'Ctrl+clic', run: () => openDir(path, 'tab') },
    { label: 'Apri in un pannello a destra', icon: 'splitH', kbd: 'Shift+clic', run: () => openDir(path, 'h') },
    { label: 'Apri in un pannello sotto', icon: 'splitV', kbd: 'Alt+clic', run: () => openDir(path, 'v') },
    '-',
    { label: isBookmarked(path) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti', icon: 'star', run: () => toggleBookmark(path) },
    { label: 'Apri in Esplora file', icon: 'external', run: () => window.yt.openPath(path) },
    { label: 'Copia percorso', icon: 'copy', run: () => { window.yt.writeClipboard(path); toast('Percorso copiato'); } }
  ], x, y);
}
function clickMode(e) { return e.ctrlKey || e.button === 1 ? 'tab' : e.shiftKey ? 'h' : e.altKey ? 'v' : 'cd'; }

function setupSidebar() {
  $('#sb-up').innerHTML = icon('up');
  $('#sb-explorer').innerHTML = icon('external');
  $('.sb-search-icon').innerHTML = icon('search');
  updateHiddenBtn();

  $('#sb-up').onclick = async () => { const par = await window.yt.parent(S.sidebarDir); if (!samePath(par, S.sidebarDir)) openDir(par); };
  $('#sb-star').onclick = () => toggleBookmark(S.sidebarDir);
  $('#sb-explorer').onclick = () => window.yt.openPath(S.sidebarDir);
  $('#sb-hidden').onclick = () => toggleHidden();
  $('#sb-crumbs').addEventListener('click', (e) => { const c = e.target.closest('.crumb'); if (c) openDir(c.dataset.path, clickMode(e)); });

  const pathLists = ['#sb-bookmarks', '#sb-recent', '#sb-drives'];
  for (const sel of pathLists) {
    const ul = $(sel);
    ul.addEventListener('click', (e) => {
      const rm = e.target.closest('.rm');
      if (rm) { e.stopPropagation(); toggleBookmark(rm.dataset.rm); return; }
      const li = e.target.closest('li[data-path]'); if (li) openDir(li.dataset.path, clickMode(e));
    });
    ul.addEventListener('auxclick', (e) => { const li = e.target.closest('li[data-path]'); if (li && e.button === 1) openDir(li.dataset.path, 'tab'); });
    ul.addEventListener('contextmenu', (e) => { const li = e.target.closest('li[data-path]'); if (li) { e.preventDefault(); dirMenu(li.dataset.path, e.clientX, e.clientY); } });
  }

  const list = $('#sb-list');
  const entryAt = (li) => filteredEntries()[+li.dataset.i];
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    const en = entryAt(li); const full = joinPath(S.sidebarDir, en.name);
    if (en.isDir) { clearSidebarFilter(); openDir(full, clickMode(e)); }
    else { S.sidebarSel = +li.dataset.i; renderSidebarList(); }
  });
  list.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li.file'); if (!li) return;
    window.yt.openPath(joinPath(S.sidebarDir, entryAt(li).name));
  });
  list.addEventListener('auxclick', (e) => {
    const li = e.target.closest('li.dir'); if (li && e.button === 1) openDir(joinPath(S.sidebarDir, entryAt(li).name), 'tab');
  });
  list.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li'); if (!li) return; e.preventDefault();
    const en = entryAt(li); const full = joinPath(S.sidebarDir, en.name);
    if (en.isDir) return dirMenu(full, e.clientX, e.clientY);
    const p = focusedPane();
    showMenu([
      { label: 'Inserisci percorso nel terminale', icon: 'terminal', run: () => { p.term.paste(quoteForShell(p.profile.kind, full) + ' '); p.term.focus(); } },
      { label: 'Apri con l’app predefinita', icon: 'external', run: () => window.yt.openPath(full) },
      { label: 'Mostra in Esplora file', icon: 'folder', run: () => window.yt.showInFolder(full) },
      { label: 'Copia percorso', icon: 'copy', run: () => { window.yt.writeClipboard(full); toast('Percorso copiato'); } }
    ], e.clientX, e.clientY);
  });
  // Trascina un file dalla lista dentro un pannello → incolla il percorso
  list.addEventListener('mousedown', (e) => { if (e.detail > 1) e.preventDefault(); });

  const input = $('#sb-filter');
  input.addEventListener('input', () => { S.sidebarSel = filteredEntries().findIndex((x) => x.isDir); renderSidebarList(); });
  input.addEventListener('keydown', (e) => {
    const n = filteredEntries().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); S.sidebarSel = Math.min(n - 1, S.sidebarSel + 1); renderSidebarList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.sidebarSel = Math.max(0, S.sidebarSel - 1); renderSidebarList(); }
    else if (e.key === 'Enter') { e.preventDefault(); sidebarSubmit(e.ctrlKey ? 'tab' : e.shiftKey ? 'h' : e.altKey ? 'v' : 'cd'); }
    else if (e.key === 'Escape') { clearSidebarFilter(); focusedPane()?.term.focus(); }
    else if (e.key === 'Backspace' && !input.value) { $('#sb-up').click(); }
  });

  // Ridimensionamento sidebar
  const sb = $('#sidebar');
  sb.style.width = (S.cfg.sidebarWidth || 270) + 'px';
  sb.classList.toggle('collapsed', !S.cfg.sidebarVisible);
  $('#sidebar-resizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { const w = Math.min(520, Math.max(180, ev.clientX)); sb.style.width = w + 'px'; S.cfg.sidebarWidth = w; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.yt.saveConfig({ sidebarWidth: S.cfg.sidebarWidth }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
  renderDrives();
}

function toggleSidebar(show) {
  S.cfg.sidebarVisible = show ?? !S.cfg.sidebarVisible;
  $('#sidebar').classList.toggle('collapsed', !S.cfg.sidebarVisible);
  $('#btn-sidebar').classList.toggle('checked', S.cfg.sidebarVisible);
  window.yt.saveConfig({ sidebarVisible: S.cfg.sidebarVisible });
}
function focusSidebarFilter() {
  if (!S.cfg.sidebarVisible) toggleSidebar(true);
  const i = $('#sb-filter'); i.focus(); i.select();
}
function toggleHidden() {
  S.cfg.showHidden = !S.cfg.showHidden;
  window.yt.saveConfig({ showHidden: S.cfg.showHidden });
  updateHiddenBtn();
  loadSidebarList();
}
function updateHiddenBtn() {
  const b = $('#sb-hidden');
  b.innerHTML = icon(S.cfg.showHidden ? 'eye' : 'eyeOff');
  b.classList.toggle('on', S.cfg.showHidden);
  b.title = S.cfg.showHidden ? 'Nascondi file nascosti' : 'Mostra file nascosti';
}

// =========================================================================
// Ricerca fuzzy
// =========================================================================
function fuzzyScore(text, q) {
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 ? 50 : 0) - t.length * 0.1;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -Infinity;
    streak = f === ti ? streak + 1 : 0;
    score += 1 + streak * 2 - (f - ti) * 0.2;
    ti = f + 1;
  }
  return score - t.length * 0.05;
}
function highlight(text, q) {
  if (!q) return esc(text);
  const t = text.toLowerCase(); const ql = q.toLowerCase();
  const idx = t.indexOf(ql);
  if (idx >= 0) return esc(text.slice(0, idx)) + '<b>' + esc(text.slice(idx, idx + q.length)) + '</b>' + esc(text.slice(idx + q.length));
  let out = '', qi = 0;
  for (let i = 0; i < text.length; i++) {
    if (qi < ql.length && t[i] === ql[qi]) { out += '<b>' + esc(text[i]) + '</b>'; qi++; } else out += esc(text[i]);
  }
  return out;
}

// =========================================================================
// Picker generico (Salta a cartella / Palette comandi)
// =========================================================================
const picker = { items: [], filtered: [], sel: 0, onPick: null, source: null, query: '' };

function openPicker({ placeholder, iconName, hints, source, onPick }) {
  picker.source = source; picker.onPick = onPick; picker.sel = 0;
  $('#picker-input').placeholder = placeholder;
  $('.picker-icon').innerHTML = icon(iconName);
  $('#picker-hints').innerHTML = hints.map(([k, l]) => `<span><kbd>${k}</kbd> ${l}</span>`).join('');
  $('#overlay').classList.remove('hidden');
  const inp = $('#picker-input'); inp.value = ''; inp.focus();
  refreshPicker();
}
function closePicker(refocus = true) {
  $('#overlay').classList.add('hidden');
  picker.source = null;
  if (refocus) focusedPane()?.term.focus();
}
async function refreshPicker() {
  const q = $('#picker-input').value.trim();
  picker.query = q;
  const items = await picker.source(q);
  if (picker.query !== q) return;
  picker.filtered = items;
  picker.sel = Math.min(picker.sel, Math.max(0, items.length - 1));
  renderPicker();
}
function renderPicker() {
  const ul = $('#picker-list');
  if (!picker.filtered.length) { ul.innerHTML = '<li class="pk-empty">Nessun risultato</li>'; return; }
  ul.innerHTML = picker.filtered.map((it, i) =>
    `<li class="${i === picker.sel ? 'sel' : ''}" data-i="${i}">${icon(it.icon || 'folder')}<div class="pk-main"><span class="pk-label">${it.labelHtml || esc(it.label)}</span>${it.detail ? `<span class="pk-detail">${esc(it.detail)}</span>` : ''}</div>${it.tag ? `<span class="pk-tag">${esc(it.tag)}</span>` : ''}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</li>`
  ).join('');
  ul.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
}
function pickerKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); picker.sel = Math.min(picker.filtered.length - 1, picker.sel + 1); renderPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); picker.sel = Math.max(0, picker.sel - 1); renderPicker(); }
  else if (e.key === 'PageDown') { e.preventDefault(); picker.sel = Math.min(picker.filtered.length - 1, picker.sel + 8); renderPicker(); }
  else if (e.key === 'PageUp') { e.preventDefault(); picker.sel = Math.max(0, picker.sel - 8); renderPicker(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const it = picker.filtered[picker.sel]; if (!it) return;
    const mode = e.ctrlKey ? 'tab' : e.shiftKey ? 'h' : e.altKey ? 'v' : 'cd';
    const fn = picker.onPick; closePicker(false); fn(it, mode);
  }
}

// --- Salta a cartella ----------------------------------------------------
let walkCache = { root: null, dirs: [], at: 0 };
async function jumpSource(q) {
  const p = focusedPane();
  const cwd = p ? p.cwd : S.info.home;
  if (q && looksLikePath(q)) {
    let target = q.startsWith('~') ? S.info.home + q.slice(1) : q;
    target = await window.yt.resolve(cwd, target);
    const ok = await window.yt.isDir(target);
    const out = ok ? [{ path: target, label: target, icon: 'jump', tag: 'percorso' }] : [];
    // completamento: cartelle del genitore che iniziano col nome digitato
    const parent = await window.yt.parent(target);
    const res = await window.yt.list(parent, false);
    if (res.ok) {
      const stem = baseName(target).toLowerCase();
      for (const e of res.entries) if (e.isDir && e.name.toLowerCase().startsWith(stem) && !samePath(joinPath(parent, e.name), target)) out.push({ path: joinPath(parent, e.name), label: e.name, detail: parent, icon: 'folder' });
    }
    return out.slice(0, 50);
  }
  if (!samePath(walkCache.root, cwd) || Date.now() - walkCache.at > 30000) {
    walkCache = { root: cwd, dirs: await window.yt.walkDirs(cwd, 3, 2000), at: Date.now() };
  }
  const seen = new Set();
  const cands = [];
  const add = (path, tag, ic, boost) => {
    const k = isWin() ? path.toLowerCase() : path; if (seen.has(k)) return; seen.add(k);
    cands.push({ path, tag, icon: ic, boost });
  };
  S.cfg.bookmarks.forEach((b) => add(b, 'preferito', 'starFilled', 40));
  recentDirs(60).forEach((r, i) => add(r, 'recente', 'clock', 30 - i * 0.4));
  walkCache.dirs.forEach((d) => add(d, null, 'folder', 0));
  (await window.yt.drives()).forEach((d) => add(d, 'unità', 'drive', 0));

  const ql = q.toLowerCase();
  const scored = [];
  for (const c of cands) {
    const name = baseName(c.path);
    let s = 0;
    if (q) {
      const sn = fuzzyScore(name, ql);
      const sp = fuzzyScore(c.path, ql);
      if (sn === -Infinity && sp === -Infinity) continue;
      s = Math.max(sn * 2, sp) + c.boost;
    } else s = c.boost - (c.boost ? 0 : c.path.length * 0.01);
    scored.push({ ...c, s, label: name, labelHtml: highlight(name, q), detail: prettyPath(c.path) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 80);
}
function openJump() {
  openPicker({
    placeholder: 'Salta a cartella… (nome, parte del percorso, oppure C:\\percorso)',
    iconName: 'jump',
    hints: [['Invio', 'entra'], ['Ctrl+Invio', 'nuova scheda'], ['Shift+Invio', 'pannello a destra'], ['Alt+Invio', 'pannello sotto']],
    source: jumpSource,
    onPick: (it, mode) => openDir(it.path, mode)
  });
}

// --- Palette comandi -----------------------------------------------------
function commands() {
  const p = focusedPane();
  const list = [
    { label: 'Salta a cartella', icon: 'jump', kbd: 'Ctrl+G', run: openJump },
    { label: 'Filtra cartella corrente', icon: 'search', kbd: 'Ctrl+Shift+L', run: focusSidebarFilter },
    { label: 'Comandi usati in questa cartella', icon: 'history', kbd: 'Ctrl+H', run: openDirCommands },
    { label: 'Azioni del progetto', icon: 'box', kbd: 'Ctrl+Shift+R', run: openProjectActions },
    { label: 'Dispositivi in rete', icon: 'router', kbd: 'Ctrl+Shift+N', run: toggleNetView },
    { label: 'Scansiona la rete', icon: 'router', run: () => { if (S.sidebarMode !== 'net') toggleNetView(); setTimeout(startScan, 300); } },
    ...(S.project ? [{ label: `Salva la disposizione per ${S.project.name}`, icon: 'splitH', run: saveLayout }] : []),
    ...(S.project && layoutFor(S.project.root) ? [{ label: `Apri la disposizione di ${S.project.name}`, icon: 'splitH', run: () => openLayout(layoutFor(S.project.root)) }] : []),
    { label: `Attiva da solo l’ambiente Python: ${S.cfg.autoVenv ? 'attivo' : 'disattivo'}`, icon: 'python', run: toggleAutoVenv },
    { label: 'Nuova scheda', icon: 'plus', kbd: 'Ctrl+Shift+T', run: () => newTab() },
    ...S.profiles.map((pr) => ({ label: `Nuova scheda: ${pr.name}`, icon: pr.icon, run: () => newTab(pr) })),
    { label: 'Dividi a destra', icon: 'splitH', kbd: 'Ctrl+Shift+D', run: () => splitPane(null, 'h') },
    { label: 'Dividi in basso', icon: 'splitV', kbd: 'Ctrl+Shift+E', run: () => splitPane(null, 'v') },
    ...S.profiles.map((pr) => ({ label: `Dividi a destra con ${pr.name}`, icon: 'splitH', run: () => splitPane(null, 'h', null, pr) })),
    { label: 'Ingrandisci / ripristina pannello', icon: 'zoom', kbd: 'Ctrl+Shift+Z', run: toggleZoom },
    { label: 'Sposta il pannello in una nuova scheda', icon: 'plus', run: () => p && movePaneToNewTab(p.id) },
    { label: 'Stacca il pannello in una nuova finestra', icon: 'external', run: () => p && detachPane(p.id) },
    { label: 'Scambia il pannello con quello a destra', icon: 'splitH', kbd: 'Ctrl+Alt+Shift+→', run: () => swapWithNeighbor('right') },
    { label: 'Scambia il pannello con quello sotto', icon: 'splitV', kbd: 'Ctrl+Alt+Shift+↓', run: () => swapWithNeighbor('down') },
    { label: 'Chiudi pannello', icon: 'close', kbd: 'Ctrl+Shift+W', run: () => p && closePane(p.id) },
    { label: 'Chiudi scheda', icon: 'close', kbd: 'Ctrl+Shift+Q', run: () => closeTab(S.activeTab) },
    { label: 'Scheda successiva', icon: 'chevronRight', kbd: 'Ctrl+Tab', run: () => cycleTab(1) },
    { label: 'Scheda precedente', icon: 'chevronLeft', kbd: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
    { label: 'Mostra/nascondi barra cartelle', icon: 'sidebar', kbd: 'Ctrl+B', run: () => toggleSidebar() },
    { label: 'Cerca nel terminale', icon: 'search', kbd: 'Ctrl+Shift+F', run: openSearch },
    { label: 'Pulisci terminale', icon: 'terminal', kbd: 'Ctrl+Shift+K', run: () => p && p.term.clear() },
    { label: 'Cartella superiore', icon: 'up', kbd: 'Alt+Su', run: goUp },
    { label: 'Aggiungi/rimuovi cartella dai preferiti', icon: 'star', kbd: 'Ctrl+Shift+S', run: () => p && toggleBookmark(p.cwd) },
    { label: 'Apri cartella in Esplora file', icon: 'external', run: () => p && window.yt.openPath(p.cwd) },
    { label: 'Copia percorso cartella', icon: 'copy', run: () => { if (p) { window.yt.writeClipboard(p.cwd); toast('Percorso copiato'); } } },
    { label: S.cfg.showHidden ? 'Nascondi file nascosti' : 'Mostra file nascosti', icon: 'eye', run: toggleHidden },
    { label: 'Aumenta carattere', icon: 'plus', kbd: 'Ctrl+=', run: () => setFontSize(S.cfg.fontSize + 1) },
    { label: 'Riduci carattere', icon: 'minimize', kbd: 'Ctrl+-', run: () => setFontSize(S.cfg.fontSize - 1) },
    { label: 'Carattere predefinito', icon: 'terminal', kbd: 'Ctrl+0', run: () => setFontSize(14) },
    { label: `Suggerimenti e colori nella shell: ${S.cfg.shellEnhancements !== false ? 'attivo' : 'disattivo'}`, icon: 'command', run: toggleEnhancements },
    { label: `Ripristina sessione all’avvio: ${S.cfg.restoreSession ? 'attivo' : 'disattivo'}`, icon: 'clock', run: () => { S.cfg.restoreSession = !S.cfg.restoreSession; window.yt.saveConfig({ restoreSession: S.cfg.restoreSession }); toast(`Ripristino sessione ${S.cfg.restoreSession ? 'attivato' : 'disattivato'}`); } },
    ...S.profiles.map((pr) => ({ label: `Shell predefinita: ${pr.name}`, icon: pr.icon, tag: defaultProfile().id === pr.id ? 'attuale' : null, run: () => { S.cfg.defaultProfile = pr.id; window.yt.saveConfig({ defaultProfile: pr.id }); toast(`${pr.name} è ora la shell predefinita`); } })),
    { label: 'Scorciatoie da tastiera', icon: 'command', kbd: 'F1', run: showShortcuts },
    { label: 'Verifica integrazione della shell', icon: 'terminal', run: checkIntegration },
    { label: 'Controlla aggiornamenti', icon: 'up', run: () => checkUpdates(true) },
    { label: `Aggiornamenti automatici: ${S.cfg.autoUpdate !== false ? 'attivi' : 'disattivati'}`, icon: 'up', run: toggleAutoUpdate },
    { label: `Informazioni su Trantor ${S.info.version || ''}`, icon: 'terminal', run: () => toast(`Trantor ${S.info.version || ''} · licenza MIT`) }
  ];
  return list;
}
function openPalette() {
  openPicker({
    placeholder: 'Cerca un comando…',
    iconName: 'command',
    hints: [['↑↓', 'scegli'], ['Invio', 'esegui'], ['Esc', 'chiudi']],
    source: async (q) => {
      const ql = q.toLowerCase();
      return commands().map((c) => ({ ...c, s: q ? fuzzyScore(c.label, ql) : 0, labelHtml: highlight(c.label, q) }))
        .filter((c) => c.s > -Infinity).sort((a, b) => b.s - a.s);
    },
    onPick: (it) => it.run()
  });
}
function showShortcuts() {
  const rows = [
    ['Ctrl+G', 'Salta a cartella (fuzzy su preferiti, recenti, sottocartelle)'],
    ['Ctrl+Shift+L', 'Filtra il contenuto della cartella nella barra laterale'],
    ['Ctrl+H', 'Comandi usati in questa cartella'],
    ['Ctrl+Shift+R', 'Azioni del progetto (npm, docker, make…)'],
    ['Ctrl+Shift+N', 'Dispositivi in rete'],
    ['Alt+Su', 'Vai alla cartella superiore'],
    ['Alt+1…9', 'Vai al preferito n°'],
    ['Ctrl+Shift+D / E', 'Dividi pannello a destra / in basso'],
    ['Alt+Frecce', 'Sposta il focus tra i pannelli'],
    ['Ctrl+Alt+Frecce', 'Ridimensiona il pannello attivo'],
    ['Ctrl+Shift+Z', 'Ingrandisci/ripristina pannello (come tmux zoom)'],
    ['Ctrl+Alt+Shift+Frecce', 'Scambia il pannello con quello vicino'],
    ['Trascina l’intestazione', 'Sposta, scambia, porta in un’altra scheda o fuori dalla finestra'],
    ['Ctrl+Shift+W', 'Chiudi pannello'],
    ['Ctrl+Shift+T', 'Nuova scheda'],
    ['Ctrl+Tab / Ctrl+1…9', 'Cambia scheda'],
    ['Ctrl+C (con selezione) / Ctrl+V', 'Copia / incolla'],
    ['Ctrl+Shift+F', 'Cerca nel terminale'],
    ['→ / Fine', 'Accetta il suggerimento grigio (PowerShell)'],
    ['Ctrl+→', 'Accetta il suggerimento una parola alla volta'],
    ['Tab / Shift+Tab', 'Menu di completamento'],
    ['↑ / ↓', 'Cronologia filtrata da ciò che hai già scritto'],
    ['F2', 'Suggerimenti in linea ↔ elenco (PowerShell 7)'],
    ['Ctrl+Shift+P', 'Palette comandi'],
    ['Ctrl+B', 'Mostra/nascondi barra cartelle']
  ];
  openPicker({
    placeholder: 'Scorciatoie da tastiera',
    iconName: 'command',
    hints: [['Esc', 'chiudi']],
    source: async (q) => rows.filter(([k, l]) => !q || fuzzyScore(l + ' ' + k, q.toLowerCase()) > -Infinity).map(([k, l]) => ({ label: l, kbd: k, icon: 'command' })),
    onPick: () => {}
  });
}

// =========================================================================
// Ricerca nel terminale
// =========================================================================
function openSearch() {
  const p = focusedPane(); if (!p) return;
  const bar = $('#searchbar');
  const r = p.el.getBoundingClientRect();
  bar.style.top = (r.top + 36) + 'px';
  bar.style.right = (window.innerWidth - r.right + 12) + 'px';
  bar.classList.remove('hidden');
  const i = $('#search-input'); i.focus(); i.select();
}
function closeSearch() { $('#searchbar').classList.add('hidden'); focusedPane()?.search.clearDecorations(); focusedPane()?.term.focus(); }
function setupSearch() {
  $('#search-prev').innerHTML = icon('chevronUp');
  $('#search-next').innerHTML = icon('chevronDown');
  $('#search-close').innerHTML = icon('close');
  const opts = { decorations: { matchBackground: '#0073E555', activeMatchBackground: '#0073E5', matchOverviewRuler: '#0073E5', activeMatchColorOverviewRuler: '#3D9BFF' } };
  const go = (back) => { const p = focusedPane(); const q = $('#search-input').value; if (p && q) back ? p.search.findPrevious(q, opts) : p.search.findNext(q, opts); };
  $('#search-input').addEventListener('input', () => go(false));
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  $('#search-prev').onclick = () => go(true);
  $('#search-next').onclick = () => go(false);
  $('#search-close').onclick = closeSearch;
}

// =========================================================================
// Menu popover e toast
// =========================================================================
function showMenu(items, x, y) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<div class="sep"></div>'
    : it.head ? `<div class="mi-head">${esc(it.head)}</div>`
    : `<div class="mi" data-i="${i}">${icon(it.icon || 'terminal')}<span class="mi-lbl">${esc(it.label)}</span>${it.check ? `<span class="mi-check">✓</span>` : ''}${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</div>`).join('');
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => { const mi = e.target.closest('.mi'); if (!mi) return; hideMenu(); items[+mi.dataset.i].run(); };
}
function hideMenu() { $('#menu').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) hideMenu(); }, true);

function paneMenu(p, x, y) {
  const hasSel = p.term.hasSelection();
  showMenu([
    { label: hasSel ? 'Copia' : 'Copia (nessuna selezione)', icon: 'copy', kbd: 'Ctrl+C', run: () => { if (hasSel) { window.yt.writeClipboard(p.term.getSelection()); p.term.clearSelection(); } } },
    { label: 'Incolla', icon: 'paste', kbd: 'Ctrl+V', run: async () => { p.term.paste(await window.yt.readClipboard()); p.term.focus(); } },
    '-',
    { label: 'Dividi a destra', icon: 'splitH', kbd: 'Ctrl+Shift+D', run: () => splitPane(p.id, 'h') },
    { label: 'Dividi in basso', icon: 'splitV', kbd: 'Ctrl+Shift+E', run: () => splitPane(p.id, 'v') },
    { label: activeTab()?.zoomed ? 'Ripristina pannello' : 'Ingrandisci pannello', icon: 'zoom', kbd: 'Ctrl+Shift+Z', run: toggleZoom },
    ...paneMoveItems(p),
    '-',
    { label: 'Salta a cartella…', icon: 'jump', kbd: 'Ctrl+G', run: openJump },
    { label: 'Apri cartella in Esplora file', icon: 'external', run: () => window.yt.openPath(p.cwd) },
    { label: 'Cerca…', icon: 'search', kbd: 'Ctrl+Shift+F', run: openSearch },
    { label: 'Pulisci', icon: 'terminal', kbd: 'Ctrl+Shift+K', run: () => p.term.clear() },
    '-',
    { label: 'Chiudi pannello', icon: 'close', kbd: 'Ctrl+Shift+W', run: () => closePane(p.id) }
  ], x, y);
}

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2200);
}

function setFontSize(n) {
  n = Math.max(8, Math.min(32, n));
  S.cfg.fontSize = n;
  for (const p of S.panes.values()) { p.term.options.fontSize = n; p.doFit(); }
  window.yt.saveConfig({ fontSize: n });
}

function toggleEnhancements() {
  S.cfg.shellEnhancements = S.cfg.shellEnhancements === false;
  window.yt.saveConfig({ shellEnhancements: S.cfg.shellEnhancements });
  toast(`Suggerimenti e colori ${S.cfg.shellEnhancements ? 'attivi' : 'disattivati'} nei nuovi pannelli`);
}

async function goUp() {
  const p = focusedPane(); if (!p) return;
  const par = await window.yt.parent(p.cwd);
  if (!samePath(par, p.cwd)) p.cd(par);
}

// =========================================================================
// Scorciatoie da tastiera
// =========================================================================
function handleShortcut(e, pane) {
  if (e.type !== 'keydown') {
    // blocca anche il keyup/keypress delle combinazioni gestite
    return e.type === 'keypress' && e.ctrlKey && e.shiftKey;
  }
  const k = e.key;
  const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
  const code = e.code;
  const p = pane || focusedPane();
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); return true; };

  // Copia / incolla in stile Windows
  if (ctrl && !shift && !alt && code === 'KeyC' && p && p.term.hasSelection()) return run(() => { window.yt.writeClipboard(p.term.getSelection()); p.term.clearSelection(); });
  if (ctrl && shift && code === 'KeyC' && p) return run(() => { if (p.term.hasSelection()) window.yt.writeClipboard(p.term.getSelection()); });
  if (ctrl && !alt && code === 'KeyV' && p) return run(async () => p.term.paste(await window.yt.readClipboard()));

  if (ctrl && shift && !alt) {
    switch (code) {
      case 'KeyP': return run(openPalette);
      case 'KeyR': return run(openProjectActions);
      case 'KeyN': return run(toggleNetView);
      case 'KeyT': return run(() => newTab());
      case 'KeyD': return run(() => splitPane(null, 'h'));
      case 'KeyE': return run(() => splitPane(null, 'v'));
      case 'KeyW': return run(() => p && closePane(p.id));
      case 'KeyQ': return run(() => closeTab(S.activeTab));
      case 'KeyZ': return run(toggleZoom);
      case 'KeyF': return run(openSearch);
      case 'KeyK': return run(() => p && p.term.clear());
      case 'KeyL': return run(focusSidebarFilter);
      case 'KeyS': return run(() => p && toggleBookmark(p.cwd));
      case 'Tab': return run(() => cycleTab(-1));
    }
  }
  if (ctrl && !shift && !alt) {
    if (code === 'KeyG') return run(openJump);
    if (code === 'KeyH') return run(openDirCommands);
    if (code === 'KeyB') return run(() => toggleSidebar());
    if (code === 'Tab') return run(() => cycleTab(1));
    if (code === 'Equal' || code === 'NumpadAdd') return run(() => setFontSize(S.cfg.fontSize + 1));
    if (code === 'Minus' || code === 'NumpadSubtract') return run(() => setFontSize(S.cfg.fontSize - 1));
    if (code === 'Digit0' || code === 'Numpad0') return run(() => setFontSize(14));
    if (/^Digit[1-9]$/.test(code)) { const i = +code.slice(5) - 1; if (S.tabs[i]) return run(() => activateTab(S.tabs[i].id)); }
  }
  if (ctrl && alt && shift) {
    const m = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (m) return run(() => swapWithNeighbor(m));
  }
  if (ctrl && alt && !shift) {
    const m = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (m) return run(() => resizeFocused(m));
  }
  if (alt && !ctrl && !shift) {
    if (k === 'ArrowUp' && e.target.closest && !e.target.closest('.xterm')) return run(goUp);
    const m = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];
    if (m) {
      const tab = activeTab();
      // con un solo pannello, Alt+Su = cartella superiore
      if (m === 'up' && tab && panesOf(tab.root).length === 1) return run(goUp);
      return run(() => moveFocus(m));
    }
    if (/^Digit[1-9]$/.test(code)) { const b = S.cfg.bookmarks[+code.slice(5) - 1]; if (b) return run(() => openDir(b)); }
  }
  if (k === 'F1') return run(showShortcuts);
  return false;
}

document.addEventListener('keydown', (e) => {
  if (!$('#overlay').classList.contains('hidden')) return;
  if (e.target.closest && e.target.closest('.xterm')) return; // gestito dal terminale
  if (e.target.tagName === 'INPUT') {
    // nei campi di testo lascia funzionare copia/incolla/annulla/seleziona tutto
    if (!(e.ctrlKey || e.key === 'F1')) return;
    if (e.ctrlKey && !e.shiftKey && ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY'].includes(e.code)) return;
  }
  handleShortcut(e, null);
}, true);

// Ctrl+rotella = zoom carattere
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey && e.target.closest('.pane')) { e.preventDefault(); setFontSize(S.cfg.fontSize + (e.deltaY < 0 ? 1 : -1)); }
}, { passive: false });

// =========================================================================
// Headerbar
// =========================================================================
function setupHeaderbar() {
  $('#btn-sidebar').innerHTML = icon('sidebar');
  $('#btn-sidebar').classList.toggle('checked', S.cfg.sidebarVisible);
  $('#btn-newtab').innerHTML = icon('plus');
  $('#btn-profiles').innerHTML = icon('chevronDown');
  $('#btn-split-h').innerHTML = icon('splitH');
  $('#btn-split-v').innerHTML = icon('splitV');
  $('#btn-palette').innerHTML = icon('menu');
  $('#wc-min').innerHTML = icon('minimize');
  $('#wc-max').innerHTML = icon('maximize');
  $('#wc-close').innerHTML = icon('close');

  $('#btn-sidebar').onclick = () => toggleSidebar();
  $('#btn-newtab').onclick = () => newTab();
  $('#btn-split-h').onclick = () => splitPane(null, 'h');
  $('#btn-split-v').onclick = () => splitPane(null, 'v');
  $('#btn-palette').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: 'Palette comandi', icon: 'command', kbd: 'Ctrl+Shift+P', run: openPalette },
      { label: 'Salta a cartella', icon: 'jump', kbd: 'Ctrl+G', run: openJump },
      '-',
      { label: 'Mostra file nascosti', icon: 'eye', check: S.cfg.showHidden, run: toggleHidden },
      { label: 'Suggerimenti e colori nella shell', icon: 'command', check: S.cfg.shellEnhancements !== false, run: toggleEnhancements },
      { label: 'Ripristina sessione all’avvio', icon: 'clock', check: S.cfg.restoreSession, run: () => { S.cfg.restoreSession = !S.cfg.restoreSession; window.yt.saveConfig({ restoreSession: S.cfg.restoreSession }); } },
      '-',
      { label: 'Scorciatoie da tastiera', icon: 'command', kbd: 'F1', run: showShortcuts },
      { label: 'Verifica integrazione della shell', icon: 'terminal', run: checkIntegration },
      { label: 'Controlla aggiornamenti', icon: 'up', run: () => checkUpdates(true) }
    ], r.right - 260, r.bottom + 6);
  };
  $('#btn-profiles').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { head: 'Nuova scheda' },
      ...S.profiles.map((pr) => ({ label: pr.name, icon: pr.icon, check: pr.id === defaultProfile().id, run: () => newTab(pr) })),
      '-',
      { head: 'Dividi a destra' },
      ...S.profiles.map((pr) => ({ label: pr.name, icon: 'splitH', run: () => splitPane(null, 'h', null, pr) }))
    ], r.left, r.bottom + 6);
  };
  $('#wc-min').onclick = () => window.yt.minimize();
  $('#wc-max').onclick = () => window.yt.toggleMaximize();
  $('#wc-close').onclick = () => { saveSessionNow(); window.yt.close(); };
  $('#headerbar').addEventListener('dblclick', (e) => { if (!e.target.closest('button, .tab')) window.yt.toggleMaximize(); });
  window.yt.onWinState(({ maximized }) => { $('#wc-max').innerHTML = icon(maximized ? 'restore' : 'maximize'); $('#wc-max').title = maximized ? 'Ripristina' : 'Ingrandisci'; });

  $('#picker-input').addEventListener('input', refreshPicker);
  $('#picker-input').addEventListener('keydown', pickerKey);
  $('#overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'overlay') closePicker(); });
  $('#picker-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    picker.sel = +li.dataset.i;
    const it = picker.filtered[picker.sel]; const fn = picker.onPick;
    closePicker(false); fn(it, clickMode(e));
  });
}

// =========================================================================
// Eventi dal processo principale
// =========================================================================
window.yt.onData((id, data) => { const p = S.panes.get(id); if (p) p.term.write(data); });
window.yt.onExit((id) => {
  const p = S.panes.get(id); if (!p) return;
  p.alive = false;
  closePane(id);
});

// =========================================================================
// Avvio
// =========================================================================
// Avvio dopo il caricamento di tutti gli script (smart.js compreso)
async function init() {
  S.cfg = await window.yt.loadConfig();
  S.info = await window.yt.info();
  S.profiles = S.info.profiles;
  if (!S.cfg.bookmarks || !S.cfg.bookmarks.length) S.cfg.bookmarks = [S.info.home];
  document.documentElement.style.setProperty('--mono-font', S.cfg.fontFamily);

  await loadSmartStores();
  setupHeaderbar();
  setupSidebar();
  setupSearch();
  setupSmart();
  setupUpdates();
  setupTabDrop();
  setupNetwork();

  try { await document.fonts.load(`${S.cfg.fontSize}px ${S.cfg.fontFamily}`); } catch {}

  window.yt.onOpenDir((dir) => newTab(defaultProfile(), dir || S.info.home));

  // Finestra nata da un pannello staccato: adotta la shell esistente
  if (S.info.secondary) {
    const adopt = await window.yt.adoptInfo();
    if (adopt) { await adoptPaneInNewTab(adopt); return; }
  }

  // Avviato con una cartella (es. "Apri in Trantor"): apri solo quella
  const sess = !S.info.startDir && S.cfg.restoreSession && S.cfg.session;
  if (S.info.startDir) {
    await newTab(defaultProfile(), S.info.startDir);
  } else if (sess && sess.tabs && sess.tabs.length) {
    for (const tree of sess.tabs) await newTab(null, null, tree);
    const t = S.tabs[sess.active] || S.tabs[0];
    activateTab(t.id);
  } else {
    await newTab(defaultProfile(), S.info.home);
  }
}
document.addEventListener('DOMContentLoaded', init);
