#!/usr/bin/env node
// Test automatici (girano anche sulla CI Windows di GitHub)
'use strict';
const assert = require('assert');
const net = require('net');
const ns = require('../src/netscan.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); }
}

(async () => {
  await t('intervalli di indirizzi', () => {
    assert.strictEqual(ns.parseRange('192.168.1.0/24').length, 254);
    assert.deepStrictEqual(ns.parseRange('192.168.1.10-12'), ['192.168.1.10', '192.168.1.11', '192.168.1.12']);
    assert.deepStrictEqual(ns.parseRange('10.0.0.254-10.0.1.1'), ['10.0.0.254', '10.0.0.255', '10.0.1.0', '10.0.1.1']);
    assert.deepStrictEqual(ns.parseRange('172.16.5.9'), ['172.16.5.9']);
    assert.throws(() => ns.parseRange('10.0.0.0/8'));
    assert.throws(() => ns.parseRange('pippo'));
  });

  await t('schede di rete del PC', () => {
    const ifs = ns.interfaces();
    for (const i of ifs) assert.match(i.range, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
    console.log('  ', ifs.map((i) => `${i.name} ${i.address}/${i.bits} → ${i.range}`).join(' | ') || '(nessuna)');
  });

  await t('tabella ARP e gateway', async () => {
    const arp = await ns.arpTable();
    const gws = await ns.defaultGateways();
    for (const [ip, mac] of arp) { assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/); assert.match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/); }
    console.log(`   ${arp.size} voci ARP · gateway: ${[...gws].join(', ') || 'nessuno'}`);
  });

  await t('riconoscimento dei comandi ssh', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'transfer.js'), 'utf8');
    const body = src.slice(src.indexOf('const SSH_OPTS_WITH_ARG'), src.indexOf('function detectRemote'));
    const { parseSsh } = new Function(body + ';return { parseSsh }')();
    const t1 = parseSsh('ssh pi@10.0.0.5'); assert.strictEqual(t1.target, 'pi@10.0.0.5');
    const t2 = parseSsh('ssh -p 2200 -i C:\\keys\\id root@plc.lan'); assert.strictEqual(t2.port, '2200'); assert.strictEqual(t2.identity, 'C:\\keys\\id'); assert.strictEqual(t2.target, 'root@plc.lan');
    const t3 = parseSsh('ssh -J salto -l admin 192.168.1.1 uptime'); assert.strictEqual(t3.target, 'admin@192.168.1.1'); assert.strictEqual(t3.jump, 'salto');
    const t4 = parseSsh('ssh ssh://op@host:2022'); assert.strictEqual(t4.target, 'op@host'); assert.strictEqual(t4.port, '2022');
    const t5 = parseSsh('C:\\Windows\\System32\\OpenSSH\\ssh.exe -o StrictHostKeyChecking=no router'); assert.strictEqual(t5.target, 'router'); assert.deepStrictEqual(t5.options, ['StrictHostKeyChecking=no']);
    assert.strictEqual(parseSsh('git status'), null);
    assert.strictEqual(parseSsh('ssh -V'), null);
  });

  await t('operazioni sui file', async () => {
    const fo = require('../src/fileops.js');
    const fs = require('fs'); const path = require('path'); const os = require('os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trantor-test-'));
    try {
      const a = await fo.mkdir(root); const b = await fo.mkdir(root);
      assert.strictEqual(path.basename(a), 'Nuova cartella'); assert.strictEqual(path.basename(b), 'Nuova cartella (2)');
      const f = await fo.newFile(a, 'note.txt'); fs.writeFileSync(f, 'ciao');
      const d1 = await fo.duplicate(f); const d2 = await fo.duplicate(f);
      assert.strictEqual(path.basename(d1), 'note - Copia.txt'); assert.strictEqual(path.basename(d2), 'note - Copia (2).txt');
      const r = await fo.rename(d2, 'altro.txt'); assert.strictEqual(path.basename(r), 'altro.txt');
      await assert.rejects(fo.rename(r, 'note.txt'), /Esiste già/);
      await assert.rejects(fo.rename(r, process.platform === 'win32' ? 'a:b' : 'a/b'));
      const copied = await fo.copy([a], b); assert.ok(fs.existsSync(path.join(copied[0], 'note.txt')));
      await assert.rejects(fo.copy([a], path.join(a)), /dentro sé stessa/);
      await assert.rejects(fo.move([b], copied[0]), /dentro sé stessa/);
      const moved = await fo.move([r], b); assert.ok(fs.existsSync(moved[0]) && !fs.existsSync(r));
      const z = await fo.zip([f, d1], await fo.zipName([f, d1])); assert.strictEqual(path.basename(z), 'Archivio.zip');
      const x = await fo.unzip(z); assert.strictEqual(fs.readFileSync(path.join(x, 'note.txt'), 'utf8'), 'ciao');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  if (process.platform === 'win32') {
    await t('appunti di Windows con i file (informativo)', async () => {
      const fo = require('../src/fileops.js');
      const f = require('path').join(require('os').tmpdir(), 'trantor-appunti.txt');
      require('fs').writeFileSync(f, 'x');
      const w = await fo.writeClipboardFiles([f]);
      const r = await fo.readClipboardFiles();
      console.log(`   scrittura: ${w} · lettura: ${JSON.stringify(r)}`);
    });
  }

  // Dispositivo Modbus finto su localhost
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', (b) => {
      const fc = b[7]; const q = b.readUInt16BE(10);
      const head = (len) => { const h = Buffer.alloc(7); b.copy(h, 0, 0, 4); h.writeUInt16BE(len + 1, 4); h[6] = b[6]; return h; };
      if (fc === 3) { const d = Buffer.alloc(q * 2); for (let i = 0; i < q; i++) d.writeUInt16BE(1000 + i, i * 2); const pdu = Buffer.concat([Buffer.from([3, d.length]), d]); s.write(Buffer.concat([head(pdu.length), pdu])); }
      else { const pdu = Buffer.from([fc | 0x80, 1]); s.write(Buffer.concat([head(2), pdu])); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await t('lettura Modbus (holding register)', async () => {
    const r = await ns.modbusRead({ ip: '127.0.0.1', port, unit: 1, fc: 3, address: 0, quantity: 4 });
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.values, [1000, 1001, 1002, 1003]);
  });
  await t('eccezione Modbus', async () => {
    const r = await ns.modbusRead({ ip: '127.0.0.1', port, fc: 2, address: 0, quantity: 4 });
    assert.ok(!r.ok && /Eccezione Modbus 1/.test(r.error), JSON.stringify(r));
  });
  await t('scritture rifiutate', async () => {
    const r = await ns.modbusRead({ ip: '127.0.0.1', port, fc: 16, address: 0, quantity: 1 });
    assert.ok(!r.ok);
  });
  await t('scansione di localhost', async () => {
    const r = await ns.scan('127.0.0.1', {});
    assert.strictEqual(r.devices.length, 1);
    console.log('   tipo:', r.devices[0].type, '· servizi:', r.devices[0].services.map((s) => s.port).join(',') || 'nessuno');
  });
  server.close();

  console.log(failed ? `\n${failed} test falliti` : '\nTutti i test superati');
  process.exit(failed ? 1 : 0);
})();
