/* Trantor — riorganizzare i pannelli
   Trascina un pannello dalla sua intestazione:
   - sul bordo di un altro pannello → lo affianca da quel lato
   - al centro di un altro pannello → li scambia
   - su una scheda → lo sposta in quella scheda; sul pulsante + → nuova scheda
   - fuori dalla finestra → lo stacca in una nuova finestra (la shell continua a funzionare) */
'use strict';

const DND_TYPE = 'application/x-trantor-pane';
const DRAG = { pid: null, dropped: false };

// -------------------------------------------------------------------------
// Operazioni sull'albero dei pannelli (senza chiudere le shell)
// -------------------------------------------------------------------------
function tabFromRoot(root) {
  const tab = { id: nextId('t'), root, focused: panesOf(root)[0], zoomed: null, view: document.createElement('div') };
  tab.view.className = 'tab-view hidden';
  $('#workspace').appendChild(tab.view);
  S.tabs.push(tab);
  return tab;
}

function removeTabShell(tab) {
  tab.view.remove();
  const i = S.tabs.indexOf(tab);
  if (i >= 0) S.tabs.splice(i, 1);
}

// Toglie la foglia `pid` dalla sua scheda; ritorna la scheda (o null se è rimasta vuota ed è stata rimossa)
function removeLeaf(pid) {
  const tab = tabOfPane(pid);
  if (!tab) return null;
  const hit = findNode(tab.root, pid);
  tab.zoomed = null;
  if (!hit.parent) { removeTabShell(tab); return null; }
  const sibling = hit.parent.a === hit.node ? hit.parent.b : hit.parent.a;
  const replaceIn = (node) => {
    if (node.type !== 'split') return false;
    if (node.a === hit.parent) { node.a = sibling; return true; }
    if (node.b === hit.parent) { node.b = sibling; return true; }
    return replaceIn(node.a) || replaceIn(node.b);
  };
  if (tab.root === hit.parent) tab.root = sibling; else replaceIn(tab.root);
  if (tab.focused === pid) tab.focused = panesOf(sibling)[0];
  return tab;
}

// Inserisce `pid` accanto a `targetPid` dal lato `zone` (left/right/top/bottom)
function insertLeaf(targetPid, pid, zone) {
  const tab = tabOfPane(targetPid);
  const hit = findNode(tab.root, targetPid);
  const dir = zone === 'left' || zone === 'right' ? 'h' : 'v';
  const first = zone === 'left' || zone === 'top';
  const leaf = { type: 'pane', id: pid };
  const split = { type: 'split', dir, ratio: 0.5, a: first ? leaf : hit.node, b: first ? hit.node : leaf };
  if (!hit.parent) tab.root = split;
  else if (hit.parent.a === hit.node) hit.parent.a = split; else hit.parent.b = split;
  tab.zoomed = null;
  tab.focused = pid;
  return tab;
}

function afterMove(tabs, focusPid) {
  if (!S.tabs.length) return;
  const target = tabOfPane(focusPid) || S.tabs[0];
  for (const t of new Set(tabs)) if (t && S.tabs.includes(t) && t !== target) renderTab(t);
  if (!S.tabs.some((t) => t.id === S.activeTab)) S.activeTab = null;
  activateTab(target.id);
  if (focusPid) focusPane(focusPid);
  renderTabs();
  saveSessionSoon();
}

// -------------------------------------------------------------------------
// Azioni
// -------------------------------------------------------------------------
function swapPanes(a, b) {
  if (!a || !b || a === b) return;
  const ta = tabOfPane(a); const tb = tabOfPane(b);
  const na = findNode(ta.root, a).node; const nb = findNode(tb.root, b).node;
  na.id = b; nb.id = a;
  for (const t of [ta, tb]) {
    t.zoomed = null;
    if (t.focused === a) t.focused = b; else if (t.focused === b) t.focused = a;
  }
  afterMove([ta, tb], a);
}

