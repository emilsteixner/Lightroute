import dgram from 'dgram';
import express, { Request, Response } from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { execFile } from 'child_process';

import { config as cfg, saveConfig, reloadConfig, CONFIG_PATH } from './config';
import type { LightrouteConfig, OutboundNodeConfig } from './config';

// ---------- Version & Identity ----------
const VERSION = '0.2.0';
const HOSTNAME = os.hostname();

// ---------- CLI / ENV ----------
const argv = new Set(process.argv.slice(2));
let verbose =
  argv.has('-v') ||
  argv.has('--verbose') ||
  /^(1|true)$/i.test(String(process.env.VERBOSE || ''));

const HEX_PREVIEW = (() => {
  const idx = process.argv.indexOf('--hex');
  const cliValue = idx >= 0 ? parseInt(process.argv[idx + 1] ?? '0', 10) : NaN;
  const envValue = parseInt(process.env.VERBOSE_HEX ?? '0', 10);
  const resolved = Number.isFinite(cliValue) ? cliValue : Number.isFinite(envValue) ? envValue : 0;
  return Math.max(0, resolved | 0);
})();

// ---------- Express / JSON ----------
const app = express();
app.use(express.json({ limit: '256kb' }));

// ---------- logging + SSE ----------
const LOG_LIMIT = 400;
const logBuffer: string[] = [];
const sseClients = new Set<Response>();

function now(): string {
  return new Date().toISOString();
}

function safeJSON(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function sse(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) {
    logBuffer.shift();
  }
  for (const res of sseClients) {
    res.write(`data: ${line}\n\n`);
  }
}

function log(message: string, meta?: unknown): void {
  const line = meta === undefined ? `[${now()}] ${message}` : `[${now()}] ${message} ${safeJSON(meta)}`;
  console.log(line);
  sse(line);
}

if (verbose) log('verbose=true (startup)');

