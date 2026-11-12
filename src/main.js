// Trantor — processo principale Electron
// Gestisce finestra, pseudo-terminali (ConPTY via node-pty), filesystem e configurazione.

const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pty;
try {
  pty = require('@lydell/node-pty');
} catch (e) {
  pty = require('node-pty');
}

const isWin = process.platform === 'win32';
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const ptys = new Map(); // id -> { proc, shellKind }
let win;
let pendingDir = null; // cartella passata da riga di comando / menu di Esplora file

// Estrae la prima cartella valida dagli argomenti (es. "Trantor.exe" "C:\\Progetti")
function dirFromArgv(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-'));
  for (const a of args) {
    const p = path.resolve(cwd || process.cwd(), a.replace(/"$/, ''));
    try { if (fs.statSync(p).isDirectory()) return p; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Configurazione persistente
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  defaultProfile: null,
  fontSize: 14,
  fontFamily: '"Ubuntu Mono", "Ubuntu Sans Mono", "Cascadia Mono", Consolas, monospace',
  sidebarVisible: true,
  sidebarWidth: 270,
  showHidden: false,
  restoreSession: true,
  bookmarks: [],
  history: {}, // path -> { count, last }
  session: null,
  bounds: { width: 1280, height: 800 }
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG, bookmarks: [os.homedir()] };
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Salvataggio config fallito', e);
  }
}

// ---------------------------------------------------------------------------
// Rilevamento shell disponibili
// ---------------------------------------------------------------------------
function which(exe) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

function detectProfiles() {
  const profiles = [];
  if (isWin) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pwsh = which('pwsh.exe') || firstExisting([path.join(pf, 'PowerShell', '7', 'pwsh.exe')]);
    if (pwsh) profiles.push({ id: 'pwsh', name: 'PowerShell 7', exe: pwsh, kind: 'powershell', icon: 'ps' });
    const ps = which('powershell.exe') || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    profiles.push({ id: 'powershell', name: 'Windows PowerShell', exe: ps, kind: 'powershell', icon: 'ps' });
    profiles.push({ id: 'cmd', name: 'Prompt dei comandi', exe: process.env.ComSpec || 'cmd.exe', kind: 'cmd', icon: 'cmd' });
    const gitBash = firstExisting([
      path.join(pf, 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
    ]);
    if (gitBash) profiles.push({ id: 'gitbash', name: 'Git Bash', exe: gitBash, kind: 'gitbash', icon: 'bash' });
    const wsl = firstExisting([path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')]);
    if (wsl) profiles.push({ id: 'wsl', name: 'WSL', exe: wsl, kind: 'wsl', icon: 'linux' });
  } else {
    // Utile solo per sviluppo/test su Linux o macOS
    const sh = process.env.SHELL || '/bin/bash';
    profiles.push({ id: 'bash', name: path.basename(sh), exe: sh, kind: 'bash', icon: 'bash' });
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// Integrazione shell: ogni prompt emette OSC 9;9 con la cartella corrente,
// così la barra laterale segue sempre la directory del pannello attivo.
// ---------------------------------------------------------------------------
function psIntegrationScript() {
  return [
    '$global:__ytOrigPrompt = $function:prompt',
    'function global:prompt {',
    '  $loc = $executionContext.SessionState.Path.CurrentLocation',
    '  $osc = ""',
    '  if ($loc.Provider.Name -eq "FileSystem") { $osc = "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]7)" }',
    '  $orig = if ($global:__ytOrigPrompt) { & $global:__ytOrigPrompt } else { "PS $($loc)> " }',
    '  return $osc + $orig',
    '}'
  ].join("\n");
}

function buildSpawn(profile, cwd) {
  const env = { ...process.env, TERM_PROGRAM: 'Trantor', COLORTERM: 'truecolor' };
  let args = [];
  switch (profile.kind) {
    case 'powershell': {
      const encoded = Buffer.from(psIntegrationScript(), 'utf16le').toString('base64');
      args = ['-NoLogo', '-NoExit', '-EncodedCommand', encoded];
      break;
    }
    case 'cmd':
      env.PROMPT = '$e]9;9;$P$e\\$P$G';
      break;
    case 'gitbash':
      env.PROMPT_COMMAND = 'printf "\\033]9;9;\\"%s\\"\\007" "$(cygpath -w "$PWD")"' + (process.env.PROMPT_COMMAND ? ';' + process.env.PROMPT_COMMAND : '');
      env.CHERE_INVOKING = '1';
      args = ['--login', '-i'];
      break;
    case 'wsl':
      env.YT_PC = 'printf "\\033]9;9;\\"%s\\"\\007" "$(wslpath -w "$PWD")"';
      env.WSLENV = (process.env.WSLENV ? process.env.WSLENV + ':' : '') + 'YT_PC/u';
      args = ['--cd', cwd, '--exec', 'bash', '-c', 'export PROMPT_COMMAND="$YT_PC${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; exec bash -i'];
      break;
    case 'bash':
      env.PROMPT_COMMAND = 'printf "\\033]9;9;\\"%s\\"\\007" "$PWD"';
      break;
  }
  return { file: profile.exe, args, env };
}

// ---------------------------------------------------------------------------
// Finestra
// ---------------------------------------------------------------------------
function createWindow() {
  const cfg = loadConfig();
  win = new BrowserWindow({
    width: cfg.bounds.width,
    height: cfg.bounds.height,
    x: cfg.bounds.x,
    y: cfg.bounds.y,
    minWidth: 640,
    minHeight: 400,
    frame: false,
    backgroundColor: '#2C2C2C',
    title: 'Trantor',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (cfg.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // I link non aprono finestre Electron ma il browser predefinito
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const sendState = () => win && win.webContents.send('win:state', { maximized: win.isMaximized() });
  win.on('maximize', sendState);
  win.on('unmaximize', sendState);

  win.on('close', () => {
    const c = loadConfig();
    c.maximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) c.bounds = win.getBounds();
    saveConfig(c);
  });
  win.on('closed', () => {
    for (const { proc } of ptys.values()) { try { proc.kill(); } catch {} }
    ptys.clear();
    win = null;
  });
}

// Una sola istanza: un secondo avvio apre una nuova scheda nella finestra esistente
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingDir = dirFromArgv(process.argv);
  app.on('second-instance', (_e, argv, workingDirectory) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('app:openDir', dirFromArgv(argv, workingDirectory) || workingDirectory);
  });
  if (isWin) app.setAppUserModelId('io.github.trantor');
  app.whenReady().then(createWindow);
}
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// IPC — finestra
// ---------------------------------------------------------------------------
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggleMaximize', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win && win.close());

// ---------------------------------------------------------------------------
// IPC — configurazione
// ---------------------------------------------------------------------------
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_e, partial) => {
  const cfg = { ...loadConfig(), ...partial };
  saveConfig(cfg);
  return true;
});
ipcMain.handle('app:info', () => ({
  platform: process.platform,
  home: os.homedir(),
  sep: path.sep,
  version: app.getVersion(),
  homepage: require('../package.json').homepage,
  startDir: pendingDir,
  profiles: detectProfiles()
}));

// ---------------------------------------------------------------------------
// IPC — pseudo-terminali
// ---------------------------------------------------------------------------
ipcMain.handle('pty:spawn', (_e, { id, profile, cwd, cols, rows }) => {
  let startDir = cwd;
  try { if (!startDir || !fs.statSync(startDir).isDirectory()) startDir = os.homedir(); } catch { startDir = os.homedir(); }
  const { file, args, env } = buildSpawn(profile, startDir);
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd: startDir,
    env,
    useConpty: true
  });
  ptys.set(id, { proc, kind: profile.kind });
  proc.onData((data) => win && !win.isDestroyed() && win.webContents.send('pty:data', id, data));
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    win && !win.isDestroyed() && win.webContents.send('pty:exit', id, exitCode);
  });
  return { pid: proc.pid, cwd: startDir };
});

