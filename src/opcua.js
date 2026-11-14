/* Trantor — esploratore OPC UA (sola lettura, connessione anonima senza cifratura)
   connect → browse (un livello alla volta) → watch (valori in tempo reale tramite sottoscrizione) → disconnect */
'use strict';

const path = require('path');

let UA = null; // caricato solo al primo uso: l'avvio dell'app resta veloce
function lib() {
  if (!UA) {
    UA = {
      ...require('node-opcua-client'),
      ...require('node-opcua-variant'),
      ...require('node-opcua-certificate-manager'),
    };
  }
  return UA;
}

const sessions = new Map(); // key -> { client, session, sub, items: Map(nodeId -> monitoredItem), url }
let certManager = null;

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: nessuna risposta entro ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

// Messaggi comprensibili per gli errori più comuni
function friendly(err) {
  const m = String((err && err.message) || err);
  if (/ECONNREFUSED/.test(m)) return 'Connessione rifiutata: nessun server OPC UA su questa porta';
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'Dispositivo non raggiungibile';
  if (/BadIdentityTokenInvalid|BadIdentityTokenRejected|BadUserAccessDenied|anonymous/i.test(m)) return 'Il server non accetta connessioni anonime (serve utente e password)';
  if (/BadSecurityPolicyRejected|SecurityPolicy|securityMode|endpoint.*not found|cannot find endpoint/i.test(m)) return 'Il server richiede una connessione cifrata con certificato: per ora sono supportate solo le connessioni senza cifratura';
  if (/BadCertificate/.test(m)) return 'Il server non ha accettato il certificato di Trantor';
  if (/BadTooManySessions/.test(m)) return 'Il server ha già troppe sessioni aperte';
  return m.split('\n')[0].slice(0, 300);
}

function nodeClassName(nc) {
  const { NodeClass } = lib();
  return NodeClass[nc] || String(nc);
}

// Valore leggibile per l'interfaccia
function fmtValue(variant) {
  const { DataType, VariantArrayType } = lib();
  if (!variant || variant.dataType === DataType.Null) return { text: '', type: '' };
  const typeName = DataType[variant.dataType] || 'Valore';
  const one = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(7));
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().replace('T', ' ').replace('Z', '');
    if (Buffer.isBuffer(v)) return v.length > 32 ? `${v.subarray(0, 32).toString('hex')}… (${v.length} byte)` : v.toString('hex');
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') return (BigInt(v[0]) * 4294967296n + BigInt(v[1] >>> 0)).toString(); // Int64/UInt64
    if (v.text !== undefined) return String(v.text || '');           // LocalizedText
    if (v.name !== undefined && v.namespaceIndex !== undefined) return v.name; // QualifiedName
    if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) return v.toString();
    try { return JSON.stringify(v).slice(0, 200); } catch { return '(struttura)'; }
  };
  if (variant.arrayType !== VariantArrayType.Scalar) {
    const arr = Array.from(variant.value || []);
    const shown = arr.slice(0, 20).map(one).join(', ');
    return { text: `[${shown}${arr.length > 20 ? `, … (${arr.length})` : ''}]`, type: `${typeName}[${arr.length}]` };
  }
  return { text: one(variant.value), type: typeName };
}

function fmtDataValue(dv) {
  const { StatusCodes } = lib();
  if (!dv) return { text: '', type: '', bad: 'nessun valore' };
  const good = dv.statusCode && (dv.statusCode.value === StatusCodes.Good.value || dv.statusCode.isGood?.());
  if (!good && dv.statusCode && dv.statusCode.value >>> 30 === 2) return { text: '', type: '', bad: dv.statusCode.name };
  return { ...fmtValue(dv.value), bad: null };
}

async function getCertManager(dataDir) {
  if (certManager) return certManager;
  const { OPCUACertificateManager } = lib();
  certManager = new OPCUACertificateManager({ rootFolder: path.join(dataDir, 'opcua-pki'), automaticallyAcceptUnknownCertificate: true });
  await certManager.initialize();
  return certManager;
}

async function connect({ ip, port, dataDir }) {
  const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = lib();
  const key = `${ip}:${port}`;
  await disconnect(key);
  const url = `opc.tcp://${ip}:${port}`;
  const client = OPCUAClient.create({
    applicationName: 'Trantor',
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false, // il server spesso annuncia il proprio nome host invece dell'IP
    keepSessionAlive: true,
    requestedSessionTimeout: 60000,
    connectionStrategy: { maxRetry: 0, initialDelay: 500, maxDelay: 2000 },
    clientCertificateManager: await getCertManager(dataDir),
  });
  const entry = { client, session: null, sub: null, items: new Map(), url, onValues: null };
  sessions.set(key, entry);
  try {
    await withTimeout(client.connect(url), 8000, 'Connessione');
    entry.session = await withTimeout(client.createSession(), 8000, 'Apertura sessione');
  } catch (err) {
    await disconnect(key);
    throw new Error(friendly(err));
  }
  let server = '';
  try {
    const dv = await entry.session.read({ nodeId: 'i=2261' }); // Server_ServerStatus_BuildInfo_ProductName
    server = dv && dv.value && dv.value.value ? String(dv.value.value) : '';
  } catch {}
  client.on('connection_lost', () => { if (entry.onValues) entry.onValues({ lost: true }); });
  client.on('connection_reestablished', () => { if (entry.onValues) entry.onValues({ lost: false }); });
  return { key, url, server };
}

