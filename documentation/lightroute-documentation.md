# Lightroute Software Architecture

This document describes the full Lightroute system as implemented so far. 

## 1. High-level goal

Lightroute is a software currently delevoped for small embedded controllers (Raspberry Pi / CM4 class device) that:

* Listens for Art-Net DMX data (UDP, port 6454) on a local lighting network.
* Optionally filters/reduces that traffic. (save-bandwidth mode)
* Forwards that data to one or more remote “outbound nodes,” typically across LTE, to a Teltonika RUTX11 router that then hands it to a DMX node (e.g. LumenRadio Aurora or a regular Art-Net DMX node) at the remote lighting rig.

I'm using this to remote-control Film lighting/fixtures over mobile networks.

### Why this exists

* Lighting consoles (like Blackout on iPad) can broadcast Lighting controll data via CRMX (2.4GhZ) locally just fine with devices like the Aurora or Sidus Four etc.
* the remote rig is often behind LTE carrier NAT (CGNAT). That means you cannot just “unicast to public IP” unless you solve NAT or port forward, or build a tunnel.
* We didn’t want to run full VPN/WireGuard everywhere for the MVP and now we're on to something way cooler, stay tuned!
* So Lightroute lives in the control network (the iPad’s side), forwards UDP packets toward the remote side’s public IP. The remote side (RUTX11) port-forwards UDP/6454 internally to the Aurora DMX interface.

In other words:  

`Art-Net Console` → `Lightroute Master Node` → `Unicast UDP` → `Outbound Node` → `generic ArtNet to DMX Node` → *`CRMX`* → `Lights`

## Project Specific vocabulary:

Since this Project is kind of complex working with different networks, protocols, RF ranges and technoologies it's important to get everyone on the same Page.

we are assuming a setup in wich:

* The iPad *or any ArtNet console* sends broadcast ArtNet
* either the forwarding device or the Lightroute Software running on the ipad or console itself is considdered the **Master Node**
    - this is the same device hosting the WebGUI
    - likely on a LTE Network
    - Worst case this is behind a CGNAT
    - Dynamic IP
* the Recieving end, (although it potentially sends back Handshakes, heartbeats etc) is considdered the **Outbound node**
    - in the most rudimentary form this is simply a Router with ArtNet ports forwarded to a Art-Net/DMX node
    - likely on a LTE Network
    - Worst case this is behind a CGNAT
    - Dynamic IP

### Furure Improvements

1. **Connection Status and Config all in one place**

   * The way i would like to see Lighroute grow is a simple to use (web-) app giving you a overview of your entire Lightroute system overseeing Uplink, ArtNet out, ArtNet in, Ping and Traffic to each Outbound Node
   * Improvement would be, having the DMX Art-Net node fully integrated and sending back conformation that DMX was sent to the masternode. this logs all potential points of faliure and makes sure the User can fix the broken connection, anywhare misconfiguration occured
1. **WiFi Halow**

   * WiFi Halow is an upcoming technology mostly in the Camera/DIT Dept. Since Lighting and Camera Depts. wil consequently be moving closter together integrating WiFi Halow in different ways is a great Opportunity to Futureproof Lightroute as a well- integrated though modular system.
1. **Tailscale Tunneling**

   * Integrating Tailscale Network Tunneling opens up a whole new world of cloud configuration of Master- and Outbound nodes allowing intuitive RX/TX linking 

---

## 2. Core runtime components

There are four main software pieces running on the **Master Node**:

1. **Art-Net forwarder / brain** **(`lightroute.js`)**

   * A Node.js daemon.
   * Listens on UDP 6454 for Art-Net packets from the lighting console.
   * Applies filtering, deduplication, and universe selection.
   * Forwards packets to configured outbound targets over UDP.
1. **Config layer** **(`config.js` + `config.json`)**

   * Keeps runtime settings: which Outbound nodes to forward to, which universes, bandwidth-saving mode, etc.
   * Persists those settings to disk.
   * Is imported by the Node daemon and also exposed to the web UI.
