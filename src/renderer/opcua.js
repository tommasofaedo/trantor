/* Trantor — finestra "Tag OPC UA"
   Albero dei nodi del server (un livello alla volta) con tipo e valore delle variabili,
   aggiornati in tempo reale. Sola lettura, connessione anonima senza cifratura. */
'use strict';

const UAV = { key: null, roots: [], nodes: new Map(), sel: null, watchTimer: null, lost: false, gen: 0 };

function uaNode(it) {
  let n = UAV.nodes.get(it.nodeId);
  if (!n) { n = { children: null, expanded: false, loading: false, error: null }; UAV.nodes.set(it.nodeId, n); }
  return Object.assign(n, it);
}

async function uaLoad(n) {
  if (n.children || n.loading) return;
  n.loading = true; uaRender();
  const r = await window.yt.ua.browse(UAV.key, n.nodeId);
  n.loading = false;
  if (!r.ok) { n.children = []; n.error = r.error; return; }
  n.children = r.data.map(uaNode);
}

async function uaToggle(n, open) {
  const want = open == null ? !n.expanded : open;
  if (want) await uaLoad(n);
  n.expanded = want && !!(n.children && n.children.length);
  uaRender();
}

function uaVisible() {
  const out = [];
  const walk = (list, depth) => { for (const n of list) { out.push([n, depth]); if (n.expanded && n.children) walk(n.children, depth + 1); } };
  walk(UAV.roots, 0);
  return out;
}

function uaValueHtml(n) {
  if (n.kind !== 'var') return '';
  if (n.bad) return `<span class="ua-bad" title="${esc(n.bad)}">${esc(n.bad)}</span>`;
  return esc(n.text);
}

function uaRender() {
  const rows = uaVisible();
  $('#ua-tree').innerHTML = rows.map(([n, d]) => {
    const leaf = n.kind === 'var' || (n.children && !n.children.length);
    return `<div class="br-row ua-row ${UAV.sel === n.nodeId ? 'sel' : ''}" data-id="${esc(n.nodeId)}" title="${esc(n.nodeId)}">` +
      `<span class="ua-name" style="padding-left:${d * 18}px"><span class="br-chev ${leaf ? 'leaf' : ''} ${n.expanded ? 'open' : ''}">${n.loading ? '' : icon('chevronRight')}</span>` +
      `${icon(n.kind === 'var' ? 'tag' : n.folder ? 'folder' : 'box')}<span class="br-name">${esc(n.name)}</span>` +
      (n.error ? `<span class="br-err">${esc(n.error)}</span>` : '') + `</span>` +
      `<span class="ua-type">${esc(n.type || '')}</span><span class="ua-val mono">${uaValueHtml(n)}</span></div>`;
  }).join('') || '<div class="ua-empty">Nessun nodo</div>';
  const sel = UAV.nodes.get(UAV.sel);
  $('#ua-nodeid').textContent = sel ? sel.nodeId : '';
  $('#ua-copyid').disabled = !sel;
  $('#ua-copyval').disabled = !sel || sel.kind !== 'var' || !!sel.bad;
  uaScheduleWatch();
}

// sottoscrive solo le variabili visibili nell'albero
function uaScheduleWatch() {
  clearTimeout(UAV.watchTimer);
  UAV.watchTimer = setTimeout(() => {
    if (!UAV.key) return;
    const ids = uaVisible().filter(([n]) => n.kind === 'var').map(([n]) => n.nodeId);
    window.yt.ua.watch(UAV.key, ids);
  }, 300);
}

function uaOnValue(key, v) {
  if (key !== UAV.key) return;
  if (v.lost !== undefined) { UAV.lost = v.lost; uaSetState(v.lost ? 'Connessione persa, riprovo…' : 'Connesso', v.lost ? 'err' : 'ok'); return; }
  const n = UAV.nodes.get(v.nodeId);
  if (!n) return;
  const changed = n.text !== v.text || n.bad !== v.bad;
  Object.assign(n, { text: v.text, bad: v.bad, type: v.type || n.type });
  if (!changed) return;
  const row = document.querySelector(`#ua-tree .ua-row[data-id="${CSS.escape(n.nodeId)}"]`);
  if (!row) return;
  row.querySelector('.ua-val').innerHTML = uaValueHtml(n);
  row.querySelector('.ua-type').textContent = n.type || '';
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  if (UAV.sel === n.nodeId) $('#ua-copyval').disabled = !!n.bad;
}

function uaSetState(text, cls = '') {
  const el = $('#ua-state');
  el.textContent = text; el.className = cls;
}

