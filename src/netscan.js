// Trantor — scansione della rete locale e riconoscimento dei dispositivi.
// Tutte le richieste sono di sola lettura: connessioni TCP, intestazioni di benvenuto,
// identificazione Modbus (FC 43/14), ListIdentity EtherNet/IP, HEL di OPC UA, COTP di S7.
'use strict';

const net = require('net');
const os = require('os');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

const PORTS = [
  { port: 22, svc: 'ssh' }, { port: 23, svc: 'telnet' }, { port: 80, svc: 'http' }, { port: 443, svc: 'https' },
  { port: 102, svc: 's7' }, { port: 502, svc: 'modbus' }, { port: 1883, svc: 'mqtt' }, { port: 8883, svc: 'mqtts' },
  { port: 4840, svc: 'opcua' }, { port: 44818, svc: 'enip' }, { port: 2404, svc: 'iec104' }, { port: 20000, svc: 'dnp3' },
  { port: 48898, svc: 'ads' }, { port: 5900, svc: 'vnc' }, { port: 3389, svc: 'rdp' }, { port: 445, svc: 'smb' },
  { port: 8080, svc: 'http' }, { port: 8443, svc: 'https' }, { port: 9100, svc: 'printer' }, { port: 554, svc: 'rtsp' }
];

const INDUSTRIAL_VENDORS = ['siemens', 'phoenix contact', 'schneider', 'telemecanique', 'rockwell', 'allen-bradley', 'beckhoff',
  'wago', 'omron', 'mitsubishi', 'b&r', 'bernecker', 'pilz', 'festo', 'saia', 'exor', 'moxa', 'hirschmann', 'eaton', 'abb',
  'rexroth', 'turck', 'pepperl', 'weidm', 'advantech', 'unitronics', 'delta electronics', 'lenze', 'sick ag', 'ifm electronic',
  'yaskawa', 'fanuc', 'keyence', 'panasonic electric works', 'hms industrial', 'anybus', 'ewon', 'red lion', 'kunbus', 'inductive automation'];
const NETWORK_VENDORS = ['mikrotik', 'routerboard', 'ubiquiti', 'tp-link', 'cisco', 'netgear', 'avm', 'zyxel', 'juniper', 'fortinet',
  'aruba', 'draytek', 'teltonika', 'huawei', 'd-link', 'linksys', 'mercusys', 'tenda', 'sonicwall', 'meraki', 'ruckus'];
const CAMERA_VENDORS = ['hikvision', 'dahua', 'axis communications', 'hanwha', 'uniview', 'reolink', 'mobotix', 'vivotek'];

// ---------------------------------------------------------------------------
// Indirizzi
// ---------------------------------------------------------------------------
const ip2n = (ip) => ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const maskBits = (mask) => mask.split('.').reduce((a, b) => a + (+b).toString(2).replace(/0/g, '').length, 0);
const isIPv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => +x <= 255);

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const bits = maskBits(a.netmask);
      // sulle reti più grandi di /24 si propone la /24 del PC (scansioni lunghe vanno chieste esplicitamente)
      const useBits = Math.max(bits, 24);
      const netN = (ip2n(a.address) & (useBits === 32 ? 0xffffffff : (~((1 << (32 - useBits)) - 1)) >>> 0)) >>> 0;
      out.push({ name, address: a.address, netmask: a.netmask, bits, mac: a.mac, range: `${n2ip(netN)}/${useBits}` });
    }
  }
  return out;
}

// "192.168.1.0/24", "192.168.1.10-50", "192.168.1.10-192.168.1.60", "192.168.1.7"
function parseRange(str) {
  const s = String(str || '').trim();
  let m;
  if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/)) && isIPv4(m[1])) {
    const bits = +m[2];
    if (bits < 20 || bits > 32) throw new Error('Usa una rete tra /20 e /32');
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    const base = (ip2n(m[1]) & mask) >>> 0;
    const size = 2 ** (32 - bits);
    if (size <= 2) return Array.from({ length: size }, (_, i) => n2ip(base + i));
    return Array.from({ length: size - 2 }, (_, i) => n2ip(base + 1 + i));
  }
  if ((m = s.match(/^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+(?:\.\d+\.\d+\.\d+)?)$/)) && isIPv4(m[1])) {
    const a = ip2n(m[1]);
    const b = m[2].includes('.') ? ip2n(m[2]) : ((a & 0xffffff00) >>> 0) + (+m[2]);
    if (b < a) throw new Error('Intervallo non valido');
    if (b - a > 4095) throw new Error('Intervallo troppo ampio (massimo 4096 indirizzi)');
    return Array.from({ length: b - a + 1 }, (_, i) => n2ip(a + i));
  }
  if (isIPv4(s)) return [s];
  throw new Error('Formato non riconosciuto: usa 192.168.1.0/24 oppure 192.168.1.10-50');
}

