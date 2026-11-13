/* Trantor — operazioni sui file nella barra laterale e azioni da amministratore
   Selezione: clic = seleziona (o entra nella cartella) · Ctrl+clic = aggiungi/togli · Shift+clic = intervallo.
   Tastiera sulla lista: Ctrl+C/X/V, F2, Canc, Ctrl+A, Invio, Esc.
   Eliminare sposta sempre nel Cestino di Windows. */
'use strict';

const FS = { picked: new Set(), anchor: null, clip: null, renaming: null };
const RUNNABLE = /\.(exe|bat|cmd|ps1|msi|com)$/i;

// -------------------------------------------------------------------------
// Selezione
// -------------------------------------------------------------------------
function resetPicked() { FS.picked.clear(); FS.anchor = null; }
function pickedEntries() {
  const list = filteredEntries();
  const sel = list.filter((e) => FS.picked.has(e.name));
  if (sel.length) return sel;
  const cur = list[S.sidebarSel];
  return cur ? [cur] : [];
}
function pickedPaths() { return pickedEntries().map((e) => joinPath(S.sidebarDir, e.name)); }

function onListClick(e) {
  const li = e.target.closest('li[data-i]');
  if (!li) { if (!e.ctrlKey) { resetPicked(); renderSidebarList(); } return; }
  if (li.querySelector('input.rename')) return;
  const list = filteredEntries();
  const i = +li.dataset.i; const en = list[i];
  if (!en) return;
  $('#sb-list').focus({ preventScroll: true });
  if (e.ctrlKey) {
    if (FS.picked.has(en.name)) FS.picked.delete(en.name); else FS.picked.add(en.name);
    FS.anchor = i; S.sidebarSel = i; renderSidebarList(); return;
  }
  if (e.shiftKey && FS.anchor != null) {
    const [a, b] = [Math.min(FS.anchor, i), Math.max(FS.anchor, i)];
    FS.picked = new Set(list.slice(a, b + 1).map((x) => x.name));
    S.sidebarSel = i; renderSidebarList(); return;
  }
  FS.picked = new Set([en.name]); FS.anchor = i; S.sidebarSel = i;
  if (en.isDir) { clearSidebarFilter(); sidebarOpen(joinPath(S.sidebarDir, en.name), e.altKey ? e : null); }
  else renderSidebarList();
}

// -------------------------------------------------------------------------
// Operazioni
// -------------------------------------------------------------------------
async function refreshAndPick(names) {
  await loadSidebarList();
  if (names) { FS.picked = new Set(names); const i = filteredEntries().findIndex((e) => e.name === names[0]); if (i >= 0) { S.sidebarSel = i; FS.anchor = i; } renderSidebarList(); }
}
const base = (p) => p.split(/[\\/]/).pop();
function report(r, okMsg) {
  if (!r.ok) { toast(r.error || 'Operazione non riuscita'); return false; }
  if (okMsg) toast(okMsg);
  return true;
}
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

async function copySel(mode = 'copy') {
  const paths = pickedPaths();
  if (!paths.length) return;
  FS.clip = { mode, paths, dir: S.sidebarDir };
  if (mode === 'copy') window.yt.files.writeClipboard(paths); // così si può incollare anche in Esplora file
  renderSidebarList();
  toast(`${plural(paths.length, `«${base(paths[0])}»`, 'elementi')} ${mode === 'cut' ? 'tagliat' : 'copiat'}${paths.length === 1 ? 'o' : 'i'}: usa Incolla nella cartella di destinazione`);
}

async function pasteInto(dir = S.sidebarDir) {
  let mode = 'copy'; let paths = [];
  if (FS.clip && FS.clip.mode === 'cut') { mode = 'cut'; paths = FS.clip.paths; }
  else {
    paths = await window.yt.files.readClipboard(); // file copiati in Esplora file (o da Trantor)
    if (!paths.length && FS.clip) paths = FS.clip.paths;
  }
  if (!paths.length) { toast('Niente da incollare: copia prima uno o più file'); return; }
  const r = mode === 'cut' ? await window.yt.files.move(paths, dir) : await window.yt.files.copy(paths, dir);
  if (!report(r)) return;
  if (mode === 'cut') FS.clip = null;
  toast(`${plural(r.result.length, `«${base(r.result[0])}»`, 'elementi')} ${mode === 'cut' ? 'spostat' : 'incollat'}${r.result.length === 1 ? 'o' : 'i'} in ${baseName(dir)}`);
  if (samePath(dir, S.sidebarDir)) refreshAndPick(r.result.map(base)); else loadSidebarList();
}

