/* Trantor — cartelle intelligenti
   1. Cronologia per cartella: ogni comando viene ricordato insieme alla cartella in cui è stato lanciato.
   2. Progetti: riconosce il tipo di progetto (git, Node, Python, Docker, .NET, Make, Rust, Go),
      propone le azioni tipiche, segna i file modificati e ricorda la disposizione dei pannelli. */
'use strict';

// -------------------------------------------------------------------------
// Utilità
// -------------------------------------------------------------------------
const NAV_RE = /^\s*(cd|chdir|sl|set-location|pushd|popd|push-location|pop-location)(\s|$)/i;
const BARE_RE = /^\s*(ls|ll|la|dir|gci|get-childitem|cls|clear|clear-host|exit|pwd|get-location|history|h)\s*$/i;
const MAX_PER_DIR = 60;
const MAX_DIRS = 600;

const dirKey = (p) => {
  const t = (p || '').replace(/[\\/]+$/, '') || p;
  return isWin() ? t.toLowerCase() : t;
};
const b64dec = (s) => {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s || ''), (c) => c.charCodeAt(0))); } catch { return ''; }
};
function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'adesso';
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  if (s < 2 * 86400) return 'ieri';
  if (s < 30 * 86400) return `${Math.round(s / 86400)} giorni fa`;
  return new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
function cmdScore(e) {
  const age = Date.now() - e.t;
  const w = age < 3600e3 ? 4 : age < 86400e3 ? 2 : age < 7 * 86400e3 ? 1 : age < 30 * 86400e3 ? 0.5 : 0.25;
  return e.n * w;
}
function parentDirs(dir, stop) {
  const crumbs = splitCrumbs(dir).map((c) => c.path).reverse();
  const out = [];
  for (const c of crumbs) { out.push(c); if (stop && samePath(c, stop)) break; if (out.length >= 4 && !stop) break; }
  return out;
}

// -------------------------------------------------------------------------
// Archivi
// -------------------------------------------------------------------------
const CH = { data: {} };        // dirKey -> { dir, items: [{ c, n, t, ok, ms }] }
const LAYOUTS = { data: {} };   // dirKey(root) -> { root, name, saved, tree }

async function loadSmartStores() {
  CH.data = (await window.yt.loadStore('commands')) || {};
  LAYOUTS.data = (await window.yt.loadStore('layouts')) || {};
}
const saveCommandsSoon = debounce(() => window.yt.saveStore('commands', CH.data), 1500);
const saveLayouts = () => window.yt.saveStore('layouts', LAYOUTS.data);

// -------------------------------------------------------------------------
// Eventi dalla shell (OSC 7777)
//   start;<cmd b64>                      un comando sta partendo
//   cmd;<dir b64>;<cmd b64>;<ok>;<ms>    un comando è terminato
// -------------------------------------------------------------------------
function onShellEvent(pane, data) {
  const f = data.split(';');
  pane.integ[f[0] === 'start' ? 'start' : 'cmd']++;
  if (f[0] === 'start') {
    pane.running = b64dec(f[1]).trim() || null;
    detectRemote(pane, pane.running);
    return;
  }
  if (f[0] === 'cmd') {
    pane.running = null;
    endRemote(pane);
    recordCommand(pane, b64dec(f[1]), b64dec(f[2]).trim(), f[3] === '1', parseInt(f[4], 10) || 0);
  }
}

function recordCommand(pane, dir, cmd, ok, ms) {
  refreshProjectSoon();
  if (!dir || !cmd || cmd.length > 2000 || NAV_RE.test(cmd) || BARE_RE.test(cmd)) return;
  pane.lastCmd = cmd;
  const k = dirKey(dir);
  const bucket = CH.data[k] || (CH.data[k] = { dir, items: [] });
  let e = bucket.items.find((x) => x.c === cmd);
  if (!e) { e = { c: cmd, n: 0 }; bucket.items.push(e); }
  e.n++; e.t = Date.now(); e.ok = ok;
  if (ms) e.ms = ms; else delete e.ms;
  if (bucket.items.length > MAX_PER_DIR) {
    bucket.items.sort((a, b) => cmdScore(b) - cmdScore(a));
    bucket.items.length = MAX_PER_DIR;
  }
  const keys = Object.keys(CH.data);
  if (keys.length > MAX_DIRS) {
    const last = (b) => Math.max(0, ...b.items.map((i) => i.t));
    keys.sort((a, b) => last(CH.data[a]) - last(CH.data[b])).slice(0, keys.length - MAX_DIRS).forEach((x) => delete CH.data[x]);
  }
  saveCommandsSoon();
  if (samePath(dir, S.sidebarDir)) renderDirCommands();
}