// ---------------------------------------------------------------------------
// Primitive di rete
// ---------------------------------------------------------------------------
function probe(ip, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const end = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.once('connect', () => end('open'));
    sock.once('timeout', () => end('timeout'));
    sock.once('error', (e) => end(e.code === 'ECONNREFUSED' ? 'closed' : 'timeout'));
    sock.connect(port, ip);
  });
}

// Apre una connessione, invia `payload` (opzionale) e raccoglie la risposta finché `enough(buf)` o timeout
function exchange(ip, port, payload, { timeout = 1500, max = 65536, enough } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const end = () => { if (done) return; done = true; sock.destroy(); resolve(buf.length ? buf : null); };
    sock.setTimeout(timeout, end);
    sock.once('error', end);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= max || (enough && enough(buf))) end(); });
    sock.once('close', end);
    sock.connect(port, ip, () => { if (payload) sock.write(payload); });
  });
}

const withTimeout = (p, ms, fallback = null) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// ---------------------------------------------------------------------------
// Riconoscimento dei servizi
// ---------------------------------------------------------------------------
async function sshBanner(ip, port) {
  const b = await exchange(ip, port, null, { timeout: 2000, enough: (x) => x.includes(10) });
  return b ? b.toString('latin1').split(/\r?\n/)[0].slice(0, 120) : null;
}

