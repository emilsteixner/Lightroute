# Lightroute

Lightroute is an Art-Net and sACN over Internet architecture designed for embedded devices (Raspberry Pi CM4) running Linux Debian. It enables remote control of film lighting fixtures by forwarding DMX data over LTE networks, bypassing carrier NAT limitations.

## Features

- **Art-Net Forwarding**: Receives Art-Net DMX data from lighting consoles and forwards to remote nodes over LTE/mobile networks
- **Universe Filtering**: Selectively forward specific DMX universes to different nodes
- **Bandwidth Optimization**: Optional deduplication mode to reduce data usage over cellular networks
- **Web-based Configuration**: Built-in admin panel for configuring outbound nodes and monitoring status
- **Real-time Monitoring**: Server-Sent Events (SSE) for live logging and activity tracking
- **Connectivity Monitoring**: ICMP/TCP probing to monitor node reachability and uplink status
- **TypeScript**: Fully typed codebase for improved reliability and maintainability
- **Hot-reload Configuration**: File watcher automatically reloads `config.json` changes without restart

## Architecture

```
Art-Net Console → Lightroute Node → LTE Network → Lightroute Node → DMX Hardware → Lights
```

**Components:**

- **Art-Net Forwarder** (`src/lightroute.ts`) - Core daemon handling UDP packet forwarding on port 6454
- **Config Layer** (`src/config.ts`) - Shared configuration management with atomic writes and hot-reload
- **Web Server** (Express) - Admin panel on port 3000 for configuration and monitoring
- **Monitoring System** - ICMP/TCP pings, activity tracking, status endpoints

## Quick Install

For Debian-based systems (Ubuntu, Raspberry Pi OS):

```bash
wget https://raw.githubusercontent.com/emilsteixner/Lightroute/main/install.sh && sudo chmod +x install.sh && sudo ./install.sh
```

Then start the service:

```bash
sudo systemctl start lightroute
```

## Manual Installation

### 1. Install Prerequisites

```bash
sudo apt update
sudo apt install -y git curl wget unzip
```

### 2. Install Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

### 3. Clone and Build

```bash
git clone https://github.com/emilsteixner/Lightroute.git
cd Lightroute/application
npm install
npm run build
```

### 4. Configure

Edit `config.json` to add your outbound nodes, or use the web UI after starting.

### 5. Run

```bash
# Default Runtime
sudo node dist/lightroute.js

# Development with verbose logging
npm run start:dev
```

## Development

### Building

```bash
# Compile TypeScript to JavaScript
npm run build

# Type checking without emitting files
npm run lint
```

### Running

```bash
# Development mode with ts-node (no build required)
npm run start:dev

# Run compiled application with verbose logging
node dist/lightroute.js -v
```

### Project Structure

```
application/
├── src/                    # TypeScript source files
│   ├── config.ts          # Configuration management
│   └── lightroute.ts      # Main application entry point
├── dist/                   # Compiled JavaScript output (generated)
├── public/                 # Web UI static assets
├── config.json            # Runtime configuration
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

## Configuration

Configuration is stored in `config.json` and can be edited via the web interface at `http://<device-ip>:3000`.

### Options

### Outbound Node Configuration

Each node in `outbound_nodes` supports:

| Option      | Type     | Default   | Description                                                  |
| ----------- | -------- | --------- | ------------------------------------------------------------ |
| `ip`        | string   | required  | Remote node IPv4 address (no hostnames)                      |
| `port`      | number   | 6454      | UDP port for Art-Net                                         |
| `enabled`   | boolean  | true      | Enable/disable forwarding to this node                       |
| `universes` | number[] | undefined | Allowed universes (empty = block all, undefined = allow all) |

### Example Configuration

```json
{
  "http_port": 3000,
  "ping_interval_sec": 30,
  "bandwidth_save": false,
  "strict_artnet_only": true,
  "outbound_nodes": [
    {
      "ip": "192.168.1.100",
      "port": 6454,
      "enabled": true,
      "universes": [0, 1, 2]
    }
  ]
}
```

## API Endpoints

| Method | Endpoint    | Description                                      |
| ------ | ----------- | ------------------------------------------------ |
| GET    | `/config`   | Get current configuration                        |
| POST   | `/config`   | Update configuration (persists to `config.json`) |
| GET    | `/status`   | Get system status and node states                |
| GET    | `/pings`    | Get connectivity/ping status                     |
| GET    | `/activity` | Get per-node packet activity                     |
| POST   | `/sweep`    | Run Art-Net test sweep                           |
| GET    | `/logs`     | Server-Sent Events stream for live logs          |

## Service Management

When installed via `install.sh`, Lightroute runs as a systemd service:

```bash
# Start service
sudo systemctl start lightroute

# Stop service
sudo systemctl stop lightroute

# Restart service
sudo systemctl restart lightroute

# Enable on boot
sudo systemctl enable lightroute

# View status
sudo systemctl status lightroute

# View logs
sudo journalctl -u lightroute -f
```

## Network Requirements

| Protocol | Port | Direction | Description                                |
| -------- | ---- | --------- | ------------------------------------------ |
| UDP      | 6454 | Inbound   | Art-Net DMX data from lighting console     |
| UDP      | 6454 | Outbound  | Forwarded Art-Net data to remote nodes     |
| TCP      | 3000 | Inbound   | Web UI and REST API (configurable)         |
| ICMP     | -    | Outbound  | Uplink connectivity checks (e.g., 1.1.1.1) |

## Important Constraints

- **Art-Net Universes**: 0-based indexing (universe 0 is the first universe)
- **Packet Forwarding**: Only OpDmx packets (opcode 0x5000) are forwarded by default
- **Packet Integrity**: Entire original packet is forwarded verbatim without header modification
- **DMX Channels**: Maximum 512 channels per universe
- **No Authentication**: Web UI assumes trusted LAN access

## Troubleshooting

### Check if service is running

```bash
sudo systemctl status lightroute
```

### View application logs

```bash
sudo journalctl -u lightroute -f
```

### Test Art-Net traffic

```bash
# Monitor incoming Art-Net packets
sudo tcpdump -i any udp port 6454 -n
```

### Check configuration

```bash
curl http://localhost:3000/config | jq
```

### Verify node connectivity

```bash
curl http://localhost:3000/pings | jq
```

### Build issues

```bash
# Clean and rebuild
rm -rf dist/
npm run build
```

## License

GPL v3 - see [LICENSE](LICENSE) file for details