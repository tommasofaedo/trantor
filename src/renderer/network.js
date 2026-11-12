/* Trantor — dispositivi in rete
   Vista "Rete" della barra laterale: scansione, elenco dei dispositivi con i servizi riconosciuti,
   azioni rapide (SSH, web, ping, desktop remoto) e lettura Modbus in sola lettura. */
'use strict';

const NET = { devices: new Map(), scanning: false, open: new Set(), ifs: [] };

const SVC_LABEL = {
  ssh: 'SSH', telnet: 'Telnet', http: 'Web', https: 'Web', s7: 'S7', modbus: 'Modbus', mqtt: 'MQTT', mqtts: 'MQTT',
  opcua: 'OPC UA', enip: 'EtherNet/IP', iec104: 'IEC 104', dnp3: 'DNP3', ads: 'ADS', vnc: 'VNC', rdp: 'RDP',
  smb: 'Condivisione', printer: 'Stampante', rtsp: 'Video'
};
const INDUSTRIAL_SVC = new Set(['s7', 'modbus', 'opcua', 'enip', 'iec104', 'dnp3', 'ads', 'mqtt', 'mqtts']);
const TYPE_INFO = {
  self: ['monitor', 'Questo PC', 'questo PC', 'questo PC'], plc: ['cpu', 'Automazione', 'di automazione', 'di automazione'],
  router: ['router', 'Rete', 'di rete', 'di rete'], pc: ['monitor', 'Computer', 'computer', 'computer'],
  server: ['server', 'Server', 'server', 'server'], camera: ['camera', 'Telecamera', 'telecamera', 'telecamere'],
  printer: ['printer', 'Stampante', 'stampante', 'stampanti'], device: ['dot', 'Dispositivo', 'altro', 'altri']
};
const ip2n = (ip) => ip.split('.').reduce((a, b) => a * 256 + (+b), 0);

// -------------------------------------------------------------------------
// Descrizione di un dispositivo
// -------------------------------------------------------------------------
function svc(d, name) { return d.services.filter((s) => s.svc === name); }
function devTitle(d) {
  if (d.self) return 'Questo PC';
  const mb = svc(d, 'modbus').find((s) => s.ident && (s.ident.vendor || s.ident.product));
  if (mb) return [mb.ident.vendor, mb.ident.product].filter(Boolean).join(' ');
  const en = svc(d, 'enip').find((s) => s.ident && s.ident.productName);
  if (en) return en.ident.productName;
  const web = d.services.find((s) => (s.svc === 'http' || s.svc === 'https') && s.title);
  if (web) return web.title;
  if (d.hostname) return d.hostname;
  if (d.gateway) return 'Router (gateway)';
  return d.vendor || '';
}
function devSub(d, title) {
  return [d.vendor && d.vendor !== title ? d.vendor : null, d.hostname && d.hostname !== title ? d.hostname : null, d.gateway && title !== 'Router (gateway)' ? 'gateway' : null]
    .filter(Boolean).join(' · ');
}
function devChips(d) {
  const seen = new Set(); const out = [];
  for (const s of d.services) {
    const l = SVC_LABEL[s.svc]; if (!l || seen.has(l)) continue;
    seen.add(l); out.push(`<span class="chip ${INDUSTRIAL_SVC.has(s.svc) ? 'chip-ind' : ''}">${l}</span>`);
  }
  return out.join('');
}
function devSearchText(d) {
  return [d.ip, d.mac, d.vendor, d.hostname, devTitle(d), ...d.services.map((s) => `${SVC_LABEL[s.svc] || ''} ${s.port} ${s.title || ''} ${s.banner || ''}`)].join(' ').toLowerCase();
}

