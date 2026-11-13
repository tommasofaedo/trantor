// Trantor — operazioni sui file della barra laterale.
// Nomi in conflitto: come Esplora file ("nome - Copia", "Nuova cartella (2)").
// Eliminazione: sempre nel Cestino (shell.trashItem nel processo principale), mai definitiva.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const INVALID = isWin ? /[<>:"/\\|?*\x00-\x1f]/ : /[/\x00]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function validName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..') return 'Il nome non può essere vuoto';
  if (INVALID.test(n)) return isWin ? 'Il nome non può contenere \\ / : * ? " < > |' : 'Il nome non può contenere /';
  if (isWin && (RESERVED.test(n) || /[. ]$/.test(n))) return 'Nome non consentito da Windows';
  return null;
}

const exists = async (p) => { try { await fs.promises.lstat(p); return true; } catch { return false; } };

function splitExt(name, isDir) {
  if (isDir) return [name, ''];
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

// "Nuova cartella" → "Nuova cartella (2)", "file.txt" → "file - Copia.txt" → "file - Copia (2).txt"
async function freeName(dir, name, { copy = false, isDir = false } = {}) {
  const [base, ext] = splitExt(name, isDir);
  const first = copy ? `${base} - Copia${ext}` : name;
  if (!(await exists(path.join(dir, first)))) return first;
  for (let i = 2; i < 1000; i++) {
    const n = copy ? `${base} - Copia (${i})${ext}` : `${base} (${i})${ext}`;
    if (!(await exists(path.join(dir, n)))) return n;
  }
  throw new Error('Troppi elementi con lo stesso nome');
}

async function mkdir(dir, name = 'Nuova cartella') {
  const n = await freeName(dir, name, { isDir: true });
  await fs.promises.mkdir(path.join(dir, n));
  return path.join(dir, n);
}

async function newFile(dir, name = 'Nuovo file.txt') {
  const n = await freeName(dir, name);
  await fs.promises.writeFile(path.join(dir, n), '', { flag: 'wx' });
  return path.join(dir, n);
}

async function rename(p, newName) {
  const err = validName(newName);
  if (err) throw new Error(err);
  const dest = path.join(path.dirname(p), newName.trim());
  if (dest === p) return p;
  // su Windows cambiare solo maiuscole/minuscole è consentito anche se "esiste già"
  if (await exists(dest) && dest.toLowerCase() !== p.toLowerCase()) throw new Error(`Esiste già un elemento chiamato «${newName.trim()}»`);
  await fs.promises.rename(p, dest);
  return dest;
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Copia gli elementi in destDir; se il nome esiste già usa "nome - Copia"
async function copy(srcs, destDir) {
  const out = [];
  for (const src of srcs) {
    const st = await fs.promises.stat(src);
    if (st.isDirectory() && inside(destDir, src)) throw new Error(`Non puoi copiare «${path.basename(src)}» dentro sé stessa`);
    const same = path.resolve(path.dirname(src)) === path.resolve(destDir);
    const name = (same || await exists(path.join(destDir, path.basename(src))))
      ? await freeName(destDir, path.basename(src), { copy: true, isDir: st.isDirectory() })
      : path.basename(src);
    const dest = path.join(destDir, name);
    await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    out.push(dest);
  }
  return out;
}

// Sposta gli elementi in destDir (rinomina; tra dischi diversi copia e poi elimina l'originale)
async function move(srcs, destDir) {
  const out = [];
  for (const src of srcs) {
    if (path.resolve(path.dirname(src)) === path.resolve(destDir)) { out.push(src); continue; }
    const st = await fs.promises.stat(src);
    if (st.isDirectory() && inside(destDir, src)) throw new Error(`Non puoi spostare «${path.basename(src)}» dentro sé stessa`);
    const name = await exists(path.join(destDir, path.basename(src)))
      ? await freeName(destDir, path.basename(src), { isDir: st.isDirectory() })
      : path.basename(src);
    const dest = path.join(destDir, name);
    try { await fs.promises.rename(src, dest); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await fs.promises.rm(src, { recursive: true, force: true });
    }
    out.push(dest);
  }
  return out;
}

async function duplicate(p) { return (await copy([p], path.dirname(p)))[0]; }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts },
    (e, out, err) => (e ? reject(new Error((err || e.message).toString().trim().split('\n').pop())) : resolve(out))));
}

// ZIP: su Windows con tar.exe (bsdtar, incluso da Windows 10 1803), altrove con zip/unzip
async function zip(paths, destZip) {
  const dir = path.dirname(paths[0]);
  const names = paths.map((p) => path.basename(p));
  if (isWin) await run('tar.exe', ['-a', '-c', '-f', destZip, '-C', dir, ...names]);
  else await run('zip', ['-r', '-q', destZip, ...names], { cwd: dir });
  return destZip;
}
async function zipName(paths) {
  const dir = path.dirname(paths[0]);
  const base = paths.length === 1 ? splitExt(path.basename(paths[0]), false)[0] : 'Archivio';
  return path.join(dir, await freeName(dir, `${base}.zip`));
}
async function unzip(zipPath) {
  const dir = path.dirname(zipPath);
  const dest = path.join(dir, await freeName(dir, splitExt(path.basename(zipPath), false)[0], { isDir: true }));
  await fs.promises.mkdir(dest);
  if (isWin) await run('tar.exe', ['-x', '-f', zipPath, '-C', dest]);
  else await run('unzip', ['-q', zipPath, '-d', dest]);
  return dest;
}

// Appunti di Windows (elenco di file): lettura e scrittura tramite Windows PowerShell 5.1 (STA)
async function readClipboardFiles() {
  if (!isWin) return [];
  const ps = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }';
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { timeout: 5000 });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}
async function writeClipboardFiles(paths) {
  if (!isWin || !paths.length) return false;
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; @(${list}) | ForEach-Object { [void]$c.Add($_) }; [System.Windows.Forms.Clipboard]::SetFileDropList($c)`;
  try { await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { timeout: 5000 }); return true; } catch { return false; }
}

module.exports = { validName, freeName, mkdir, newFile, rename, copy, move, duplicate, zip, zipName, unzip, readClipboardFiles, writeClipboardFiles };