function commandsFor(dir) {
  const b = CH.data[dirKey(dir)];
  return b ? [...b.items].sort((a, b2) => cmdScore(b2) - cmdScore(a)) : [];
}

function forgetCommand(dir, cmd) {
  const b = CH.data[dirKey(dir)];
  if (!b) return;
  b.items = b.items.filter((x) => x.c !== cmd);
  if (!b.items.length) delete CH.data[dirKey(dir)];
  saveCommandsSoon();
  renderDirCommands();
}

// -------------------------------------------------------------------------
// Eseguire / inserire comandi
// -------------------------------------------------------------------------
function insertCommand(pane, cmd) {
  if (!pane) return;
  pane.term.paste(cmd);
  pane.term.focus();
}

async function runCommandIn(pane, dir, cmd, mode = 'here') {
  if (mode === 'h' || mode === 'v') {
    const np = await splitPane(pane ? pane.id : null, mode, dir);
    if (np) window.yt.write(np.id, cmd + '\r');
    return;
  }
  if (mode === 'tab') {
    const tab = await newTab(pane && !isSerial(pane) ? pane.profile : null, dir);
    const np = tab && S.panes.get(tab.focused);
    if (np) window.yt.write(np.id, cmd + '\r');
    return;
  }
  if (!pane) return;
  if (isSerial(pane)) return runCommandIn(pane, dir, cmd, 'tab');
  if (dir && !samePath(pane.cwd, dir)) window.yt.write(pane.id, cdCommand(pane.profile.kind, dir));
  window.yt.write(pane.id, cmd + '\r');
  pane.term.focus();
}

// -------------------------------------------------------------------------
// Sezione "Usati qui" nella barra laterale
// -------------------------------------------------------------------------
function cmdTooltip(e) {
  return [`${e.c}`, `Usato ${e.n} ${e.n === 1 ? 'volta' : 'volte'} · ${relTime(e.t)}`,
    `Ultimo esito: ${e.ok ? 'riuscito' : 'errore'}${e.ms ? ' · ' + fmtDuration(e.ms) : ''}`,
    'Clic: inserisci · ▶ o doppio clic: esegui · Shift+clic: esegui in un pannello a destra'].join('\n');
}

function renderDirCommands() {
  const sec = $('#sec-commands');
  if (!sec) return;
  const list = commandsFor(S.sidebarDir);
  sec.classList.toggle('hidden', !S.sidebarDir);
  if (!list.length) {
    const p = focusedPane();
    const msg = p && p.profile.kind === 'cmd'
      ? 'Il Prompt dei comandi non comunica i comandi eseguiti: per la cronologia usa PowerShell, Git Bash o WSL.'
      : 'I comandi che lanci in questa cartella compariranno qui (esclusi cd, dir, ls, cls).';
    $('#sb-commands').innerHTML = `<div class="sb-empty">${msg}</div>`;
    S.dirCmdView = [];
    return;
  }
  const top = list.slice(0, 6);
  $('#sb-commands').innerHTML = top.map((e, i) =>
    `<li class="cmd-item" data-i="${i}" title="${esc(cmdTooltip(e))}">` +
    `<span class="cmd-dot ${e.ok ? 'ok' : 'fail'}"></span>` +
    `<span class="lbl mono">${esc(e.c)}</span>` +
    (e.n > 1 ? `<span class="sub">${e.n}×</span>` : '') +
    `<button class="run" data-run="${i}" title="Esegui">${icon('play')}</button></li>`
  ).join('') + (list.length > top.length
    ? `<li class="more" data-more="1"><span class="lbl">Tutti i ${list.length} comandi di questa cartella</span><kbd>Ctrl+H</kbd></li>` : '');
  S.dirCmdView = top;
}

