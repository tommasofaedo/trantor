/* Trantor — pulsanti di comando e invio a tutti i pannelli
   - Barra di pulsanti sopra i pannelli: ognuno esegue un comando. Valgono ovunque o solo in un progetto.
   - "Digita in tutti i pannelli": quello che scrivi va in tutti i pannelli della scheda (come synchronize-panes di tmux). */
'use strict';

const QB = { syncTabs: new Set() };

// -------------------------------------------------------------------------
// Pulsanti
// -------------------------------------------------------------------------
function quickButtons() { return S.cfg.quickButtons || []; }
function saveQuickButtons(list) { S.cfg.quickButtons = list; window.yt.saveConfig({ quickButtons: list }); renderQuickbar(); }

// Pulsanti visibili per il pannello attivo: quelli generali + quelli del suo progetto
function visibleButtons() {
  const p = focusedPane();
  const root = p && p.projectRoot;
  return quickButtons().filter((b) => b.scope !== 'project' || (root && samePath(b.root, root)));
}

function renderQuickbar() {
  const bar = $('#quickbar');
  const btns = visibleButtons();
  const tab = activeTab();
  const multi = tab && panesOf(tab.root).length > 1;
  const synced = tab && QB.syncTabs.has(tab.id);
  bar.classList.toggle('hidden', !btns.length && !synced);
  bar.innerHTML = btns.map((b) =>
    `<button class="qb ${b.scope === 'project' ? 'qb-proj' : ''}" data-id="${esc(b.id)}" title="${esc(`${b.cmd}\n${b.scope === 'project' ? 'Solo nel progetto ' + baseName(b.root) : 'In tutte le cartelle'} · ${TARGET_LABEL[b.target || 'pane']}\nShift+clic: in un nuovo pannello · Alt+clic: in tutti i pannelli · tasto destro: modifica`)}">${icon('play')}${esc(b.label)}</button>`
  ).join('') +
    `<button class="qb qb-add" title="Nuovo pulsante di comando">${icon('plus')}</button>` +
    `<span class="qb-spacer"></span>` +
    (multi || synced ? `<button class="qb qb-sync ${synced ? 'on' : ''}" title="Quello che scrivi va in tutti i pannelli di questa scheda (Ctrl+Shift+A)">${icon('splitH')}${synced ? 'Digitazione in tutti i pannelli' : 'Tutti i pannelli'}</button>` : '');
  document.querySelectorAll('.tab-view').forEach((v) => v.classList.remove('synced'));
  if (synced) tab.view.classList.add('synced');
}

const TARGET_LABEL = { pane: 'nel pannello attivo', newpane: 'in un nuovo pannello', all: 'in tutti i pannelli della scheda' };

function runQuickButton(b, override) {
  const p = focusedPane();
  if (!p) return;
  const dir = b.scope === 'project' ? b.root : null;
  const target = override || b.target || 'pane';
  if (target === 'all') return sendToAllPanes(b.cmd, dir);
  if (target === 'newpane') return runCommandIn(p, dir || p.cwd, b.cmd, 'h');
  runCommandIn(p, dir, b.cmd);
}

function sendToAllPanes(cmd, dir) {
  const tab = activeTab(); if (!tab) return;
  for (const id of panesOf(tab.root)) {
    const p = S.panes.get(id);
    if (!p || !p.alive || p.remote && dir) continue;
    if (dir && !samePath(p.cwd, dir)) window.yt.write(p.id, cdCommand(p.profile.kind, dir));
    window.yt.write(p.id, cmd + '\r');
  }
}

// Editor di un pulsante (nuovo o esistente)
function editQuickButton(existing, preset = {}) {
  const p = focusedPane();
  const root = (existing && existing.root) || preset.root || (p && p.projectRoot) || (S.project && S.project.root) || null;
  const b = existing || { label: preset.label || '', cmd: preset.cmd || '', scope: preset.scope || (root ? 'project' : 'global'), target: 'pane', root };
  openForm({
    title: existing ? 'Modifica pulsante' : 'Nuovo pulsante di comando',
    icon: 'play',
    fields: [
      { id: 'label', label: 'Nome del pulsante', value: b.label, placeholder: 'es. Build' },
      { id: 'cmd', label: 'Comando', value: b.cmd, placeholder: 'es. npm run build', mono: true },
      { id: 'scope', label: 'Dove compare', type: 'select', value: b.scope,
        options: [['global', 'In tutte le cartelle'], ...(root ? [['project', `Solo nel progetto ${baseName(root)}`]] : [])] },
      { id: 'target', label: 'Dove esegue', type: 'select', value: b.target || 'pane',
        options: [['pane', 'Nel pannello attivo'], ['newpane', 'In un nuovo pannello'], ['all', 'In tutti i pannelli della scheda']] }
    ],
    submitLabel: existing ? 'Salva' : 'Crea',
    onSubmit: (v) => {
      if (!v.cmd.trim()) return 'Scrivi il comando';
      const item = { id: existing ? existing.id : nextId('qb'), label: v.label.trim() || v.cmd.trim().slice(0, 24), cmd: v.cmd.trim(), scope: v.scope, target: v.target, root: v.scope === 'project' ? root : null };
      const list = quickButtons().slice();
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = item; else list.push(item);
      saveQuickButtons(list);
      toast(existing ? 'Pulsante aggiornato' : `Pulsante «${item.label}» creato`);
      return null;
    }
  });
}