app.get('/logs', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  for (const entry of logBuffer) {
    res.write(`data: ${entry}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ---------- UDP 6454 ----------
const LISTEN_PORT = 6454;
const LISTEN_ADDR = '0.0.0.0';
const server = dgram.createSocket('udp4');
const client = dgram.createSocket('udp4');

let lastInTs = 0;
let lastOutTs = 0;
let seqIn = 0;
let seqOut = 0;
const lastDMX: Record<string, Buffer> = Object.create(null);
const nodeActivity: Record<string, { last_out_ts: number; seq: number }> = Object.create(null);

type PingStateEntry = {
  index: number;
  ip: string;
  port: number;
  alive: boolean;
  rtt_ms: number | null;
  method: string;
};

let uplink = false;
let uplinkRtt: number | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let pingState: PingStateEntry[] = [];
let lastPingTs = 0;
let seqUplink = 0;
let lastUplinkTs = 0;

function bumpActivity(ip: string, port: number): void {
  const key = `${ip}:${port}`;
  const entry = nodeActivity[key] ?? { last_out_ts: 0, seq: 0 };
  entry.last_out_ts = Date.now();
  entry.seq = (entry.seq | 0) + 1;
  nodeActivity[key] = entry;
}

function isArtNet(buf: Buffer): boolean {
  return (
    buf.length >= 18 &&
    buf[0] === 0x41 &&
    buf[1] === 0x72 &&
    buf[2] === 0x74 &&
    buf[3] === 0x2d &&
    buf[4] === 0x4e &&
    buf[5] === 0x65 &&
    buf[6] === 0x74 &&
    buf[7] === 0x00
  );
}

function isOpDmx(buf: Buffer): boolean {
  return isArtNet(buf) && buf.readUInt16LE(8) === 0x5000;
}

interface DmxPacket {
  op: 'OpDmx';
  protVer: number;
  seq: number;
  phy: number;
  universe: number;
  len: number;
  data: Buffer;
}

function parseDmx(buf: Buffer): DmxPacket | null {
  if (!isOpDmx(buf) || buf.length < 18) return null;
  const protVer = buf.readUInt16BE(10);
  const seq = buf.readUInt8(12);
  const phy = buf.readUInt8(13);
  const universe = buf.readUInt16LE(14);
  const len = buf.readUInt16BE(16);
  const cappedLength = Math.min(len, Math.max(0, buf.length - 18));
  const data = Buffer.from(buf.subarray(18, 18 + cappedLength));
  return { op: 'OpDmx', protVer, seq, phy, universe, len: cappedLength, data };
}

function previewDMX(data: Buffer, n = 8): string {
  const limit = Math.min(n, data.length);
  const items: number[] = [];
  for (let i = 0; i < limit; i += 1) {
    items.push(data[i]!);
  }
  return items.join(',');
}

function hexPreview(buf: Buffer, n: number): string {
  if (!n) return '';
  const length = Math.min(n, buf.length);
  const parts: string[] = [];
  for (let i = 0; i < length; i += 1) {
    parts.push(buf[i]!.toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
  lastInTs = Date.now();
  seqIn += 1;

  if (verbose) {
    const parsed = parseDmx(msg);
    if (parsed) {
      const preview = previewDMX(parsed.data, 8);
      log(`[IN] ${rinfo.address}:${rinfo.port} u=${parsed.universe} len=${parsed.len} seq=${parsed.seq} ch1..8=${preview}`);
      if (HEX_PREVIEW) {
        log(`[IN-HEX ${Math.min(HEX_PREVIEW, msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
      }
    } else if (isArtNet(msg)) {
      const opCode = msg.readUInt16LE(8);
      const op = `0x${opCode.toString(16).padStart(4, '0')}`;
      log(`[IN] ${rinfo.address}:${rinfo.port} Art-Net op=${op} len=${msg.length}`);
      if (HEX_PREVIEW) {
        log(`[IN-HEX ${Math.min(HEX_PREVIEW, msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
      }
    } else {
      log(`[IN RAW] ${rinfo.address}:${rinfo.port} len=${msg.length}`);
      if (HEX_PREVIEW) {
        log(`[IN-HEX ${Math.min(HEX_PREVIEW, msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
      }
    }
  }

  const dmx = parseDmx(msg);
  if (!dmx && cfg.strict_artnet_only !== false) {
    if (verbose) log(`DROP non-OpDmx from ${rinfo.address}:${rinfo.port}`);
    return;
  }

  let universe = 0;
  let dmxLen = 0;
  let dmxData: Buffer | null = null;
  let seq = 0;

  if (dmx) {
    universe = dmx.universe;
    dmxLen = dmx.len;
    dmxData = dmx.data;
    seq = dmx.seq;
  }

  for (const node of cfg.outbound_nodes) {
    const port = node.port ?? 6454;
    const enabled = node.enabled !== false;
    if (!enabled) continue;

    if (dmx && Array.isArray(node.universes) && !node.universes.includes(universe)) {
      if (verbose) log(`DROP u=${universe} -> ${node.ip}:${port} (universe filtered)`);
      continue;
    }

    if (cfg.bandwidth_save && dmxData) {
      const key = `${node.ip}:${port}|${universe}`;
      const prev = lastDMX[key];
      if (prev && Buffer.compare(prev, dmxData) === 0) {
        if (verbose) log(`SKIP same dmx u=${universe} -> ${node.ip}:${port}`);
        continue;
      }
      lastDMX[key] = Buffer.from(dmxData);
    }

    client.send(msg, 0, msg.length, port, node.ip, (err: Error | null) => {
      if (err) {
        log(`OUT FAIL ${node.ip}:${port} - ${err.message}`);
        return;
      }

      lastOutTs = Date.now();
      seqOut += 1;
      if (dmx) bumpActivity(node.ip, port);

      if (!verbose) return;

      if (dmx) {
        const preview = previewDMX(dmx.data, 8);
        log(`[OUT] ${node.ip}:${port} u=${universe} len=${dmxLen} seq=${seq} ch1..8=${preview}`);
        if (HEX_PREVIEW) {
          log(`[OUT-HEX ${Math.min(HEX_PREVIEW, msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
        }
      } else {
        log(`[OUT RAW] ${node.ip}:${port} len=${msg.length}`);
        if (HEX_PREVIEW) {
          log(`[OUT-HEX ${Math.min(HEX_PREVIEW, msg.length)}B] ${hexPreview(msg, HEX_PREVIEW)}`);
        }
      }
    });
  }
});

server.on('error', (error) => log(`UDP server error: ${error.message}`));
server.bind(LISTEN_PORT, LISTEN_ADDR, () => log(`UDP server listening on ${LISTEN_ADDR}:${LISTEN_PORT}`));

// ---------- Reachability: ICMP + TCP fallback ----------
async function checkUplink(): Promise<void> {
  const result = await icmpPing('1.1.1.1', 2000);
  const wasUp = uplink;
  uplink = result.alive;
  uplinkRtt = result.rtt_ms;
  if (uplink) {
    seqUplink += 1;
    lastUplinkTs = Date.now();
  }
  if (verbose || wasUp !== uplink) {
    log(`[uplink] ${uplink ? 'OK' : 'DOWN'}${uplinkRtt !== null ? ` rtt=${uplinkRtt}ms` : ''}`);
  }
}

function icmpPing(host: string, timeoutMs = 1000): Promise<{ alive: boolean; rtt_ms: number | null }> {
  return new Promise((resolve) => {
    const platform = process.platform;
    let command = 'ping';
    let args: string[];

    if (platform === 'win32') {
      args = ['-n', '1', '-w', String(timeoutMs), host];
    } else {
      args = ['-n', '-c', '1', '-W', '1', host];
    }

    execFile(command, args, { timeout: timeoutMs + 500 }, (err, stdout = '') => {
      const alive = !err;
      let rtt: number | null = null;
      const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
      if (match && match[1]) rtt = Math.round(parseFloat(match[1]));
      resolve({ alive, rtt_ms: rtt });
    });
  });
}

function tcpProbe(host: string, port: number, timeoutMs = 900): Promise<{ alive: boolean; rtt_ms: number | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let settled = false;

    function finish(alive: boolean): void {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve({ alive, rtt_ms: alive ? Date.now() - started : null });
    }

    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish(true);
      else finish(false);
    });
  });
}

async function probeNode(host: string, port: number): Promise<{ alive: boolean; rtt_ms: number | null; method: string }> {
  const ic = await icmpPing(host, 1000);
  if (ic.alive) return { method: 'icmp', ...ic };
  const targetPort = port || 6454;
  const tp = await tcpProbe(host, targetPort, 900);
  return { method: tp.alive ? 'tcp' : 'none', ...tp };
}

async function sweepNodes(): Promise<void> {
  const entries = cfg.outbound_nodes.map((node, index) => ({ ...node, index }));
  const next: PingStateEntry[] = [];

  await Promise.all(
    entries.map(async (node) => {
      try {
        const port = node.port ?? 6454;
        const result = await probeNode(node.ip, port);
        next.push({ index: node.index, ip: node.ip, port, alive: result.alive, rtt_ms: result.rtt_ms, method: result.method });
      } catch {
        const port = node.port ?? 6454;
        next.push({ index: node.index, ip: node.ip, port, alive: false, rtt_ms: null, method: 'err' });
      }
    })
  );

  pingState = next;
  lastPingTs = Date.now();
  log('[ping] sweep', next);
}

function startPingLoop(): void {
  if (pingTimer) clearInterval(pingTimer);
  const sec = Math.max(5, Number(cfg.ping_interval_sec) || 30);
  log(`(re)start ping loop every ${sec}s`);
  checkUplink();
  sweepNodes();
  pingTimer = setInterval(() => {
    checkUplink();
    sweepNodes();
  }, sec * 1000);
}

// ---------- Watch external edits ----------
try {
  fs.watch(CONFIG_PATH, { persistent: true }, (eventType) => {
    if (eventType === 'change') {
      const before = JSON.stringify(cfg, null, 2);
      const after = JSON.stringify(reloadConfig(), null, 2);
      log(`[config-watch] reloaded from disk; changed=${before !== after}`);
      startPingLoop();
    }
  });
  log(`[config-watch] watching ${CONFIG_PATH}`);
} catch (error) {
  log(`[config-watch] failed to watch: ${(error as Error).message}`);
}

// ---------- HTTP API ----------
app.get('/config', (_req: Request, res: Response<LightrouteConfig>) => res.json(cfg));

app.post('/config', (req: Request<{}, {}, Partial<LightrouteConfig>>, res: Response) => {
  log('HTTP POST /config body', req.body ?? {});
  try {
    const saved = saveConfig(req.body ?? {});
    const diskRaw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
    const diskSha = diskRaw ? sha(diskRaw) : null;
    const memSha = sha(JSON.stringify(saved, null, 2));
    log(`/config post-commit verify diskSha=${diskSha} memSha=${memSha}`);
    startPingLoop();
    res.json(saved);
  } catch (error) {
    log('POST /config failed', error instanceof Error ? error.message : String(error));
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/verbose', (req: Request<{}, {}, { enabled?: boolean }>, res: Response<{ verbose: boolean }>) => {
  verbose = Boolean(req.body?.enabled);
  log(`verbose=${verbose}`);
  res.json({ verbose });
});

app.get('/status', (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    hostname: HOSTNAME,
    uplink,
    uplink_rtt: uplinkRtt,
    uplink_seq: seqUplink,
    artnet_in: Date.now() - lastInTs < 3000,
    artnet_in_seq: seqIn,
    artnet_out: Date.now() - lastOutTs < 3000,
    artnet_out_seq: seqOut,
    lastInTs,
    lastOutTs,
    lastUplinkTs,
    now: Date.now()
  });
});

app.get('/pings', (_req: Request, res: Response) => {
  res.json({
    ping_interval_sec: Math.max(5, Number(cfg.ping_interval_sec) || 30),
    updated_at: lastPingTs,
    list: pingState
  });
});

app.get('/ping', (_req: Request, res: Response) => {
  res.json({
    ping_interval_sec: Math.max(5, Number(cfg.ping_interval_sec) || 30),
    updated_at: lastPingTs,
    list: pingState
  });
});

app.get('/activity', (_req: Request, res: Response) => {
  const list = cfg.outbound_nodes.map((node) => {
    const port = node.port ?? 6454;
    const key = `${node.ip}:${port}`;
    const entry = nodeActivity[key] ?? { last_out_ts: 0, seq: 0 };
    return { ip: node.ip, port, last_out_ts: entry.last_out_ts, seq: entry.seq | 0 };
  });
  res.json({ now: Date.now(), list });
});

// ---------- Art-Net Sweep (test) ----------
const ARTNET_HEADER = Buffer.from('Art-Net\0', 'ascii');
const OPCODE_DMX = 0x5000;
const PROTOCOL_VERSION = 14;
const DMX_CHANNELS = 512;

type SweepTarget = { ip: string; port: number; universe: number };

type SweepResult = { success: boolean; targets?: number; error?: string };

function createArtDmxPacket(universe: number, dmxData: Buffer): Buffer {
  const buffer = Buffer.alloc(18 + dmxData.length);
  let offset = 0;
  ARTNET_HEADER.copy(buffer, offset);
  offset += 8;
  buffer.writeUInt16LE(OPCODE_DMX, offset);
  offset += 2;
  buffer.writeUInt16BE(PROTOCOL_VERSION, offset);
  offset += 2;
  buffer.writeUInt8(0, offset);
  offset += 1;
  buffer.writeUInt8(0, offset);
  offset += 1;
  buffer.writeUInt16LE(universe, offset);
  offset += 2;
  buffer.writeUInt16BE(dmxData.length, offset);
  offset += 2;
  dmxData.copy(buffer, offset);
  return buffer;
}

let sweepInProgress = false;

async function runSweep(): Promise<SweepResult> {
  if (sweepInProgress) {
    return { success: false, error: 'Sweep already in progress' };
  }
  sweepInProgress = true;
  log('[sweep] Starting ArtNet test sweep');

  const activeNodes = cfg.outbound_nodes.filter((node) => node.enabled !== false);
  if (activeNodes.length === 0) {
    sweepInProgress = false;
    log('[sweep] No enabled nodes found');
    return { success: false, error: 'No enabled outbound nodes' };
  }

  const targets: SweepTarget[] = [];
  for (const node of activeNodes) {
    const port = node.port ?? 6454;
    if (Array.isArray(node.universes)) {
      if (node.universes.length === 0) {
        log(`[sweep] Skipping ${node.ip}:${port} - empty universes array (blocks all)`);
        continue;
      }
      for (const universe of node.universes) {
        targets.push({ ip: node.ip, port, universe });
      }
    } else {
      targets.push({ ip: node.ip, port, universe: 0 });
    }
  }

  if (targets.length === 0) {
    sweepInProgress = false;
    log('[sweep] No valid targets');
    return { success: false, error: 'No valid targets' };
  }

  log(`[sweep] ${targets.length} target(s): ${targets.map((t) => `${t.ip}:${t.port}/u${t.universe}`).join(', ')}`);

  const SWEEP_DURATION_MS = 1000;
  const FRAME_RATE = 40;
  const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;
  const TOTAL_FRAMES = Math.floor(SWEEP_DURATION_MS / FRAME_INTERVAL_MS);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let frame = 0; frame <= TOTAL_FRAMES; frame += 1) {
    const value = Math.min(255, Math.floor((frame / TOTAL_FRAMES) * 255));
    const dmxData = Buffer.alloc(DMX_CHANNELS, value);

    for (const target of targets) {
      const packet = createArtDmxPacket(target.universe, dmxData);
      client.send(packet, 0, packet.length, target.port, target.ip, (err) => {
        if (err) {
          log(`[sweep] Send error to ${target.ip}:${target.port} - ${err.message}`);
        } else {
          lastOutTs = Date.now();
          seqOut += 1;
          bumpActivity(target.ip, target.port);
        }
      });
    }

    if (frame < TOTAL_FRAMES) {
      await sleep(FRAME_INTERVAL_MS);
    }
  }

  log('[sweep] Sweep complete, resetting to 0');

  const zeroData = Buffer.alloc(DMX_CHANNELS, 0);
  for (const target of targets) {
    const packet = createArtDmxPacket(target.universe, zeroData);
    client.send(packet, 0, packet.length, target.port, target.ip, (err) => {
      if (!err) {
        lastOutTs = Date.now();
        seqOut += 1;
        bumpActivity(target.ip, target.port);
      }
    });
  }

  await sleep(100);
  sweepInProgress = false;
  log('[sweep] Done');
  return { success: true, targets: targets.length };
}

app.post('/sweep', async (_req: Request, res: Response) => {
  try {
    const result = await runSweep();
    res.json(result);
  } catch (error) {
    log(`[sweep] Error: ${(error as Error).message}`);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/sweep/status', (_req: Request, res: Response) => {
  res.json({ in_progress: sweepInProgress });
});

// ---------- Static UI ----------
app.use(express.static(path.resolve(__dirname, '../public')));

app.listen(cfg.http_port, '0.0.0.0', () => {
  log(`HTTP listening on 0.0.0.0:${cfg.http_port}`);
  startPingLoop();
});

function sha(value: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(value);
  return hash.digest('hex').slice(0, 12);
}