function httpInfo(ip, port, secure) {
  return new Promise((resolve) => {
    const lib = secure ? https : http;
    const req = lib.request({ host: ip, port, path: '/', method: 'GET', timeout: 2500, rejectUnauthorized: false,
      headers: { 'User-Agent': 'Trantor', Accept: 'text/html,*/*' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65536) res.destroy(); });
      const done = () => {
        const t = body.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
        resolve({ status: res.statusCode, server: res.headers.server || null,
          title: t ? t[1].replace(/\s+/g, ' ').trim() : null, location: res.headers.location || null });
      };
      res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Modbus TCP: FC 43 / MEI 14 (Read Device Identification), oggetti di base 0..2
const MB_OBJ = { 0: 'vendor', 1: 'product', 2: 'revision', 3: 'url', 4: 'productName', 5: 'model' };
async function modbusIdentify(ip, port) {
  for (const unit of [255, 1, 0]) {
    const req = Buffer.from([0x13, 0x37, 0, 0, 0, 5, unit, 0x2b, 0x0e, 0x01, 0x00]);
    const res = await exchange(ip, port, req, { timeout: 1500, enough: (b) => b.length >= 6 && b.length >= 6 + b.readUInt16BE(4) });
    if (!res || res.length < 9) continue;
    const fc = res[7];
    if (fc === 0xab) { if (unit === 0) return { supported: false, exception: res[8] }; continue; }
    if (fc !== 0x2b || res[8] !== 0x0e) continue;
    const n = res[13];
    const info = { unit };
    let o = 14;
    for (let i = 0; i < n && o + 2 <= res.length; i++) {
      const id = res[o], len = res[o + 1];
      const val = res.slice(o + 2, o + 2 + len).toString('latin1').replace(/\0/g, '').trim();
      if (MB_OBJ[id] && val) info[MB_OBJ[id]] = val;
      o += 2 + len;
    }
    return info;
  }
  return null;
}

// EtherNet/IP: ListIdentity (comando 0x63) via TCP
async function enipIdentify(ip, port) {
  const req = Buffer.alloc(24);
  req.writeUInt16LE(0x63, 0);
  const res = await exchange(ip, port, req, { timeout: 1500, enough: (b) => b.length >= 24 && b.length >= 24 + b.readUInt16LE(2) });
  if (!res || res.length < 24 + 2 + 4 + 34) return null;
  try {
    let o = 24;
    const count = res.readUInt16LE(o); o += 2;
    if (!count) return null;
    o += 4; // tipo e lunghezza dell'elemento
    o += 2 + 16; // versione protocollo + sockaddr
    const vendorId = res.readUInt16LE(o); o += 2;
    const deviceType = res.readUInt16LE(o); o += 2;
    const productCode = res.readUInt16LE(o); o += 2;
    const revision = `${res[o]}.${res[o + 1]}`; o += 2;
    o += 2; // stato
    const serial = res.readUInt32LE(o).toString(16).toUpperCase().padStart(8, '0'); o += 4;
    const nameLen = res[o]; o += 1;
    const productName = res.slice(o, o + nameLen).toString('latin1').trim();
    return { vendorId, deviceType, productCode, revision, serial, productName };
  } catch { return null; }
}

// OPC UA: messaggio HEL, il server risponde ACK
async function opcuaHello(ip, port) {
  const url = Buffer.from(`opc.tcp://${ip}:${port}`);
  const body = Buffer.alloc(20 + 4 + url.length);
  body.writeUInt32LE(0, 0); body.writeUInt32LE(65535, 4); body.writeUInt32LE(65535, 8); body.writeUInt32LE(0, 12); body.writeUInt32LE(0, 16);
  body.writeInt32LE(url.length, 20); url.copy(body, 24);
  const head = Buffer.alloc(8); head.write('HELF', 0, 'latin1'); head.writeUInt32LE(8 + body.length, 4);
  const res = await exchange(ip, port, Buffer.concat([head, body]), { timeout: 1500, enough: (b) => b.length >= 8 });
  if (!res) return null;
  const type = res.slice(0, 3).toString('latin1');
  return type === 'ACK' ? { endpoint: `opc.tcp://${ip}:${port}` } : type === 'ERR' ? { endpoint: `opc.tcp://${ip}:${port}`, error: true } : null;
}

// Siemens S7: richiesta di connessione COTP (TSAP rack 0, slot 1 e 2), risposta CC = 0xD0
async function s7Probe(ip, port) {
  for (const slot of [1, 2]) {
    const req = Buffer.from([3, 0, 0, 22, 17, 0xe0, 0, 0, 0, 1, 0, 0xc0, 1, 0x0a, 0xc1, 2, 1, 0, 0xc2, 2, 1, slot]);
    const res = await exchange(ip, port, req, { timeout: 1500, enough: (b) => b.length >= 6 });
    if (res && res[0] === 3 && res.length >= 6 && res[5] === 0xd0) return { cotp: true, slot };
  }
  return { cotp: false };
}

async function vncBanner(ip, port) {
  const b = await exchange(ip, port, null, { timeout: 1500, enough: (x) => x.length >= 12 });
  return b ? b.toString('latin1').trim().slice(0, 20) : null;
}

// ---------------------------------------------------------------------------
// ARP, gateway, produttore
// ---------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (e, out) => resolve(e ? '' : out)));
}

async function arpTable() {
  const map = new Map();
  if (isWin) {
    const out = await run('arp', ['-a']);
    for (const m of out.matchAll(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/gi)) map.set(m[1], m[2].replace(/-/g, ':').toLowerCase());
  } else {
    try {
      for (const line of fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 4 && f[2] === '0x2') map.set(f[0], f[3].toLowerCase());
      }
    } catch {}
  }
  for (const [ip, mac] of map) if (mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac === '00:00:00:00:00:00') map.delete(ip);
  return map;
}

async function defaultGateways() {
  const gws = new Set();
  if (isWin) {
    const out = await run('route', ['print', '-4', '0.0.0.0']);
    for (const m of out.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/gm)) gws.add(m[1]);
  } else {
    try {
      for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f[1] === '00000000' && f[2] && f[2] !== '00000000') {
          const h = f[2]; gws.add([h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((x) => parseInt(x, 16)).join('.'));
        }
      }
    } catch {}
  }
  return gws;
}

