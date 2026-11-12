# Contributing

Thanks for wanting to help!

## Setup

```powershell
npm install
npm start
```

Open DevTools in the app with `Ctrl+Shift+I`.

## Guidelines

- Keep the look consistent with [Yaru](https://github.com/ubuntu/yaru): use the CSS variables in `src/renderer/styles.css`, no new hard-coded colors.
- Every new action should be reachable from the command palette (`commands()` in `app.js`) and, if it is frequent, from a shortcut listed in `showShortcuts()` and in the README.
- Run `npm run lint` before opening a pull request.
- Test with at least PowerShell and one other shell (cmd, Git Bash or WSL).

## Translations

UI strings are currently written in Italian directly in `src/renderer/`. Extracting them into a translation file is one of the planned improvements; PRs are welcome.
