// Avvia Trantor (sorgenti) su Windows, esegue comandi nel pannello e legge lo stato della barra laterale.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => { console.log(...a); fs.appendFileSync(path.join(out, 'log.txt'), a.join(' ') + '\n'); };
app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (_ev, level, msg) => { if (level >= 2) log('CONSOLE', msg); });
  const js = (c) => w.webContents.executeJavaScript(c);
  const type = (s) => js(`window.yt.write(focusedPane().id, ${JSON.stringify(s)}); 0`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(async () => {
    try {
      log('PROFILO', await js('focusedPane().profile.name + " / " + focusedPane().profile.kind'));
      log('CARTELLA', await js('focusedPane().cwd + " | sidebar: " + S.sidebarDir'));
      for (const c of ['echo "prova trantor"', 'git --version', 'dir', 'Get-Date -Format yyyy', 'echo "prova trantor"']) { await type(c + '\r'); await wait(2500); }
      await wait(1500);
      log('USATI QUI', await js('JSON.stringify(commandsFor(S.sidebarDir).map(c => c.c + " x" + c.n))'));
      log('SEZIONE VISIBILE', await js('!document.querySelector("#sec-commands").classList.contains("hidden")'));
      log('ARCHIVIO', await js('JSON.stringify(Object.keys(CH.data))'));
      fs.writeFileSync(path.join(out, 'app.png'), (await w.webContents.capturePage()).toPNG());
    } catch (e) { log('ERRORE', e.stack || e); }
    app.exit(0);
  }, 12000);
});
require('../src/main.js');
