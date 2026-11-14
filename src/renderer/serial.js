/* Trantor — connessione seriale in stile PuTTY
   Finestra di configurazione (porte, velocità, 8N1, flusso, sessioni salvate) e pannelli seriali:
   intestazione con porta, impostazioni e stato; pulsanti per vista HEX, ora, invio esadecimale e registrazione. */
'use strict';

const SR = { ports: [], sel: null, session: null };
const SR_KEYS = ['path', 'baudRate', 'dataBits', 'parity', 'stopBits', 'flow', 'eol', 'echo', 'lf', 'hex', 'timestamps'];

function isSerial(p) { return !!(p && p.profile && p.profile.kind === 'serial'); }
function serialProfile(cfg) { return { id: 'serial', kind: 'serial', name: cfg.path, icon: 'plug', serial: { ...cfg } }; }
function serialSummary(c) {
  const par = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[c.parity] || 'N';
  return `${c.baudRate} ${c.dataBits}${par}${c.stopBits}${c.flow && c.flow !== 'none' ? ' · ' + (c.flow === 'rtscts' ? 'RTS/CTS' : 'XON/XOFF') : ''}`;
}

// --- finestra di configurazione ---------------------------------------------
function srReadForm() {
  return {
    path: $('#sr-path').value.trim(),
    baudRate: parseInt($('#sr-baud').value, 10),
    dataBits: +$('#sr-data').value, parity: $('#sr-parity').value, stopBits: +$('#sr-stop').value, flow: $('#sr-flow').value,
    eol: $('#sr-eol').value, echo: $('#sr-echo').checked, lf: $('#sr-lf').checked, hex: $('#sr-hex').checked, timestamps: $('#sr-ts').checked,
  };
}
function srFillForm(c) {
  if (c.path != null) $('#sr-path').value = c.path;
  if (c.baudRate) $('#sr-baud').value = c.baudRate;
  if (c.dataBits) $('#sr-data').value = c.dataBits;
  if (c.parity) $('#sr-parity').value = c.parity;
  if (c.stopBits) $('#sr-stop').value = c.stopBits;
  if (c.flow) $('#sr-flow').value = c.flow;
  if (c.eol) $('#sr-eol').value = c.eol;
  for (const [k, id] of [['echo', 'sr-echo'], ['lf', 'sr-lf'], ['hex', 'sr-hex'], ['timestamps', 'sr-ts']]) if (c[k] != null) $('#' + id).checked = !!c[k];
}
function srValidate(c) {
  if (!c.path) return 'Scegli o scrivi una porta (per esempio COM3)';
  if (!c.baudRate || c.baudRate < 50 || c.baudRate > 4000000) return 'Velocità non valida';
  return null;
}

function srRenderPorts() {
  const cur = $('#sr-path').value.trim().toLowerCase();
  $('#sr-ports').innerHTML = SR.ports.length
    ? SR.ports.map((p) => `<div class="sr-item ${p.path.toLowerCase() === cur ? 'sel' : ''}" data-path="${esc(p.path)}" title="${esc([p.name, p.manufacturer, p.vid && `VID ${p.vid} · PID ${p.pid}`].filter(Boolean).join('\n'))}">${icon('plug')}<b class="mono">${esc(p.path)}</b><span>${esc(p.name || p.manufacturer || '')}</span></div>`).join('')
    : '<div class="sr-empty">Nessuna porta trovata. Collega il convertitore e premi Aggiorna, oppure scrivi il nome della porta.</div>';
  $('#sr-pathlist').innerHTML = SR.ports.map((p) => `<option value="${esc(p.path)}">${esc(p.name || '')}</option>`).join('');
}
function srRenderSessions() {
  const list = S.cfg.serialSessions || [];
  $('#sr-sessions').innerHTML = list.length
    ? list.map((s, i) => `<div class="sr-item ${SR.session === i ? 'sel' : ''}" data-i="${i}" title="${esc(s.path + ' · ' + serialSummary(s))}">${icon('star')}<b>${esc(s.name)}</b><span class="mono">${esc(s.path)} · ${esc(serialSummary(s))}</span></div>`).join('')
    : '<div class="sr-empty">Configura la porta e premi "Salva…" per ritrovarla qui.</div>';
  $('#sr-delete').disabled = SR.session == null;
}

async function srRefresh() {
  $('#sr-ports').innerHTML = '<div class="sr-empty">Ricerca delle porte…</div>';
  SR.ports = await window.yt.serial.list();
  if (!$('#sr-path').value && SR.ports.length) srPickPort(SR.ports[0].path);
  srRenderPorts();
}
function srPickPort(path) {
  $('#sr-path').value = path;
  const last = (S.cfg.serialLast || {})[path.toLowerCase()];
  if (last) srFillForm({ ...last, path });
  SR.session = null;
  srRenderPorts(); srRenderSessions();
}

