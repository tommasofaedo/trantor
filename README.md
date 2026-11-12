<p align="center">
  <img src="build/icon.png" width="96" alt="Trantor icon">
</p>

<h1 align="center">Trantor</h1>

<p align="center">
  A modern terminal for Windows with tmux-style split panes, fast folder navigation and a <b>Yaru Dark</b> look.<br>
  <i>Named after the city-planet of Isaac Asimov's Foundation: endless corridors, and you always know where you are.</i><br>
  🇬🇧 English · 🇮🇹 <a href="README.it.md">Italiano</a>
</p>

![Trantor](docs/screenshot.png)

## Download

<p>
  <a href="../../releases/latest/download/Trantor-Setup-x64.exe"><b>⬇ Download Trantor for Windows</b></a> (installer, x64)
  &nbsp;·&nbsp;
  <a href="../../releases/latest/download/Trantor-Portable-x64.exe">Portable version</a> (single <code>.exe</code>, no installation)
</p>

Windows 10 and 11, 64-bit. Nothing else to install. Older versions and release notes are on the [Releases](../../releases) page.

- **Installer**: adds Trantor to the Start menu and an **"Open in Trantor"** entry when you right-click a folder in Explorer.
- **Portable**: double-click and go, handy on a USB stick or a PC where you can't install software. It starts a few seconds slower.

> **"Windows protected your PC"**: the executables are not code-signed yet, so SmartScreen may warn you the first time. Click **More info → Run anyway**.

## Features

- **Tabs and split panes** like tmux, but mouse-friendly: every pane has split / zoom / close buttons, dividers can be dragged (double-click resets to 50/50).
- **Folder sidebar that follows the active pane**: clickable breadcrumb, bookmarks, frecency-ranked recent folders, drives and the current folder's content with an instant filter.
- **Jump to folder** (`Ctrl+G`): fuzzy search over bookmarks, recent folders (like `z`/`zoxide`), subfolders and drives. Open in the current pane, a new tab or a new split.
- **Command palette** (`Ctrl+Shift+P`) with every action and its shortcut.
- **Session restore**: tabs, splits and folders come back when you reopen the app.
- **Shells detected automatically**: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL.
- **Explorer integration**: "Open in Trantor" context-menu entry, drag a folder onto a pane to `cd` into it.
- **Network devices**: finds PLCs, panels, routers and servers on the local network, recognizes Modbus, S7, EtherNet/IP, OPC UA, SSH and web interfaces, and reads Modbus registers (read only).
- **Rearrange panes**: drag panes to move, swap, send them to another tab or detach them into a new window without stopping the shell.
- **Smart folders**: remembers the commands you run in each folder, recognizes projects (git, Node, Python, Docker, .NET…) with one-click actions, and restores saved pane layouts per project.
- **Command suggestions and syntax colors**: grey inline suggestions from history, Tab completion menu, colors for commands, strings and numbers (PowerShell), all in Yaru tones.
- **Yaru Dark theme** with the official Yaru blue accent (`#0073E5`), Ubuntu terminal palette, WebGL rendering.

![Jump to folder](docs/jump-to-folder.png)

> The interface is currently in Italian. Translations are welcome, see [CONTRIBUTING](CONTRIBUTING.md).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+G` | Jump to folder |
| `Ctrl+Shift+L` | Filter the current folder in the sidebar |
| `Ctrl+H` | Commands used in this folder |
| `Ctrl+Shift+R` | Project actions |
| `Ctrl+Shift+N` | Network devices |
| `Ctrl+Alt+Shift+Arrows` | Swap the active pane with its neighbour |
| `Alt+Up` | Parent folder (moves focus up when there are several panes) |
| `Alt+1…9` | Go to bookmark 1…9 |
| `Ctrl+Shift+S` | Bookmark / unbookmark the current folder |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Split right / down |
| `Alt+Arrows` | Move focus between panes |
| `Ctrl+Alt+Arrows` | Resize the active pane |
| `Ctrl+Shift+Z` | Zoom / unzoom pane |
| `Ctrl+Shift+W` / `Ctrl+Shift+Q` | Close pane / tab |
| `Ctrl+Shift+T` | New tab |
| `Ctrl+Tab`, `Ctrl+1…9` | Switch tab |
| `Ctrl+C` (with selection), `Ctrl+V` | Copy / paste |
| `Ctrl+Shift+F` | Find in terminal |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+=`, `Ctrl+-`, `Ctrl+0`, `Ctrl+wheel` | Font size |
| `→` / `Ctrl+→` | Accept the suggestion / one word of it |
| `Tab` / `↑` `↓` | Completion menu / history filtered by what you typed |
| `Ctrl+Shift+P` | Command palette |
| `F1` | Shortcut list |