async function newFolder() {
  const r = await window.yt.files.mkdir(S.sidebarDir);
  if (!report(r)) return;
  await refreshAndPick([base(r.result)]);
  startRename(base(r.result));
}
async function newFile() {
  const r = await window.yt.files.newFile(S.sidebarDir);
  if (!report(r)) return;
  await refreshAndPick([base(r.result)]);
  startRename(base(r.result));
}
async function duplicateSel() {
  const paths = pickedPaths();
  const out = [];
  for (const p of paths) { const r = await window.yt.files.duplicate(p); if (!report(r)) return; out.push(base(r.result)); }
  refreshAndPick(out);
}
async function zipSel() {
  const paths = pickedPaths(); if (!paths.length) return;
  toast('Compressione in corso…');
  const r = await window.yt.files.zip(paths);
  if (report(r, `Creato ${base(r.result || '')}`)) refreshAndPick([base(r.result)]);
}
async function unzipSel() {
  const p = pickedPaths()[0]; if (!p) return;
  toast('Estrazione in corso…');
  const r = await window.yt.files.unzip(p);
  if (report(r, `Estratto in ${base(r.result || '')}`)) refreshAndPick([base(r.result)]);
}
function trashSel() {
  const paths = pickedPaths(); if (!paths.length) return;
  const what = paths.length === 1 ? `«${base(paths[0])}»` : `${paths.length} elementi`;
  openPicker({
    placeholder: `Spostare ${what} nel Cestino?`,
    iconName: 'close',
    hints: [['Invio', 'conferma'], ['Esc', 'annulla']],
    source: async () => [
      { label: `Sposta ${what} nel Cestino`, detail: paths.length === 1 ? 'Puoi recuperarlo dal Cestino di Windows' : 'Puoi recuperarli dal Cestino di Windows', icon: 'close', ok: true },
      { label: 'Annulla', icon: 'chevronLeft', ok: false }
    ],
    onPick: async (it) => {
      if (!it.ok) return;
      const r = await window.yt.files.trash(paths);
      if (report(r, `${what} nel Cestino`)) { resetPicked(); loadSidebarList(); }
    }
  });
}

// Rinomina direttamente nella lista
function startRename(name) {
  const i = filteredEntries().findIndex((e) => e.name === name);
  const li = $(`#sb-list li[data-i="${i}"]`);
  if (!li) return;
  const lbl = li.querySelector('.lbl');
  const input = document.createElement('input');
  input.className = 'rename'; input.value = name; input.spellcheck = false;
  lbl.replaceWith(input);
  FS.renaming = name;
  input.focus();
  const dot = name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 && !filteredEntries()[i].isDir ? dot : name.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true; FS.renaming = null;
    const nn = input.value.trim();
    if (commit && nn && nn !== name) {
      const r = await window.yt.files.rename(joinPath(S.sidebarDir, name), nn);
      if (!report(r)) { renderSidebarList(); return; }
      refreshAndPick([nn]);
    } else renderSidebarList();
    $('#sb-list').focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}
function renameSel() { const e = pickedEntries(); if (e.length === 1) startRename(e[0].name); }

// -------------------------------------------------------------------------
// Amministratore
// -------------------------------------------------------------------------
async function runAsAdmin(p) {
  const r = await window.yt.admin.runFile(p);
  if (!r.ok) toast(r.error === 'Operazione annullata' ? 'Esecuzione come amministratore annullata' : r.error);
}

async function openAdminTerminal(dir = S.sidebarDir) {
  const info = await window.yt.admin.info();
  const prof = defaultProfile();
  if (info.isAdmin) { newTab(prof, dir); toast('Trantor è già in esecuzione come amministratore'); return; }
  const elevate = info.gsudo ? 'gsudo' : info.sudo ? 'sudo' : null;
  if (elevate && prof.kind !== 'wsl') {
    const p = { ...prof, elevate, name: `${prof.name} (amministratore)` };
    await newTab(p, dir);
    if (elevate === 'sudo') toast('Conferma nella finestra di Windows. Se sudo è impostato “In una nuova finestra”, la shell si aprirà fuori da Trantor (Impostazioni → Per sviluppatori → sudo → In linea)');
    return;
  }
  const r = await window.yt.admin.externalShell(dir, prof);
  if (r.ok) toast('Shell da amministratore aperta in una finestra separata. Per averla dentro Trantor installa gsudo: winget install gerardog.gsudo');
  else toast(r.error === 'Operazione annullata' ? 'Apertura come amministratore annullata' : r.error);
}

