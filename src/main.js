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
  shellEnhancements: true,
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

// Colori della riga di comando in stile Yaru Dark (accento blu).
// Fonti: github.com/ubuntu/yaru — accento blu #0073E5 schiarito per lo sfondo
// scuro (#389AFE), warning $yellow #F99B11, accento "purple" #7764D8 schiarito,
// errore #FF7A71, testo attenuato. Pochi toni, ognuno con un ruolo preciso.
const SYNTAX = {
  command: '56;154;254',      // #389AFE  comandi e cmdlet
  parameter: '88;199;245',    // #58C7F5  -Parametri, $variabili, [Tipi]
  string: '249;155;17',       // #F99B11  'stringhe'
  number: '165;151;236',      // #A597EC  numeri
  operator: '156;156;156',    // #9C9C9C  operatori e punteggiatura
  comment: '122;122;122',     // #7A7A7A  # commenti
  text: '247;247;247',        // #F7F7F7  testo normale
  error: '255;122;113',       // #FF7A71  errori di sintassi
  ghost: '108;108;108',       // #6C6C6C  suggerimento in linea
  selBg: '35;57;80'           // #233950  selezione (accent-sub)
};

function psIntegrationScript(enhance) {
  const lines = [
    '$global:__trOrigPrompt = $function:prompt',
    'function global:prompt {',
    '  $loc = $executionContext.SessionState.Path.CurrentLocation',
    '  $osc = ""',
    '  if ($loc.Provider.Name -eq "FileSystem") { $osc = "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]7)" }',
    '  $orig = if ($global:__trOrigPrompt) { & $global:__trOrigPrompt } else { "PS $($loc)> " }',
    '  return $osc + $orig',
    '}'
  ];
  if (enhance) {
    const fg = (rgb, style = '') => `"$e[${style}38;2;${rgb}m"`;
    lines.push(
      '$__trRL = Get-Module PSReadLine',
      'if ($__trRL) {',
      '  $e = [char]27',
      // Colori: chiavi supportate già da PSReadLine 2.0 (Windows PowerShell 5.1)
      '  try { Set-PSReadLineOption -ErrorAction Stop -Colors @{',
      `    Command = ${fg(SYNTAX.command)}; Keyword = ${fg(SYNTAX.command, '1;')}`,
      `    Parameter = ${fg(SYNTAX.parameter)}; Variable = ${fg(SYNTAX.parameter)}; Type = ${fg(SYNTAX.parameter)}`,
      `    String = ${fg(SYNTAX.string)}; Number = ${fg(SYNTAX.number)}`,
      `    Operator = ${fg(SYNTAX.operator)}; Comment = ${fg(SYNTAX.comment, '3;')}`,
      `    Member = ${fg(SYNTAX.text)}; Default = ${fg(SYNTAX.text)}; Error = ${fg(SYNTAX.error)}`,
      `    Emphasis = ${fg(SYNTAX.command, '1;')}; Selection = "$e[48;2;${SYNTAX.selBg}m"`,
      '  } } catch {}',
      // Suggerimenti in linea (PSReadLine 2.1+) e vista a elenco (2.2+)
      `  try { Set-PSReadLineOption -ErrorAction Stop -Colors @{ InlinePrediction = ${fg(SYNTAX.ghost)} } } catch {}`,
      `  try { Set-PSReadLineOption -ErrorAction Stop -Colors @{ ListPrediction = ${fg(SYNTAX.command)}; ListPredictionSelected = "$e[48;2;${SYNTAX.selBg}m" } } catch {}`,
      '  if ($__trRL.Version -ge [version]"2.1.0") {',
      '    try { Set-PSReadLineOption -ErrorAction Stop -PredictionSource HistoryAndPlugin } catch { try { Set-PSReadLineOption -ErrorAction Stop -PredictionSource History } catch {} }',
      '    try { Set-PSReadLineOption -ErrorAction Stop -PredictionViewStyle InlineView } catch {}',
      '  }',
      // Tab = menu di completamento; frecce = cronologia filtrata da ciò che hai scritto
      '  try {',
      '    Set-PSReadLineOption -HistorySearchCursorMovesToEnd',
      '    Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete',
      '    Set-PSReadLineKeyHandler -Key Shift+Tab -Function TabCompletePrevious',
      '    Set-PSReadLineKeyHandler -Key UpArrow -Function HistorySearchBackward',
      '    Set-PSReadLineKeyHandler -Key DownArrow -Function HistorySearchForward',
      '    Set-PSReadLineKeyHandler -Key Ctrl+RightArrow -Function ForwardWord',
      '  } catch {}',
      '}',
      // PowerShell 7.2+: colori dell'output (intestazioni tabelle, cartelle, errori)
      'if ($PSStyle) { try {',
      '  $e = [char]27',
      `  $PSStyle.Formatting.TableHeader = ${fg(SYNTAX.command, '1;')}`,
      `  $PSStyle.Formatting.CustomTableHeaderLabel = ${fg(SYNTAX.command, '1;3;')}`,
      `  $PSStyle.Formatting.FormatAccent = ${fg(SYNTAX.command, '1;')}`,
      `  $PSStyle.Formatting.ErrorAccent = ${fg(SYNTAX.parameter, '1;')}`,
      `  $PSStyle.Formatting.Error = ${fg(SYNTAX.error)}`,
      `  $PSStyle.Formatting.Warning = ${fg(SYNTAX.string)}`,
      `  $PSStyle.Formatting.Verbose = ${fg(SYNTAX.parameter)}`,
      `  $PSStyle.Formatting.Debug = ${fg(SYNTAX.number)}`,
      `  $PSStyle.FileInfo.Directory = ${fg(SYNTAX.command, '1;')}`,
      `  $PSStyle.FileInfo.SymbolicLink = ${fg(SYNTAX.parameter)}`,
      `  $PSStyle.FileInfo.Executable = ${fg(SYNTAX.number)}`,
      `  $PSStyle.Progress.Style = ${fg(SYNTAX.command)}`,
      '} catch {} }',
      'Remove-Variable __trRL, e -ErrorAction SilentlyContinue'
    );
  }
  return lines.join('\n');
}

