// lightroute.js — verbose Art-Net logs, per-node activity, ping, SSE, config-watch
const dgram = require('dgram');
const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const cfg = require('./config'); // keep shared live object

// ---------- Version & Identity ----------
const VERSION = '0.1.0';
const HOSTNAME = os.hostname();

// ---------- CLI / ENV ----------
const argv = new Set(process.argv.slice(2));
let verbose =
  argv.has('-v') || argv.has('--verbose') ||
  /^(1|true)$/i.test(String(process.env.VERBOSE || ''));
const HEX_PREVIEW = (() => {
  const i = process.argv.indexOf('--hex');
  const n = i >= 0 ? parseInt(process.argv[i + 1] || '0', 10) : NaN;
  const env = parseInt(process.env.VERBOSE_HEX || '0', 10);
  const v = Number.isFinite(n) ? n : (Number.isFinite(env) ? env : 0);
  return Math.max(0, v | 0);
})();

// ---------- Express / JSON ----------
const app = express();
app.use(express.json({ limit: '256kb' }));

// ---------- logging + SSE ----------
const LOG_LIMIT = 400;
const logBuffer = [];
let sseClients = new Set();
function now(){ return new Date().toISOString(); }
function safeJSON(v){ try { return JSON.stringify(v); } catch { return '"[unserializable]"'; } }
function sse(line){ logBuffer.push(line); if (logBuffer.length>LOG_LIMIT) logBuffer.shift(); for (const r of sseClients) r.write(`data: ${line}\n\n`); }
function log(msg, obj){ const line = obj===undefined ? `[${now()}] ${msg}` : `[${now()}] ${msg} ${safeJSON(obj)}`; console.log(line); sse(line); }
if (verbose) log('verbose=true (startup)');

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  for (const l of logBuffer) res.write(`data: ${l}\n\n`);
  sseClients.add(res);
  req.on('close',()=>sseClients.delete(res));
});

// ---------- UDP 6454 ----------
const LISTEN_PORT = 6454, LISTEN_ADDR='0.0.0.0';
const server = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');

let lastInTs=0, lastOutTs=0;
let seqIn = 0, seqOut = 0;  // activity sequence counters for blinky LEDs
const lastDMX = Object.create(null);

// per-node TX activity (for blink)
const nodeActivity = Object.create(null); // key "ip:port" -> { last_out_ts, seq }
function bumpActivity(ip, port){
  const key = `${ip}:${port||6454}`;
  const item = nodeActivity[key] || { last_out_ts: 0, seq: 0 };
  item.last_out_ts = Date.now();
  item.seq = (item.seq|0) + 1;
  nodeActivity[key] = item;
}

function isArtNet(buf){
  return buf.length>=18 &&
    buf[0]===0x41 && buf[1]===0x72 && buf[2]===0x74 && buf[3]===0x2D &&
    buf[4]===0x4E && buf[5]===0x65 && buf[6]===0x74 && buf[7]===0x00;
}
function isOpDmx(buf){ return isArtNet(buf) && buf.readUInt16LE(8)===0x5000; }
function parseDmx(buf){
  if (!isOpDmx(buf)) return null;
  const protVer = (buf[10]<<8)|buf[11];
  const seq     = buf[12];
  const phy     = buf[13];
  const universe= buf.readUInt16LE(14);
  const len     = buf.readUInt16BE(16);
  const data    = buf.slice(18, 18 + Math.min(len, buf.length - 18));
  return { op:'OpDmx', protVer, seq, phy, universe, len, data };
}
function previewDMX(data, n=8){
  const m = Math.min(n, data.length); const out = new Array(m);
  for (let i=0;i<m;i++) out[i] = data[i];
  return out.join(',');
}
function hexPreview(buf, n){
  if (!n) return '';
  const m = Math.min(n, buf.length);
  let s = '';
  for (let i=0;i<m;i++){ const b = buf[i].toString(16).padStart(2,'0'); s += b + (i+1<m ? ' ' : ''); }
  return s;
}

