# Repository Overview

## Agent Guidelines

- Top Priority: leave everything well documented within this file.
- Prioritize comprehensive documentation within this file including current tasks, TODOs, testing procedures, and success criteria. always update it when structure, architectures change.
- Maintain clear records of actions, decisions, and context updates. overwrite outdated information
- Update `.agents/mistakes.md` with any issues, missteps, or lessons learned, and review this log before starting work each session.
- Keep `.agents/directories.md` in sync with the actual project structure and planned directories, and review it before each session to understand the expected layout.
- Use the `.agents/.temp/` directory for temporary or debugging scripts and data not meant for end users. Document each script's purpose, usage, and status in the file header.
- Before executing debug tools, check existing scripts in `.agents/.temp/` to avoid duplicating work and to reuse available utilities.
- Always read `.agents/mistakes.md` and `.agents/directories.md` before starting a session to stay aligned with project history and structure expectations.
- Keep communication concise and avoid redundant actions. Document rationale for significant changes, testing procedures executed, and criteria for task completion.
- before ending a session, write the changes made to this file (AGENTS.md)

## Project Description

Lightroute is an Art-Net and sACN over Internet architecture designed for embedded devices (Raspberry Pi CM4) running Linux Debian. It enables remote control of film lighting fixtures by forwarding DMX data over LTE networks, bypassing carrier NAT limitations.

**Main Purpose:**

- Receive Art-Net DMX data from lighting consoles (UDP port 6454)
- Filter and optimize traffic (bandwidth saving, universe filtering)
- Forward data to other nodes over LTE/mobile networks and tunnels
- Provide web-based configuration and monitoring interface

**Key Technologies:**

- Node.js (18+) for packet handling and web server
- Express.js for embedded web UI
- UDP networking via Node.js `dgram` module
- systemd for service management on Linux
- Server-Sent Events (SSE) for real-time logging
- ICMP/TCP probing for connectivity monitoring

## Architecture Overview

### High-Level Architecture

```
Art-Net Console → Lightroute Node → LTE Network → Lightroute Node → DMX Hardware → Lights
```

**Master Node Components:**

1. **Art-Net Forwarder** (`lightroute.ts`) - Core daemon handling UDP packet forwarding
2. **Config Layer** (`config.ts`) - Shared configuration management with hot-reload
3. **Web Server** (Express) - Admin panel for configuration and monitoring
4. **Monitoring System** - ICMP/TCP pings, activity tracking, status endpoints

### Data Flow

1. Lighting console sends Art-Net broadcast to UDP 6454
2. Lightroute receives and parses ArtDMX packets (opcode 0x5000)
3. Applies filters: universe selection, bandwidth deduplication
4. Forwards packets to configured devices via UDP
5. Web UI polls status endpoints and receives SSE log events

### System Interactions

- **UDP Socket 6454**: Bidirectional Art-Net traffic (receive + forward)
- **HTTP Server 3000**: Web UI, REST API (`/config`, `/status`, `/pings`, `/logs`)
- **File System**: `config.json` persistence with atomic writes
- **Network**: ICMP pings to 1.1.1.1 for uplink detection, TCP probes to nodes

## Directory Structure

```
lightroute/
├── application/            # Main application directory
│   ├── src/               # TypeScript source files (PRIMARY DEVELOPMENT)
│   │   ├── config.ts     # Configuration management module
│   │   └── lightroute.ts # Main application entry point
│   ├── dist/              # Compiled JavaScript output (GENERATED - do not edit)
│   ├── artnet/            # Art-Net related utilities (currently empty)
│   ├── public/            # Web UI assets
│   ├── config.json        # Runtime configuration
│   ├── package.json       # Node.js dependencies and scripts
│   └── tsconfig.json      # TypeScript compiler configuration
├── install.sh             # Installation script for target devices
└── README.md              # User-facing documentation
```

### Key Files