async function openSerialDialog() {
  const last = S.cfg.serialLastUsed || {};
  srFillForm({ baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', eol: 'cr', echo: false, lf: true, hex: false, timestamps: false, ...last });
  SR.session = null;
  $('#sr-error').textContent = '';
  $('#sr-overlay').classList.remove('hidden');
  srRenderSessions();
  await srRefresh();
  $('#sr-ports').focus();
}
function closeSerialDialog() { $('#sr-overlay').classList.add('hidden'); focusedPane()?.term.focus(); }

async function srOpen(mode) {
  const c = srReadForm();
  const err = srValidate(c);
  if (err) { $('#sr-error').textContent = err; return; }
  if ([...S.panes.values()].some((p) => isSerial(p) && p.profile.serial.path.toLowerCase() === c.path.toLowerCase())) {
    $('#sr-error').textContent = `${c.path} è già aperta in un altro pannello`; return;
  }
  // ricorda le impostazioni per questa porta
  S.cfg.serialLast = { ...(S.cfg.serialLast || {}), [c.path.toLowerCase()]: c };
  S.cfg.serialLastUsed = c;
  window.yt.saveConfig({ serialLast: S.cfg.serialLast, serialLastUsed: c });
  closeSerialDialog();
  const prof = serialProfile(c);
  if (mode === 'h' && focusedPane()) return splitPane(null, 'h', null, prof);
  return newTab(prof);
}

function srSaveSession() {
  const c = srReadForm();
  const err = srValidate(c);
  if (err) { $('#sr-error').textContent = err; return; }
  const list = S.cfg.serialSessions || [];
  const cur = SR.session != null ? list[SR.session] : null;
  $('#sr-overlay').classList.add('hidden');
  openForm({
    title: 'Salva sessione seriale', icon: 'star', submitLabel: 'Salva',
    fields: [{ id: 'name', label: 'Nome', value: cur ? cur.name : `${c.path} ${serialSummary(c)}`, placeholder: 'Banco prova inverter' }],
    onSubmit: ({ name }) => {
      name = name.trim();
      if (!name) return 'Scrivi un nome';
      const next = list.filter((s) => s.name !== name);
      next.push({ name, ...c });
      next.sort((a, b) => a.name.localeCompare(b.name, 'it'));
      S.cfg.serialSessions = next;
      window.yt.saveConfig({ serialSessions: next });
      SR.session = next.findIndex((s) => s.name === name);
      setTimeout(() => { $('#sr-overlay').classList.remove('hidden'); srRenderSessions(); $('#sr-sessions').focus(); });
      return null;
    },
  });
  // se l'utente annulla, torna alla finestra seriale
  const cancel = $('#form-cancel'); const prev = cancel.onclick;
  cancel.onclick = () => { prev && prev(); $('#sr-overlay').classList.remove('hidden'); };
}
function srDeleteSession() {
  if (SR.session == null) return;
  const list = (S.cfg.serialSessions || []).slice();
  list.splice(SR.session, 1);
  S.cfg.serialSessions = list; SR.session = null;
  window.yt.saveConfig({ serialSessions: list });
  srRenderSessions();
}

// --- pannelli seriali ----------------------------------------------------------
function setupSerialPane(p) {
  const c = p.profile.serial;
  p.el.classList.add('serial');
  p.serialState = { state: 'opening', text: '', cfg: { hex: !!c.hex, timestamps: !!c.timestamps, echo: !!c.echo, logging: false } };
  const actions = p.el.querySelector('.p-actions');
  actions.insertAdjacentHTML('afterbegin', `
    <button class="icon-btn sr-btn" data-sr="hex" title="Vista esadecimale / testo"><span class="sr-txt">HEX</span></button>
    <button class="icon-btn sr-btn" data-sr="ts" title="Ora su ogni riga">${icon('clock')}</button>
    <button class="icon-btn sr-btn" data-sr="send" title="Invia byte in esadecimale">${icon('play')}</button>
    <button class="icon-btn sr-btn" data-sr="log" title="Registra i dati ricevuti su file"><span class="sr-rec"></span></button>
    <span class="p-sep"></span>`);
  actions.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sr]'); if (!b) return;
    e.stopPropagation();
    serialAction(p, b.dataset.sr);
  }, true);
  renderSerialHeader(p);
}