function movePaneNextTo(pid, targetPid, zone) {
  if (!pid || !targetPid || pid === targetPid) return;
  if (zone === 'swap') return swapPanes(pid, targetPid);
  const from = removeLeaf(pid);
  const to = insertLeaf(targetPid, pid, zone);
  afterMove([from, to], pid);
}

function movePaneToNewTab(pid) {
  const src = tabOfPane(pid);
  if (src && panesOf(src.root).length === 1) { toast('Il pannello è già da solo nella sua scheda'); return; }
  const from = removeLeaf(pid);
  tabFromRoot({ type: 'pane', id: pid });
  afterMove([from], pid);
}

function movePaneToTab(pid, tabId) {
  const dst = S.tabs.find((t) => t.id === tabId);
  if (!dst || tabOfPane(pid) === dst) return;
  const target = dst.focused;
  const from = removeLeaf(pid);
  insertLeaf(target, pid, 'right');
  afterMove([from, dst], pid);
}

async function detachPane(pid, screenX, screenY) {
  const p = S.panes.get(pid);
  if (!p || !p.alive) return;
  const tab = tabOfPane(pid);
  if (S.tabs.length === 1 && panesOf(tab.root).length === 1) { toast('È l’unico pannello di questa finestra'); return; }
  const r = p.el.getBoundingClientRect();
  const payload = {
    id: p.id, profile: p.profile, cwd: p.cwd, serialized: p.serializer.serialize({ scrollback: 2000 }),
    width: Math.round(Math.max(r.width + 320, 900)), height: Math.round(Math.max(r.height + 60, 560)),
    x: screenX != null ? Math.round(screenX - 120) : undefined, y: screenY != null ? Math.round(screenY - 20) : undefined
  };
  const from = removeLeaf(pid);
  S.panes.delete(pid);
  p.dispose(true); // la shell resta viva: passa alla nuova finestra
  await window.yt.detachPane(payload);
  afterMove([from], from ? from.focused : (S.tabs[0] && S.tabs[0].focused));
}

// Nuova finestra: crea la scheda con il pannello adottato
async function adoptPaneInNewTab(adopt) {
  const p = new Pane(adopt.profile, adopt.cwd, { id: adopt.id });
  S.panes.set(p.id, p);
  const tab = tabFromRoot({ type: 'pane', id: p.id });
  activateTab(tab.id);
  await p.start(adopt);
  focusPane(p.id);
}

// Pannello vicino in una direzione (stessa logica di moveFocus)
function neighborPane(dir) {
  const tab = activeTab(); if (!tab || tab.zoomed) return null;
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
  return best;
}
function swapWithNeighbor(dir) {
  const fp = focusedPane(); const n = neighborPane(dir);
  if (fp && n) swapPanes(fp.id, n);
}

// Voci per i menu del pannello
function paneMoveItems(p) {
  const others = S.tabs.filter((t) => t !== tabOfPane(p.id));
  return [
    { label: 'Sposta in una nuova scheda', icon: 'plus', run: () => movePaneToNewTab(p.id) },
    { label: 'Stacca in una nuova finestra', icon: 'external', run: () => detachPane(p.id) },
    ...others.slice(0, 6).map((t) => {
      const fp = S.panes.get(t.focused);
      return { label: `Sposta nella scheda «${fp ? baseName(fp.cwd) : 'Terminale'}»`, icon: 'chevronRight', run: () => movePaneToTab(p.id, t.id) };
    })
  ];
}

// -------------------------------------------------------------------------
// Trascinamento
// -------------------------------------------------------------------------
function dropZone(el, x, y) {
  const r = el.getBoundingClientRect();
  const rx = (x - r.left) / r.width, ry = (y - r.top) / r.height;
  if (rx > 0.3 && rx < 0.7 && ry > 0.3 && ry < 0.7) return 'swap';
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  return Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
}