function setupDirCommands() {
  const ul = $('#sb-commands');
  const itemAt = (el) => S.dirCmdView && S.dirCmdView[+el.dataset.i];
  ul.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) return openDirCommands();
    const run = e.target.closest('.run');
    const li = e.target.closest('li.cmd-item'); if (!li) return;
    const it = itemAt(li); const p = focusedPane();
    if (run || e.shiftKey || e.altKey || e.ctrlKey) runCommandIn(p, S.sidebarDir, it.c, e.shiftKey ? 'h' : e.altKey ? 'v' : e.ctrlKey ? 'tab' : 'here');
    else insertCommand(p, it.c);
  });
  ul.addEventListener('dblclick', (e) => {
    const li = e.target.closest('li.cmd-item'); if (!li || e.target.closest('.run')) return;
    const p = focusedPane();
    if (p) { window.yt.write(p.id, '\r'); p.term.focus(); } // il primo clic ha già inserito il testo
  });
  ul.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li.cmd-item'); if (!li) return;
    e.preventDefault();
    const it = itemAt(li); const dir = S.sidebarDir; const p = focusedPane();
    showMenu([
      { label: 'Esegui', icon: 'play', run: () => runCommandIn(p, dir, it.c) },
      { label: 'Inserisci senza eseguire', icon: 'terminal', run: () => insertCommand(p, it.c) },
      { label: 'Esegui in un pannello a destra', icon: 'splitH', kbd: 'Shift+clic', run: () => runCommandIn(p, dir, it.c, 'h') },
      { label: 'Esegui in un pannello sotto', icon: 'splitV', kbd: 'Alt+clic', run: () => runCommandIn(p, dir, it.c, 'v') },
      '-',
      { label: 'Crea un pulsante con questo comando', icon: 'play', run: () => editQuickButton(null, { cmd: it.c, root: S.project ? S.project.root : null }) },
      { label: 'Copia comando', icon: 'copy', run: () => { window.yt.writeClipboard(it.c); toast('Comando copiato'); } },
      { label: 'Dimentica questo comando', icon: 'close', run: () => forgetCommand(dir, it.c) }
    ], e.clientX, e.clientY);
  });
}

// Finestra "Comandi usati in questa cartella" (Ctrl+H): cartella corrente + cartelle superiori del progetto
function openDirCommands() {
  const p = focusedPane();
  const dir = p ? p.cwd : S.sidebarDir;
  const root = S.project && S.project.root;
  const dirs = parentDirs(dir, root && dirKey(dir).startsWith(dirKey(root)) ? root : null);
  openPicker({
    placeholder: `Comandi usati in ${baseName(dir)} e cartelle superiori…`,
    iconName: 'history',
    hints: [['Invio', 'esegui'], ['Ctrl+Invio', 'inserisci'], ['Shift+Invio', 'pannello a destra'], ['Alt+Invio', 'pannello sotto']],
    source: async (q) => {
      const ql = q.toLowerCase();
      const out = [];
      dirs.forEach((d, di) => {
        for (const e of commandsFor(d)) {
          const s = q ? fuzzyScore(e.c, ql) : 0;
          if (s === -Infinity) continue;
          out.push({
            dir: d, c: e.c, icon: e.ok ? 'play' : 'close',
            label: e.c, labelHtml: highlight(e.c, q),
            detail: `${e.n}× · ${relTime(e.t)}${e.ms ? ' · ' + fmtDuration(e.ms) : ''}${di ? ' · in ' + prettyPath(d) : ''}`,
            tag: di ? baseName(d) : null,
            s: (q ? s : cmdScore(e)) - di * 0.5
          });
        }
      });
      out.sort((a, b) => b.s - a.s);
      return out.slice(0, 120);
    },
    onPick: (it, mode) => {
      const pane = focusedPane();
      if (mode === 'tab') return insertCommand(pane, it.c);
      runCommandIn(pane, it.dir, it.c, mode === 'cd' ? 'here' : mode);
    }
  });
}

// -------------------------------------------------------------------------
// Progetti
// -------------------------------------------------------------------------
const PROJ_CACHE = new Map();
function detectProjectCached(dir, force) {
  const k = dirKey(dir);
  const c = PROJ_CACHE.get(k);
  if (!force && c && Date.now() - c.at < 8000) return c.p;
  const p = window.yt.detectProject(dir).catch(() => null);
  PROJ_CACHE.set(k, { at: Date.now(), p });
  if (PROJ_CACHE.size > 200) PROJ_CACHE.delete(PROJ_CACHE.keys().next().value);
  return p;
}