async function openOpcua(ip, port, title) {
  await closeOpcua(true);
  const gen = ++UAV.gen;
  UAV.nodes.clear(); UAV.roots = []; UAV.sel = null; UAV.lost = false;
  $('#ua-target').textContent = `opc.tcp://${ip}:${port}${title && title !== ip ? ' · ' + title : ''}`;
  $('#ua-overlay').classList.remove('hidden');
  $('#ua-tree').innerHTML = '<div class="ua-empty">Connessione in corso…</div>';
  uaSetState('');
  $('#ua-copyid').disabled = $('#ua-copyval').disabled = true;
  const c = await window.yt.ua.connect(ip, port);
  if (gen !== UAV.gen) { if (c.ok) window.yt.ua.disconnect(c.data.key); return; }
  if (!c.ok) {
    uaSetState('Non connesso', 'err');
    $('#ua-tree').innerHTML = `<div class="ua-empty err">${esc(c.error)}</div>`;
    return;
  }
  UAV.key = c.data.key;
  uaSetState(c.data.server ? `Connesso · ${c.data.server}` : 'Connesso', 'ok');
  const r = await window.yt.ua.browse(UAV.key, null);
  if (gen !== UAV.gen) return;
  if (!r.ok) { $('#ua-tree').innerHTML = `<div class="ua-empty err">${esc(r.error)}</div>`; return; }
  UAV.roots = r.data.map(uaNode);
  // apre già le cartelle "utili" se c'è un solo ramo che non è quello standard del server
  const own = UAV.roots.filter((n) => !/^ns=0;/.test(n.nodeId));
  if (own.length === 1) { await uaLoad(own[0]); own[0].expanded = !!own[0].children.length; }
  UAV.sel = (own[0] || UAV.roots[0] || {}).nodeId || null;
  uaRender();
  $('#ua-tree').focus();
}

async function closeOpcua(silent) {
  UAV.gen++;
  clearTimeout(UAV.watchTimer);
  const key = UAV.key; UAV.key = null;
  if (key) window.yt.ua.disconnect(key);
  if (!silent) { $('#ua-overlay').classList.add('hidden'); focusedPane()?.term.focus(); }
}

function uaCopy(what) {
  const n = UAV.nodes.get(UAV.sel); if (!n) return;
  const text = what === 'id' ? n.nodeId : n.text;
  window.yt.writeClipboard(text);
  toast(what === 'id' ? 'NodeId copiato' : 'Valore copiato');
}

function uaKey(e) {
  const rows = uaVisible();
  const i = rows.findIndex(([n]) => n.nodeId === UAV.sel);
  const cur = i >= 0 ? rows[i][0] : null;
  const go = (fn) => { e.preventDefault(); fn(); };
  const select = (r) => { if (r) { UAV.sel = r[0].nodeId; uaRender(); $('#ua-tree .ua-row.sel')?.scrollIntoView({ block: 'nearest' }); } };
  if (e.key === 'Escape') return go(() => closeOpcua());
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') return go(() => uaCopy(cur && cur.kind === 'var' ? 'val' : 'id'));
  if (e.key === 'ArrowDown') return go(() => select(rows[Math.min(rows.length - 1, i + 1)]));
  if (e.key === 'ArrowUp') return go(() => select(rows[Math.max(0, i - 1)]));
  if ((e.key === 'ArrowRight' || e.key === 'Enter') && cur && cur.kind !== 'var') return go(() => uaToggle(cur, e.key === 'Enter' ? null : true));
  if (e.key === 'ArrowLeft' && cur) return go(() => {
    if (cur.expanded) return uaToggle(cur, false);
    for (let k = i - 1; k >= 0; k--) if (rows[k][1] < rows[i][1]) return select(rows[k]);
  });
}

function setupOpcua() {
  window.yt.ua.onValues(uaOnValue);
  $('#ua-close').onclick = () => closeOpcua();
  $('#ua-copyid').onclick = () => uaCopy('id');
  $('#ua-copyval').onclick = () => uaCopy('val');
  const tree = $('#ua-tree');
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.ua-row'); if (!row) return;
    const n = UAV.nodes.get(row.dataset.id);
    UAV.sel = n.nodeId;
    if (e.target.closest('.br-chev') && n.kind !== 'var') uaToggle(n); else uaRender();
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.ua-row'); if (!row || e.target.closest('.br-chev')) return;
    const n = UAV.nodes.get(row.dataset.id);
    if (n.kind !== 'var') uaToggle(n);
  });
  tree.addEventListener('keydown', uaKey);
  $('#ua-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'ua-overlay') closeOpcua(); });
}

document.addEventListener('DOMContentLoaded', setupOpcua);