1. **Embedded web server (Express)**

   * Serves a small admin panel (HTML/CSS/JS).
   * Lets you add/remove outbound nodes, toggle bandwidth-saving mode, and (later) observe system health LEDs.
   * Updates the same config object the forwarder uses.
1. only relevant to Master Nodes hosted on a Pi **systemd service**

   * Runs the forwarder at boot on the Pi.
   * So power on = “lighting bridge is live” without a keyboard.

## 3. Language/runtime choices

### Node.js for packet handling

We chose Node.js for the forwarder because:

* We needed fast iteration, not hardcore microsecond-level optimization.
* UDP datagrams in Node are easy via the built-in `dgram` module.
* We also wanted to serve a local web UI without bolting on another process.
* We have easy access to `fs` for JSON config persistence.
* Installable on Raspberry Pi OS in a straightforward way, without cross-compiling C.
* **latency** is a considderation, but **negligable** in a space working with LTE connection inbetween Master Node and Outbound Node

Could we do it in Rust or Python for lower jitter? Absolutely. But for now: Node got us moving, and latency in practice was fine (around 40-100ms) once we dealt with NAT/routing on the RUTX side. remember, we're still in the Film and not show lighting world.

Future Languages might be Rust, Python (and webui HTMX) or similar, depending on what future inprovements require.

### Express for web UI

We embedded Express instead of Nginx + CGI or something else because:

* Single-process deployment.
* Easy static hosting of `index.html`, CSS, icons.
* Easy JSON REST endpoints (`GET /config`, `POST /config`).
* No external reverse proxy needed.
* We don’t need authentication yet (we’re assuming you are on the same trusted LAN / physically holding the controller).

### systemd for boot/start

We run the Node script as a `systemd` unit so that:

* It auto-starts on boot.
* It restarts if it crashes.
* We can still run it manually with `-v` (verbose) for debugging.
* We can stop it via `sudo systemctl stop lightroute` when we want to run a foreground debug session.

## 4. Art-Net forwarding logic

### Art-Net basics (as used here)

Art-Net is a UDP lighting control protocol. The part we care about is “ArtDMX” packets, opcode `0x5000`, which carry DMX channel values for a given universe. Art-Net packets generally:

- Are sent to UDP port 6454.
- Begin with the ASCII string `"Art-Net"` plus a null byte.
- Contain header fields like opcode, sequence, physical port, and _universe_ (which universe this DMX data is for).
- Then contain length and channel payload (0–512 DMX slots).

In our script we parse:

```js
// Minimum structural validation
if (msg.length < 18) return;

// Check header ("Art-Net\0")
if (msg.toString('ascii', 0, 8) !== 'Art-Net\0') return;

// Opcode is little-endian at byte offset 8
const opcode = msg.readUInt16LE(8);
if (opcode !== 0x5000) return;  // ignore non-DMX packets

// Universe (little-endian) at offset 14
const universe = msg.readUInt16LE(14);

// Payload length (big-endian!) at offset 16
const length = msg.readUInt16BE(16);

// DMX data payload starts at offset 18
const dmxData = msg.slice(18, 18 + length);
```

Why we parse like this:

* We only forward ArtDMX packets (`0x5000`), not ArtPoll or other discovery chatter.
* We want the universe number to apply per-node filtering.
* We want the payload to do dedupe (bandwidth-saving).

### Listening socket

We create a single UDP socket:

```js
const dgram = require('dgram');
const socket = dgram.createSocket('udp4');

socket.bind(6454);
```

Binding to `0.0.0.0:6454` means:

* We receive broadcast Art-Net (“192.168.x.255 → 6454”) from the lighting console / iPad.
* We receive unicast Art-Net (“192.168.x.console → 192.168.x.pi:6454”).

We originally hit a collision:

* If systemd already had the service running, and we ran `node lightroute.js` manually, we saw:  

    `EADDRINUSE 0.0.0.0:6454`  

    because port 6454 was already bound.  

    That’s expected. Solution was to `systemctl stop lightroute` before manually debugging, or vice versa.

### Forwarding logic

For every incoming valid ArtDMX packet, we iterate over the configured outbound nodes and decide if we should forward it:

```js
for (const node of config.outbound_nodes) {
  // skip if node isn't enabled
  // skip if invalid IP
  // skip if universe list doesn't include this universe
  // skip if bandwidth_save is on and DMX wasn't changed

  socket.send(msg, 0, msg.length, 6454, node.ip, (err) => {
    // optional verbose logging
  });
}
```

Important details:

* We reuse the same `socket` for both receive and send. That means forwarded packets will _source from_ the Pi’s IP and _source port 6454_ unless the OS picks otherwise. That’s fine for us.
* We forward the _entire_ original packet, untouched. We don’t rebuild Art-Net. We just forward what we received, which preserves sequence fields etc. This keeps compatibility with Art-Net nodes.

#### Universe filtering logic

Each outbound node has a `universes` array. If it’s non-empty, we only forward packets whose universe matches:

```js
if (node.universes.length && !node.universes.includes(universe)) {
  continue; // skip this node
}
```

We originally thought of “Universe 1–4” in the UI, but Art-Net universes are actually 0-based in the protocol. So Universe “0” in Art-Net is actually the first one. We had to correct the web UI to cover universe 0–3.

This universe filter matters for:

* Reducing wasted traffic if you’re only actually using e.g. 2 universes out of 4.
* Bandwidth over LTE (small but real).
* Security-ish: you don’t accidentally blast universes that belong to a totally different rig/layer.

#### Bandwidth saving / dedupe

We introduced “bandwidth_save” (UI label: “Save Bandwidth / send only changed values”). This is an optimization:  

DMX data often gets sent ~40 times a second even if no fader moves. LTE bandwidth is precious and constant transmission could cost money and battery.

So we keep a per-destination+universe cache of last DMX payload:

```js
const lastDMX = {}; // key: `${node.ip}_${universe}` -> Buffer of last DMX slot values

if (config.bandwidth_save) {
  const key = `${node.ip}_${universe}`;
  if (lastDMX[key] && Buffer.compare(lastDMX[key], dmxData) === 0) {
    // identical payload, skip sending
    continue;
  }
  lastDMX[key] = Buffer.from(dmxData);
}
```

This way:

* If nothing changed, we skip that outbound send.
* If something changed (even on a single channel), we forward again.

We learned something important:  

Some lighting receivers (or console logic) expect a “keepalive” stream of DMX, not just changes. When we only send on change, the remote fixture may stop updating after the first frame or might “timeout to black” depending on how smart the DMX node is.

So we made bandwidth_save a toggle, not a permanent behavior.

## 5. Verbose / diagnostics modes

We added two developer-facing tools:

1. `node lightroute.js -v`

* Enables `VERBOSE`.
* Prints things like:

  ```text
  🎛️  Received DMX universe 0 from 192.168.1.42:6454
  📤 Sent DMX to 86.62.33.47
  ⏸️  Skipped unchanged DMX to 86.62.33.47 [universe 0]
  ❌ Failed to send to 86.62.33.47: <err.message>
  ```
* This is how we verified forwarding decisions.

2. `node lightroute.js -h` or `--help`

   * Prints minimal CLI usage and exits, so you don’t have to read the code to remember flags.

We also used `tcpdump` heavily on both ends to confirm:

* Packets arrive at the Pi from the iPad (broadcast to 192.168.x.255:6454).
* Packets leave the Pi toward the remote public IP, with UDP length ~558 bytes (530 payload + headers).
* The RUTX11 sees UDP arriving on LTE and then forwards it internally (NAT DNAT to Aurora).

Example debug command we ran on the Pi:

```bash
sudo tcpdump -i any udp port 6454 -n
```

Example debug command we ran on the RUTX11:

```bash
tcpdump -i any udp port 6454 -n
```

We often saw two types of messages:

* Broadcast packets (`192.168.1.42.6454 > 192.168.1.255.6454`)
* Forwarded unicast packets (`192.168.1.199.6454 > <public-ip>.6454`)
* Then, on RUTX11, DNAT output to Aurora LAN IP.