// Figli di un nodo: oggetti/cartelle e variabili, con valore iniziale delle variabili
async function browse(key, nodeId) {
  const { BrowseDirection, NodeClassMask, AttributeIds, StatusCodes } = lib();
  const e = sessions.get(key);
  if (!e || !e.session) throw new Error('Sessione chiusa: riconnettiti');
  let r = await withTimeout(e.session.browse({
    nodeId: nodeId || 'i=85', // ObjectsFolder
    referenceTypeId: 'HierarchicalReferences',
    includeSubtypes: true,
    browseDirection: BrowseDirection.Forward,
    nodeClassMask: NodeClassMask.Object | NodeClassMask.Variable,
    resultMask: 63,
  }), 10000, 'Lettura dei nodi');
  if (r.statusCode && r.statusCode.value !== StatusCodes.Good.value) throw new Error(friendly(r.statusCode.name));
  let refs = r.references || [];
  // i server con tanti nodi rispondono a pezzi
  let guard = 0;
  while (r.continuationPoint && refs.length < 5000 && guard++ < 50) {
    r = (await e.session.browseNext(r.continuationPoint, false));
    refs = refs.concat(r.references || []);
  }
  const seen = new Set();
  const items = [];
  for (const ref of refs) {
    const id = ref.nodeId.toString();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      nodeId: id,
      name: (ref.displayName && ref.displayName.text) || (ref.browseName && ref.browseName.name) || id,
      kind: nodeClassName(ref.nodeClass) === 'Variable' ? 'var' : 'obj',
      folder: ref.typeDefinition && ref.typeDefinition.toString() === 'ns=0;i=61',
    });
  }
  // valore iniziale delle variabili, in blocchi
  const vars = items.filter((x) => x.kind === 'var');
  for (let i = 0; i < vars.length; i += 200) {
    const chunk = vars.slice(i, i + 200);
    try {
      const dvs = await withTimeout(e.session.read(chunk.map((v) => ({ nodeId: v.nodeId, attributeId: AttributeIds.Value }))), 10000, 'Lettura dei valori');
      dvs.forEach((dv, k) => Object.assign(chunk[k], fmtDataValue(dv)));
    } catch (err) { chunk.forEach((v) => { v.bad = friendly(err); }); }
  }
  // cartelle e oggetti prima, poi variabili; il nodo "Server" (diagnostica standard) in fondo
  items.sort((a, b) => (a.nodeId === 'ns=0;i=2253') - (b.nodeId === 'ns=0;i=2253') || (a.kind === 'var') - (b.kind === 'var') || a.name.localeCompare(b.name, 'it', { numeric: true }));
  return items;
}

// Sottoscrive i valori delle variabili visibili (sostituisce l'elenco precedente)
async function watch(key, nodeIds, onValues) {
  const { ClientMonitoredItem, AttributeIds, TimestampsToReturn } = lib();
  const e = sessions.get(key);
  if (!e || !e.session) return;
  e.onValues = onValues;
  if (!e.sub) {
    e.sub = await e.session.createSubscription2({
      requestedPublishingInterval: 500, requestedLifetimeCount: 600, requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 1000, publishingEnabled: true, priority: 10,
    });
  }
  const want = new Set(nodeIds.slice(0, 1000));
  for (const [id, mi] of e.items) if (!want.has(id)) { e.items.delete(id); mi.terminate().catch(() => {}); }
  for (const id of want) {
    if (e.items.has(id)) continue;
    const mi = ClientMonitoredItem.create(e.sub, { nodeId: id, attributeId: AttributeIds.Value },
      { samplingInterval: 500, discardOldest: true, queueSize: 1 }, TimestampsToReturn.Neither);
    mi.on('changed', (dv) => { if (e.onValues) e.onValues({ nodeId: id, ...fmtDataValue(dv) }); });
    mi.on('err', () => {});
    e.items.set(id, mi);
  }
}

async function disconnect(key) {
  const e = sessions.get(key);
  if (!e) return;
  sessions.delete(key);
  e.onValues = null;
  try { if (e.sub) await withTimeout(e.sub.terminate(), 3000, 'chiusura'); } catch {}
  try { if (e.session) await withTimeout(e.session.close(), 3000, 'chiusura'); } catch {}
  try { await withTimeout(e.client.disconnect(), 3000, 'chiusura'); } catch {}
}

async function disconnectAll() { await Promise.all([...sessions.keys()].map(disconnect)); }

module.exports = { connect, browse, watch, disconnect, disconnectAll, fmtValue };