ipcMain.on('pty:write', (_e, id, data) => { const p = ptys.get(id); if (p) p.proc.write(data); });
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) { try { p.proc.resize(cols, rows); } catch {} }
});
ipcMain.on('pty:kill', (_e, id) => {
  const p = ptys.get(id);
  if (p) { try { p.proc.kill(); } catch {} ptys.delete(id); }
});

// ---------------------------------------------------------------------------
// IPC — filesystem (navigazione cartelle)
// ---------------------------------------------------------------------------
const WIN_SYSTEM_NAMES = new Set(['$recycle.bin', 'system volume information', 'desktop.ini', 'thumbs.db', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'recovery', 'config.msi']);

function isHiddenName(name) {
  const n = name.toLowerCase();
  return name.startsWith('.') || WIN_SYSTEM_NAMES.has(n) || n.startsWith('ntuser.');
}

ipcMain.handle('fs:list', async (_e, dir, showHidden) => {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const d of entries) {
      const hidden = isHiddenName(d.name);
      if (hidden && !showHidden) continue;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try { isDir = (await fs.promises.stat(path.join(dir, d.name))).isDirectory(); } catch {}
      }
      out.push({ name: d.name, isDir, hidden });
    }
    out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'it', { sensitivity: 'base', numeric: true }));
    return { ok: true, entries: out };
  } catch (err) {
    return { ok: false, error: err.code || String(err) };
  }
});

// Elenca sottocartelle fino a una certa profondità (per il "Salta a cartella")
ipcMain.handle('fs:walkDirs', async (_e, root, depth = 2, limit = 1500) => {
  const results = [];
  const SKIP = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', '.cache', '__pycache__']);
  async function walk(dir, d) {
    if (d > depth || results.length >= limit) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= limit) return;
      if (!e.isDirectory()) continue;
      if (isHiddenName(e.name) || SKIP.has(e.name.toLowerCase())) continue;
      const full = path.join(dir, e.name);
      results.push(full);
      await walk(full, d + 1);
    }
  }
  await walk(root, 1);
  return results;
});

ipcMain.handle('fs:drives', () => {
  if (!isWin) return ['/'];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { fs.accessSync(d); drives.push(d); } catch {}
  }
  return drives;
});

ipcMain.handle('fs:isDir', (_e, p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
ipcMain.handle('fs:resolve', (_e, base, rel) => path.resolve(base, rel));
ipcMain.handle('fs:parent', (_e, p) => path.dirname(p));
ipcMain.handle('fs:openExternal', (_e, p) => shell.openPath(p));
ipcMain.handle('fs:showInFolder', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('shell:openUrl', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(t));