function detailRows(d) {
  const rows = [];
  if (d.mac) rows.push(['MAC', `${d.mac.toUpperCase()}${d.vendor ? ' · ' + d.vendor : ''}`]);
  if (d.hostname) rows.push(['Nome', d.hostname]);
  for (const s of d.services) {
    const l = `${SVC_LABEL[s.svc] || s.svc} · ${s.port}`;
    if (s.svc === 'ssh' || s.svc === 'vnc') rows.push([l, s.banner || 'aperta']);
    else if (s.svc === 'http' || s.svc === 'https') rows.push([l, [s.title, s.server, s.status && s.status !== 200 ? `HTTP ${s.status}` : null].filter(Boolean).join(' · ') || 'aperta']);
    else if (s.svc === 'modbus') rows.push([l, s.ident && (s.ident.vendor || s.ident.product)
      ? [s.ident.vendor, s.ident.product, s.ident.revision && 'v' + s.ident.revision, `unit ${s.ident.unit}`].filter(Boolean).join(' · ')
      : 'identificazione non supportata']);
    else if (s.svc === 'enip') rows.push([l, s.ident ? `${s.ident.productName} · rev ${s.ident.revision} · S/N ${s.ident.serial}` : 'aperta']);
    else if (s.svc === 'opcua') rows.push([l, s.ident ? s.ident.endpoint : 'aperta']);
    else if (s.svc === 's7') rows.push([l, s.ident && s.ident.cotp ? `risponde (ISO-on-TCP, slot ${s.ident.slot})` : 'aperta']);
    else rows.push([l, 'aperta']);
  }
  if (!d.services.length) rows.push(['Servizi', 'nessuna porta nota aperta (trovato tramite ARP o risposta di rifiuto)']);
  return rows;
}

function devActions(d) {
  const a = [];
  if (svc(d, 'ssh').length) a.push({ label: 'SSH', icon: 'terminal', run: () => openSshPicker(d.ip) });
  for (const s of d.services.filter((x) => x.svc === 'http' || x.svc === 'https')) {
    const url = `${s.svc}://${d.ip}${(s.svc === 'http' && s.port === 80) || (s.svc === 'https' && s.port === 443) ? '' : ':' + s.port}`;
    a.push({ label: `Apri ${url.replace(/^https?:\/\//, '')}${s.svc === 'https' ? ' (https)' : ''}`, icon: 'globe', run: () => window.yt.openUrl(url) });
  }
  const mb = svc(d, 'modbus')[0];
  if (mb) a.push({ label: 'Leggi registri Modbus', icon: 'cpu', run: () => openModbus(d.ip, mb.port, (mb.ident && mb.ident.unit !== 255 && mb.ident.unit) || 1) });
  const ua = svc(d, 'opcua')[0];
  if (ua) a.push({ label: 'Copia endpoint OPC UA', icon: 'copy', run: () => { window.yt.writeClipboard(`opc.tcp://${d.ip}:${ua.port}`); toast('Endpoint copiato'); } });
  if (svc(d, 'rdp').length && isWin()) a.push({ label: 'Desktop remoto', icon: 'monitor', run: () => window.yt.netRdp(d.ip) });
  if (svc(d, 'telnet').length) a.push({ label: 'Telnet', icon: 'terminal', run: () => runInNewPane(`telnet ${d.ip}`, 'v') });
  a.push({ label: 'Ping continuo', icon: 'pulse', run: () => runInNewPane(isWin() ? `ping -t ${d.ip}` : `ping ${d.ip}`, 'v') });
  a.push({ label: 'Copia IP', icon: 'copy', run: () => { window.yt.writeClipboard(d.ip); toast(`${d.ip} copiato`); } });
  if (d.mac) a.push({ label: 'Copia MAC', icon: 'copy', run: () => { window.yt.writeClipboard(d.mac.toUpperCase()); toast('MAC copiato'); } });
  return a;
}

async function runInNewPane(cmd, mode) {
  const p = focusedPane();
  if (!p) return;
  const np = await splitPane(p.id, mode);
  if (np) window.yt.write(np.id, cmd + '\r');
}