async function refreshProject(force) {
  const dir = S.sidebarDir;
  if (!dir) return;
  const pr = await detectProjectCached(dir, force);
  if (!samePath(dir, S.sidebarDir)) return;
  S.project = pr;
  buildGitIndex(pr);
  renderProjectSection();
  renderSidebarList();
  const fp = focusedPane();
  if (fp && samePath(fp.cwd, dir)) updatePaneGit(fp, pr);
}
const refreshProjectSoon = debounce(() => refreshProject(true), 500);

// chiamata quando un pannello cambia cartella
async function paneCwdChanged(pane) {
  const pr = await detectProjectCached(pane.cwd);
  const root = pr ? pr.root : null;
  if (root !== pane.projectRoot) { pane.projectRoot = root; if (pane === focusedPane()) renderQuickbar(); }
  updatePaneGit(pane, pr);
  maybeAutoVenv(pane, pr);
}

function updatePaneGit(pane, pr) {
  if (!pane || !pane.gitEl) return;
  const g = pr && pr.git;
  if (!g || !g.branch) { pane.gitEl.innerHTML = ''; pane.gitEl.title = ''; return; }
  pane.gitEl.innerHTML = `${icon('branch')}<span>${esc(g.branch)}</span>` +
    (g.count ? `<span class="g-count">●${g.count}</span>` : '') +
    (g.ahead ? `<span class="g-ab">↑${g.ahead}</span>` : '') + (g.behind ? `<span class="g-ab">↓${g.behind}</span>` : '');
  pane.gitEl.title = `Ramo ${g.branch}` + (g.count ? ` · ${g.count} file modificati` : ' · nessuna modifica') +
    (g.ahead ? ` · ${g.ahead} commit da inviare` : '') + (g.behind ? ` · ${g.behind} commit da ricevere` : '');
}

// Indice dei file modificati per segnarli nella lista "Contenuto"
const GIT_LABEL = { M: 'Modificato', A: 'Aggiunto', '?': 'Nuovo, non tracciato', D: 'Eliminato', R: 'Rinominato', U: 'In conflitto' };
function buildGitIndex(pr) {
  S.gitIndex = null;
  const g = pr && pr.git;
  if (!g || !g.count) return;
  const norm = (x) => (isWin() ? x.toLowerCase() : x);
  const files = new Map();
  const dirs = new Map();
  for (const [f, st] of Object.entries(g.changes)) {
    const key = norm(f);
    files.set(key, st);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d) || st === 'U') dirs.set(d, st === 'U' ? 'U' : 'dir');
    }
  }
  S.gitIndex = { root: g.root, files, dirs, norm };
}

function gitMark(entry) {
  const gi = S.gitIndex;
  if (!gi) return '';
  const full = joinPath(S.sidebarDir, entry.name);
  const root = gi.root.replace(/[\\/]+$/, '');
  if (!dirKey(full).startsWith(dirKey(root) + (isWin() ? '\\' : '/')) && !dirKey(full).startsWith(dirKey(root) + '/')) return '';
  const rel = gi.norm(full.slice(root.length + 1).replace(/\\/g, '/'));
  let st = gi.files.get(rel);
  if (!st && entry.isDir) st = gi.dirs.get(rel);
  if (!st) return '';
  const cls = st === 'dir' ? 'st-dir' : st === '?' ? 'st-new' : st === 'A' ? 'st-new' : st === 'U' ? 'st-conf' : st === 'D' ? 'st-conf' : 'st-mod';
  const label = st === 'dir' ? 'Contiene modifiche' : GIT_LABEL[st] || 'Modificato';
  return `<span class="git-mark ${cls}" title="${label}"></span>`;
}