- `application/src/lightroute.ts` - Main application logic
- `application/src/config.ts` - Configuration management with hot-reload
- `application/config.json` - Runtime configuration (universes, nodes, filters)
- `application/public/` - Web UI static files

### Entry Points

- **Production**: `systemctl start lightroute` (runs `node /path/to/dist/lightroute.js`)
- **Development**: `npm run start:dev` or `node dist/lightroute.js -v` (verbose mode)
- **Web UI**: `http://<device-ip>:3000`

## Development Workflow

### Building/Running

```bash
# Development with hot reload (uses ts-node)
npm run start:dev

# Build TypeScript
npm run build

# Run compiled application
node dist/lightroute.js

# Development with verbose logging
node dist/lightroute.js -v

# Production (via systemd)
sudo systemctl start lightroute
sudo systemctl stop lightroute
sudo systemctl status lightroute

# View logs
journalctl -u lightroute -f
```

### Testing Approach

- **Manual Testing**: Use `-v` flag for verbose packet logging
- **Network Debugging**: `tcpdump -i any udp port 6454 -n`
- **Web UI Testing**: Access `http://localhost:3000`, configure nodes, run Art-Net test sweep
- **Connectivity Testing**: Use `/pings` endpoint to verify ICMP/TCP reachability

### Development Environment Setup

```bash
# Clone repository
git clone https://github.com/emilsteixner/Lightroute.git
cd Lightroute

# Install Node.js 18+ (if needed)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install dependencies
cd application
npm install

# Run in development mode
npm run start:dev
```

### Installation on Target Device

```bash
# Quick install (Debian-based systems)
wget https://raw.githubusercontent.com/emilsteixner/Lightroute/main/install.sh
sudo chmod +x install.sh
sudo ./install.sh

# Start service
sudo systemctl start lightroute
```

### Lint and Type Checking

- **Type checking**: `npm run lint` (runs `tsc --noEmit`)
- **Build verification**: `npm run build` must complete without errors
- Code style: camelCase, 2-space indentation, functional patterns

## Important Constraints

### Protocol-Specific

- **Art-Net Universes are 0-based** (first universe is 0, not 1)
- **Only OpDmx packets (0x5000) are forwarded** by default
- **Entire original packet is forwarded verbatim** (no header modification)
- **DMX data is 512 channels max**

### Network-Specific

- **Outbound nodes use raw IPv4 addresses only** (no hostnames)
- **UDP port 6454 is hardcoded** (Art-Net standard)
- **HTTP port 3000 is configurable** via `http_port` in config
- **CGNAT-aware**: System designed for LTE networks behind carrier NAT

### Configuration

- **Single-process shared state**: Config object mutated in-place
- **Atomic writes**: Config saved via temp file + rename + fsync
- **Hot-reload**: File watcher on `config.json` triggers automatic reload
- **No authentication**: Web UI assumes trusted LAN access

### Performance Considerations

- **Bandwidth saving mode**: Deduplicates unchanged DMX frames
- **Per-node caching**: Last DMX state tracked per destination+universe
- **Activity LEDs**: Blink on packet receipt, not per-channel changes
- **SSE log buffer**: Limited to 400 entries to prevent memory issues

## TypeScript Migration (Completed)

### Changes Made

1. **Created TypeScript source structure**:

   - Created `application/src/` directory
   - Converted `config.js` → `src/config.ts`
   - Converted `lightroute.js` → `src/lightroute.ts`
   - Updated `package.json` with TypeScript tooling

2. **Type definitions added**:

   - `OutboundNodeConfig` interface for node configuration
   - `LightrouteConfig` interface for main config
   - `DmxPacket` interface for Art-Net packet parsing
   - `PingStateEntry` type for ping results
   - `SweepTarget` and `SweepResult` types for sweep functionality

3. **Build configuration**:

   - Added `tsconfig.json` with strict type checking
   - Configured output to `dist/` directory
   - Added `npm run build` script using `tsc`
   - Added `npm run lint` for type checking without emit

