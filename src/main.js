// Trantor — processo principale Electron
// Gestisce finestra, pseudo-terminali (ConPTY via node-pty), filesystem e configurazione.

const { app, BrowserWindow, ipcMain, shell, clipboard, webContents, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

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
    'function global:__trB64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }',
    'function global:prompt {',
    '  $ok = $?',
    '  $loc = $executionContext.SessionState.Path.CurrentLocation',
    '  $osc = ""',
    // Comando appena terminato: cartella in cui è partito, testo, esito, durata (OSC 7777)
    '  $h = Get-History -Count 1',
    '  if ($h -and $h.Id -ne $global:__trLastId) {',
    '    $global:__trLastId = $h.Id',
    '    $ms = [int]($h.EndExecutionTime - $h.StartExecutionTime).TotalMilliseconds',
    '    if ($global:__trPrevDir) { $osc += "$([char]27)]7777;cmd;$(__trB64 $global:__trPrevDir);$(__trB64 $h.CommandLine);$([int]$ok);$ms$([char]7)" }',
    '  }',
    '  if ($loc.Provider.Name -eq "FileSystem") {',
    '    $global:__trPrevDir = $loc.ProviderPath',
    '    $osc += "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]7)"',
    '  }',
    '  $orig = if ($global:__trOrigPrompt) { & $global:__trOrigPrompt } else { "PS $($loc)> " }',
    '  return $osc + $orig',
    '}',
    // Invio: segnala a Trantor il comando che sta partendo (serve per salvare le disposizioni)
    'if (Get-Module PSReadLine) { try {',
    '  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {',
    '    $l = $null; $c = $null',
    '    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$l, [ref]$c)',
    '    if ($l.Trim()) { [Console]::Write("$([char]27)]7777;start;$(__trB64 $l)$([char]7)") }',
    '    [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()',
    '  }',
    '} catch {} }'
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

// PROMPT_COMMAND: registra il comando appena terminato (OSC 7777) e la cartella corrente (OSC 9;9).
// Il primo prompt non registra nulla: "history 1" lì è l'ultima riga della sessione precedente.
function bashPromptCommand(pathExpr, enhance) {
  const b64 = (v) => `$(printf %s "${v}" | base64 | tr -d '\\n')`;
  return [
    '__tr_ec=$?',
    `__tr_p="${pathExpr}"`,
    '__tr_h="$(HISTTIMEFORMAT= history 1)"',
    '__tr_n="$(printf %s "$__tr_h" | sed -E \'s/^ *([0-9]+).*/\\1/\')"',
    '__tr_c="$(printf %s "$__tr_h" | sed -E \'s/^ *[0-9]+\\*? +//\')"',
    `if [ -z "\${__tr_ln+x}" ]; then __tr_ln="$__tr_n"; elif [ -n "$__tr_n" ] && [ "$__tr_n" != "$__tr_ln" ]; then printf "\\033]7777;cmd;%s;%s;%s;0\\007" "${b64('$__tr_pd')}" "${b64('$__tr_c')}" "$([ $__tr_ec = 0 ] && echo 1 || echo 0)"; __tr_ln="$__tr_n"; fi`,
    '__tr_pd="$__tr_p"',
    enhance ? '[ -z "$__TR_INIT" ] && { __TR_INIT=1; eval "$TRANTOR_INIT"; }' : ':',
    'printf "\\033]9;9;\\"%s\\"\\007" "$__tr_p"'
  ].join('; ');
}

// PS0 viene espanso da bash subito prima di eseguire un comando: lo usiamo per l'evento "start"
const BASH_PS0 = '$(printf "\\033]7777;start;%s\\007" "$(HISTTIMEFORMAT= history 1 | sed -E \'s/^ *[0-9]+\\*? +//\' | base64 | tr -d \'\\n\')")';

function buildSpawn(profile, cwd, enhance) {
  const env = { ...process.env, TERM_PROGRAM: 'Trantor', COLORTERM: 'truecolor', PS0: BASH_PS0 };
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
      env.WSLENV = (process.env.WSLENV ? process.env.WSLENV + ':' : '') + 'TR_PC/u:PS0/u' + (enhance ? ':TRANTOR_INIT/u' : '');
      args = ['--cd', cwd, '--exec', 'bash', '-c', 'export PROMPT_COMMAND="$TR_PC${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; exec bash -i'];
      break;
    case 'bash':
      env.PROMPT_COMMAND = bashPromptCommand('$PWD', enhance);
      break;
  }
  if (profile.elevate && isWin) {
    const elevator = profile.elevate === 'gsudo' ? which('gsudo.exe') : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sudo.exe');
    if (elevator && fs.existsSync(elevator)) return { file: elevator, args: [profile.exe, ...args], env };
  }
  return { file: profile.exe, args, env };
}