let OUI = null;
function vendorOf(mac) {
  if (!mac) return null;
  if (!OUI) { try { OUI = require('oui-data'); } catch { OUI = {}; } }
  const key = mac.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
  // indirizzi amministrati localmente (spesso casuali: telefoni, VM)
  if ((parseInt(key.slice(0, 2), 16) & 2) === 2) return 'Indirizzo MAC locale/casuale';
  const v = OUI[key];
  return v ? v.split('\n')[0].trim() : null;
}

function classify(dev) {
  const has = (s) => dev.services.some((x) => x.svc === s);
  const v = (dev.vendor || '').toLowerCase();
  if (dev.self) return 'self';
  if (has('s7') || has('modbus') || has('enip') || has('ads') || has('iec104') || has('dnp3') || has('opcua') || INDUSTRIAL_VENDORS.some((x) => v.includes(x))) return 'plc';
  if (dev.gateway || NETWORK_VENDORS.some((x) => v.includes(x))) return 'router';
  if (CAMERA_VENDORS.some((x) => v.includes(x)) || has('rtsp')) return 'camera';
  if (has('printer')) return 'printer';
  if (has('rdp') || has('smb')) return 'pc';
  if (has('ssh')) return 'server';
  return 'device';
}

// ---------------------------------------------------------------------------
// Scansione
// ---------------------------------------------------------------------------
let current = null;

async function scan(range, { onProgress, onDevice } = {}) {
  if (current) current.cancelled = true;
  const job = { cancelled: false };
  current = job;
  const hosts = parseRange(range);
  const ifs = interfaces();
  const selfIps = new Map(ifs.map((i) => [i.address, i.mac]));
  const gateways = await defaultGateways();
  const devices = new Map();
  const total = hosts.length * PORTS.length;
  let done = 0;
  const timeout = hosts.length > 512 ? 400 : 600;
  const tasks = [];
  for (const ip of hosts) for (const p of PORTS) tasks.push([ip, p]);
  let lastProgress = 0;
  const progress = (force) => {
    const now = Date.now();
    if (!force && now - lastProgress < 120) return;
    lastProgress = now;
    onProgress && onProgress({ done, total, found: devices.size, phase: 'porte' });
  };
  const touch = (ip) => {
    if (!devices.has(ip)) devices.set(ip, { ip, services: [], alive: true, self: selfIps.has(ip), gateway: gateways.has(ip) });
    return devices.get(ip);
  };
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length && !job.cancelled) {
      const [ip, p] = tasks[idx++];
      const r = await probe(ip, p.port, timeout);
      done++;
      if (r === 'open') touch(ip).services.push({ port: p.port, svc: p.svc });
      else if (r === 'closed') touch(ip);
      progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(256, tasks.length) }, worker));
  if (job.cancelled) return { cancelled: true, devices: [] };

  // Tabella ARP: le prove hanno risolto gli indirizzi anche dei dispositivi che non rispondono sulle porte
  const arp = await arpTable();
  const inRange = new Set(hosts);
  for (const [ip, mac] of arp) if (inRange.has(ip)) touch(ip).mac = mac;
  for (const [ip, mac] of selfIps) if (inRange.has(ip)) { const d = touch(ip); d.mac = mac; d.self = true; }

  // Arricchimento: nome, produttore, dettagli dei servizi
  onProgress && onProgress({ done: total, total, found: devices.size, phase: 'dettagli' });
  const list = [...devices.values()].sort((a, b) => ip2n(a.ip) - ip2n(b.ip));
  let i2 = 0;
  const enrich = async () => {
    while (i2 < list.length && !job.cancelled) {
      const d = list[i2++];
      d.vendor = vendorOf(d.mac);
      d.services.sort((a, b) => a.port - b.port);
      const jobs = [withTimeout(dns.reverse(d.ip).then((n) => n[0]).catch(() => null), 1500).then((n) => { if (n) d.hostname = n; })];
      for (const s of d.services) {
        if (s.svc === 'ssh') jobs.push(sshBanner(d.ip, s.port).then((x) => { s.banner = x; }));
        if (s.svc === 'http' || s.svc === 'https') jobs.push(httpInfo(d.ip, s.port, s.svc === 'https').then((x) => { if (x) Object.assign(s, x); }));
        if (s.svc === 'modbus') jobs.push(modbusIdentify(d.ip, s.port).then((x) => { s.ident = x; }));
        if (s.svc === 'enip') jobs.push(enipIdentify(d.ip, s.port).then((x) => { s.ident = x; }));
        if (s.svc === 'opcua') jobs.push(opcuaHello(d.ip, s.port).then((x) => { s.ident = x; }));
        if (s.svc === 's7') jobs.push(s7Probe(d.ip, s.port).then((x) => { s.ident = x; }));
        if (s.svc === 'vnc') jobs.push(vncBanner(d.ip, s.port).then((x) => { s.banner = x; }));
      }
      await withTimeout(Promise.all(jobs), 6000);
      d.type = classify(d);
      onDevice && onDevice(d);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, list.length) }, enrich));
  if (current === job) current = null;
  onProgress && onProgress({ done: total, total, found: list.length, phase: 'fine' });
  return { cancelled: job.cancelled, devices: list };
}