// Readline (Git Bash, WSL): completamento a menu colorato e ricerca nella cronologia
const BASH_INIT = [
  "bind 'set colored-completion-prefix on'",
  "bind 'set colored-stats on'",
  "bind 'set show-all-if-ambiguous on'",
  "bind 'set completion-ignore-case on'",
  "bind 'set menu-complete-display-prefix on'",
  "bind 'TAB: menu-complete'",
  "bind '\"\\e[Z\": menu-complete-backward'",
  "bind '\"\\e[A\": history-search-backward'",
  "bind '\"\\e[B\": history-search-forward'"
].join('\n');

function bashPromptCommand(pathExpr, enhance) {
  const osc = `printf "\\033]9;9;\\"%s\\"\\007" "${pathExpr}"`;
  return enhance ? `[ -z "$__TR_INIT" ] && { __TR_INIT=1; eval "$TRANTOR_INIT"; }; ${osc}` : osc;
}

function buildSpawn(profile, cwd, enhance) {
  const env = { ...process.env, TERM_PROGRAM: 'Trantor', COLORTERM: 'truecolor' };
  if (enhance) env.TRANTOR_INIT = BASH_INIT;
  let args = [];
  switch (profile.kind) {
    case 'powershell': {
      const encoded = Buffer.from(psIntegrationScript(enhance), 'utf16le').toString('base64');
      args = ['-NoLogo', '-NoExit', '-EncodedCommand', encoded];
      break;
    }
    case 'cmd':
      env.PROMPT = '$e]9;9;$P$e\\$P$G';
      break;
    case 'gitbash':
      env.PROMPT_COMMAND = bashPromptCommand('$(cygpath -w "$PWD")', enhance) + (process.env.PROMPT_COMMAND ? ';' + process.env.PROMPT_COMMAND : '');
      env.CHERE_INVOKING = '1';
      args = ['--login', '-i'];
      break;
    case 'wsl':
      env.TR_PC = bashPromptCommand('$(wslpath -w "$PWD")', enhance);
      env.WSLENV = (process.env.WSLENV ? process.env.WSLENV + ':' : '') + 'TR_PC/u' + (enhance ? ':TRANTOR_INIT/u' : '');
      args = ['--cd', cwd, '--exec', 'bash', '-c', 'export PROMPT_COMMAND="$TR_PC${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; exec bash -i'];
      break;
    case 'bash':
      env.PROMPT_COMMAND = bashPromptCommand('$PWD', enhance);
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
  startDir: pendingDir,
  profiles: detectProfiles()
}));

// ---------------------------------------------------------------------------
// IPC — pseudo-terminali
// ---------------------------------------------------------------------------
ipcMain.handle('pty:spawn', (_e, { id, profile, cwd, cols, rows, enhance }) => {
  let startDir = cwd;
  try { if (!startDir || !fs.statSync(startDir).isDirectory()) startDir = os.homedir(); } catch { startDir = os.homedir(); }
  const { file, args, env } = buildSpawn(profile, startDir, enhance !== false);
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
