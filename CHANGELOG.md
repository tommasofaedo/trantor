# Changelog

## 1.4.0 — 2026-11-12

- **Drag files between local and remote panes**: a pane becomes remote when you run `ssh` in it (port, key, jump host and `-o` options are understood). Drop files or folders from Explorer or from the sidebar onto it to upload them; select a file name in the remote pane and drag the "Scarica" label onto a local pane or a sidebar folder (or click it) to download. Transfers run `scp` in a pane below, so password prompts work, and the pane closes by itself when the transfer succeeds
- Remote folder detection for bash and zsh (pane menu → "Rileva la cartella remota"), shown in the pane header
- Remote pane menu: upload files, download a file or folder by path, recent remote destinations per host

## 1.3.0 — 2026-11-12

- **Network devices** (sidebar → Rete, Ctrl+Shift+N): scans the local network, finds devices also through the ARP table, shows the vendor from the MAC address and recognizes services: SSH, web, Siemens S7, Modbus TCP (vendor/product via device identification), EtherNet/IP (product name), OPC UA, MQTT, IEC 104, DNP3, ADS, RDP, VNC, printers, cameras. One-click actions: SSH with user choice, web interface, continuous ping, remote desktop, copy IP/MAC/OPC UA endpoint
- **Modbus read window**: holding/input registers, coils and discrete inputs, unsigned/signed/hex/binary/float32 formats, refresh every second with changed values highlighted. Read only: Trantor never writes to devices
- **Rearrange panes**: drag a pane by its header onto another pane's edge to move it there, onto its centre to swap, onto a tab to move it to that tab, onto + for a new tab, or outside the window to detach it into a new window — the shell keeps running and the content is preserved. Ctrl+Alt+Shift+arrows swaps with the neighbouring pane
- **Automatic updates**: the installed version checks GitHub releases at start-up and every 6 hours and shows an update button; download and restart keep the session. The portable version shows a link to the new download
- Automated tests (`npm test`) run in CI on Windows

## 1.2.1 — 2026-11-12

- "Usati qui" is always visible and explains what it will show (or that the Command Prompt can't report commands) instead of staying hidden until the first command
- New command "Verifica integrazione della shell" (☰ menu and command palette) to check whether the active pane receives the folder and the commands from the shell

## 1.2.0 — 2026-11-12

- **Per-folder command history**: every command is remembered together with the folder it ran in. The sidebar shows the ones used most in the current folder ("Usati qui"); Ctrl+H searches them, including parent folders of the project. Click inserts, ▶ runs, Shift+click runs in a new pane
- **Project detection**: git, Node (npm/pnpm/yarn/bun scripts), Python (virtual env, requirements), Docker Compose, .NET, Make, Rust, Go. Ready-made actions in the sidebar and in Ctrl+Shift+R
- **Git at a glance**: branch, number of changes and commits ahead/behind in the sidebar and in the pane header; modified and new files marked in the folder list
- **Saved layouts per project**: save the panes of a tab (and the commands running in them, e.g. a dev server); open the project in a new tab to get them back
- Optional automatic activation of the project's Python virtual environment

## 1.1.0 — 2026-11-12

- Command suggestions while you type (PowerShell): grey inline prediction from history and plugins, accepted with → or word by word with Ctrl+→
- Tab opens a completion menu; ↑/↓ search history filtered by what you've typed (PowerShell, Git Bash, WSL)
- Syntax colors on the command line in Yaru style: commands, parameters and variables, strings, numbers, comments, errors
- PowerShell 7 output colors (table headers, folders, warnings, errors) aligned with Yaru
- Terminal ANSI palette based on official Yaru accent colors
- New setting "Suggerimenti e colori nella shell" to turn all of this off and keep your own PSReadLine setup

## 1.0.0 — 2026-11-12

First public version.

- Tabs and tmux-style split panes with mouse controls, zoom and keyboard navigation
- Folder sidebar following the active pane: breadcrumb, bookmarks, recent folders, drives, filterable content
- Jump to folder (`Ctrl+G`) with fuzzy search and frecency ranking
- Command palette, find in terminal, session restore
- Automatic detection of PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL with cwd tracking
- "Open in Trantor" Explorer context menu, single instance
- Yaru Dark theme with blue accent
- Fallback Electron download with checksum verification