// ---------------------------------------------------------------------------
// Finestra
// ---------------------------------------------------------------------------
const windows = new Set(); // tutte le finestre; `win` è la principale (sessione, dimensioni, aggiornamenti)

// opts.adopt: pannello staccato da un'altra finestra { id, profile, cwd, serialized, width, height, x, y }
function createWindow(opts = {}) {
  const cfg = loadConfig();
  const adopt = opts.adopt || null;
  const secondary = !!adopt;
  const bounds = secondary
    ? { width: Math.max(640, adopt.width || 900), height: Math.max(400, adopt.height || 600), x: adopt.x, y: adopt.y }
    : cfg.bounds;
  const w = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
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
  w.trantor = { secondary, adopt };
  windows.add(w);
  if (!secondary || !win) win = win || w;
  if (!secondary && cfg.maximized) w.maximize();
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.once('ready-to-show', () => w.show());
  // I link non aprono finestre Electron ma il browser predefinito
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());

  const sendState = () => !w.isDestroyed() && w.webContents.send('win:state', { maximized: w.isMaximized() });
  w.on('maximize', sendState);
  w.on('unmaximize', sendState);

  w.on('close', () => {
    if (w !== win) return;
    const c = loadConfig();
    c.maximized = w.isMaximized();
    if (!w.isMaximized() && !w.isMinimized()) c.bounds = w.getBounds();
    saveConfig(c);
  });
  const wcId = w.webContents.id;
  w.on('closed', () => {
    for (const [id, p] of ptys) {
      if (p.ownerId === wcId) { try { p.proc.kill(); } catch {} ptys.delete(id); }
    }
    windows.delete(w);
    if (win === w) win = [...windows][0] || null;
  });
  return w;
}

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

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
ipcMain.on('win:minimize', (e) => { const w = winOf(e); if (w) w.minimize(); });
ipcMain.on('win:toggleMaximize', (e) => { const w = winOf(e); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });
ipcMain.on('win:close', (e) => { const w = winOf(e); if (w) w.close(); });