function cancel() { if (current) current.cancelled = true; }

// ---------------------------------------------------------------------------
// Lettura Modbus TCP (solo lettura: FC 1, 2, 3, 4)
// ---------------------------------------------------------------------------
const MB_EXC = { 1: 'funzione non supportata', 2: 'indirizzo non valido', 3: 'valore non valido', 4: 'errore del dispositivo',
  5: 'richiesta accettata, in elaborazione', 6: 'dispositivo occupato', 10: 'gateway: percorso non disponibile', 11: 'gateway: il dispositivo non risponde' };
let tid = 1;
async function modbusRead({ ip, port = 502, unit = 1, fc = 3, address = 0, quantity = 10 }) {
  fc = +fc; unit = +unit; address = +address; quantity = +quantity; port = +port;
  if (![1, 2, 3, 4].includes(fc)) return { ok: false, error: 'Sono consentite solo letture (funzioni 1, 2, 3, 4)' };
  const maxQ = fc <= 2 ? 2000 : 125;
  if (!isIPv4(ip)) return { ok: false, error: 'Indirizzo IP non valido' };
  if (!(unit >= 0 && unit <= 255)) return { ok: false, error: 'Unit ID tra 0 e 255' };
  if (!(address >= 0 && address <= 65535)) return { ok: false, error: 'Indirizzo tra 0 e 65535' };
  if (!(quantity >= 1 && quantity <= maxQ) || address + quantity > 65536) return { ok: false, error: `Quantità tra 1 e ${maxQ}` };
  const t = (tid = (tid + 1) & 0xffff);
  const req = Buffer.alloc(12);
  req.writeUInt16BE(t, 0); req.writeUInt16BE(0, 2); req.writeUInt16BE(6, 4); req[6] = unit; req[7] = fc;
  req.writeUInt16BE(address, 8); req.writeUInt16BE(quantity, 10);
  const started = Date.now();
  const res = await exchange(ip, port, req, { timeout: 2500, enough: (b) => b.length >= 6 && b.length >= 6 + b.readUInt16BE(4) });
  const ms = Date.now() - started;
  if (!res) return { ok: false, error: 'Nessuna risposta (dispositivo spento, porta chiusa o Unit ID errato)' };
  if (res.length < 9) return { ok: false, error: 'Risposta troppo corta' };
  if (res[7] === (fc | 0x80)) return { ok: false, error: `Eccezione Modbus ${res[8]}: ${MB_EXC[res[8]] || 'sconosciuta'}`, ms };
  if (res[7] !== fc) return { ok: false, error: 'Risposta inattesa' };
  const n = res[8];
  const data = res.slice(9, 9 + n);
  const values = [];
  if (fc <= 2) for (let i = 0; i < quantity; i++) values.push((data[i >> 3] >> (i & 7)) & 1);
  else for (let i = 0; i < quantity && i * 2 + 1 < data.length; i++) values.push(data.readUInt16BE(i * 2));
  return { ok: true, values, ms };
}

module.exports = { interfaces, parseRange, scan, cancel, modbusRead, arpTable, defaultGateways, PORTS };