function renderSerialHeader(p) {
  const c = p.profile.serial; const st = p.serialState;
  const label = { open: 'Connesso', wait: 'In attesa', opening: 'Apertura…' }[st.state] || st.state;
  p.pathEl.innerHTML = `<span class="sr-port mono">${esc(c.path)}</span><span class="sr-set mono">${esc(serialSummary(c))}</span>` +
    `<span class="sr-state ${st.state}" title="${esc(st.text || label)}">${esc(label)}</span>`;
  p.el.querySelector('[data-sr="hex"]').classList.toggle('on', !!st.cfg.hex);
  p.el.querySelector('[data-sr="ts"]').classList.toggle('on', !!st.cfg.timestamps);
  p.el.querySelector('[data-sr="ts"]').disabled = !!st.cfg.hex;
  p.el.querySelector('[data-sr="log"]').classList.toggle('on', !!st.cfg.logging);
  p.el.querySelector('[data-sr="log"]').title = st.cfg.logging ? 'Interrompi la registrazione' : 'Registra i dati ricevuti su file';
}

function serialSet(p, opts) {
  Object.assign(p.profile.serial, opts);
  Object.assign(p.serialState.cfg, opts);
  window.yt.serial.set(p.id, opts);
  renderSerialHeader(p);
  saveSessionSoon();
}

function serialSendHex(p) {
  openForm({
    title: `Invia a ${p.profile.serial.path}`, icon: 'play', submitLabel: 'Invia',
    fields: [{ id: 'hex', label: 'Byte in esadecimale', value: p.lastHex || '', placeholder: '01 03 00 00 00 0A C5 CD', mono: true }],
    onSubmit: ({ hex }) => {
      window.yt.serial.sendHex(p.id, hex).then((r) => { if (r && !r.ok) toast(r.error); });
      p.lastHex = hex;
      return null;
    },
  });
}

async function serialAction(p, act) {
  focusPane(p.id, false);
  const c = p.serialState.cfg;
  if (act === 'hex') serialSet(p, { hex: !c.hex });
  if (act === 'ts') serialSet(p, { timestamps: !c.timestamps });
  if (act === 'echo') serialSet(p, { echo: !c.echo });
  if (act === 'send') serialSendHex(p);
  if (act === 'log') { await window.yt.serial.log(p.id, !c.logging); }
  if (act !== 'send') p.term.focus();
}

function serialMenuItems(p) {
  if (!isSerial(p)) return [];
  const c = p.serialState.cfg;
  return [
    { label: 'Vista esadecimale', icon: 'cpu', check: !!c.hex, run: () => serialAction(p, 'hex') },
    { label: 'Ora su ogni riga', icon: 'clock', check: !!c.timestamps, run: () => serialAction(p, 'ts') },
    { label: 'Eco locale', icon: 'eye', check: !!c.echo, run: () => serialAction(p, 'echo') },
    { label: 'Invia esadecimale…', icon: 'play', run: () => serialAction(p, 'send') },
    { label: c.logging ? 'Interrompi registrazione' : 'Registra su file…', icon: 'file', run: () => serialAction(p, 'log') },
    '-',
  ];
}

function setupSerial() {
  $('.sr-icon').innerHTML = icon('plug');
  $('#sr-refresh').innerHTML = icon('refresh');
  $('#sr-refresh').onclick = srRefresh;
  $('#sr-cancel').onclick = closeSerialDialog;
  $('#sr-open').onclick = () => srOpen();
  $('#sr-save').onclick = srSaveSession;
  $('#sr-delete').onclick = srDeleteSession;
  $('#sr-path').addEventListener('input', srRenderPorts);
  $('#sr-ports').addEventListener('click', (e) => { const it = e.target.closest('.sr-item'); if (it) srPickPort(it.dataset.path); });
  $('#sr-ports').addEventListener('dblclick', (e) => { const it = e.target.closest('.sr-item'); if (it) { srPickPort(it.dataset.path); srOpen(); } });
  $('#sr-sessions').addEventListener('click', (e) => {
    const it = e.target.closest('.sr-item'); if (!it) return;
    SR.session = +it.dataset.i;
    const s = (S.cfg.serialSessions || [])[SR.session]; if (s) srFillForm(s);
    srRenderSessions(); srRenderPorts();
  });
  $('#sr-sessions').addEventListener('dblclick', (e) => { if (e.target.closest('.sr-item')) srOpen(); });
  $('#sr-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'sr-overlay') closeSerialDialog(); });
  $('#sr-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSerialDialog(); }
    if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); srOpen(); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.id === 'sr-ports' && SR.ports.length) {
      e.preventDefault();
      const i = SR.ports.findIndex((p) => p.path.toLowerCase() === $('#sr-path').value.trim().toLowerCase());
      const j = Math.max(0, Math.min(SR.ports.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      srPickPort(SR.ports[j].path);
    }
  });
  window.yt.serial.onState((id, st) => {
    const p = S.panes.get(id); if (!isSerial(p)) return;
    p.serialState = { ...p.serialState, state: st.state, text: st.text, cfg: { ...p.serialState.cfg, ...st.cfg } };
    renderSerialHeader(p);
    renderTabs();
  });
}

document.addEventListener('DOMContentLoaded', setupSerial);