// ---------------------------------------------------------------------------
// IPC — configurazione
// ---------------------------------------------------------------------------
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_e, partial) => {
  const cfg = { ...loadConfig(), ...partial };
  saveConfig(cfg);
  return true;
});
ipcMain.handle('app:info', (e) => ({
  secondary: !!(winOf(e) && winOf(e).trantor && winOf(e).trantor.secondary),
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
// Ogni pty appartiene a una finestra; durante il passaggio a un'altra finestra i dati vanno in coda
function ptySend(entry, channel, ...args) {
  if (entry.queue) { entry.queue.push([channel, args]); return; }
  const wc = webContents.fromId(entry.ownerId);
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
}

ipcMain.handle('pty:spawn', (e, { id, profile, cwd, cols, rows, enhance }) => {
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
  const entry = { proc, kind: profile.kind, ownerId: e.sender.id, queue: null };
  ptys.set(id, entry);
  proc.onData((data) => ptySend(entry, 'pty:data', id, data));
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    ptySend(entry, 'pty:exit', id, exitCode);
  });
  return { pid: proc.pid, cwd: startDir };
});

// Staccare un pannello in una nuova finestra senza interrompere la shell
ipcMain.handle('pane:detach', (_e, payload) => {
  const entry = ptys.get(payload.id);
  if (!entry) return false;
  entry.queue = [];
  const w = createWindow({ adopt: payload });
  entry.ownerId = w.webContents.id;
  return true;
});
ipcMain.handle('pane:adoptInfo', (e) => { const w = winOf(e); return (w && w.trantor && w.trantor.adopt) || null; });
ipcMain.on('pane:adopted', (e, id) => {
  const entry = ptys.get(id);
  if (!entry || entry.ownerId !== e.sender.id || !entry.queue) return;
  const q = entry.queue; entry.queue = null;
  for (const [ch, args] of q) e.sender.send(ch, ...args);
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
// IPC — dispositivi in rete
// ---------------------------------------------------------------------------
const netscan = require('./netscan');
ipcMain.handle('net:interfaces', () => netscan.interfaces());
ipcMain.handle('net:scan', async (e, range) => {
  const wc = e.sender;
  const send = (ch, data) => { if (!wc.isDestroyed()) wc.send(ch, data); };
  try {
    const r = await netscan.scan(range, { onProgress: (p) => send('net:progress', p), onDevice: (d) => send('net:device', d) });
    return { ok: true, cancelled: r.cancelled, count: r.devices.length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('net:cancel', () => netscan.cancel());
ipcMain.handle('net:modbus', (_e, opts) => netscan.modbusRead(opts));
ipcMain.handle('net:rdp', (_e, ip) => {
  if (!isWin || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false;
  require('child_process').spawn('mstsc', [`/v:${ip}`], { detached: true, stdio: 'ignore' }).unref();
  return true;
});

// ---------------------------------------------------------------------------
// Aggiornamenti automatici (electron-updater, release di GitHub)
// L'indirizzo della repo non è scritto nei sorgenti: lo inserisce GitHub Actions
// in fase di compilazione (package.json → trantorRepo = "proprietario/repo").
// Installer: scarica e installa. Versione portable: avvisa e apre la pagina di download.
// ---------------------------------------------------------------------------
const UPD = { state: 'idle', version: null, notes: null, progress: 0, error: null };
let updater = null;
function repoInfo() {
  try {
    const r = require('../package.json').trantorRepo;
    if (!r || !/^[\w.-]+\/[\w.-]+$/.test(r)) return null;
    const [owner, repo] = r.split('/');
    return { owner, repo };
  } catch { return null; }
}
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
function updatePayload() {
  return { ...UPD, current: app.getVersion(), portable: isPortable(), enabled: !!(repoInfo() && app.isPackaged) };
}
function sendUpdate() { if (win && !win.isDestroyed()) win.webContents.send('update:state', updatePayload()); }
function getUpdater() {
  if (updater) return updater;
  const r = repoInfo();
  if (!r || !app.isPackaged) return null;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'github', owner: r.owner, repo: r.repo });
  const set = (patch) => { Object.assign(UPD, patch); sendUpdate(); };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 2000) : null }));
  autoUpdater.on('update-not-available', () => set({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', progress: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => set({ state: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 300) }));
  updater = autoUpdater;
  return updater;
}
ipcMain.handle('update:get', () => updatePayload());
ipcMain.handle('update:check', async () => {
  const u = getUpdater();
  if (!u) return updatePayload();
  try { await u.checkForUpdates(); } catch (e) { UPD.state = 'error'; UPD.error = String(e.message || e).split('\n')[0]; }
  return updatePayload();
});
ipcMain.handle('update:download', async () => {
  const r = repoInfo();
  if (isPortable() && r) { shell.openExternal(`https://github.com/${r.owner}/${r.repo}/releases/latest`); return updatePayload(); }
  const u = getUpdater();
  if (u) { try { await u.downloadUpdate(); } catch (e) { UPD.state = 'error'; UPD.error = String(e.message || e).split('\n')[0]; sendUpdate(); } }
  return updatePayload();
});
ipcMain.handle('update:install', () => { const u = getUpdater(); if (u && UPD.state === 'ready') setImmediate(() => u.quitAndInstall(false, true)); });

// ---------------------------------------------------------------------------
// IPC — archivi JSON separati (cronologia comandi per cartella, disposizioni)
// ---------------------------------------------------------------------------
const STORE_NAMES = new Set(['commands', 'layouts']);
const storeFile = (name) => path.join(app.getPath('userData'), `${name}.json`);
ipcMain.handle('store:load', (_e, name) => {
  if (!STORE_NAMES.has(name)) return null;
  try { return JSON.parse(fs.readFileSync(storeFile(name), 'utf8')); } catch { return null; }
});
ipcMain.handle('store:save', (_e, name, data) => {
  if (!STORE_NAMES.has(name)) return false;
  try {
    const f = storeFile(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(data), 'utf8');
    fs.renameSync(f + '.tmp', f);
    return true;
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// IPC — riconoscimento progetti
// Risale dalla cartella corrente fino alla radice del progetto e propone le azioni
// tipiche: script npm, ambiente Python, docker compose, dotnet, make, cargo, go.
// ---------------------------------------------------------------------------
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'Makefile', 'makefile'];

function findUp(start, test, stopAt) {
  let dir = start;
  for (let i = 0; i < 25; i++) {
    if (test(dir)) return dir;
    if (stopAt && dir === stopAt) return null;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function listSafe(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

function gitInfo(root) {
  return new Promise((resolve) => {
    const info = { root, branch: null, ahead: 0, behind: 0, changes: {}, count: 0, available: true };
    // ramo letto direttamente da .git/HEAD (funziona anche senza git installato)
    try {
      let gitDir = path.join(root, '.git');
      if (fs.statSync(gitDir).isFile()) {
        const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
        if (m) gitDir = path.resolve(root, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      info.branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 7);
    } catch {}
    execFile('git', ['-C', root, '--no-optional-locks', 'status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal'],
      { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) { info.available = err.code !== 'ENOENT'; return resolve(info); }
        const parts = stdout.split('\0');
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i];
          if (!line) continue;
          if (line.startsWith('## ')) {
            const m = line.match(/^## (?:No commits yet on )?([^.\s]+)/);
            if (m) info.branch = m[1];
            const a = line.match(/ahead (\d+)/); const b = line.match(/behind (\d+)/);
            info.ahead = a ? +a[1] : 0; info.behind = b ? +b[1] : 0;
            continue;
          }
          const xy = line.slice(0, 2); const file = line.slice(3);
          if (xy[0] === 'R' || xy[0] === 'C') i++; // con -z il nome originale segue come voce separata
          let st = 'M';
          if (xy === '??') st = '?';
          else if (xy.includes('U') || xy === 'AA' || xy === 'DD') st = 'U';
          else if (xy.includes('A')) st = 'A';
          else if (xy.includes('D')) st = 'D';
          else if (xy[0] === 'R') st = 'R';
          info.changes[file.replace(/\/$/, '')] = st;
        }
        info.count = Object.keys(info.changes).length;
        resolve(info);
      });
  });
}

function nodeActions(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return null;
  let pm = 'npm';
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (exists(path.join(dir, 'yarn.lock'))) pm = 'yarn';
  else if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) pm = 'bun';
  const run = (name) => pm === 'npm' ? `npm run ${name}` : pm === 'bun' ? `bun run ${name}` : `${pm} ${name}`;
  const actions = [];
  if (!exists(path.join(dir, 'node_modules'))) actions.push({ label: `${pm} install`, cmd: `${pm} install`, hint: 'dipendenze mancanti' });
  const order = ['dev', 'start', 'serve', 'build', 'test', 'lint'];
  const names = Object.keys(pkg.scripts || {}).filter((n) => !/^(pre|post)/.test(n) || order.includes(n));
  names.sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  for (const n of names) actions.push({ label: run(n), cmd: run(n), hint: String(pkg.scripts[n]).slice(0, 80) });
  return { kind: 'node', label: 'Node', name: pkg.name, dir, actions };
}

function pythonActions(dir) {
  const has = (f) => exists(path.join(dir, f));
  if (!['pyproject.toml', 'requirements.txt', 'setup.py', 'manage.py'].some(has)) return null;
  let venv = null;
  for (const v of ['.venv', 'venv', 'env', '.env']) {
    const vp = path.join(dir, v);
    if (exists(path.join(vp, 'pyvenv.cfg'))) {
      const win = exists(path.join(vp, 'Scripts'));
      venv = {
        name: v, path: vp,
        ps1: path.join(vp, win ? 'Scripts' : 'bin', win ? 'Activate.ps1' : 'activate.ps1'),
        bat: path.join(vp, 'Scripts', 'activate.bat'),
        sh: path.join(vp, win ? 'Scripts' : 'bin', 'activate')
      };
      break;
    }
  }
  const actions = [];
  if (!venv) actions.push({ label: 'python -m venv .venv', cmd: 'python -m venv .venv', hint: 'crea un ambiente virtuale' });
  if (has('requirements.txt')) actions.push({ label: 'pip install -r requirements.txt', cmd: 'pip install -r requirements.txt' });
  else if (has('pyproject.toml')) actions.push({ label: 'pip install -e .', cmd: 'pip install -e .' });
  if (has('manage.py')) actions.push({ label: 'python manage.py runserver', cmd: 'python manage.py runserver' });
  for (const f of ['main.py', 'app.py']) if (has(f)) actions.push({ label: `python ${f}`, cmd: `python ${f}` });
  if (exists(path.join(dir, 'tests')) || exists(path.join(dir, 'pytest.ini'))) actions.push({ label: 'pytest', cmd: 'pytest' });
  return { kind: 'python', label: 'Python', dir, venv, actions };
}

function composeActions(dir) {
  const f = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find((n) => exists(path.join(dir, n)));
  if (!f) return null;
  return { kind: 'docker', label: 'Docker', dir, actions: [
    { label: 'docker compose up -d', cmd: 'docker compose up -d' },
    { label: 'docker compose ps', cmd: 'docker compose ps' },
    { label: 'docker compose logs -f', cmd: 'docker compose logs -f --tail=100' },
    { label: 'docker compose down', cmd: 'docker compose down' }
  ] };
}

function dotnetActions(dir) {
  const files = listSafe(dir);
  const sln = files.find((n) => /\.(sln|slnx)$/i.test(n));
  const proj = files.find((n) => /\.(csproj|fsproj|vbproj)$/i.test(n));
  if (!sln && !proj) return null;
  const actions = [{ label: 'dotnet build', cmd: 'dotnet build' }];
  if (proj) actions.push({ label: 'dotnet run', cmd: 'dotnet run' });
  actions.push({ label: 'dotnet test', cmd: 'dotnet test' });
  return { kind: 'dotnet', label: '.NET', dir, actions };
}

function makeActions(dir) {
  const f = ['Makefile', 'makefile'].find((n) => exists(path.join(dir, n)));
  if (!f) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch {}
  const targets = [];
  for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:(?!=)/gm)) {
    if (!targets.includes(m[1]) && !m[1].startsWith('.')) targets.push(m[1]);
    if (targets.length >= 10) break;
  }
  return { kind: 'make', label: 'Make', dir, actions: targets.map((t) => ({ label: `make ${t}`, cmd: `make ${t}` })) };
}

function cargoActions(dir) {
  if (!exists(path.join(dir, 'Cargo.toml'))) return null;
  return { kind: 'rust', label: 'Rust', dir, actions: ['build', 'run', 'test', 'clippy'].map((c) => ({ label: `cargo ${c}`, cmd: `cargo ${c}` })) };
}

function goActions(dir) {
  if (!exists(path.join(dir, 'go.mod'))) return null;
  return { kind: 'go', label: 'Go', dir, actions: [
    { label: 'go run .', cmd: 'go run .' }, { label: 'go build ./...', cmd: 'go build ./...' }, { label: 'go test ./...', cmd: 'go test ./...' }
  ] };
}

ipcMain.handle('project:detect', async (_e, start) => {
  try { if (!fs.statSync(start).isDirectory()) return null; } catch { return null; }
  const home = os.homedir();
  const gitRoot = findUp(start, (d) => exists(path.join(d, '.git')));
  const stop = gitRoot || null;
  const projDir = findUp(start, (d) => d !== home && PROJECT_MARKERS.some((m) => exists(path.join(d, m))), stop);
  const root = projDir || gitRoot;
  if (!root || root === home) return null;
  // i tipi di progetto si cercano nella cartella del progetto e, se diversa, nella radice git
  const dirs = [...new Set([projDir, gitRoot].filter(Boolean))];
  const kinds = [];
  for (const d of dirs) {
    for (const fn of [nodeActions, pythonActions, composeActions, dotnetActions, cargoActions, goActions, makeActions]) {
      const k = fn(d);
      if (k && !kinds.some((x) => x.kind === k.kind)) kinds.push(k);
    }
  }
  const git = gitRoot ? await gitInfo(gitRoot) : null;
  if (!git && !kinds.length) return null;
  const pkgName = kinds.find((k) => k.kind === 'node' && k.name)?.name;
  return { root, name: pkgName || path.basename(root), kinds, git };
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

ipcMain.handle('dialog:chooseFiles', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), { title: 'File da caricare', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
// ---------------------------------------------------------------------------
// IPC — operazioni sui file (barra laterale)
// ---------------------------------------------------------------------------
const fileops = require('./fileops');
const wrap = (fn) => async (_e, ...a) => { try { return { ok: true, result: await fn(...a) }; } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('files:mkdir', wrap((dir, name) => fileops.mkdir(dir, name)));
ipcMain.handle('files:newFile', wrap((dir, name) => fileops.newFile(dir, name)));
ipcMain.handle('files:rename', wrap((p, name) => fileops.rename(p, name)));
ipcMain.handle('files:copy', wrap((srcs, dest) => fileops.copy(srcs, dest)));
ipcMain.handle('files:move', wrap((srcs, dest) => fileops.move(srcs, dest)));
ipcMain.handle('files:duplicate', wrap((p) => fileops.duplicate(p)));
ipcMain.handle('files:zip', wrap(async (paths) => fileops.zip(paths, await fileops.zipName(paths))));
ipcMain.handle('files:unzip', wrap((p) => fileops.unzip(p)));
ipcMain.handle('files:trash', wrap(async (paths) => { for (const p of paths) await shell.trashItem(p); return paths.length; }));
ipcMain.handle('files:readClipboard', () => fileops.readClipboardFiles());
ipcMain.handle('files:writeClipboard', (_e, paths) => fileops.writeClipboardFiles(paths));

// ---------------------------------------------------------------------------
// IPC — amministratore
// gsudo (anche Windows 10) o sudo di Windows 11 permettono una shell elevata dentro un pannello;
// altrimenti si apre una finestra separata con la richiesta UAC di Windows.
// ---------------------------------------------------------------------------
let adminInfoCache = null;
function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function runElevated(filePath, argList, cwd) {
  return new Promise((resolve) => {
    const args = argList && argList.length ? ` -ArgumentList ${argList.map(psQuote).join(',')}` : '';
    const wd = cwd ? ` -WorkingDirectory ${psQuote(cwd)}` : '';
    const cmd = `try { Start-Process -FilePath ${psQuote(filePath)}${args}${wd} -Verb RunAs -ErrorAction Stop; 'ok' } catch { 'errore: ' + $_.Exception.Message }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 120000 }, (e, out) => {
      const o = String(out || '').trim();
      if (e || !o.startsWith('ok')) resolve({ ok: false, error: /cancel|annullat/i.test(o) ? 'Operazione annullata' : (o.replace(/^errore: /, '') || String(e && e.message)) });
      else resolve({ ok: true });
    });
  });
}
ipcMain.handle('admin:info', async () => {
  if (!isWin) return { windows: false, isAdmin: process.getuid ? process.getuid() === 0 : false, gsudo: null, sudo: null };
  if (adminInfoCache) return adminInfoCache;
  const isAdmin = await new Promise((r) => execFile('net', ['session'], { windowsHide: true }, (e) => r(!e)));
  const gsudo = which('gsudo.exe');
  const sudoPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sudo.exe');
  adminInfoCache = { windows: true, isAdmin, gsudo, sudo: fs.existsSync(sudoPath) ? sudoPath : null };
  return adminInfoCache;
});
ipcMain.handle('admin:runFile', async (_e, p) => {
  if (!isWin) return { ok: false, error: 'Disponibile solo su Windows' };
  const ext = path.extname(p).toLowerCase();
  const dir = path.dirname(p);
  if (ext === '.ps1') return runElevated('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', p], dir);
  if (ext === '.msi') return runElevated('msiexec.exe', ['/i', p], dir);
  return runElevated(p, null, dir);
});
ipcMain.handle('admin:externalShell', async (_e, dir, profile) => {
  if (!isWin) return { ok: false, error: 'Disponibile solo su Windows' };
  if (profile && profile.kind === 'cmd') return runElevated(profile.exe, ['/k', `cd /d "${dir}"`], dir);
  const exe = profile && profile.kind === 'powershell' ? profile.exe : 'powershell.exe';
  return runElevated(exe, ['-NoExit', '-Command', `Set-Location -LiteralPath ${psQuote(dir)}`], dir);
});
ipcMain.handle('admin:relaunch', async () => {
  if (!isWin) return { ok: false, error: 'Disponibile solo su Windows' };
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? [] : process.argv.slice(1);
  app.releaseSingleInstanceLock();
  const r = await runElevated(exe, args, path.dirname(exe));
  if (r.ok) setTimeout(() => app.quit(), 300);
  else app.requestSingleInstanceLock();
  return r;
});

ipcMain.handle('fs:isDir', (_e, p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
ipcMain.handle('fs:resolve', (_e, base, rel) => path.resolve(base, rel));
ipcMain.handle('fs:parent', (_e, p) => path.dirname(p));
ipcMain.handle('fs:openExternal', (_e, p) => shell.openPath(p));
ipcMain.handle('fs:showInFolder', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('shell:openUrl', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(t));
