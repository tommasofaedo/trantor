/* Trantor — porte seriali (stile PuTTY)
   Una porta aperta si comporta come una shell: il pannello del terminale riceve testo e invia i tasti.
   Vista testo o esadecimale, ora su ogni riga, eco locale, terminatore di riga, registrazione su file,
   riconnessione automatica quando il convertitore USB viene scollegato e ricollegato. */
'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

let SP = null; // caricato solo al primo uso
function lib() { if (!SP) SP = require('serialport'); return SP; }

const DIM = '\x1b[2m', OFF = '\x1b[0m', TX = '\x1b[38;2;61;155;255m', WARN = '\x1b[38;2;247;196;0m', ERR = '\x1b[38;2;255;122;113m';

function comNumber(p) { const m = /(\d+)$/.exec(p || ''); return m ? +m[1] : 1e6; }

async function list() {
  let ports = [];
  try { ports = await lib().SerialPort.list(); } catch { ports = []; }
  return ports
    .map((p) => ({
      path: p.path,
      name: String(p.friendlyName || p.manufacturer || '').replace(/\s*\((COM\d+)\)\s*$/i, '').trim(),
      manufacturer: p.manufacturer || '',
      vid: p.vendorId || '',
      pid: p.productId || '',
      serial: p.serialNumber || '',
    }))
    .sort((a, b) => comNumber(a.path) - comNumber(b.path) || a.path.localeCompare(b.path));
}

const DEFAULTS = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', eol: 'cr', echo: false, hex: false, timestamps: false, lf: true };

function describe(c) {
  const par = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[c.parity] || 'N';
  return `${c.path} · ${c.baudRate} ${c.dataBits}${par}${c.stopBits}`;
}

