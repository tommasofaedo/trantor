# Changelog

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
