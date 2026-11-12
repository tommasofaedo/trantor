# Trantor

🇬🇧 [English](README.md) · 🇮🇹 Italiano

![Trantor](docs/screenshot.png)

Terminale moderno per Windows 10/11 in stile **Yaru Dark** (accento blu `#0073E5`).

Il nome viene da **Trantor**, la capitale-pianeta del ciclo della *Fondazione* di Isaac Asimov: una città sconfinata di corridoi e settori, in cui con questo terminale sai sempre dove ti trovi.

Funzioni principali:

- **Schede e pannelli divisi** stile tmux, ma usabili anche col mouse (pulsanti su ogni pannello, divisori trascinabili, doppio clic sul divisore = 50/50)
- **Barra laterale cartelle** che segue sempre il pannello attivo: preferiti, recenti, unità, contenuto della cartella con filtro
- **Salta a cartella** (`Ctrl+G`): ricerca fuzzy su preferiti, cartelle recenti (frecency, come `z`/`zoxide`), sottocartelle e unità
- **Palette comandi** (`Ctrl+Shift+P`) con tutte le azioni e le scorciatoie
- Sessione (schede, pannelli, cartelle) **ripristinata all'avvio**
- Shell rilevate in automatico: PowerShell 7, Windows PowerShell, Prompt dei comandi, Git Bash, WSL

Basato su Electron + xterm.js + ConPTY (`@lydell/node-pty`, con binari precompilati: **non serve** Visual Studio Build Tools).

## Installazione

Scarica l'installer o la versione portable dalla pagina [Releases](../../releases).

## Avvio dai sorgenti

Serve [Node.js](https://nodejs.org) 20 o superiore.

```powershell
cd trantor
npm install
npm start
```

## Creare l'installer / l'eseguibile portable

```powershell
npm run dist
```

Trovi in `dist\` sia l'installer sia la versione portable. L'installer aggiunge anche la voce **"Apri in Trantor"** al menu contestuale delle cartelle in Esplora file.

Per pubblicare una release: su GitHub vai in **Releases → Draft a new release**, crea un tag (es. `v1.0.1`) e pubblica. La GitHub Action compila installer e portable e li allega alla release. Prima aggiorna `version` in `package.json`.

## Problemi noti

**"Electron failed to install correctly"**: lo script `postinstall` del progetto riscarica Electron in automatico e ne verifica il checksum. Se anche questo fallisce (proxy aziendale), imposta `HTTPS_PROXY` oppure `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` e rilancia `npm install`.

## Font consigliati

Per l'aspetto Ubuntu completo installa i font ufficiali **Ubuntu** e **Ubuntu Mono** da <https://design.ubuntu.com/font>.
Se mancano, l'app ripiega su Segoe UI e Cascadia Mono / Consolas.

## Scorciatoie

| Tasti | Azione |
|---|---|
| `Ctrl+G` | Salta a cartella (fuzzy) |
| `Ctrl+Shift+L` | Filtra il contenuto della cartella nella barra laterale |
| `Alt+Su` | Cartella superiore (con più pannelli: sposta il focus in su) |
| `Alt+1…9` | Vai al preferito n° 1…9 |
| `Ctrl+Shift+S` | Aggiungi/rimuovi la cartella corrente dai preferiti |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Dividi a destra / in basso |
| `Alt+Frecce` | Sposta il focus tra i pannelli |
| `Ctrl+Alt+Frecce` | Ridimensiona il pannello attivo |
| `Ctrl+Shift+Z` | Ingrandisci/ripristina pannello (zoom di tmux) |
| `Ctrl+Shift+W` / `Ctrl+Shift+Q` | Chiudi pannello / scheda |
| `Ctrl+Shift+T` | Nuova scheda |
| `Ctrl+Tab`, `Ctrl+1…9` | Cambia scheda |
| `Ctrl+C` (con selezione), `Ctrl+V` | Copia / incolla |
| `Ctrl+Shift+F` | Cerca nel terminale |
| `Ctrl+B` | Mostra/nascondi barra cartelle |
| `Ctrl+=`, `Ctrl+-`, `Ctrl+0`, `Ctrl+rotella` | Dimensione carattere |
| `Ctrl+Shift+P` | Palette comandi |
| `F1` | Elenco scorciatoie |

**Con il mouse**, in barra laterale e in "Salta a cartella":
clic = entra · `Ctrl`+clic o clic centrale = nuova scheda · `Shift`+clic = pannello a destra · `Alt`+clic = pannello sotto · tasto destro = menu.
Puoi anche **trascinare una cartella da Esplora file** dentro un pannello per entrarci (un file trascinato inserisce il suo percorso).

Nel campo filtro della barra laterale puoi scrivere un percorso (`D:\Progetti`, `..`, `~\Documents`) e premere Invio; `Backspace` a campo vuoto sale di una cartella.

## Come fa a sapere in che cartella sei

All'avvio di ogni shell viene aggiunta una piccola integrazione che, a ogni prompt, invia la sequenza `OSC 9;9` (la stessa usata da Windows Terminal):

- **PowerShell**: avvolge la funzione `prompt` esistente, quindi funziona anche con oh-my-posh/Starship
- **cmd**: imposta la variabile `PROMPT`
- **Git Bash / WSL**: aggiunge un comando a `PROMPT_COMMAND`

Se nel tuo `.bashrc` di WSL sovrascrivi `PROMPT_COMMAND` (invece di aggiungerci), la barra laterale non seguirà i `cd` fatti a mano: in quel caso usa `PROMPT_COMMAND="$PROMPT_COMMAND;..."`.

## Struttura

```
scripts/
  ensure-electron.js scarica Electron se lo script ufficiale non l'ha fatto
  check.js           controllo sintassi (npm run lint)
build/               icona e script dell'installer
src/
  main.js            processo principale: finestra, ConPTY, filesystem, configurazione
  preload.js         API esposte all'interfaccia (contextIsolation attivo)
  renderer/
    index.html
    styles.css       tema Yaru Dark (colori derivati da github.com/ubuntu/yaru)
    icons.js         icone simboliche
    app.js           schede, pannelli, barra laterale, picker, scorciatoie
```

Configurazione, preferiti, cronologia e sessione sono salvati in `%APPDATA%\Trantor\config.json`.

## Note sul tema

I colori vengono dai sorgenti ufficiali di Yaru (`gtk/src/default/gtk-3.0/_palette.scss`, `_colors.scss`, `common/accent-colors.scss.in`):
`$jet #181818` → sfondo finestra `#2C2C2C`, viste `#272727`, headerbar `#242424`, bordi `#181818`, testo `$porcelain #F7F7F7`, accento blu `#0073E5`.
La palette ANSI del terminale è quella del profilo Ubuntu di GNOME Terminal.

## Licenza

MIT — vedi [LICENSE](LICENSE).

Progetto indipendente, non affiliato né approvato da Canonical, dal progetto Yaru o dagli eredi di Isaac Asimov. "Ubuntu" è un marchio registrato di Canonical Ltd.