function friendlyError(err, path) {
  const m = String((err && err.message) || err);
  if (/Access denied|EBUSY|resource busy|Permission denied/i.test(m)) return `${path} è occupata da un altro programma (o non hai i permessi)`;
  if (/File not found|ENOENT|cannot find|No such file/i.test(m)) return `${path} non è presente: collega il convertitore`;
  if (/baud/i.test(m)) return `Velocità non supportata da ${path}`;
  return m.split('\n')[0];
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function hexLine(bytes, dir) {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const ascii = Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
  const tag = dir === 'tx' ? `${TX}TX${OFF}` : `${DIM}RX${OFF}`;
  return `${DIM}${stamp()}${OFF} ${tag} ${dir === 'tx' ? TX : ''}${hex.padEnd(47)}${dir === 'tx' ? OFF : ''}  ${DIM}${ascii}${OFF}\r\n`;
}

// Converte "01 03 00 00 0A" / "0x01,0x03" / "0103000A" in byte
function parseHex(text) {
  const clean = String(text).replace(/0x/gi, '').replace(/[\s,;:-]+/g, '');
  if (!clean || /[^0-9a-f]/i.test(clean)) throw new Error('Usa solo cifre esadecimali, per esempio 01 03 00 00 00 0A');
  if (clean.length % 2) throw new Error('Numero di cifre dispari: ogni byte sono due cifre');
  return Buffer.from(clean, 'hex');
}

class SerialProc {
  constructor(cfg, { onState, log } = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.cfg.baudRate = +this.cfg.baudRate; this.cfg.dataBits = +this.cfg.dataBits; this.cfg.stopBits = +this.cfg.stopBits;
    this.onState = onState || (() => {});
    this.logErr = log || (() => {});
    this.pid = 0;
    this.port = null;
    this.closed = false;
    this.dataCbs = []; this.exitCbs = [];
    this.decoder = new StringDecoder('utf8');
    this.atLineStart = true;
    this.rx = []; this.rxTimer = null;
    this.logStream = null;
    this.lastErr = '';
    this.state = 'opening';
    setImmediate(() => this.open(true));
  }

  onData(cb) { this.dataCbs.push(cb); return { dispose: () => {} }; }
  onExit(cb) { this.exitCbs.push(cb); return { dispose: () => {} }; }
  emit(s) { if (s) for (const cb of this.dataCbs) cb(s); }
  note(msg, color = DIM) {
    this.flushRx();
    this.emit(`${this.atLineStart ? '' : '\r\n'}${color}[${msg}]${OFF}\r\n`);
    this.atLineStart = true;
  }
  setState(state, text) { this.state = state; this.onState({ state, text: text || '', info: describe(this.cfg), cfg: this.publicCfg() }); }
  publicCfg() { const { hex, timestamps, echo, eol, lf } = this.cfg; return { hex, timestamps, echo, eol, lf, logging: !!this.logStream }; }

  open(first) {
    if (this.closed) return;
    const c = this.cfg;
    let port;
    try {
      port = new (lib().SerialPort)({
        path: c.path, baudRate: c.baudRate, dataBits: c.dataBits, parity: c.parity, stopBits: c.stopBits,
        rtscts: c.flow === 'rtscts', xon: c.flow === 'xonxoff', xoff: c.flow === 'xonxoff', autoOpen: false,
      });
    } catch (err) { return this.failed(err, first); }
    port.on('data', (buf) => this.receive(buf));
    port.on('error', (err) => this.logErr('[seriale]', c.path, err));
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = null;
      if (this.closed) return;
      this.note(`${c.path} scollegata: in attesa che venga ricollegata…`, WARN);
      this.setState('wait', 'scollegata');
      this.retry();
    });
    port.open((err) => {
      if (this.closed) { if (!err) port.close(() => {}); return; }
      if (err) return this.failed(err, first);
      this.port = port;
      this.lastErr = '';
      this.note(first ? `Connesso a ${describe(c)} — chiudi il pannello per scollegarti` : `${c.path} ricollegata`, first ? DIM : TX);
      this.setState('open');
    });
  }

  failed(err, first) {
    const msg = friendlyError(err, this.cfg.path);
    if (msg !== this.lastErr) { this.note(`${msg}${first ? ' — riprovo ogni 2 secondi' : ''}`, ERR); this.lastErr = msg; }
    this.setState('wait', msg);
    this.retry();
  }
  retry() { clearTimeout(this.rt); if (!this.closed) this.rt = setTimeout(() => this.open(false), 2000); }

  receive(buf) {
    if (this.logStream) this.logStream.write(buf);
    if (this.cfg.hex) {
      // i byte che arrivano senza pause formano un "pacchetto": va a capo dopo 16 byte o dopo 30 ms di silenzio
      for (const b of buf) { this.rx.push(b); if (this.rx.length === 16) this.flushRx(); }
      clearTimeout(this.rxTimer);
      this.rxTimer = setTimeout(() => this.flushRx(), 30);
      return;
    }
    let s = this.decoder.write(buf);
    if (this.cfg.lf) s = s.replace(/\r?\n/g, '\r\n');
    this.emit(this.cfg.timestamps ? this.stampLines(s) : s);
    if (!this.cfg.timestamps && s) this.atLineStart = s.endsWith('\n');
  }
  flushRx() {
    clearTimeout(this.rxTimer);
    if (!this.rx.length) return;
    const bytes = this.rx; this.rx = [];
    this.emit(hexLine(bytes, 'rx'));
    this.atLineStart = true;
  }
  stampLines(s) {
    let out = '';
    for (const piece of s.split(/(?<=\n)/)) {
      if (!piece) continue;
      if (this.atLineStart) out += `${DIM}${stamp()}${OFF} `;
      out += piece;
      this.atLineStart = piece.endsWith('\n');
    }
    return out;
  }

  // tasti dal terminale
  write(data) {
    const eol = { cr: '\r', lf: '\n', crlf: '\r\n' }[this.cfg.eol] || '\r';
    const text = String(data).replace(/\r/g, eol);
    this.writeBytes(Buffer.from(text, 'utf8'), text);
  }
  writeBytes(buf, text) {
    if (!this.port) { this.note('Porta non collegata: dati non inviati', WARN); return false; }
    this.port.write(buf);
    if (this.cfg.hex) { this.flushRx(); this.emit(hexLine(buf, 'tx')); this.atLineStart = true; }
    else if (this.cfg.echo) { const e = (text != null ? text : buf.toString('latin1')).replace(/\r\n|\r|\n/g, '\r\n'); this.emit(`${TX}${e}${OFF}`); this.atLineStart = e.endsWith('\n'); }
    return true;
  }
  sendHex(text) { return this.writeBytes(parseHex(text)); }

  set(opts) {
    const before = this.cfg.hex;
    Object.assign(this.cfg, opts);
    if (before !== this.cfg.hex) { this.flushRx(); this.decoder = new StringDecoder('utf8'); this.note(this.cfg.hex ? 'Vista esadecimale' : 'Vista testo'); }
    this.setState(this.state, '');
  }
  setLog(file) {
    if (this.logStream) { this.logStream.end(); this.logStream = null; this.note('Registrazione terminata'); }
    if (file) { this.logStream = fs.createWriteStream(file, { flags: 'a' }); this.note(`Registrazione dei dati ricevuti in ${file}`); }
    this.setState(this.state, '');
  }
  resize() {}
  kill() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.rt); clearTimeout(this.rxTimer);
    if (this.logStream) { this.logStream.end(); this.logStream = null; }
    const p = this.port; this.port = null;
    if (p) { try { p.close(() => {}); } catch {} }
  }
}

function create(cfg, opts) { return new SerialProc(cfg, opts); }

module.exports = { list, create, parseHex, describe, DEFAULTS };