Mouse, in the sidebar and in Jump to folder: click = enter · `Ctrl`+click or middle-click = new tab · `Shift`+click = split right · `Alt`+click = split down · right-click = menu.

## Network devices

<img src="docs/network.png" width="340" align="right" alt="Network devices">

Open the **Rete** tab of the sidebar (`Ctrl+Shift+N`), check the network range and press **Scansiona**. Trantor:

- tries the most common ports on every address and then reads the Windows ARP table, so it also finds devices that don't answer on any port;
- shows the vendor from the MAC address (IEEE database);
- recognizes services with read-only requests: SSH banner, web page title, **Modbus TCP** device identification (vendor, product, version), **EtherNet/IP** product name, **OPC UA** and **Siemens S7** handshakes, MQTT, IEC 104, DNP3, Beckhoff ADS, RDP, VNC, printers and cameras;
- groups devices as automation, network, computers, printers, cameras.

Click a device for details and actions: SSH (choose the user), open the web interface, continuous ping in a new pane, remote desktop, copy IP / MAC / OPC UA endpoint, and **Read Modbus registers**: holding/input registers, coils, discrete inputs, shown as unsigned, signed, hex, binary or float32, optionally refreshed every second with changed values highlighted. Trantor never writes to devices.

Scan only networks you manage or are authorized to test.

<br clear="right">

## Rearranging panes

Drag a pane by its header:

- onto the **edge** of another pane → it moves next to it on that side;
- onto the **centre** of another pane → the two swap;
- onto a **tab** → it moves into that tab; onto **+** → it gets its own tab;
- **outside the window** → it is detached into a new window. The shell keeps running and the content is preserved.

The same actions are in the pane's right-click menu. `Ctrl+Alt+Shift+arrows` swaps the active pane with its neighbour.

## Updates

The installed version checks for new releases at start-up and every 6 hours. When one is available an **Update** button appears in the header bar: it downloads the update, then **Restart to update** installs it and reopens your session. The portable version shows a link to the new download. Automatic checks can be turned off from the command palette.

## Smart folders

![Smart folders](docs/smart-folders.png)

Trantor remembers what you do in each folder and recognizes what kind of project you are in.

**Commands used here.** Every command is saved with the folder it ran in, how many times, when, and whether it succeeded. The sidebar shows the most used ones for the current folder; `Ctrl+H` searches all of them, including the parent folders of the project. Click to insert a command, ▶ or double-click to run it, Shift+click to run it in a new pane. Months later you open a project and immediately see how it was built, started or deployed.

**Project card.** When the folder belongs to a project, the sidebar shows its name, git branch, changes and ready-made actions:

| Detected from | Actions |
|---|---|
| `.git` | branch, changes, commits ahead/behind; modified files marked in the list |
| `package.json` | npm / pnpm / yarn / bun scripts, install if `node_modules` is missing |
| `pyproject.toml`, `requirements.txt` | activate the virtual env, install requirements, run `main.py`/`app.py`/`manage.py`, pytest |
| `compose.yaml` | `docker compose up -d`, `ps`, `logs -f`, `down` |
| `*.sln`, `*.csproj` | `dotnet build`, `run`, `test` |
| `Makefile`, `Cargo.toml`, `go.mod` | make targets, cargo, go |

`Ctrl+Shift+R` lists every action. Shift+click runs an action in a new pane, handy for dev servers.

**Saved layouts.** From the ☰ button of the project card, save the layout of the current tab: the panes, their folders and the commands running in them (for example `npm run dev` in one pane and `docker compose logs -f` in another). Opening the project in a new tab (Ctrl+click, or Ctrl+Enter in Jump to folder) brings the whole layout back.

Command history works with PowerShell, Git Bash and WSL; the Command Prompt (cmd) does not report the commands it runs. To activate Python environments in Windows PowerShell 5.1 the script execution policy must allow it (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).

## Suggestions and syntax colors

![Suggestions and syntax colors](docs/suggestions.png)

Trantor turns on the line-editing features that your shell already has and styles them in Yaru colors:

| | PowerShell 7 | Windows PowerShell 5.1 | Git Bash / WSL |
|---|---|---|---|
| Grey inline suggestion from history | ✓ | with PSReadLine 2.1+ ¹ | — ² |
| Tab completion menu | ✓ | ✓ | ✓ |
| History search filtered by what you typed (↑/↓) | ✓ | ✓ | ✓ |
| Syntax colors while typing | ✓ | ✓ | — ² |

Keys: **→** or **End** accepts the suggestion, **Ctrl+→** accepts one word, **Tab / Shift+Tab** moves through the completion menu, **F2** switches between inline and list suggestions (PowerShell 7).

Colors: commands `#389AFE` · parameters, variables and types `#58C7F5` · strings `#F99B11` · numbers `#A597EC` · comments and operators in grey · errors `#FF7A71`. They are derived from the official [Yaru](https://github.com/ubuntu/yaru) accent palette and kept to a few tones on purpose.

¹ Update it with `Install-Module PSReadLine -Scope CurrentUser -Force`.
² Bash has no built-in inline suggestions or highlighting: install [ble.sh](https://github.com/akinomyoga/ble.sh) to get them. For cmd, [Clink](https://github.com/chrisant996/clink) adds both.

These settings are applied after your PowerShell profile, so they override your own PSReadLine colors and key bindings. If you prefer your setup, turn off **Suggerimenti e colori nella shell** in the ☰ menu or the command palette (applies to new panes).

## How the sidebar knows your folder

Each shell gets a tiny integration that emits `OSC 9;9` (the same sequence Windows Terminal uses) at every prompt:

- **PowerShell** wraps your existing `prompt` function, so oh-my-posh and Starship keep working.
- **cmd** sets the `PROMPT` variable.
- **Git Bash / WSL** append to `PROMPT_COMMAND`.

If your WSL `.bashrc` *overwrites* `PROMPT_COMMAND`, append to it instead (`PROMPT_COMMAND="$PROMPT_COMMAND;..."`).

## Fonts

For the full Ubuntu look install **Ubuntu** and **Ubuntu Mono** from <https://design.ubuntu.com/font>. Otherwise the app falls back to Segoe UI and Cascadia Mono / Consolas.

## Development

You only need this to change the code. To use Trantor, [download it](#download).

### Run from source

Requires [Node.js](https://nodejs.org) 20+. Clone the repository (green **Code** button on GitHub, or download it as ZIP), then from its folder:

```powershell
npm install
npm start
```

Build the installer and the portable version into `dist\`:

```powershell
npm run dist
```

### Troubleshooting

**`Electron failed to install correctly`**: the project's `postinstall` script re-downloads Electron and verifies its SHA-256 checksum. If that also fails behind a corporate proxy, set `HTTPS_PROXY`, or `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`, and run `npm install` again.

### Releasing

On GitHub go to **Releases → Draft a new release**, create a tag such as `v1.0.1` and publish it. GitHub Actions builds the installer and the portable executable and attaches them to that release. Remember to bump `version` in `package.json` first.

### Project structure

```
src/
  main.js              main process: window, ConPTY, filesystem, settings
  preload.js           API exposed to the UI (context isolation on)
  renderer/
    index.html
    styles.css         Yaru Dark theme
    icons.js           symbolic icons
    app.js             tabs, panes, sidebar, pickers, shortcuts
    smart.js           per-folder history, projects, git, saved layouts
    panes.js           drag, swap, move and detach panes
    network.js         network devices view and Modbus reader
    updates.js         update button
  netscan.js           network scan, service recognition, Modbus TCP
scripts/
  ensure-electron.js   fallback Electron download
  check.js             syntax check (npm run lint)
  test.js              automated tests (npm test)
build/                 icons and installer script
```

Settings, bookmarks, history and session are stored in `%APPDATA%\Trantor\config.json`.

## Credits

- Colors derived from the official [Yaru](https://github.com/ubuntu/yaru) sources (`$jet #181818`, `$porcelain #F7F7F7`, blue accent `#0073E5`).
- Built with [Electron](https://www.electronjs.org), [xterm.js](https://xtermjs.org) and [node-pty](https://github.com/microsoft/node-pty) (prebuilt binaries by [@lydell/node-pty](https://www.npmjs.com/package/@lydell/node-pty)).

## License

MIT, see [LICENSE](LICENSE).

This is an independent project and is not affiliated with or endorsed by Canonical, the Yaru project or the Asimov estate. "Ubuntu" is a registered trademark of Canonical Ltd.
