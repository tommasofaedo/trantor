# Changelog

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
