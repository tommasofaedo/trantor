// Diagnostica: avvia le shell con l'integrazione di Trantor via ConPTY e mostra cosa arriva.
const fs = require('fs');
const path = require('path');
const pty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const body = src.slice(src.indexOf('const SYNTAX'), src.indexOf('function buildSpawn'));
const { psIntegrationScript } = new Function(body + ';return { psIntegrationScript }')();
const dec = (b) => Buffer.from(b || '', 'base64').toString('utf8');
const shells = [
  ['Windows PowerShell 5.1', 'powershell.exe'],
  ['PowerShell 7', 'pwsh.exe']
];
async function run([name, exe], opts) {
  return new Promise((resolve) => {
    const enc = Buffer.from(psIntegrationScript(true), 'utf16le').toString('base64');
    const term = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
    const events = [];
    let raw = '';
    term.parser.registerOscHandler(9, (d) => { if (d.startsWith('9;')) events.push('cwd  ' + d.slice(2)); return true; });
    term.parser.registerOscHandler(7777, (d) => { const f = d.split(';'); events.push(f[0] === 'start' ? 'start ' + dec(f[1]) : `cmd   ${dec(f[2])}  [dir=${dec(f[1])} ok=${f[3]} ms=${f[4]}]`); return true; });
    const p = pty.spawn(exe, ['-NoLogo', '-NoExit', '-EncodedCommand', enc], { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.env.USERPROFILE, env: process.env, useConpty: true, ...opts });
    p.onData((d) => { raw += d; term.write(d); });
    term.onData((d) => p.write(d));
    const steps = [[8000, 'echo "ciao"\r'], [2500, 'git --version\r'], [2500, 'cd $env:TEMP\r'], [2500, 'Write-Output 42\r']];
    let t = 0; for (const [d, s] of steps) { t += d; setTimeout(() => p.write(s), t); }
    setTimeout(() => {
      console.log(`\n===== ${name} ${JSON.stringify(opts)} =====`);
      console.log(events.length ? events.map((e) => '  ' + e).join('\n') : '  (nessun evento ricevuto)');
      console.log('  OSC 9;9 nel flusso grezzo:', raw.includes(']9;9;'), ' OSC 7777 nel flusso grezzo:', raw.includes(']7777;'));
      const buf = term.buffer.active; const lines = [];
      for (let i = 0; i < buf.length; i++) { const l = buf.getLine(i).translateToString(true); if (l.trim()) lines.push(l); }
      console.log('  --- schermo ---\n' + lines.slice(-12).map((l) => '  | ' + l).join('\n'));
      p.kill(); resolve();
    }, t + 3000);
  });
}
(async () => {
  console.log('Windows', require('os').release());
  for (const s of shells) { await run(s, {}); }
  for (const s of shells) { await run(s, { useConptyDll: true }); }
  process.exit(0);
})();