function showIndicator(paneEl, zone) {
  let ind = paneEl.querySelector('.drop-ind');
  if (!ind) { ind = document.createElement('div'); ind.className = 'drop-ind'; paneEl.appendChild(ind); }
  ind.dataset.zone = zone;
  ind.textContent = zone === 'swap' ? 'Scambia' : '';
}
function clearIndicators() { document.querySelectorAll('.drop-ind').forEach((n) => n.remove()); document.querySelectorAll('.tab.drop-pane').forEach((n) => n.classList.remove('drop-pane')); }

function setupPaneDrag(pane) {
  const head = pane.el.querySelector('.pane-header');
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    if (e.target.closest('button') && e.target.closest('.p-actions')) { e.preventDefault(); return; }
    DRAG.pid = pane.id; DRAG.dropped = false;
    e.dataTransfer.setData(DND_TYPE, pane.id);
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = baseName(pane.cwd) || 'Terminale';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
    document.body.classList.add('pane-dragging');
  });
  head.addEventListener('dragend', (e) => {
    document.body.classList.remove('pane-dragging');
    clearIndicators();
    const pid = DRAG.pid; DRAG.pid = null;
    if (DRAG.dropped || !pid) return;
    // rilasciato fuori dalla finestra → nuova finestra
    const out = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;
    if (out) detachPane(pid, e.screenX, e.screenY);
  });

  pane.el.addEventListener('dragover', (e) => {
    if (!DRAG.pid || !e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    if (DRAG.pid === pane.id) { clearIndicators(); return; }
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.drop-ind').forEach((n) => { if (n.parentElement !== pane.el) n.remove(); });
    showIndicator(pane.el, dropZone(pane.el, e.clientX, e.clientY));
  });
  pane.el.addEventListener('dragleave', (e) => {
    if (!pane.el.contains(e.relatedTarget)) pane.el.querySelector('.drop-ind')?.remove();
  });
  pane.el.addEventListener('drop', (e) => {
    if (!DRAG.pid || !e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault(); e.stopPropagation();
    DRAG.dropped = true;
    const zone = dropZone(pane.el, e.clientX, e.clientY);
    clearIndicators();
    if (DRAG.pid !== pane.id) movePaneNextTo(DRAG.pid, pane.id, zone);
  });
}

function setupTabDrop() {
  const tabs = $('#tabs');
  tabs.addEventListener('dragover', (e) => {
    if (!DRAG.pid || !e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    document.querySelectorAll('.tab.drop-pane').forEach((n) => n.classList.remove('drop-pane'));
    const t = e.target.closest('.tab'); if (t) t.classList.add('drop-pane');
  });
  tabs.addEventListener('drop', (e) => {
    if (!DRAG.pid || !e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault(); e.stopPropagation();
    DRAG.dropped = true;
    const el = e.target.closest('.tab');
    const idx = el ? [...tabs.children].indexOf(el) : -1;
    clearIndicators();
    if (idx >= 0 && S.tabs[idx]) movePaneToTab(DRAG.pid, S.tabs[idx].id); else movePaneToNewTab(DRAG.pid);
  });
  const plus = $('#btn-newtab');
  plus.addEventListener('dragover', (e) => { if (DRAG.pid) { e.preventDefault(); plus.classList.add('checked'); } });
  plus.addEventListener('dragleave', () => plus.classList.remove('checked'));
  plus.addEventListener('drop', (e) => { if (!DRAG.pid) return; e.preventDefault(); plus.classList.remove('checked'); DRAG.dropped = true; movePaneToNewTab(DRAG.pid); });
  // rilascio sulla barra laterale o sulla headerbar: annulla senza staccare
  for (const sel of ['#headerbar', '#sidebar']) {
    $(sel).addEventListener('dragover', (e) => { if (DRAG.pid) e.preventDefault(); });
    $(sel).addEventListener('drop', (e) => { if (DRAG.pid) { e.preventDefault(); DRAG.dropped = true; } });
  }
}