### TypeScript Strict Mode Fixes

The tsconfig.json has strict settings enabled:

- `noUncheckedIndexedAccess: true` - Makes array indexing return `T | undefined`
- `exactOptionalPropertyTypes: true` - Makes optional properties stricter

Required fixes applied:

1. **previewDMX function**: Added non-null assertion `data[i]!`
2. **hexPreview function**: Added non-null assertion `buf[i]!`
3. **icmpPing function**: Added null check `if (match && match[1])`

### Status

- TypeScript migration **complete**
- Build succeeds without errors
- Compiled JavaScript runs successfully:
  - UDP server listening on 0.0.0.0:6454
  - HTTP server listening on 0.0.0.0:3000
  - Config API returns valid JSON
  - Status API returns valid JSON
- All type errors resolved with minimal changes to code logic

## Installation Script Updates

The `install.sh` script supports TypeScript builds:

1. **Dependency Installation**: Installs all dependencies (including TypeScript devDependencies) to enable building on target device
2. **TypeScript Build Step**:
   - Detects presence of `tsconfig.json` and `src/` directory
   - Runs `npm run build` as service user
   - Verifies `dist/lightroute.js` is created
   - Falls back to legacy `lightroute.js` if TypeScript build not detected
3. **Service Configuration**: Updated systemd service to:
   - Use compiled `dist/lightroute.js` as primary executable
   - Fall back to `lightroute.js` if compiled output not available
   - Uses shell conditional for graceful fallback
4. **Verification**: Checks for either `dist/lightroute.js` OR `lightroute.js`

## Current File Structure

```
application/
├── src/                    # TypeScript source files (PRIMARY DEVELOPMENT)
│   ├── config.ts          # Configuration management module
│   └── lightroute.ts      # Main application entry point
├── dist/                   # Compiled JavaScript output (GENERATED)
│   ├── config.js
│   ├── config.d.ts
│   ├── config.js.map
│   ├── lightroute.js
│   ├── lightroute.d.ts
│   └── lightroute.js.map
├── artnet/                 # Art-Net utilities (reserved for future use)
├── package.json           # Updated with TypeScript tooling
├── tsconfig.json          # TypeScript compiler configuration
├── config.json            # Runtime configuration
└── public/                # Web UI assets
```

## Build Process

```bash
# Install dependencies
npm install

# Type check without emitting
npm run lint

# Build TypeScript
npm run build

# Run compiled application
node dist/lightroute.js

# Run with verbose logging
node dist/lightroute.js -v

# Development mode with ts-node
npm run start:dev
```

## Testing Performed

Successfully tested compiled application:

1. **Build**: `npm run build` completes without errors
2. **Type Check**: `npm run lint` passes without errors
3. **Startup**: Application starts correctly with both UDP and HTTP servers
4. **Config API**: `/config` endpoint returns valid JSON configuration
5. **Status API**: `/status` endpoint returns valid system status
6. **Connectivity**: ICMP ping to 1.1.1.1 works correctly
7. **Node Sweep**: Ping sweep function operates correctly

## Deployment Notes

When deploying to production:

1. The `install.sh` script will:
   - Install all npm dependencies (including TypeScript)
   - Build the TypeScript application
   - Configure systemd to run the compiled output
   - Fall back to legacy JavaScript if build fails

2. The systemd service will:
   - Prefer `dist/lightroute.js` if available
   - Fall back to `lightroute.js` if compiled output not found
   - This ensures compatibility during transition

3. For manual deployment without install.sh:
   ```bash
   npm install
   npm run build
   # Then use dist/lightroute.js as the main executable
   ```

## Current Status

- **TypeScript migration**: Complete
- **Build system**: Working
- **Type checking**: Enabled via `npm run lint`
- **Development workflow**: Supports both `ts-node` and compiled runs
- **Next steps**: Monitor for any runtime issues with compiled output