function quickButtonMenu(b, x, y) {
  const list = quickButtons();
  const i = list.findIndex((q) => q.id === b.id);
  const move = (d) => { const l = list.slice(); const [it] = l.splice(i, 1); l.splice(Math.max(0, Math.min(l.length, i + d)), 0, it); saveQuickButtons(l); };
  showMenu([
    { head: b.label },
    { label: 'Esegui', icon: 'play', run: () => runQuickButton(b) },
    { label: 'Esegui in un nuovo pannello', icon: 'splitH', kbd: 'Shift+clic', run: () => runQuickButton(b, 'newpane') },
    { label: 'Esegui in tutti i pannelli', icon: 'splitV', kbd: 'Alt+clic', run: () => runQuickButton(b, 'all') },
    '-',
    { label: 'Modifica', icon: 'edit', run: () => editQuickButton(b) },
    ...(i > 0 ? [{ label: 'Sposta a sinistra', icon: 'chevronLeft', run: () => move(-1) }] : []),
    ...(i < list.length - 1 ? [{ label: 'Sposta a destra', icon: 'chevronRight', run: () => move(1) }] : []),
    { label: 'Elimina', icon: 'close', run: () => { saveQuickButtons(list.filter((q) => q.id !== b.id)); toast('Pulsante eliminato'); } }
  ], x, y);
}

// -------------------------------------------------------------------------
// Digitare in tutti i pannelli
// -------------------------------------------------------------------------
function toggleSyncInput() {
  const tab = activeTab(); if (!tab) return;
  if (QB.syncTabs.has(tab.id)) { QB.syncTabs.delete(tab.id); toast('Digitazione solo nel pannello attivo'); }
  else {
    if (panesOf(tab.root).length < 2) { toast('Servono almeno due pannelli nella scheda'); return; }
    QB.syncTabs.add(tab.id); toast('Quello che scrivi va in tutti i pannelli di questa scheda');
  }
  renderQuickbar();
  focusedPane()?.term.focus();
}

// Usata dai pannelli per inviare i tasti premuti
function sendInput(pane, data) {
  const tab = tabOfPane(pane.id);
  if (!tab || !QB.syncTabs.has(tab.id)) { window.yt.write(pane.id, data); return; }
  for (const id of panesOf(tab.root)) { const p = S.panes.get(id); if (p && p.alive) window.yt.write(p.id, data); }
}

function broadcastPrompt() {
  const tab = activeTab(); if (!tab) return;
  const n = panesOf(tab.root).length;
  openPicker({
    placeholder: `Comando da inviare a ${n === 1 ? 'questo pannello' : `tutti i ${n} pannelli della scheda`}…`,
    iconName: 'splitH',
    hints: [['Invio', 'invia'], ['Esc', 'annulla']],
    source: async (q) => q.trim() ? [{ label: q.trim(), icon: 'play', detail: `Esegue in ${n} pannell${n === 1 ? 'o' : 'i'}` }] : [],
    onPick: (it) => sendToAllPanes(it.label)
  });
}

// -------------------------------------------------------------------------
// Modulo generico (usato dall'editor dei pulsanti)
// -------------------------------------------------------------------------
function openForm({ title, icon: ic, fields, submitLabel, onSubmit }) {
  const ov = $('#form-overlay');
  $('#form-title').innerHTML = `${icon(ic || 'edit')}<b>${esc(title)}</b>`;
  $('#form-fields').innerHTML = fields.map((f) => `<label>${esc(f.label)}` + (f.type === 'select'
    ? `<select data-id="${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
    : `<input data-id="${f.id}" type="text" spellcheck="false" class="${f.mono ? 'mono' : ''}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" />`) + '</label>').join('');
  $('#form-submit').textContent = submitLabel || 'OK';
  $('#form-error').textContent = '';
  ov.classList.remove('hidden');
  const first = ov.querySelector('[data-id]'); first.focus(); if (first.select) first.select();
  const close = () => { ov.classList.add('hidden'); $('#form-submit').onclick = null; focusedPane()?.term.focus(); };
  const submit = () => {
    const v = {}; ov.querySelectorAll('[data-id]').forEach((el) => { v[el.dataset.id] = el.value; });
    const err = onSubmit(v);
    if (err) { $('#form-error').textContent = err; return; }
    close();
  };
  $('#form-submit').onclick = submit;
  $('#form-cancel').onclick = close;
  ov.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); } };
  ov.onmousedown = (e) => { if (e.target === ov) close(); };
}

// -------------------------------------------------------------------------
// Avvio
// -------------------------------------------------------------------------
function setupQuickbar() {
  const bar = $('#quickbar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.qb'); if (!btn) return;
    if (btn.classList.contains('qb-add')) return editQuickButton(null);
    if (btn.classList.contains('qb-sync')) return toggleSyncInput();
    const b = quickButtons().find((q) => q.id === btn.dataset.id); if (!b) return;
    runQuickButton(b, e.shiftKey ? 'newpane' : e.altKey ? 'all' : null);
  });
  bar.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('.qb[data-id]'); if (!btn) return;
    e.preventDefault();
    const b = quickButtons().find((q) => q.id === btn.dataset.id); if (b) quickButtonMenu(b, e.clientX, e.clientY);
  });
  renderQuickbar();
}