// Tutte le azioni del progetto, nell'ordine in cui conviene proporle
function projectActions(pr) {
  if (!pr) return [];
  const out = [];
  const py = pr.kinds.find((k) => k.kind === 'python' && k.venv);
  if (py) out.push({ special: 'venv', label: `Attiva ambiente Python (${py.venv.name})`, icon: 'python', venv: py.venv, dir: py.dir });
  const lay = layoutFor(pr.root);
  if (lay) out.push({ special: 'layout', label: `Apri disposizione salvata (${countLeaves(lay.tree)} pannelli)`, icon: 'splitH', layout: lay });
  for (const k of pr.kinds) for (const a of k.actions) out.push({ ...a, dir: k.dir, kind: k.label, icon: 'play' });
  return out;
}

function renderProjectSection() {
  const sec = $('#sec-project');
  const pr = S.project;
  sec.classList.toggle('hidden', !pr);
  if (!pr) return;
  const g = pr.git;
  const rel = samePath(pr.root, S.sidebarDir) ? '' : prettyPath(pr.root);
  const chips = [];
  if (g && g.branch) chips.push(`<span class="chip chip-git" title="Ramo git">${icon('branch')}${esc(g.branch)}</span>`);
  if (g && g.count) chips.push(`<span class="chip chip-mod" title="File modificati o nuovi">●&nbsp;${g.count} ${g.count === 1 ? 'modifica' : 'modifiche'}</span>`);
  if (g && (g.ahead || g.behind)) chips.push(`<span class="chip" title="Commit da inviare / da ricevere">${g.ahead ? '↑' + g.ahead : ''}${g.ahead && g.behind ? ' ' : ''}${g.behind ? '↓' + g.behind : ''}</span>`);
  for (const k of pr.kinds) chips.push(`<span class="chip chip-kind">${esc(k.label)}</span>`);
  $('#sb-project-head').innerHTML =
    `<div class="proj-title">${icon('box')}<b title="${esc(pr.root)}">${esc(pr.name)}</b>` +
    `<button class="icon-btn small" id="proj-menu" title="Opzioni del progetto">${icon('menu')}</button></div>` +
    (rel ? `<div class="proj-root" data-path="${esc(pr.root)}" title="Vai alla radice del progetto">${esc(rel)}</div>` : '') +
    (chips.length ? `<div class="proj-chips">${chips.join('')}</div>` : '');
  const acts = projectActions(pr);
  S.projectView = acts.slice(0, 5);
  $('#sb-project-actions').innerHTML = S.projectView.map((a, i) =>
    `<li class="act ${a.special ? 'special' : ''}" data-i="${i}" title="${esc(a.special ? a.label : `${a.cmd}${a.hint ? '\n' + a.hint : ''}\nClic: esegui · Shift+clic: in un pannello a destra · Ctrl+clic: in una nuova scheda`)}">` +
    `${icon(a.icon)}<span class="lbl ${a.special ? '' : 'mono'}">${esc(a.label)}</span>` +
    (a.hint && !a.special ? `<span class="sub">${esc(a.hint)}</span>` : '') + `</li>`
  ).join('') + (acts.length > S.projectView.length
    ? `<li class="more" data-more="1"><span class="lbl">Tutte le ${acts.length} azioni</span><kbd>Ctrl+Shift+R</kbd></li>` : '');
}

function runProjectAction(a, mode = 'here') {
  const p = focusedPane();
  if (a.special === 'venv') return activateVenv(p, a.venv);
  if (a.special === 'layout') return openLayout(a.layout);
  runCommandIn(p, a.dir, a.cmd, mode);
}

function setupProjectSection() {
  const head = $('#sb-project-head');
  head.addEventListener('click', (e) => {
    if (e.target.closest('#proj-menu')) { const r = e.target.closest('#proj-menu').getBoundingClientRect(); return projectMenu(r.left, r.bottom + 4); }
    const root = e.target.closest('.proj-root'); if (root) openDir(root.dataset.path, clickMode(e));
  });
  const ul = $('#sb-project-actions');
  ul.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) return openProjectActions();
    const li = e.target.closest('li.act'); if (!li) return;
    runProjectAction(S.projectView[+li.dataset.i], e.shiftKey ? 'h' : e.altKey ? 'v' : e.ctrlKey ? 'tab' : 'here');
  });
  ul.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li.act'); if (!li) return;
    e.preventDefault();
    const a = S.projectView[+li.dataset.i];
    if (a.special) return projectMenu(e.clientX, e.clientY);
    const p = focusedPane();
    showMenu([
      { label: 'Esegui', icon: 'play', run: () => runProjectAction(a) },
      { label: 'Esegui in un pannello a destra', icon: 'splitH', kbd: 'Shift+clic', run: () => runProjectAction(a, 'h') },
      { label: 'Esegui in un pannello sotto', icon: 'splitV', kbd: 'Alt+clic', run: () => runProjectAction(a, 'v') },
      { label: 'Esegui in una nuova scheda', icon: 'plus', kbd: 'Ctrl+clic', run: () => runProjectAction(a, 'tab') },
      { label: 'Inserisci senza eseguire', icon: 'terminal', run: () => insertCommand(p, a.cmd) },
      { label: 'Crea un pulsante con questa azione', icon: 'play', run: () => editQuickButton(null, { cmd: a.cmd, label: a.label.replace(/^(npm run|pnpm|yarn|bun run|make|docker compose|dotnet|cargo|go) /, ''), root: S.project ? S.project.root : null }) }
    ], e.clientX, e.clientY);
  });
}

