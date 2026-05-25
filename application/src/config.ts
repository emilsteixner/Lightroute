import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface OutboundNodeConfig {
  ip: string;
  port?: number;
  enabled?: boolean;
  universes?: number[];
}

export interface LightrouteConfig {
  http_port: number;
  ping_interval_sec: number;
  bandwidth_save: boolean;
  strict_artnet_only: boolean;
  outbound_nodes: OutboundNodeConfig[];
}

const CONFIG_PATH = path.resolve(__dirname, '../config.json');
const TMP_PATH = CONFIG_PATH + '.tmp';

const DEFAULTS: LightrouteConfig = {
  http_port: 3000,
  ping_interval_sec: 30,
  bandwidth_save: false,
  strict_artnet_only: true,
  outbound_nodes: []
};

const config: LightrouteConfig = { ...DEFAULTS };

function now(): string {
  return new Date().toISOString();
}

function log(message: string, meta?: unknown): void {
  if (meta !== undefined) {
    console.log(`${now()} [config] ${message}`, meta);
  } else {
    console.log(`${now()} [config] ${message}`);
  }
}

function sha12(value: string | Buffer): string {
  const hash = crypto.createHash('sha256');
  hash.update(value);
  return hash.digest('hex').slice(0, 12);
}

function overwriteConfig(target: LightrouteConfig, source: LightrouteConfig): void {
  (Object.keys(target) as (keyof LightrouteConfig)[]).forEach((key) => {
    delete target[key];
  });
  Object.assign(target, source);
}

function sanitize(raw: Partial<LightrouteConfig> | undefined): LightrouteConfig {
  const safeNodes: OutboundNodeConfig[] = Array.isArray(raw?.outbound_nodes)
    ? raw!.outbound_nodes
        .map((node) => {
          if (!node) return null;
          const ip = String(node.ip || '').trim();
          if (!ip) return null;

          const port = Number(node.port) || 6454;
          const enabled = node.enabled !== false;

          const universes = Array.isArray(node.universes)
            ? node.universes
                .map((u) => Number(u))
                .filter((u) => Number.isInteger(u) && u >= 0 && u <= 32767)
            : undefined;

          const normalized: OutboundNodeConfig = { ip, port, enabled };
          if (universes !== undefined) {
            normalized.universes = universes;
          }
          return normalized;
        })
        .filter((node): node is OutboundNodeConfig => node !== null)
    : [];

  const httpPort = Number(raw?.http_port) || DEFAULTS.http_port;
  const pingInterval = Math.max(5, Number(raw?.ping_interval_sec) || DEFAULTS.ping_interval_sec);
  const bandwidthSave = Boolean(raw?.bandwidth_save);
  const strictArtNetOnly = raw?.strict_artnet_only === false ? false : true;

  return {
    http_port: httpPort,
    ping_interval_sec: pingInterval,
    bandwidth_save: bandwidthSave,
    strict_artnet_only: strictArtNetOnly,
    outbound_nodes: safeNodes
  };
}

function readConfigFromDisk(): LightrouteConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    log(`read config.json ok sha=${sha12(raw)} size=${raw.length}`);
    return sanitize(JSON.parse(raw));
  } catch (error) {
    return { ...DEFAULTS };
  }
}

function writeAtomic(data: LightrouteConfig): void {
  const json = JSON.stringify(data, null, 2);
  const sha = sha12(json);
  log(`writeAtomic start sha=${sha} size=${json.length}`);

  fs.writeFileSync(TMP_PATH, json, { mode: 0o644 });

  const fd = fs.openSync(TMP_PATH, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  fs.renameSync(TMP_PATH, CONFIG_PATH);

  try {
    fs.chmodSync(CONFIG_PATH, 0o644);
  } catch (error) {
    // ignore permission errors on chmod
  }

  const verify = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (sha12(verify) !== sha) {
    throw new Error('post-write checksum mismatch');
  }
  log(`writeAtomic done sha=${sha}`);
}

function reloadConfig(): LightrouteConfig {
  const disk = readConfigFromDisk();
  overwriteConfig(config, disk);
  log('reloadConfig -> in-memory updated', config);
  return config;
}

function saveConfig(next: Partial<LightrouteConfig> | undefined): LightrouteConfig {
  log('saveConfig incoming (pre-sanitize)', next);
  const sanitized = sanitize(next);
  log('saveConfig sanitized', sanitized);
  writeAtomic(sanitized);
  overwriteConfig(config, sanitized);
  log(`saveConfig committed (nodes=${config.outbound_nodes.length}, bw=${config.bandwidth_save}, ping=${config.ping_interval_sec}s)`);
  return config;
}

overwriteConfig(config, readConfigFromDisk());

export { config, saveConfig, reloadConfig, CONFIG_PATH };
