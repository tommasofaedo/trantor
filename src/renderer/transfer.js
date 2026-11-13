/* Trantor — trasferire file tra pannelli locali e remoti (SSH)
   - Un pannello diventa "remoto" quando ci lanci `ssh …` (anche dalla vista Rete).
   - Locale → remoto: trascina file o cartelle (da Esplora file o dalla barra laterale) su un pannello remoto.
   - Remoto → locale: seleziona il nome di un file nel pannello remoto e trascina l'etichetta "⬇" che compare
     su un pannello locale o su una cartella della barra laterale (oppure cliccala).
   I trasferimenti usano `scp` (incluso in Windows 10/11) in un pannello visibile: se serve la password la scrivi lì,
   e il pannello si chiude da solo quando il trasferimento riesce. */
'use strict';

const PATH_TYPE = 'application/x-trantor-path';
const REMOTE_TYPE = 'application/x-trantor-remote';

// -------------------------------------------------------------------------
// Riconoscere una sessione SSH dal comando lanciato
// -------------------------------------------------------------------------
const SSH_OPTS_WITH_ARG = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);

function tokenize(cmd) {
  const out = []; let cur = ''; let q = null;
  for (const ch of cmd) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseSsh(cmd) {
  const t = tokenize(cmd || '');
  if (!t.length || !/^ssh(\.exe)?$/i.test(t[0].split(/[\\/]/).pop())) return null;
  const r = { port: null, identity: null, user: null, jump: null, configFile: null, options: [] };
  let i = 1;
  for (; i < t.length; i++) {
    const a = t[i];
    if (!a.startsWith('-')) break;
    const opt = a.slice(0, 2);
    const val = a.length > 2 ? a.slice(2) : (SSH_OPTS_WITH_ARG.has(opt) ? t[++i] : null);
    if (opt === '-p') r.port = val;
    else if (opt === '-i') r.identity = val;
    else if (opt === '-l') r.user = val;
    else if (opt === '-J') r.jump = val;
    else if (opt === '-F') r.configFile = val;
    else if (opt === '-o' && val) r.options.push(val);
  }
  let dest = t[i];
  if (!dest) return null;
  let m = dest.match(/^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/);
  if (m) { r.user = r.user || m[1] || null; r.host = m[2]; r.port = r.port || m[3] || null; }
  else { m = dest.match(/^(?:(.+)@)?(.+)$/); r.user = r.user || m[1] || null; r.host = m[2]; }
  r.target = (r.user ? r.user + '@' : '') + r.host;
  r.cmd = cmd;
  return r;
}

function detectRemote(pane, cmd) {
  const r = parseSsh(cmd);
  if (!r) return;
  pane.remote = { ...r, cwd: null };
  renderRemoteBadge(pane);
}
function endRemote(pane) {
  if (!pane.remote) return;
  pane.remote = null;
  renderRemoteBadge(pane);
  hideRemoteChip();
}
function setRemoteCwd(pane, p) {
  if (!pane.remote) return false;
  pane.remote.cwd = p;
  renderRemoteBadge(pane);
  return true;
}

function renderRemoteBadge(pane) {
  let el = pane.el.querySelector('.p-remote');
  if (!pane.remote) { if (el) el.remove(); pane.el.classList.remove('remote'); return; }
  if (!el) {
    el = document.createElement('span');
    el.className = 'p-remote';
    pane.el.querySelector('.p-path').before(el);
    el.addEventListener('click', (e) => { e.stopPropagation(); remoteMenu(pane, e.clientX, e.clientY); });
  }
  pane.el.classList.add('remote');
  const r = pane.remote;
  el.innerHTML = `${icon('globe')}<span>${esc(r.target)}${r.cwd ? `:<b>${esc(r.cwd)}</b>` : ''}</span>`;
  el.title = `Sessione SSH su ${r.target}${r.port ? ' (porta ' + r.port + ')' : ''}\n` +
    (r.cwd ? `Cartella remota: ${r.cwd}` : 'Cartella remota sconosciuta: clic per attivarne il rilevamento') +
    '\nTrascina qui file o cartelle per caricarli';
}

// -------------------------------------------------------------------------
// Comandi scp
// -------------------------------------------------------------------------
function scpBaseArgs(r) {
  const a = ['scp'];
  if (r.port) a.push('-P', r.port);
  if (r.identity) a.push('-i', r.identity);
  if (r.jump) a.push('-J', r.jump);
  if (r.configFile) a.push('-F', r.configFile);
  for (const o of r.options) a.push('-o', o);
  return a;
}
function shellQuote(kind, s) {
  if (kind === 'powershell') return `'${String(s).replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${String(s).replace(/"/g, '')}"`;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function remoteSpec(r, p) { return `${r.target}:${p}`; }
function joinRemote(dir, name) {
  if (!dir) return name;
  return dir.replace(/\/+$/, '') + '/' + name;
}

// Esegue scp in un pannello sotto `nearPane`; il pannello si chiude da solo se va tutto bene
async function runTransfer(nearPane, args, { cwd, done } = {}) {
  const profile = defaultProfile();
  const kind = profile.kind;
  const local = (x) => (kind === 'gitbash' || kind === 'wsl') ? toPosix(x, kind) : x;
  const line = args.map((a) => (a.local ? shellQuote(kind, local(a.local)) : /^[\w\-./:@]+$/.test(a) ? a : shellQuote(kind, a))).join(' ');
  const tail = kind === 'powershell' ? '; if ($LASTEXITCODE -eq 0) { exit }' : ' && exit';
  const np = await splitPane(nearPane ? nearPane.id : null, 'v', cwd || S.info.home, profile);
  if (!np) return;
  np.onExitHook = (code) => { if (done) done(code); };
  window.yt.write(np.id, line + tail + '\r');
}

// -------------------------------------------------------------------------
// Locale → remoto
// -------------------------------------------------------------------------
function uploadTo(pane, paths) {
  const r = pane.remote;
  if (!r || !paths.length) return;
  const names = paths.map((p) => baseName(p));
  const dflt = r.cwd || '~';
  const recent = (S.cfg.remoteDirs || {})[r.target] || [];
  openPicker({
    placeholder: 'Cartella remota di destinazione',
    initial: dflt,
    iconName: 'up',
    hints: [['Invio', 'carica'], ['Esc', 'annulla']],
    source: async (q) => {
      const dest = q.trim() || dflt;
      const what = names.length === 1 ? `«${names[0]}»` : `${names.length} elementi`;
      return [
        { label: `Carica ${what} in ${r.target}:${dest}`, dest, icon: 'up', detail: r.cwd ? 'cartella corrente del pannello remoto' : (dest === '~' ? 'cartella home remota (la cartella corrente non è nota)' : '') },
        ...recent.filter((d) => d !== dest).map((d) => ({ label: `Carica in ${r.target}:${d}`, dest: d, icon: 'history', tag: 'recente' }))
      ];
    },
    onPick: async (it) => {
      const dest = it.dest === '~' ? '' : it.dest;
      const dirs = await Promise.all(paths.map((p) => window.yt.isDir(p)));
      const args = scpBaseArgs(r);
      if (dirs.some(Boolean)) args.push('-r');
      for (const p of paths) args.push({ local: p });
      args.push(remoteSpec(r, dest ? dest.replace(/\/?$/, '/') : ''));
      rememberRemoteDir(r.target, it.dest);
      runTransfer(pane, args, {
        cwd: pane.cwd,
        done: (code) => toast(code === 0 ? `Caricato su ${r.target}: ${names.join(', ')}` : 'Caricamento non riuscito: guarda il pannello del trasferimento')
      });
    }
  });
}

function rememberRemoteDir(target, dir) {
  if (!dir || dir === '~') return;
  const all = S.cfg.remoteDirs || {};
  all[target] = [dir, ...(all[target] || []).filter((d) => d !== dir)].slice(0, 6);
  S.cfg.remoteDirs = all;
  window.yt.saveConfig({ remoteDirs: all });
}

async function uploadChooser(pane) {
  const files = await window.yt.chooseFiles();
  if (files && files.length) uploadTo(pane, files);
}

// -------------------------------------------------------------------------
// Remoto → locale
// -------------------------------------------------------------------------
function remotePathFor(pane, text) {
  const t = text.trim().replace(/^['"]|['"]$/g, '').replace(/\/$/, '');
  if (t.startsWith('/') || t.startsWith('~')) return t;
  return pane.remote.cwd ? joinRemote(pane.remote.cwd, t) : t; // relativo alla home remota
}

function downloadFrom(pane, remotePath, localDir) {
  const r = pane.remote;
  if (!r || !remotePath) return;
  localDir = localDir || S.sidebarDir || pane.cwd;
  const args = scpBaseArgs(r);
  args.push('-r', remoteSpec(r, remotePath), { local: localDir });
  const name = remotePath.split('/').pop();
  runTransfer(pane, args, {
    cwd: localDir,
    done: (code) => {
      toast(code === 0 ? `«${name}» scaricato in ${prettyPath(localDir)}` : 'Download non riuscito: guarda il pannello del trasferimento');
      if (code === 0 && samePath(localDir, S.sidebarDir)) loadSidebarList();
    }
  });
}

function downloadPrompt(pane, preset) {
  const r = pane.remote;
  if (!r) return;
  const localDir = S.sidebarDir || pane.cwd;
  openPicker({
    placeholder: `Percorso del file o della cartella su ${r.target}`,
    initial: preset || (r.cwd ? r.cwd.replace(/\/?$/, '/') : ''),
    iconName: 'chevronDown',
    hints: [['Invio', 'scarica'], ['Esc', 'annulla']],
    source: async (q) => q.trim() ? [{ label: `Scarica ${r.target}:${remotePathFor(pane, q)}`, detail: `in ${prettyPath(localDir)}`, path: remotePathFor(pane, q), icon: 'chevronDown' }] : [],
    onPick: (it) => downloadFrom(pane, it.path, localDir)
  });
}

// Etichetta "⬇ nome" che compare quando selezioni testo in un pannello remoto
let chipState = null;
function showRemoteChip(pane) {
  const sel = pane.term.getSelection().trim();
  if (!pane.remote || !sel || sel.includes('\n') || sel.length > 300) { hideRemoteChip(); return; }
  let chip = $('#remote-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'remote-chip';
    chip.draggable = true;
    document.body.appendChild(chip);
    chip.addEventListener('dragstart', (e) => {
      if (!chipState) return;
      e.dataTransfer.setData(REMOTE_TYPE, JSON.stringify({ pane: chipState.pane.id, path: chipState.path }));
      e.dataTransfer.effectAllowed = 'copy';
      document.body.classList.add('remote-dragging');
    });
    chip.addEventListener('dragend', () => { document.body.classList.remove('remote-dragging'); });
    chip.addEventListener('click', () => { if (chipState) downloadFrom(chipState.pane, chipState.path); hideRemoteChip(); });
  }
  const path = remotePathFor(pane, sel);
  chipState = { pane, path };
  chip.innerHTML = `${icon('chevronDown')}<span>Scarica <b>${esc(path.split('/').pop() || path)}</b></span>`;
  chip.title = `Clic: scarica ${pane.remote.target}:${path} in ${prettyPath(S.sidebarDir)}\nTrascina su un pannello locale o su una cartella della barra laterale per scegliere dove` +
    (pane.remote.cwd || path.startsWith('/') || path.startsWith('~') ? '' : '\n(percorso relativo alla home remota: attiva il rilevamento della cartella remota per usare quella corrente)');
  const m = S.lastMouse || { x: 200, y: 200 };
  chip.style.left = Math.min(m.x + 8, window.innerWidth - 260) + 'px';
  chip.style.top = Math.min(m.y + 14, window.innerHeight - 40) + 'px';
  chip.classList.remove('hidden');
}
function hideRemoteChip() { const c = $('#remote-chip'); if (c) c.classList.add('hidden'); chipState = null; }

// -------------------------------------------------------------------------
// Rilevamento della cartella remota (sessione corrente, bash o zsh)
// -------------------------------------------------------------------------
const REMOTE_OSC7 = ` __tr7(){ printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-$HOST}" "$PWD"; }; if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__tr7); else PROMPT_COMMAND="__tr7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi`;
function enableRemoteCwd(pane) {
  if (!pane.remote) return;
  window.yt.write(pane.id, REMOTE_OSC7 + '\r');
  toast('Rilevamento della cartella remota attivo per questa sessione');
  pane.term.focus();
}

function remoteMenuItems(pane) {
  const r = pane.remote;
  if (!r) return [];
  const sel = pane.term.hasSelection() ? pane.term.getSelection().trim() : '';
  return [
    { head: `SSH · ${r.target}` },
    { label: 'Carica file qui…', icon: 'up', run: () => uploadChooser(pane) },
    ...(sel && !sel.includes('\n') ? [{ label: `Scarica «${sel.slice(0, 40)}» in ${baseName(S.sidebarDir || pane.cwd)}`, icon: 'chevronDown', run: () => downloadFrom(pane, remotePathFor(pane, sel)) }] : []),
    { label: 'Scarica un file o una cartella…', icon: 'chevronDown', run: () => downloadPrompt(pane) },
    ...(r.cwd ? [] : [{ label: 'Rileva la cartella remota', icon: 'folder', run: () => enableRemoteCwd(pane) }]),
    '-'
  ];
}
function remoteMenu(pane, x, y) { showMenu(remoteMenuItems(pane).filter((i) => i !== '-'), x, y); }

// -------------------------------------------------------------------------
// Destinazioni di rilascio
// -------------------------------------------------------------------------
// Rilascio su un pannello: file locali (Esplora file o barra laterale) o file remoti (etichetta ⬇)
async function handlePaneDrop(pane, e) {
  const dt = e.dataTransfer;
  if (dt.types.includes(REMOTE_TYPE)) {
    const { pane: srcId, path } = JSON.parse(dt.getData(REMOTE_TYPE));
    const src = S.panes.get(srcId);
    if (!src || !src.remote) return true;
    if (pane.remote) { toast('Rilascia su un pannello locale o su una cartella della barra laterale'); return true; }
    downloadFrom(src, path, pane.cwd);
    return true;
  }
  let paths = [];
  if (dt.types.includes(PATH_TYPE)) paths = JSON.parse(dt.getData(PATH_TYPE));
  else if (dt.files && dt.files.length) paths = [...dt.files].map((f) => window.yt.pathForFile(f));
  if (!paths.length) return false;
  if (pane.remote) { uploadTo(pane, paths); return true; }
  if (paths.length === 1 && await window.yt.isDir(paths[0])) pane.cd(paths[0]);
  else pane.term.paste(paths.map((p) => quoteForShell(pane.profile.kind, p)).join(' ') + ' ');
  return true;
}

function setupTransfer() {
  document.addEventListener('mousemove', (e) => { S.lastMouse = { x: e.clientX, y: e.clientY }; }, { passive: true });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#remote-chip')) hideRemoteChip(); }, true);

  // File della barra laterale trascinabili (su pannelli locali → percorso, su pannelli remoti → caricamento)
  const list = $('#sb-list');
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const en = filteredEntries()[+li.dataset.i]; if (!en) return;
    const full = joinPath(S.sidebarDir, en.name);
    const paths = FS.picked.has(en.name) && FS.picked.size > 1 ? [...FS.picked].map((n) => joinPath(S.sidebarDir, n)) : [full];
    e.dataTransfer.setData(PATH_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', full);
    e.dataTransfer.effectAllowed = 'copy';
  });
  // Cartelle della barra laterale come destinazione dei download remoti
  const sidebar = $('#sb-files');
  sidebar.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(REMOTE_TYPE)) return;
    e.preventDefault();
    document.querySelectorAll('.drop-folder').forEach((n) => n.classList.remove('drop-folder'));
    const li = e.target.closest('#sb-list li.dir, #sb-bookmarks li[data-path], #sb-recent li[data-path]');
    (li || $('#sec-content')).classList.add('drop-folder');
  });
  sidebar.addEventListener('dragleave', (e) => { if (!sidebar.contains(e.relatedTarget)) document.querySelectorAll('.drop-folder').forEach((n) => n.classList.remove('drop-folder')); });
  sidebar.addEventListener('drop', (e) => {
    if (!e.dataTransfer.types.includes(REMOTE_TYPE)) return;
    e.preventDefault();
    document.querySelectorAll('.drop-folder').forEach((n) => n.classList.remove('drop-folder'));
    const { pane: srcId, path } = JSON.parse(e.dataTransfer.getData(REMOTE_TYPE));
    const src = S.panes.get(srcId); if (!src || !src.remote) return;
    let dir = S.sidebarDir;
    const li = e.target.closest('#sb-list li.dir');
    if (li) { const en = filteredEntries()[+li.dataset.i]; if (en) dir = joinPath(S.sidebarDir, en.name); }
    const other = e.target.closest('#sb-bookmarks li[data-path], #sb-recent li[data-path]');
    if (other) dir = other.dataset.path;
    downloadFrom(src, path, dir);
    hideRemoteChip();
  });
}