function projectMenu(x, y) {
  const pr = S.project; if (!pr) return;
  const lay = layoutFor(pr.root);
  showMenu([
    { head: pr.name },
    { label: 'Salva la disposizione di questa scheda', icon: 'splitH', run: saveLayout },
    ...(lay ? [
      { label: 'Apri la disposizione salvata', icon: 'plus', run: () => openLayout(lay) },
      { label: 'Elimina la disposizione salvata', icon: 'close', run: () => { delete LAYOUTS.data[dirKey(pr.root)]; saveLayouts(); renderProjectSection(); toast('Disposizione eliminata'); } }
    ] : []),
    '-',
    { label: 'Attiva da solo l’ambiente Python', icon: 'python', check: !!S.cfg.autoVenv, run: toggleAutoVenv },
    { label: 'Aggiorna stato git', icon: 'branch', run: () => refreshProject(true) },
    { label: 'Vai alla radice del progetto', icon: 'up', run: () => openDir(pr.root) }
  ], x, y);
}

function openProjectActions() {
  const pr = S.project;
  if (!pr) { toast('Nessun progetto riconosciuto in questa cartella'); return; }
  const acts = projectActions(pr);
  openPicker({
    placeholder: `Azioni di ${pr.name}…`,
    iconName: 'box',
    hints: [['Invio', 'esegui'], ['Shift+Invio', 'pannello a destra'], ['Alt+Invio', 'pannello sotto'], ['Ctrl+Invio', 'nuova scheda']],
    source: async (q) => {
      const ql = q.toLowerCase();
      return acts.map((a) => ({ ...a, s: q ? fuzzyScore(a.label + ' ' + (a.hint || ''), ql) : 0, labelHtml: highlight(a.label, q), detail: a.special ? '' : a.hint, tag: a.kind }))
        .filter((a) => a.s > -Infinity).sort((a, b) => b.s - a.s);
    },
    onPick: (it, mode) => runProjectAction(it, mode === 'cd' ? 'here' : mode)
  });
}

// --- Ambiente Python -------------------------------------------------------
function activateVenv(pane, venv) {
  if (!pane || !venv) return;
  const k = pane.profile.kind;
  let cmd;
  if (k === 'powershell') cmd = `& '${venv.ps1.replace(/'/g, "''")}'`;
  else if (k === 'cmd') cmd = `"${venv.bat}"`;
  else cmd = `source ${quoteForShell(k, venv.sh)}`;
  window.yt.write(pane.id, cmd + '\r');
  pane.venv = venv.path;
  pane.term.focus();
}
function maybeAutoVenv(pane, pr) {
  if (!S.cfg.autoVenv || !pane || !pr || pane.running) return;
  const py = pr.kinds.find((k) => k.kind === 'python' && k.venv);
  if (!py || pane.venv === py.venv.path) return;
  activateVenv(pane, py.venv);
  toast(`Ambiente Python ${py.venv.name} attivato`);
}
function toggleAutoVenv() {
  S.cfg.autoVenv = !S.cfg.autoVenv;
  window.yt.saveConfig({ autoVenv: S.cfg.autoVenv });
  toast(S.cfg.autoVenv ? 'L’ambiente Python verrà attivato entrando nel progetto' : 'Attivazione automatica disattivata');
}

