#!/usr/bin/env node
// Verifica che il binario di Electron sia presente dopo `npm install`.
// Lo script ufficiale di Electron in alcuni ambienti (Node 24, reti aziendali)
// termina senza errori ma senza scaricare nulla: qui lo scarichiamo, ne
// verifichiamo lo SHA-256 con i checksum ufficiali e lo estraiamo.
//
// Ensures the Electron binary exists after `npm install`. Electron's own
// postinstall can exit silently without downloading in some environments.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');

function log(msg) { console.log(`[ensure-electron] ${msg}`); }

function platformPath() {
  switch (process.platform) {
    case 'win32': return 'electron.exe';
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron';
    default: return 'electron';
  }
}

function isInstalled() {
  try {
    const p = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8');
    return fs.existsSync(path.join(electronDir, 'dist', p));
  } catch {
    return false;
  }
}

async function download(url, dest) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return;
  } catch (err) {
    log(`fetch non riuscito (${err.message}), provo con curl…`);
  }
  // curl rispetta le variabili HTTPS_PROXY/HTTP_PROXY ed è incluso in Windows 10/11
  execFileSync('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extract(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'linux') execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' }); // bsdtar su Windows e macOS
}

async function main() {
  if (!fs.existsSync(electronDir)) return; // electron non installato (es. --omit=dev)
  if (isInstalled()) return;

  const { version } = require(path.join(electronDir, 'package.json'));
  const arch = process.env.npm_config_arch || process.arch;
  const name = `electron-v${version}-${process.platform}-${arch}.zip`;
  const mirror = (process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/').replace(/\/?$/, '/');
  const url = `${mirror}v${version}/${name}`;
  const tmp = path.join(os.tmpdir(), name);

  log(`binario di Electron mancante, scarico ${url}`);
  await download(url, tmp);

  let checksums = {};
  try { checksums = require(path.join(electronDir, 'checksums.json')); } catch {}
  if (checksums[name]) {
    const got = sha256(tmp);
    if (got !== checksums[name]) throw new Error(`checksum non valido per ${name}`);
    log('checksum SHA-256 verificato');
  }

  extract(tmp, path.join(electronDir, 'dist'));
  fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath());
  try { fs.unlinkSync(tmp); } catch {}
  log(`Electron ${version} installato`);
}

main().catch((err) => {
  console.error(`[ensure-electron] ${err.message}`);
  console.error('[ensure-electron] Vedi la sezione "Troubleshooting" nel README.');
  process.exit(0); // non bloccare npm install
});
