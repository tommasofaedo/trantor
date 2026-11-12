#!/usr/bin/env node
// Controllo rapido: sintassi di tutti i file JS e validità dei JSON.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|json)$/.test(e.name) && e.name !== 'package-lock.json') targets.push(p);
  }
})(root);

let failed = 0;
for (const f of targets) {
  try {
    if (f.endsWith('.json')) JSON.parse(fs.readFileSync(f, 'utf8'));
    else execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${path.relative(root, f)}\n${(err.stderr || err.message).toString()}`);
  }
}
console.log(failed ? `${failed} file con errori` : `✓ ${targets.length} file OK`);
process.exit(failed ? 1 : 0);
