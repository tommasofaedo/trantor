/* Trantor — finestra "Sfoglia cartelle"
   Albero completo delle unità e delle cartelle, già aperto sulla cartella corrente.
   Clic = seleziona · doppio clic (o freccia) = espandi/chiudi · "Apri nel terminale" · "Chiudi". */
'use strict';

const BR = { roots: [], sel: null, nodes: new Map() };

function brNode(path, name) {
  let n = BR.nodes.get(path);
  if (!n) { n = { path, name, children: null, expanded: false, loading: false, error: null }; BR.nodes.set(path, n); }
  return n;
}

async function brLoad(n) {
  if (n.children || n.loading) return;
  n.loading = true;
  const r = await window.yt.list(n.path, S.cfg.showHidden);
  n.loading = false;
  if (!r.ok) { n.children = []; n.error = r.error; return; }
  n.children = r.entries.filter((e) => e.isDir).map((e) => brNode(joinPath(n.path, e.name), e.name));
}

async function brToggle(n, open) {
  const want = open == null ? !n.expanded : open;
  if (want) await brLoad(n);
  n.expanded = want;
  brRender();
}

// Espande l'albero fino alla cartella indicata e la seleziona
async function brReveal(dir) {
  const crumbs = splitCrumbs(dir);
  let level = BR.roots;
  let node = null;
  for (const c of crumbs) {
    node = level.find((x) => samePath(x.path, c.path));
    if (!node) break;
    await brLoad(node);
    node.expanded = true;
    level = node.children || [];
  }
  if (node) { node.expanded = false; BR.sel = node.path; if (node.children && node.children.length) node.expanded = true; }
  brRender();
  $('#br-tree .br-row.sel')?.scrollIntoView({ block: 'center' });
}

function brVisible() {
  const out = [];
  const walk = (list, depth) => { for (const n of list) { out.push([n, depth]); if (n.expanded && n.children) walk(n.children, depth + 1); } };
  walk(BR.roots, 0);
  return out;
}

function brRender() {
  const rows = brVisible();
  $('#br-tree').innerHTML = rows.map(([n, d]) => {
    const leaf = n.children && !n.children.length;
    return `<div class="br-row ${BR.sel === n.path ? 'sel' : ''}" data-path="${esc(n.path)}" style="padding-left:${8 + d * 18}px" title="${esc(n.path)}">` +
      `<span class="br-chev ${leaf ? 'leaf' : ''} ${n.expanded ? 'open' : ''}">${n.loading ? '' : icon('chevronRight')}</span>` +
      `${icon(d === 0 ? 'drive' : 'folder')}<span class="br-name">${esc(n.name)}</span>` +
      (n.error ? `<span class="br-err">${esc(n.error)}</span>` : '') + `</div>`;
  }).join('');
  $('#br-path').innerHTML = BR.sel ? `<bdi>${esc(BR.sel)}</bdi>` : '';
  $('#br-open').disabled = !BR.sel;
}

async function openBrowse() {
  const drives = await window.yt.drives();
  BR.nodes.clear();
  BR.roots = drives.map((d) => brNode(d, d.replace(/\\$/, '') || d));
  BR.sel = null;
  $('#br-overlay').classList.remove('hidden');
  brRender();
  await brReveal(S.sidebarDir || S.info.home);
  $('#br-tree').focus();
}
function closeBrowse() { $('#br-overlay').classList.add('hidden'); focusedPane()?.term.focus(); }
function browseOpenInTerminal() {
  if (!BR.sel) return;
  const dir = BR.sel;
  closeBrowse();
  openDir(dir, 'cd');
}

function brKey(e) {
  const rows = brVisible();
  const i = rows.findIndex(([n]) => n.path === BR.sel);
  const cur = i >= 0 ? rows[i][0] : null;
  const go = (fn) => { e.preventDefault(); fn(); };
  if (e.key === 'Escape') return go(closeBrowse);
  if (e.key === 'Enter') return go(browseOpenInTerminal);
  if (e.key === 'ArrowDown') return go(() => { const r = rows[Math.min(rows.length - 1, i + 1)]; if (r) { BR.sel = r[0].path; brRender(); $('#br-tree .br-row.sel')?.scrollIntoView({ block: 'nearest' }); } });
  if (e.key === 'ArrowUp') return go(() => { const r = rows[Math.max(0, i - 1)]; if (r) { BR.sel = r[0].path; brRender(); $('#br-tree .br-row.sel')?.scrollIntoView({ block: 'nearest' }); } });
  if (e.key === 'ArrowRight' && cur) return go(() => brToggle(cur, true));
  if (e.key === 'ArrowLeft' && cur) return go(() => {
    if (cur.expanded) return brToggle(cur, false);
    // vai alla cartella superiore
    for (let k = i - 1; k >= 0; k--) if (rows[k][1] < rows[i][1]) { BR.sel = rows[k][0].path; brRender(); $('#br-tree .br-row.sel')?.scrollIntoView({ block: 'nearest' }); break; }
  });
}

function setupBrowse() {
  $('#sb-browse').innerHTML = icon('tree');
  $('#sb-browse').onclick = openBrowse;
  $('#br-close').onclick = closeBrowse;
  $('#br-open').onclick = browseOpenInTerminal;
  const tree = $('#br-tree');
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.br-row'); if (!row) return;
    const n = BR.nodes.get(row.dataset.path);
    BR.sel = n.path;
    if (e.target.closest('.br-chev')) brToggle(n); else brRender();
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.br-row'); if (!row || e.target.closest('.br-chev')) return;
    brToggle(BR.nodes.get(row.dataset.path));
  });
  tree.addEventListener('keydown', brKey);
  $('#br-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'br-overlay') closeBrowse(); });
}