// --- Disposizioni salvate per progetto ---------------------------------------
function countLeaves(n) { return n.type === 'pane' ? 1 : countLeaves(n.a) + countLeaves(n.b); }
function layoutFor(dir) { return dir ? LAYOUTS.data[dirKey(dir)] : null; }

function saveLayout() {
  const pr = S.project; const tab = activeTab();
  if (!pr || !tab) return;
  const root = pr.root.replace(/[\\/]+$/, '');
  const ser = (n) => {
    if (n.type === 'split') return { type: 'split', dir: n.dir, ratio: n.ratio, a: ser(n.a), b: ser(n.b) };
    const p = S.panes.get(n.id);
    const inside = dirKey(p.cwd) === dirKey(root) || dirKey(p.cwd).startsWith(dirKey(root) + sep());
    return { type: 'pane', profile: p.profile.id, rel: inside ? p.cwd.slice(root.length).replace(/^[\\/]/, '') : null, abs: inside ? null : p.cwd, cmd: p.running || null, serial: isSerial(p) ? p.profile.serial : undefined };
  };
  const tree = ser(tab.root);
  LAYOUTS.data[dirKey(root)] = { root, name: pr.name, saved: Date.now(), tree };
  saveLayouts();
  renderProjectSection();
  const leaves = []; (function walk(n) { if (n.type === 'pane') leaves.push(n); else { walk(n.a); walk(n.b); } })(tree);
  const running = leaves.filter((l) => l.cmd).map((l) => l.cmd);
  toast(`Disposizione salvata: ${leaves.length} pannelli` + (running.length ? ` · rilancerà ${running.join(', ')}` : ''));
}

function openLayout(lay) {
  const root = lay.root;
  const res = (n) => n.type === 'split'
    ? { type: 'split', dir: n.dir, ratio: n.ratio, a: res(n.a), b: res(n.b) }
    : { type: 'pane', profile: n.profile, cwd: n.abs || (n.rel ? joinPath(root, n.rel) : root), cmd: n.cmd, serial: n.serial };
  return newTab(null, null, res(lay.tree));
}

// -------------------------------------------------------------------------
// Verifica dell'integrazione con la shell del pannello attivo
// -------------------------------------------------------------------------
function checkIntegration() {
  const p = focusedPane();
  if (!p) return;
  const i = p.integ;
  const yes = (n) => (n ? `sì (${n})` : 'no');
  const rows = [
    ['Shell', p.profile.name],
    ['Trantor', S.info.version || '?'],
    ['Cartella corrente ricevuta', yes(i.cwd)],
    ['Avvio comandi ricevuto', yes(i.start)],
    ['Fine comandi ricevuta', yes(i.cmd)],
    ['Comandi salvati in questa cartella', String(commandsFor(p.cwd).length)]
  ];
  let verdict;
  if (p.profile.kind === 'cmd') verdict = 'Il Prompt dei comandi comunica solo la cartella, non i comandi.';
  else if (!i.cwd) verdict = 'La shell non sta comunicando con Trantor: prova a chiudere e riaprire il pannello.';
  else if (!i.cmd) verdict = 'La cartella arriva ma i comandi no: lancia un comando diverso da cd/dir/ls e ricontrolla.';
  else verdict = 'Tutto funziona.';
  openPicker({
    placeholder: 'Verifica integrazione della shell',
    iconName: 'terminal',
    hints: [['Esc', 'chiudi'], ['Invio', 'copia il risultato']],
    source: async () => [...rows.map(([k, v]) => ({ label: k, kbd: v, icon: 'terminal' })), { label: verdict, icon: i.cmd || p.profile.kind === 'cmd' ? 'play' : 'close' }],
    onPick: () => { window.yt.writeClipboard(rows.map((r) => r.join(': ')).join('\n') + '\n' + verdict); toast('Risultato copiato'); }
  });
}

// -------------------------------------------------------------------------
// Avvio
// -------------------------------------------------------------------------
function setupSmart() {
  setupDirCommands();
  setupProjectSection();
  // stato git aggiornato periodicamente quando la finestra è in primo piano
  setInterval(() => { if (document.hasFocus() && S.project && S.project.git) refreshProject(true); }, 10000);
  window.addEventListener('focus', () => { if (S.project) refreshProject(true); });
}
