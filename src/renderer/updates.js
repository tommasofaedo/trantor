/* Trantor — aggiornamenti automatici: pulsante nella headerbar, controllo all'avvio e ogni 6 ore */
'use strict';

const UPD_UI = { state: null };

function renderUpdateButton(st) {
  UPD_UI.state = st;
  const b = $('#btn-update');
  if (!b) return;
  let label = null; let title = '';
  if (st.state === 'available') {
    label = st.portable ? `Trantor ${st.version} disponibile` : `Aggiorna a ${st.version}`;
    title = st.portable ? 'Apre la pagina di download della nuova versione portable' : 'Scarica la nuova versione';
  } else if (st.state === 'downloading') {
    label = `Download ${st.progress || 0}%`; title = 'Download dell’aggiornamento in corso';
  } else if (st.state === 'ready') {
    label = 'Riavvia per aggiornare'; title = `Trantor ${st.version} è pronto: riavvia per installarlo (la sessione viene salvata)`;
  }
  b.classList.toggle('hidden', !label);
  b.classList.toggle('busy', st.state === 'downloading');
  b.style.setProperty('--p', `${st.progress || 0}%`);
  if (label) { b.textContent = label; b.title = title; }
}

async function checkUpdates(manual) {
  const st = await window.yt.updateCheck();
  renderUpdateButton(st);
  if (!manual) return;
  if (!st.enabled) toast('Gli aggiornamenti automatici sono disponibili nella versione installata da GitHub');
  else if (st.state === 'none') toast(`Trantor ${st.current} è aggiornato`);
  else if (st.state === 'error') toast(`Controllo aggiornamenti non riuscito: ${st.error || 'errore di rete'}`);
}

async function onUpdateClick() {
  const st = UPD_UI.state || {};
  if (st.state === 'available') { renderUpdateButton(await window.yt.updateDownload()); return; }
  if (st.state === 'ready') { saveSessionNow(); setTimeout(() => window.yt.updateInstall(), 300); }
}

function toggleAutoUpdate() {
  S.cfg.autoUpdate = S.cfg.autoUpdate === false;
  window.yt.saveConfig({ autoUpdate: S.cfg.autoUpdate });
  toast(S.cfg.autoUpdate ? 'Trantor controllerà gli aggiornamenti da solo' : 'Controllo automatico degli aggiornamenti disattivato');
}

function setupUpdates() {
  $('#btn-update').onclick = onUpdateClick;
  window.yt.onUpdateState(renderUpdateButton);
  window.yt.updateGet().then(renderUpdateButton);
  if (S.cfg.autoUpdate !== false) {
    setTimeout(() => checkUpdates(false), 15000);
    setInterval(() => { if (S.cfg.autoUpdate !== false) checkUpdates(false); }, 6 * 3600 * 1000);
  }
}