We also noticed “bad udp cksum” in tcpdump output. That’s normal on outbound capture interfaces: checksum offload means tcpdump is seeing the packet before the NIC driver fills in the final checksum in hardware. It does _not_ mean the packet is corrupted in flight.

## 6. Config system

### Persistent config file

We use a `config.json` file on disk (same directory as the Node scripts) that looks conceptually like this:

```json
{
  "outbound_nodes": [
    {
      "ip": "185.81.xxx.xxx",
      "enabled": true,
      "universes": [0, 1, 2]
    },
    {
      "ip": "86.62.xxx.xxx",
      "enabled": false,
      "universes": []
    }
  ],
  "bandwidth_save": true
}
```

Key fields:

* `outbound_nodes`: array of destinations.
    - `ip`: string IPv4. We **do not** support hostnames here, and that’s on purpose.
        - We actually hit a bug early where upstream traffic tried to use a hostname. The Teltonika RUTX firewall was doing NAT rules expecting fixed IPs, and hostname resolution on the router wasn’t happening the way we thought. So we locked down to explicit IPs only.
    - `enabled`: boolean.
    - `universes`: list of allowed universes (Art-Net universe numbers, 0-based). Empty list means “allow all”.
* `bandwidth_save`: boolean toggle for the dedupe optimization.

We _do not_ store listening port here, or local universe mappings, etc. yet. Listening port is hardcoded (6454) because Art-Net expects that.

### config.js module

We have a small helper module that:

* Loads `config.json` once at startup into an in-memory `config` object.
* Exports that object.
* Exports `saveConfig()` that writes the current in-memory config back to disk.

Pseudo-structure:

```js
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

let config;

try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH));
} catch (err) {
  console.error('Failed to read config.json:', err.message);
  process.exit(1);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { config, saveConfig };
```

Why we went with a singleton:

* The forwarder loop and the web server are in the same Node process. They share memory.
* When the web UI `POST /config` arrives, we mutate the shared `config` object and call `saveConfig()`; the forwarder immediately uses the new values (next packet).
* We don’t fork multiple workers, so we don’t need IPC or shared memory.

This is simple and works fine on a single-board computer model.

## 7. Web UI

We serve an admin panel over HTTP (default on port 3000). It’s meant for:

* Field techs who have an iPad or laptop and want to point Safari/Chrome at `http://lightroute.local:3000/`.
* Quickly check “am I forwarding?” and “to whom?” without SSH.

### Express setup

We initialize Express like this (conceptually):

```js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

app.use(bodyParser.json());

// Serve static frontend assets:
app.use(express.static(path.join(__dirname, 'public')));

// REST endpoint: get current config
app.get('/config', (req, res) => {
  res.json(config);
});

// REST endpoint: update config
app.post('/config', (req, res) => {
  // req.body has outbound_nodes[], bandwidth_save
  Object.assign(config, req.body);
  saveConfig();
  res.sendStatus(200);
});

// Listen on TCP 3000
app.listen(3000, () => {
  console.log('🌐 Web UI running at http://localhost:3000');
});
```

Libraries we use here:

* `express` for routing/static serving.
* `body-parser` to parse JSON POSTs (modern Express can do `express.json()` too, but body-parser is fine and explicit).
* `path` for safe absolute paths.
* `fs` indirectly via `saveConfig()`.

### Frontend design goals

We wanted:

* Zero build tooling (no React/Vue build chain).
* A single `index.html` that uses plain `<script>` and fetches `/config`.
* CSS that visually matches Teltonika’s RUTX WebUI vibe: dark grey background, white text, simple rounded cards, bordered transparent buttons. We mimicked the look/feel you see on Teltonika routers (cards, section headers, toggle checkboxes).

Key elements in the HTML:

* “Outbound Nodes” section
    - Shows list of configured destinations.
    - Each destination (“node”) has:
        - IP field.
        - Enable checkbox.
        - Universe checkboxes.
        - A ❌ Remove button once we added deletion.
* “Bandwidth Mode” section
    - Checkbox for the dedupe feature (`bandwidth_save`).
* “Save Settings” button
    - On click, we collect the DOM state, build a JSON body, and `POST /config`.
    - After a successful save, we temporarily swap the button text to “Settings Saved”.