// -------------------------------------------------------------------------
// Elenco
// -------------------------------------------------------------------------
function renderNetList() {
  const box = $('#net-list');
  const q = $('#net-filter').value.trim().toLowerCase();
  const list = [...NET.devices.values()].sort((a, b) => ip2n(a.ip) - ip2n(b.ip)).filter((d) => !q || devSearchText(d).includes(q));
  if (!NET.devices.size) {
    box.innerHTML = NET.scanning ? '<div class="sb-empty">Ricerca in corso…</div>'
      : `<div class="net-empty">${icon('router')}<p>Cerca i dispositivi collegati alla rete: PLC, pannelli, router, server, stampanti.</p>
         <p class="dim">Trantor prova le porte più comuni e legge l’identificazione che i dispositivi espongono, senza modificare nulla. Usa la scansione solo su reti che gestisci o per cui hai l’autorizzazione.</p></div>`;
    return;
  }
  if (!list.length) { box.innerHTML = '<div class="sb-empty">Nessun dispositivo corrisponde al filtro</div>'; return; }
  const counts = {};
  for (const d of NET.devices.values()) counts[d.type] = (counts[d.type] || 0) + 1;
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${(TYPE_INFO[t] || TYPE_INFO.device)[n === 1 ? 2 : 3]}`).join(' · ');
  box.innerHTML = `<div class="net-summary">${NET.devices.size} dispositivi · ${summary}</div>` + list.map((d) => {
    const title = devTitle(d); const sub = devSub(d, title);
    const [ic, tlabel] = TYPE_INFO[d.type] || TYPE_INFO.device;
    const open = NET.open.has(d.ip);
    return `<div class="dev ${open ? 'open' : ''} t-${d.type}" data-ip="${d.ip}">
      <div class="dev-row" title="${esc(tlabel)}">
        <span class="dev-ico">${icon(ic)}</span>
        <div class="dev-main"><div class="dev-line"><span class="dev-ip mono">${d.ip}</span><span class="dev-title">${esc(title)}</span></div>
          ${sub ? `<div class="dev-sub">${esc(sub)}</div>` : ''}
          ${d.services.length ? `<div class="dev-chips">${devChips(d)}</div>` : ''}</div>
      </div>
      ${open ? `<div class="dev-detail">
        <dl>${detailRows(d).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="dev-actions">${devActions(d).map((a, i) => `<button class="dev-act" data-act="${i}">${icon(a.icon)}${esc(a.label)}</button>`).join('')}</div>
      </div>` : ''}
    </div>`;
  }).join('');
}

function setNetProgress(p) {
  const box = $('.net-progress');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const pct = p.phase === 'dettagli' || p.phase === 'fine' ? 100 : Math.round((p.done / Math.max(1, p.total)) * 100);
  box.querySelector('i').style.width = pct + '%';
  box.classList.toggle('indeterminate', p.phase === 'dettagli');
  $('#net-status').textContent = p.phase === 'dettagli' ? `Riconoscimento di ${p.found} dispositivi…`
    : p.phase === 'fine' ? `${p.found} dispositivi trovati` : `${pct}% · ${p.found} dispositivi`;
}

async function startScan() {
  if (NET.scanning) { window.yt.netCancel(); return; }
  const range = $('#net-range').value.trim();
  if (!range) { toast('Scrivi la rete da scansionare, per esempio 192.168.1.0/24'); return; }
  NET.scanning = true; NET.devices.clear(); NET.open.clear();
  S.cfg.netRange = range; window.yt.saveConfig({ netRange: range });
  $('#net-scan').textContent = 'Interrompi';
  setNetProgress({ done: 0, total: 1, found: 0, phase: 'porte' });
  renderNetList();
  const r = await window.yt.netScan(range);
  NET.scanning = false;
  $('#net-scan').textContent = 'Scansiona';
  if (!r.ok) { setNetProgress(null); toast(r.error); }
  else if (r.cancelled) { $('#net-status').textContent = 'Scansione interrotta'; }
  renderNetList();
}

async function loadInterfaces() {
  NET.ifs = await window.yt.netInterfaces();
  const sel = $('#net-if');
  sel.innerHTML = NET.ifs.map((i, k) => `<option value="${k}">${esc(i.name)} · ${i.address}/${i.bits}</option>`).join('') +
    '<option value="custom">Intervallo personalizzato</option>';
  if (!NET.ifs.length) sel.value = 'custom';
  if (!$('#net-range').value) $('#net-range').value = S.cfg.netRange || (NET.ifs[0] ? NET.ifs[0].range : '');
}

// -------------------------------------------------------------------------
// SSH: scelta dell'utente
// -------------------------------------------------------------------------
function openSshPicker(ip) {
  const known = S.cfg.sshUsers || [];
  openPicker({
    placeholder: `Utente per ssh su ${ip}…`,
    iconName: 'terminal',
    hints: [['Invio', 'nuova scheda'], ['Shift+Invio', 'pannello a destra'], ['Alt+Invio', 'pannello sotto']],
    source: async (q) => {
      const users = [...new Set([q.trim(), ...known, 'root', 'admin', 'pi', 'ubuntu'].filter((u) => u && /^[\w.\-]+$/.test(u)))];
      return users.map((u) => ({ label: `ssh ${u}@${ip}`, user: u, icon: 'terminal', tag: known.includes(u) ? 'usato' : null }));
    },
    onPick: async (it, mode) => {
      S.cfg.sshUsers = [it.user, ...known.filter((u) => u !== it.user)].slice(0, 6);
      window.yt.saveConfig({ sshUsers: S.cfg.sshUsers });
      const cmd = `ssh ${it.user}@${ip}`;
      if (mode === 'h' || mode === 'v') return runInNewPane(cmd, mode);
      const tab = await newTab(null, S.info.home);
      const np = tab && S.panes.get(tab.focused);
      if (np) window.yt.write(np.id, cmd + '\r');
    }
  });
}

// -------------------------------------------------------------------------
// Lettura Modbus
// -------------------------------------------------------------------------
const MB = { ip: null, port: 502, timer: null, last: null, busy: false };

function formatModbus(values, fc, fmt, addr) {
  const rows = [];
  if (fc <= 2) { values.forEach((v, i) => rows.push([addr + i, v ? '1 · ON' : '0 · OFF'])); return rows; }
  if (fmt === 'f32' || fmt === 'f32s') {
    const dv = new DataView(new ArrayBuffer(4));
    for (let i = 0; i + 1 < values.length; i += 2) {
      const [hi, lo] = fmt === 'f32' ? [values[i], values[i + 1]] : [values[i + 1], values[i]];
      dv.setUint16(0, hi); dv.setUint16(2, lo);
      const f = dv.getFloat32(0);
      rows.push([`${addr + i}–${addr + i + 1}`, Number.isFinite(f) ? String(+f.toPrecision(7)).replace('.', ',') : String(f)]);
    }
    return rows;
  }
  values.forEach((v, i) => {
    let s;
    if (fmt === 's16') s = String(v > 32767 ? v - 65536 : v);
    else if (fmt === 'hex') s = '0x' + v.toString(16).toUpperCase().padStart(4, '0');
    else if (fmt === 'bin') s = v.toString(2).padStart(16, '0').replace(/(\d{4})(?=\d)/g, '$1 ');
    else s = String(v);
    rows.push([addr + i, s]);
  });
  return rows;
}

function renderModbusTable() {
  const r = MB.last; const tb = $('#mb-table tbody');
  if (!r || !r.ok) { tb.innerHTML = ''; return; }
  const fc = +$('#mb-fc').value; const addr = +$('#mb-addr').value;
  const rows = formatModbus(r.values, fc, $('#mb-fmt').value, addr);
  const prev = MB.prevRows || {};
  tb.innerHTML = rows.map(([a, v]) => `<tr class="${prev[a] !== undefined && prev[a] !== v ? 'changed' : ''}"><td class="mono">${a}</td><td class="mono">${esc(v)}</td></tr>`).join('');
  MB.prevRows = Object.fromEntries(rows);
}

async function modbusReadOnce() {
  if (MB.busy) return;
  MB.busy = true;
  const opts = { ip: MB.ip, port: MB.port, unit: +$('#mb-unit').value, fc: +$('#mb-fc').value, address: +$('#mb-addr').value, quantity: +$('#mb-qty').value };
  const r = await window.yt.netModbus(opts);
  MB.busy = false;
  if ($('#mb-overlay').classList.contains('hidden')) return;
  MB.last = r;
  const st = $('#mb-status');
  st.classList.toggle('err', !r.ok);
  st.textContent = r.ok ? `Letti ${r.values.length} valori${r.ms != null ? ` in ${r.ms} ms` : ''} · ${new Date().toLocaleTimeString('it-IT')}` : r.error;
  renderModbusTable();
}

function setModbusPolling(on) {
  clearInterval(MB.timer); MB.timer = null;
  $('#mb-poll').checked = on;
  if (on) { modbusReadOnce(); MB.timer = setInterval(modbusReadOnce, 1000); }
}

function openModbus(ip, port = 502, unit = 1) {
  MB.ip = ip; MB.port = port; MB.last = null; MB.prevRows = null;
  $('#mb-target').textContent = `${ip}:${port}`;
  $('#mb-unit').value = unit;
  $('#mb-status').textContent = ''; $('#mb-table tbody').innerHTML = '';
  $('#mb-overlay').classList.remove('hidden');
  $('#mb-read').focus();
}
function closeModbus() { setModbusPolling(false); $('#mb-overlay').classList.add('hidden'); focusedPane()?.term.focus(); }

// -------------------------------------------------------------------------
// Vista della barra laterale
// -------------------------------------------------------------------------
function setSidebarMode(mode) {
  S.sidebarMode = mode;
  // la vista Rete ha bisogno di un po' più di spazio
  const sb = $('#sidebar');
  sb.style.width = (mode === 'net' ? Math.max(S.cfg.sidebarWidth || 270, 340) : (S.cfg.sidebarWidth || 270)) + 'px';
  document.querySelectorAll('.sb-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#sb-files').classList.toggle('hidden', mode !== 'files');
  $('#sb-net').classList.toggle('hidden', mode !== 'net');
  if (mode === 'net' && !NET.ifs.length) loadInterfaces();
}
function toggleNetView() {
  if (!S.cfg.sidebarVisible) toggleSidebar(true);
  setSidebarMode(S.sidebarMode === 'net' ? 'files' : 'net');
  if (S.sidebarMode === 'net') $('#net-range').focus();
}

function setupNetwork() {
  $('.net-filter-icon').innerHTML = icon('search');
  $('.mb-icon').innerHTML = icon('cpu');
  $('#mb-close').innerHTML = icon('close');
  document.querySelectorAll('.sb-mode button').forEach((b) => b.addEventListener('click', () => setSidebarMode(b.dataset.mode)));
  $('#net-scan').onclick = startScan;
  $('#net-range').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startScan(); } if (e.key === 'Escape') focusedPane()?.term.focus(); });
  $('#net-if').addEventListener('change', (e) => {
    const i = NET.ifs[+e.target.value];
    if (i) $('#net-range').value = i.range; else { $('#net-range').select(); $('#net-range').focus(); }
  });
  $('#net-filter').addEventListener('input', renderNetList);
  window.yt.onNetProgress(setNetProgress);
  window.yt.onNetDevice((d) => { NET.devices.set(d.ip, d); renderNetListSoon(); });

  const list = $('#net-list');
  list.addEventListener('click', (e) => {
    const devEl = e.target.closest('.dev'); if (!devEl) return;
    const d = NET.devices.get(devEl.dataset.ip);
    const act = e.target.closest('.dev-act');
    if (act) { devActions(d)[+act.dataset.act].run(); return; }
    if (e.target.closest('.dev-row')) {
      if (NET.open.has(d.ip)) NET.open.delete(d.ip); else NET.open.add(d.ip);
      renderNetList();
    }
  });
  list.addEventListener('contextmenu', (e) => {
    const devEl = e.target.closest('.dev'); if (!devEl) return;
    e.preventDefault();
    const d = NET.devices.get(devEl.dataset.ip);
    showMenu([{ head: `${d.ip} · ${devTitle(d) || 'dispositivo'}` }, ...devActions(d)], e.clientX, e.clientY);
  });

  // Finestra Modbus
  $('#mb-close').onclick = closeModbus;
  $('#mb-read').onclick = () => modbusReadOnce();
  $('#mb-poll').addEventListener('change', (e) => setModbusPolling(e.target.checked));
  $('#mb-fmt').addEventListener('change', renderModbusTable);
  $('#mb-fc').addEventListener('change', () => { $('#mb-qty').max = +$('#mb-fc').value <= 2 ? 2000 : 125; MB.last = null; MB.prevRows = null; renderModbusTable(); });
  $('#mb-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'mb-overlay') closeModbus(); });
  $('#mb-dialog').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModbus(); }
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); modbusReadOnce(); }
  });
  renderNetList();
}
const renderNetListSoon = debounce(renderNetList, 120);
