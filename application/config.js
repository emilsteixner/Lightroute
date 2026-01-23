// config.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const TMP_PATH = CONFIG_PATH + '.tmp';
const LOG_PREFIX = '[config]';

const DEFAULTS = {
  http_port: 3000,
  ping_interval_sec: 30,
  bandwidth_save: false,
  outbound_nodes: []
};

const config = {}; // <-- single exported object; never reassign this reference

function now() { return new Date().toISOString(); }
function log(msg, obj) {
  if (obj !== undefined) console.log(`${now()} ${LOG_PREFIX} ${msg}`, obj);
  else console.log(`${now()} ${LOG_PREFIX} ${msg}`);
}
function sha12(bufOrStr) {
  const h = crypto.createHash('sha256'); h.update(bufOrStr); return h.digest('hex').slice(0,12);
}
function overwrite(target, src) {
  Object.keys(target).forEach(k => delete target[k]);
  Object.assign(target, src);
}

function sanitize(c) {
  const out = {
    http_port: Number(c.http_port) || DEFAULTS.http_port,
    ping_interval_sec: Math.max(5, Number(c.ping_interval_sec) || DEFAULTS.ping_interval_sec),
    bandwidth_save: !!c.bandwidth_save,
    // default ON unless explicitly set false
    strict_artnet_only: c && c.strict_artnet_only === false ? false : true,
    outbound_nodes: Array.isArray(c.outbound_nodes) ? c.outbound_nodes.map(n => {
      const ip = (n.ip || '').trim(); if (!ip) return null;
      const port = Number(n.port) || 6454;
      const enabled = !!n.enabled;

      const hasUniverses = Array.isArray(n.universes);
      const universes = hasUniverses
        ? n.universes.map(u => Number(u))
            .filter(u => Number.isInteger(u) && u >= 0 && u <= 32767)
        : undefined;

      const o = { ip, port, enabled };
      if (hasUniverses) o.universes = universes; // [] => block all; missing => allow all
      return o;
    }).filter(Boolean) : []
  };
  return out;
}


function readConfigFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    log(`read config.json ok sha=${sha12(raw)} size=${raw.length}`);
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

function writeAtomic(obj) {
  const data = JSON.stringify(obj, null, 2);
  const sha = sha12(data);
  log(`writeAtomic start sha=${sha} size=${data.length}`);
  fs.writeFileSync(TMP_PATH, data, { mode: 0o644 });
  const fd = fs.openSync(TMP_PATH, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
  fs.renameSync(TMP_PATH, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o644); } catch {}
  const back = fs.readFileSync(CONFIG_PATH, 'utf8');
  if (sha12(back) !== sha) throw new Error('post-write checksum mismatch');
  log(`writeAtomic done sha=${sha}`);
}

// public API
function reloadConfig() {
  const disk = readConfigFromDisk();
  overwrite(config, disk);                 // <-- mutate the exported object
  log('reloadConfig -> in-memory updated', config);
  return config;
}
function saveConfig(newCfg) {
  log('saveConfig incoming (pre-sanitize)', newCfg);
  const sanitized = sanitize(newCfg || {});
  log('saveConfig sanitized', sanitized);
  writeAtomic(sanitized);
  overwrite(config, sanitized);            // <-- mutate the exported object
  log(`saveConfig committed (nodes=${config.outbound_nodes.length}, bw=${config.bandwidth_save}, ping=${config.ping_interval_sec}s)`);
  return config;
}

// initialize once
overwrite(config, readConfigFromDisk());

module.exports = { config, saveConfig, reloadConfig, CONFIG_PATH };
