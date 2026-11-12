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