async function relaunchAsAdmin() {
  saveSessionNow();
  toast('Conferma nella finestra di Windows per riavviare Trantor come amministratore');
  const r = await window.yt.admin.relaunch();
  if (!r.ok) toast(r.error === 'Operazione annullata' ? 'Riavvio come amministratore annullato' : r.error);
}

// -------------------------------------------------------------------------
// Menu
// -------------------------------------------------------------------------
function fileMenu(e) {
  const li = e.target.closest('li[data-i]');
  if (!li) return listBackgroundMenu(e);
  const en = filteredEntries()[+li.dataset.i];
  if (!FS.picked.has(en.name)) { FS.picked = new Set([en.name]); FS.anchor = +li.dataset.i; S.sidebarSel = +li.dataset.i; renderSidebarList(); }
  const sel = pickedEntries();
  const one = sel.length === 1 ? sel[0] : null;
  const full = one ? joinPath(S.sidebarDir, one.name) : null;
  const p = focusedPane();
  const items = [];
  if (one && one.isDir) {
    items.push(
      { label: 'Apri nel terminale', icon: 'terminal', kbd: 'Doppio clic', run: () => openDir(full, 'cd') },
      { label: 'Apri in nuova scheda', icon: 'plus', run: () => openDir(full, 'tab') },
      { label: 'Apri in un pannello a destra', icon: 'splitH', run: () => openDir(full, 'h') },
      { label: 'Apri terminale come amministratore qui', icon: 'shield', run: () => openAdminTerminal(full) },
      '-');
  } else if (one) {
    items.push({ label: 'Apri', icon: 'external', kbd: 'Doppio clic', run: () => window.yt.openPath(full) });
    if (RUNNABLE.test(one.name)) items.push({ label: 'Esegui come amministratore', icon: 'shield', run: () => runAsAdmin(full) });
    if (/\.zip$/i.test(one.name)) items.push({ label: 'Estrai qui', icon: 'folder', run: unzipSel });
    items.push({ label: 'Inserisci percorso nel terminale', icon: 'terminal', run: () => { p.term.paste(quoteForShell(p.profile.kind, full) + ' '); p.term.focus(); } }, '-');
  }
  items.push(
    { label: 'Taglia', icon: 'cut', kbd: 'Ctrl+X', run: () => copySel('cut') },
    { label: 'Copia', icon: 'copy', kbd: 'Ctrl+C', run: () => copySel('copy') },
    ...(one && one.isDir ? [{ label: `Incolla in «${one.name}»`, icon: 'paste', run: () => pasteInto(full) }] : [{ label: 'Incolla qui', icon: 'paste', kbd: 'Ctrl+V', run: () => pasteInto() }]),
    ...(one ? [{ label: 'Rinomina', icon: 'edit', kbd: 'F2', run: renameSel }] : []),
    { label: 'Duplica', icon: 'copy', run: duplicateSel },
    { label: sel.length > 1 ? `Comprimi ${sel.length} elementi in ZIP` : 'Comprimi in ZIP', icon: 'box', run: zipSel },
    { label: 'Elimina', icon: 'close', kbd: 'Canc', run: trashSel },
    '-',
    ...(one ? [
      { label: 'Copia percorso', icon: 'copy', run: () => { window.yt.writeClipboard(full); toast('Percorso copiato'); } },
      { label: 'Mostra in Esplora file', icon: 'folder', run: () => window.yt.showInFolder(full) },
      ...(one.isDir ? [{ label: isBookmarked(full) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti', icon: 'star', run: () => toggleBookmark(full) }] : [])
    ] : [])
  );
  showMenu(items, e.clientX, e.clientY);
}

function listBackgroundMenu(e) {
  resetPicked(); renderSidebarList();
  showMenu([
    { label: 'Nuova cartella', icon: 'folderPlus', run: newFolder },
    { label: 'Nuovo file', icon: 'filePlus', run: newFile },
    { label: 'Incolla', icon: 'paste', kbd: 'Ctrl+V', run: () => pasteInto() },
    '-',
    { label: 'Apri nel terminale', icon: 'terminal', run: () => openDir(S.sidebarDir, 'cd') },
    { label: 'Apri terminale come amministratore qui', icon: 'shield', run: () => openAdminTerminal(S.sidebarDir) },
    { label: 'Aggiorna', icon: 'refresh', run: () => loadSidebarList() },
    { label: 'Mostra in Esplora file', icon: 'folder', run: () => window.yt.openPath(S.sidebarDir) }
  ], e.clientX, e.clientY);
}

// -------------------------------------------------------------------------
// Tastiera sulla lista
// -------------------------------------------------------------------------
function onListKey(e) {
  if (e.target.closest('input')) return;
  const list = filteredEntries();
  const k = e.key; const ctrl = e.ctrlKey;
  const go = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (ctrl && e.code === 'KeyC') return go(() => copySel('copy'));
  if (ctrl && e.code === 'KeyX') return go(() => copySel('cut'));
  if (ctrl && e.code === 'KeyV') return go(() => pasteInto());
  if (ctrl && e.code === 'KeyA') return go(() => { FS.picked = new Set(list.map((x) => x.name)); renderSidebarList(); });
  if (k === 'F2') return go(renameSel);
  if (k === 'Delete') return go(trashSel);
  if (k === 'Escape') return go(() => { resetPicked(); renderSidebarList(); focusedPane()?.term.focus(); });
  if (k === 'ArrowDown' || k === 'ArrowUp') return go(() => {
    const i = Math.max(0, Math.min(list.length - 1, (S.sidebarSel < 0 ? -1 : S.sidebarSel) + (k === 'ArrowDown' ? 1 : -1)));
    if (e.shiftKey && FS.anchor != null) { const [a, b] = [Math.min(FS.anchor, i), Math.max(FS.anchor, i)]; FS.picked = new Set(list.slice(a, b + 1).map((x) => x.name)); }
    else { FS.picked = new Set([list[i].name]); FS.anchor = i; }
    S.sidebarSel = i; renderSidebarList();
  });
  if (k === 'Enter') return go(() => {
    const en = list[S.sidebarSel]; if (!en) return;
    const full = joinPath(S.sidebarDir, en.name);
    if (en.isDir) { if (ctrl) openDir(full, 'cd'); else browseTo(full); } else window.yt.openPath(full);
  });
  if (k === 'Backspace') return go(() => $('#sb-up').click());
}

// -------------------------------------------------------------------------
// Trascinamento su una cartella: sposta (Ctrl = copia); da Esplora file copia
// -------------------------------------------------------------------------
function setupFiles() {
  const list = $('#sb-list');
  list.tabIndex = 0;
  list.addEventListener('keydown', onListKey);
  $('#sb-newdir').innerHTML = icon('folderPlus'); $('#sb-newdir').onclick = newFolder;
  $('#sb-newfile').innerHTML = icon('filePlus'); $('#sb-newfile').onclick = newFile;
  $('#sb-paste').innerHTML = icon('paste'); $('#sb-paste').onclick = () => pasteInto();
  $('#sb-refresh').innerHTML = icon('refresh'); $('#sb-refresh').onclick = () => { loadSidebarList(); refreshProject(true); };

  const target = (e) => e.target.closest('#sb-list li.dir');
  list.addEventListener('dragover', (e) => {
    const t = e.dataTransfer.types;
    if (!(t.includes(PATH_TYPE) || t.includes('Files'))) return;
    const li = target(e);
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey || t.includes('Files') ? 'copy' : 'move';
    document.querySelectorAll('#sb-list .drop-folder').forEach((n) => { if (n !== li) n.classList.remove('drop-folder'); });
    if (li) li.classList.add('drop-folder'); else $('#sec-content').classList.add('drop-folder');
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) document.querySelectorAll('.drop-folder').forEach((n) => n.classList.remove('drop-folder')); });
  list.addEventListener('drop', async (e) => {
    const t = e.dataTransfer.types;
    if (!(t.includes(PATH_TYPE) || t.includes('Files'))) return;
    e.preventDefault(); e.stopPropagation();
    document.querySelectorAll('.drop-folder').forEach((n) => n.classList.remove('drop-folder'));
    const li = target(e);
    const dest = li ? joinPath(S.sidebarDir, filteredEntries()[+li.dataset.i].name) : S.sidebarDir;
    const fromExplorer = !t.includes(PATH_TYPE);
    const paths = fromExplorer ? [...e.dataTransfer.files].map((f) => window.yt.pathForFile(f)) : JSON.parse(e.dataTransfer.getData(PATH_TYPE));
    const srcs = paths.filter((p) => !samePath(p, dest));
    if (!srcs.length) return;
    const copyMode = fromExplorer || e.ctrlKey;
    const r = copyMode ? await window.yt.files.copy(srcs, dest) : await window.yt.files.move(srcs, dest);
    if (report(r, `${plural(srcs.length, `«${base(srcs[0])}»`, 'elementi')} ${copyMode ? 'copiat' : 'spostat'}${srcs.length === 1 ? 'o' : 'i'} in ${baseName(dest)}`)) loadSidebarList();
  });
}