server.on('message', (msg, rinfo) => {
  lastInTs = Date.now();
  seqIn++;

  // ---- verbose IN logging ----
  if (verbose) {
    const _dmx = parseDmx(msg);
    if (_dmx) {
      log(`[IN] ${rinfo.address}:${rinfo.port} u=${_dmx.universe} len=${_dmx.len} seq=${_dmx.seq} ch1..8=${previewDMX(_dmx.data,8)}`);
      if (HEX_PREVIEW) log(`[IN-HEX ${Math.min(HEX_PREVIEW,msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
    } else if (isArtNet(msg)) {
      const op = '0x' + msg.readUInt16LE(8).toString(16).padStart(4,'0');
      log(`[IN] ${rinfo.address}:${rinfo.port} Art-Net op=${op} len=${msg.length}`);
      if (HEX_PREVIEW) log(`[IN-HEX ${Math.min(HEX_PREVIEW,msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
    } else {
      log(`[IN RAW] ${rinfo.address}:${rinfo.port} len=${msg.length}`);
      if (HEX_PREVIEW) log(`[IN-HEX ${Math.min(HEX_PREVIEW,msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
    }
  }

  // ---- STRICT DMX ONLY: drop anything that's not OpDmx ----
  const dmx = parseDmx(msg);  // null if not OpDmx
  if (!dmx && (cfg.config.strict_artnet_only !== false)) {
    if (verbose) log(`DROP non-OpDmx from ${rinfo.address}:${rinfo.port}`);
    return;
  }

  // ---- parse once; declare once ----
  let universe = 0, dmxLen = 0, dmxData = null, seq = 0;
  if (dmx) { universe = dmx.universe; dmxLen = dmx.len; dmxData = dmx.data; seq = dmx.seq; }

  // ---- per-node forwarding ----
  for (const node of (cfg.config.outbound_nodes || [])) {
    if (!node.enabled) continue;

    // Universe filtering (apply ONLY for OpDmx):
    // - 'universes' present (even empty) => enforce
    // - 'universes' missing => allow all
    if (dmx && Array.isArray(node.universes) && !node.universes.includes(universe)) {
      if (verbose) log(`DROP u=${universe} -> ${node.ip}:${node.port||6454} (universe filtered)`);
      continue;
    }

    // Bandwidth-save (only for OpDmx)
    if (cfg.config.bandwidth_save && dmxData) {
      const key = `${node.ip}:${node.port||6454}|${universe}`;
      const prev = lastDMX[key];
      if (prev && Buffer.compare(prev, dmxData) === 0) {
        if (verbose) log(`SKIP same dmx u=${universe} -> ${node.ip}:${node.port||6454}`);
        continue;
      }
      lastDMX[key] = Buffer.from(dmxData);
    }

    client.send(msg, 0, msg.length, node.port || 6454, node.ip, (err) => {
      if (err) {
        log(`OUT FAIL ${node.ip}:${node.port||6454} - ${err.message}`);
      } else {
        lastOutTs = Date.now();
        seqOut++;
        // Activity LED ONLY for OpDmx forwards
        if (dmx) bumpActivity(node.ip, node.port || 6454);

        if (verbose) {
          if (dmx) {
            log(`[OUT] ${node.ip}:${node.port||6454} u=${universe} len=${dmxLen} seq=${seq} ch1..8=${previewDMX(dmx.data,8)}`);
            if (HEX_PREVIEW) log(`[OUT-HEX ${Math.min(HEX_PREVIEW,msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
          } else {
            // won't happen if strict_artnet_only !== false
            log(`[OUT RAW] ${node.ip}:${node.port||6454} len=${msg.length}`);
            if (HEX_PREVIEW) log(`[OUT-HEX ${Math.min(HEX_PREVIEW,msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
          }
        }
      }
    });
  }
});



server.on('error', (e)=>log(`UDP server error: ${e.message}`));
server.bind(LISTEN_PORT, LISTEN_ADDR, ()=>log(`UDP server listening on ${LISTEN_ADDR}:${LISTEN_PORT}`));

// ---------- Reachability: ICMP + TCP fallback ----------
let uplink=false, uplinkRtt=null, pingTimer=null, pingState=[], lastPingTs=0;
let seqUplink = 0, lastUplinkTs = 0;

async function checkUplink() {
  // Actually ping 1.1.1.1 to verify internet connectivity
  const result = await icmpPing('1.1.1.1', 2000);
  const wasUp = uplink;
  uplink = result.alive;
  uplinkRtt = result.rtt_ms;
  if (uplink) {
    seqUplink++;
    lastUplinkTs = Date.now();
  }
  if (verbose || wasUp !== uplink) {
    log(`[uplink] ${uplink ? 'OK' : 'DOWN'}${uplinkRtt !== null ? ' rtt=' + uplinkRtt + 'ms' : ''}`);
  }
}

function icmpPing(host, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const plat = process.platform;
    let cmd = 'ping', args;
    if (plat === 'win32') {
      args = ['-n', '1', '-w', String(timeoutMs), host];
    } else {
      // Linux/macOS/busybox: -c1 one probe, -W timeout sec (use 1s)
      args = ['-n', '-c', '1', '-W', '1', host];
    }
    execFile(cmd, args, { timeout: timeoutMs + 500 }, (err, stdout = '') => {
      const alive = !err;
      let rtt = null;
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/i);
      if (m) rtt = Math.round(parseFloat(m[1]));
      resolve({ alive, rtt_ms: rtt });
    });
  });
}

function tcpProbe(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.createConnection({ host, port, timeout: timeoutMs });
    let settled = false;
    function finish(alive) {
      if (settled) return; settled = true;
      try { s.destroy(); } catch {}
      resolve({ alive, rtt_ms: alive ? (Date.now() - t0) : null });
    }
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', (err) => {
      // Fast refusal proves reachability (host up, port reachable)
      if (err && err.code === 'ECONNREFUSED') finish(true);
      else finish(false);
    });
  });
}

async function probeNode(host, port) {
  const ic = await icmpPing(host, 1000);
  if (ic.alive) return { method: 'icmp', ...ic };
  const tp = await tcpProbe(host, port || 6454, 900);
  return { method: tp.alive ? 'tcp' : 'none', ...tp };
}

async function sweepNodes(){
  const items = (cfg.config.outbound_nodes || []).map((n,i)=>({...n,index:i}));
  const next = [];
  await Promise.all(items.map(async (n) => {
    try {
      const r = await probeNode(n.ip, n.port || 6454);
      next.push({ index:n.index, ip:n.ip, port:n.port||6454, alive:r.alive, rtt_ms:r.rtt_ms, method:r.method });
    } catch {
      next.push({ index:n.index, ip:n.ip, port:n.port||6454, alive:false, rtt_ms:null, method:'err' });
    }
  }));
  pingState = next;
  lastPingTs = Date.now();
  log('[ping] sweep', next);
}

function startPingLoop(){
  if (pingTimer) clearInterval(pingTimer);
  const sec = Math.max(5, Number(cfg.config.ping_interval_sec)||30);
  log(`(re)start ping loop every ${sec}s`);
  checkUplink(); sweepNodes();
  pingTimer = setInterval(()=>{ checkUplink(); sweepNodes(); }, sec*1000);
}

// ---------- Watch external edits ----------
try {
  fs.watch(cfg.CONFIG_PATH, { persistent:true }, (ev)=>{
    if (ev==='change') {
      const before = JSON.stringify(cfg.config,null,2);
      const after  = JSON.stringify(cfg.reloadConfig(),null,2);
      log(`[config-watch] reloaded from disk; changed=${before!==after}`);
      startPingLoop();
    }
  });
  log('[config-watch] watching ' + cfg.CONFIG_PATH);
} catch(e){ log('[config-watch] failed to watch: ' + e.message); }

// ---------- HTTP API ----------
app.get('/config', (_req,res)=>res.json(cfg.config));
app.post('/config', (req,res)=>{
  log('HTTP POST /config body', req.body||{});
  try {
    const saved = cfg.saveConfig(req.body||{});
    const diskRaw = fs.existsSync(cfg.CONFIG_PATH) ? fs.readFileSync(cfg.CONFIG_PATH,'utf8') : null;
    const diskSha = diskRaw ? sha(diskRaw) : null;
    const memSha  = sha(JSON.stringify(saved,null,2));
    log(`/config post-commit verify diskSha=${diskSha} memSha=${memSha}`);
    startPingLoop();
    res.json(saved);
  } catch(e){
    log('POST /config failed', e.message);
    res.status(400).json({ error: e.message });
  }
});
app.post('/verbose', (req,res)=>{ verbose=!!(req.body&&req.body.enabled); log(`verbose=${verbose}`); res.json({verbose}); });

app.get('/status', (_req,res)=>res.json({
  version: VERSION,
  hostname: HOSTNAME,
  uplink,
  uplink_rtt: uplinkRtt,
  uplink_seq: seqUplink,
  artnet_in: (Date.now()-lastInTs)<3000,
  artnet_in_seq: seqIn,
  artnet_out: (Date.now()-lastOutTs)<3000,
  artnet_out_seq: seqOut,
  lastInTs, lastOutTs, lastUplinkTs, now: Date.now()
}));

app.get('/pings', (_req,res)=>res.json({
  ping_interval_sec: Math.max(5, Number(cfg.config.ping_interval_sec)||30),
  updated_at: lastPingTs,
  list: pingState            // { ip,port,alive,rtt_ms,method }
}));
app.get('/ping',  (_req,res)=>res.json({
  ping_interval_sec: Math.max(5, Number(cfg.config.ping_interval_sec)||30),
  updated_at: lastPingTs,
  list: pingState
}));

app.get('/activity', (_req,res)=>{
  const list = (cfg.config.outbound_nodes||[]).map(n => {
    const key = `${n.ip}:${n.port||6454}`;
    const entry = nodeActivity[key] || { last_out_ts: 0, seq: 0 };
    return { ip: n.ip, port: n.port||6454, last_out_ts: entry.last_out_ts, seq: entry.seq|0 };
  });
  res.json({ now: Date.now(), list });
});

// ---------- Art-Net Sweep (test) ----------
const ARTNET_HEADER = Buffer.from('Art-Net\0', 'ascii');
const OPCODE_DMX = 0x5000;
const PROTOCOL_VERSION = 14;
const DMX_CHANNELS = 512;

function createArtDmxPacket(universe, dmxData) {
  const buffer = Buffer.alloc(18 + dmxData.length);
  let offset = 0;
  ARTNET_HEADER.copy(buffer, offset); offset += 8;
  buffer.writeUInt16LE(OPCODE_DMX, offset); offset += 2;
  buffer.writeUInt16BE(PROTOCOL_VERSION, offset); offset += 2;
  buffer.writeUInt8(0, offset); offset += 1; // sequence
  buffer.writeUInt8(0, offset); offset += 1; // physical
  buffer.writeUInt16LE(universe, offset); offset += 2;
  buffer.writeUInt16BE(dmxData.length, offset); offset += 2;
  dmxData.copy(buffer, offset);
  return buffer;
}

let sweepInProgress = false;

async function runSweep() {
  if (sweepInProgress) {
    return { success: false, error: 'Sweep already in progress' };
  }
  sweepInProgress = true;
  log('[sweep] Starting ArtNet test sweep');

  const activeNodes = (cfg.config.outbound_nodes || []).filter(n => n.enabled);
  if (activeNodes.length === 0) {
    sweepInProgress = false;
    log('[sweep] No enabled nodes found');
    return { success: false, error: 'No enabled outbound nodes' };
  }

  // Build targets - respect universe filtering
  const targets = [];
  for (const node of activeNodes) {
    // If universes array exists but is empty, skip this node (blocks all)
    // If universes array exists and has values, use those
    // If universes is undefined/missing, default to universe 0
    if (Array.isArray(node.universes)) {
      if (node.universes.length === 0) {
        log(`[sweep] Skipping ${node.ip}:${node.port || 6454} - empty universes array (blocks all)`);
        continue;
      }
      for (const universe of node.universes) {
        targets.push({ ip: node.ip, port: node.port || 6454, universe });
      }
    } else {
      // No universes defined = allow all, default to universe 0 for sweep
      targets.push({ ip: node.ip, port: node.port || 6454, universe: 0 });
    }
  }

  if (targets.length === 0) {
    sweepInProgress = false;
    log('[sweep] No valid targets');
    return { success: false, error: 'No valid targets' };
  }

  log(`[sweep] ${targets.length} target(s): ${targets.map(t => `${t.ip}:${t.port}/u${t.universe}`).join(', ')}`);

  const SWEEP_DURATION_MS = 1000;
  const FRAME_RATE = 40;
  const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;
  const TOTAL_FRAMES = Math.floor(SWEEP_DURATION_MS / FRAME_INTERVAL_MS);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Sweep 0 -> 255
  for (let frame = 0; frame <= TOTAL_FRAMES; frame++) {
    const value = Math.min(255, Math.floor((frame / TOTAL_FRAMES) * 255));
    const dmxData = Buffer.alloc(DMX_CHANNELS, value);

    for (const target of targets) {
      const packet = createArtDmxPacket(target.universe, dmxData);
      client.send(packet, 0, packet.length, target.port, target.ip, (err) => {
        if (err) {
          log(`[sweep] Send error to ${target.ip}:${target.port} - ${err.message}`);
        } else {
          lastOutTs = Date.now();
          seqOut++;
          bumpActivity(target.ip, target.port);
        }
      });
    }
    if (frame < TOTAL_FRAMES) await sleep(FRAME_INTERVAL_MS);
  }

  log('[sweep] Sweep complete, resetting to 0');

  // Reset to 0
  const zeroData = Buffer.alloc(DMX_CHANNELS, 0);
  for (const target of targets) {
    const packet = createArtDmxPacket(target.universe, zeroData);
    client.send(packet, 0, packet.length, target.port, target.ip, (err) => {
      if (!err) {
        lastOutTs = Date.now();
        seqOut++;
        bumpActivity(target.ip, target.port);
      }
    });
  }

  await sleep(100);
  sweepInProgress = false;
  log('[sweep] Done');
  return { success: true, targets: targets.length };
}

app.post('/sweep', async (req, res) => {
  try {
    const result = await runSweep();
    res.json(result);
  } catch (e) {
    log(`[sweep] Error: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/sweep/status', (req, res) => {
  res.json({ in_progress: sweepInProgress });
});

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname,'public')));

app.listen(cfg.config.http_port, ()=>{ log(`HTTP listening on 0.0.0.0:${cfg.config.http_port}`); startPingLoop(); });

function sha(x){ const h=crypto.createHash('sha256'); h.update(x); return h.digest('hex').slice(0,12); }