We also later added:

* Universe checkboxes for universes **0,1,2,3** (not 1–4), because Art-Net universes in the wild often start at 0. We ran into a bug where filtering out Universe 0 prevented any traffic forwarding. Fixing that mattered.
* A Remove button for outbound nodes (because we don’t want dead/typo IPs left forever in the config).

Planned/desired additions (some already discussed, may or may not be in the code you have right now):

* “Digital LEDs” on the page:
    - **Uplink OK** (is the Pi able to send to at least one enabled node? could be just a simple “last successful send timestamp > N seconds ago” = green).
    - **Art-Net In** (have we received any Art-Net in the last N seconds?).
    - **Art-Net Out** (have we forwarded any Art-Net out in the last N seconds?).
* A live verbose console / debug modal:
    - Where we pipe recent log lines (“Received DMX universe 0 from …”, “Sent DMX to …”) without ssh’ing.
    - This means adding some ring buffer of recent events in memory and an endpoint `/events`, polled by the frontend.

### Frontend -> backend contract

When you hit Save in the UI, the browser does roughly:

```js
const body = {
  outbound_nodes: [
    {
      ip: "86.62.33.47",
      enabled: true,
      universes: [0, 1, 2]  // from checkboxes
    },
    ...
  ],
  bandwidth_save: true
};

fetch('/config', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body)
});
```

The backend then `Object.assign(config, req.body); saveConfig();`

Why `Object.assign`?

* We want to replace entire arrays/fields atomically with what the browser sent.
* We’re not merging deeply or validating types yet; this is a trust boundary assumption: only you (the operator) accesses this UI.

Security note:

* Currently there is **no auth**.
* In a production version, you’d at least want HTTP basic auth, a shared secret, or to bind Express only on a management VLAN, or only to `127.0.0.1` and let people SSH port-forward in.
* For field work, we accepted the risk.

## 8. Interaction with Teltonika RUTX11

Even though this file is “software.md,” it’s important to document how our software expects the network to behave, because that fed directly into the software design.

On the receiver side (RUTX11 + Aurora DMX node):

- The RUTX11 is typically on LTE.
- Often LTE SIMs sit behind CGNAT (Carrier Grade NAT):
    - The router’s “public IP” looks like 10.x.x.x or 100.x.x.x,
    - Online “what is my IP” shows a totally different public IP,
    - Meaning inbound UDP from the internet just gets dropped upstream by the carrier.
- In rare cases we can buy/pay for a “public APN” that gives a real public IPv4 and then you can DNAT 6454 -> Aurora directly.
- When that worked, we created firewall rules on the RUTX11 that DNAT any UDP 6454 arriving on WAN into the Aurora’s LAN IP:6454.

Example of what we configured via `uci`:

```bash
uci set firewall.artnet_in=redirect
uci set firewall.artnet_in.name='ArtNet In'
uci set firewall.artnet_in.src='wan'
uci set firewall.artnet_in.dest='lan'
uci set firewall.artnet_in.proto='udp'
uci set firewall.artnet_in.src_dport='6454'
uci set firewall.artnet_in.dest_ip='192.168.1.181'    # Aurora DMX node
uci set firewall.artnet_in.dest_port='6454'
uci set firewall.artnet_in.target='DNAT'
uci set firewall.artnet_in.family='ipv4'
uci set firewall.artnet_in.enabled='1'

uci commit firewall
/etc/init.d/firewall restart
```

We also added a “loopback” redirect for LAN-originated traffic to that same public IP. Why?  

Because during on-site testing, sometimes the controller (iPad or Pi) would try to send Art-Net to the router’s _public_ IP even though we were already inside its LAN. Without hairpin NAT / reflection, that would fail.

So we also configured an internal redirect:

* Source zone = LAN
* Destination zone = LAN
* DNAT port 6454 on “the router’s own public IP” to the Aurora IP again

This tricks local senders into thinking they’re sending to a public IP, but the router immediately loops it back internally.

On the Lightroute side, that means:

* We just send packets to whatever IP is configured in `config.json`.
* We don’t worry about NAT; we assume the remote router will either:
    - expose a real public IP, or
    - emulate that public IP via hairpin NAT so even local senders get DNAT’d correctly.

This assumption is why we insisted the outbound node has a **raw IPv4 address** instead of a hostname. Hostnames introduce DNS, which can resolve to different things depending on context, and we saw early on that the firewall rules on the RUTX wanted fixed IPs, not hostnames. If we used hostnames, NAT didn’t always match and traffic got dropped.

## 9. Handling multiple destinations

We explicitly allow multiple outbound nodes, e.g.:

* Node A: The actual rig in Venue 1.
* Node B: A backup rig (or a visualizer machine, or some recording bridge).
* Node C: Future/next stage.

The forwarder just loops through them and conditionally forwards:

* If they’re enabled.
* If the universe matches.
* If bandwidth_save allows (or not, depending on toggle).

This is conceptually like a hub:

* One incoming Art-Net broadcast stream goes out to N remote receivers.

Later plans:

* Per-node universe filters from the web UI (we have this).
* Per-node enable/disable (we have this).
* Eventually per-node “rate limit” or “throttle,” but not yet implemented.

## 10. Headless UX goals

We had requirements for field usability:

1. **Boot and run headless.**  

    The Pi/CM4 should be able to sit in a rack with the LTE router, power up, start forwarding, no keyboard/monitor attached.

    We handled this with:

- `systemd` unit file to run `node /home/lightroute/lightroute.js` at boot.
- The script itself binds port 6454 and port 3000 when it starts.
- If you plug in over Ethernet/Wi-Fi to the “TX side,” you can hit `http://lightroute.local:3000` and edit targets.

2. **Local status feedback.**  

    We talked about adding a tiny screen (Adafruit Mini PiTFT for example) or an OLED on I²C/SPI.  

    The idea would be to show:

   * Device IP on the LAN.
   * “Packets in / Packets out” counters.
   * Maybe even a local menu via hardware buttons to toggle “bandwidth_save” on/off in the field without a browser.

    On the software side, this would mean:

   * Exposing something like a local module that the display code can require, which gives the last-seen metrics.
   * The forwarder would update shared state like:

     ```js
     stats.lastInTime = Date.now();
     stats.lastOutTime = Date.now();
     stats.packetsIn++;
     stats.packetsOut++;
     ```
   * The display script could poll that or import it if in the same process.
3. **Digital LEDs in Web UI.**  

    On the web page we plan to render three indicators:

   * “Uplink alive?” (did we recently manage to send a packet to at least one enabled node without error)
   * “Art-Net in?” (have we received Art-Net recently)
   * “Forwarding out?” (have we actually emitted to anyone)

    Implementation approach:

   * Keep timestamps in memory:

     ```js
     let lastInAt   = 0;
     let lastOutAt  = 0;
     let lastOkSendAt = 0;
     ```
   * Add an endpoint like `/status` that returns booleans based on `Date.now() - last*At < someThreshold`.
   * Frontend polls `/status` every second and lights green/red circles.

## 11. Future / alternative backends

We considered (and partially tested) different approaches beyond “Pi forwards directly to public IP”:

### A. WireGuard site-to-site

- Run WireGuard server on the office/FOH side (where you _do_ have a public IP).
- RUTX11 acts as WireGuard _client_ (Teltonika supports WireGuard).
- Then you just send Art-Net over a /30 tunnel IP (e.g. 10.77.0.2:6454).
- The RUTX11 DNATs that to Aurora.
- Pros: No VPS in the middle.
- Cons: Requires configuring WireGuard keys, etc., and the office side must stay up.

### B. VPS relay (Realm / generic UDP relay)

* Both sides (TX Pi and RX RUTX/another Pi) make outbound UDP/TCP connections to a VPS with a real public IP.
* The VPS forwards UDP between them like a reflector.
* Pros: Works even if both ends are behind CGNAT.
* Cons: Introduces a “middlebox” you rent. Slight latency overhead but usually manageable.

These options matter for software design because they influence:

* Whether we need multiple outbound nodes.
* Whether we need encryption or access control.
* Whether we need persistent keepalives.

For instance, if we move to a WireGuard tunnel, the outbound node in `config.json` might become a _private_ tunnel IP (`10.77.0.2`) instead of a public LTE IP. Everything else in the forwarder stays basically the same.

## 12. Lessons learned / constraints baked into the code

Here are the “why” decisions we already made and encoded into the design:

1. **Use raw IPv4, not hostnames.**

* Because the RUTX11 NAT/redirect rules and our mental model of forwarding are IP-centric.
* DNS added failure modes (hostname not resolving where we thought; mismatch between hostname and DNAT’s hardcoded target).
* The web UI enforces “IP” text, not arbitrary hostname.

2. **Universe numbers are 0-based.**

   * The first Art-Net universe is universe 0.
   * The UI originally showed 1–4; we fixed it to 0–3 because otherwise we were filtering out the only traffic we cared about (universe 0).
   * New assistants must respect: when we say “universe 1” to a human LD, that might actually mean “0” in the protocol.
3. **Bandwidth saving is optional, not mandatory.**

   * Some fixtures/nodes behave badly if they don’t get continuous frames.
   * So we made `bandwidth_save` a toggle.
   * The code tracks lastDMX per (destination, universe) because different destinations may have different states.
4. **Single-process shared state.**

   * We read `config.json` once into memory and mutate it in place.
   * `/config` POST just overwrites fields and calls `saveConfig()`.
   * The forwarding loop references the same `config` object in RAM, so updates become live instantly.
   * This works because we are not clustering or multi-processing Node.
5. **We don’t rewrite Art-Net, we forward it verbatim.**

   * We’re not generating new sequence numbers or new headers.
   * We are acting like a “UDP multicast repeater” that forwards whole packets.
   * This keeps the Pi transparent to the downstream node.
6. **Debugging strategy is: tcpdump + verbose mode.**

   * We assume we can SSH into the Pi and RUTX11 in the field.
   * We run `tcpdump -i any udp port 6454 -n` and compare timestamps/logs.
   * Web UI will later surface minimal status so a tech doesn’t _need_ SSH.

## 13. Summary for a new assistant

If you take over software work on Lightroute, here’s what you're inheriting:

- A Node.js script (`lightroute.js`) that:
    - Binds a UDP socket on 6454 to receive Art-Net (broadcast or unicast).
    - Parses ArtDMX (opcode 0x5000), extracts universe and DMX payload.
    - Optionally filters by universe per outbound node.
    - Optionally suppresses unchanged frames for bandwidth saving.
    - Forwards the _entire original_ Art-Net packet via UDP to each enabled outbound node’s IP:6454.
    - Logs activity if run with `-v`.
- A shared `config` object (from `config.js`) that:
    - Mirrors what’s on disk in `config.json`.
    - Contains `outbound_nodes[]` with `{ip, enabled, universes[]}` and `bandwidth_save` global toggle.
    - Is updated live by an Express web server that serves `/config` GET/POST and a static frontend.
    - Is persisted to disk on save so the settings survive reboot.
- A minimal web UI (static HTML/CSS/JS) that:
    - Shows and edits outbound nodes.
    - Lets you toggle bandwidth-saving.
    - Is intended to grow into showing “digital LEDs,” log console, remove-node buttons, etc.
    - Has a Teltonika-inspired dark theme (gray background, rounded boxes, transparent bordered buttons).
- A run mode managed by `systemd`:
    - So the service comes up automatically on boot for headless field use.
    - You can stop that service to run `node lightroute.js -v` manually for debugging.
    - You should never try to run two copies at once, otherwise `EADDRINUSE` will happen on UDP 6454.
- An assumption about the network:
    - The far end (the lighting rig) is often behind LTE/CGNAT and not directly reachable.
    - Right now, the “happy path” is: you _do_ have some routable IP on the RUTX11 (via public APN or hairpin NAT tricks), and you DNAT UDP 6454 to the local Art-Net-to-DMX node (Aurora).
    - Lightroute forwards to that IP, and that’s enough*
    - 