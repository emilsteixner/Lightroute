#!/bin/bash

################################################################################
# Lightroute Install Script (FIXED)
# Installs Lightroute Art-Net forwarder on Raspberry Pi / Linux systems
################################################################################

set -e  # Exit on error

# Configuration
REPO_URL="https://github.com/emilsteixner/Lightroute.git"
APP_SUBDIR="application"
INSTALL_DIR="${INSTALL_DIR:-/usr/sbin/lightrouteService}"
NODE_VERSION_REQUIREMENT=">=18.0.0"
SERVICE_USER="lightroute"
SERVICE_NAME="lightroute"
TEMP_DIR=$(mktemp -d)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

################################################################################
# Helper Functions
################################################################################

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then 
        print_error "Please run as root (use sudo)"
        exit 1
    fi
}

cleanup() {
    print_status "Cleaning up temporary files..."
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

################################################################################
# Main Installation
################################################################################

print_header "Lightroute Installation Script"

check_root

print_status "Installation directory: $INSTALL_DIR"
print_status "Service user: $SERVICE_USER"
print_status "Service name: $SERVICE_NAME"
echo ""

################################################################################
# Install System Prerequisites
################################################################################

print_header "Installing System Prerequisites"

if [ -f /etc/debian_version ]; then
    print_status "Detected Debian-based system. Updating package lists..."
    apt-get update -qq
    
    print_status "Installing required packages..."
    apt-get install -y \
        curl \
        wget \
        git \
        unzip \
        gnupg \
        ca-certificates \
        build-essential
    
    print_status "Prerequisites installed successfully."
else
    print_error "This script is designed for Debian-based systems (Ubuntu, Raspberry Pi OS)."
    print_error "Please manually install git, unzip, and Node.js 18+."
    exit 1
fi

# Verify critical tools are now available
missing_tools=()
for tool in git curl wget unzip; do
    if ! command -v "$tool" &> /dev/null; then
        missing_tools+=("$tool")
    fi
done

if [ ${#missing_tools[@]} -gt 0 ]; then
    print_error "Failed to install required tools: ${missing_tools[*]}"
    exit 1
fi

print_status "All required tools are available: git, curl, wget, unzip"

################################################################################
# Check for existing Node.js installation
################################################################################

print_header "Checking Node.js Installation"

check_node_version() {
    if command -v node &> /dev/null && command -v npm &> /dev/null; then
        NODE_VERSION=$(node -v | sed 's/v//')
        print_status "Found Node.js version: $NODE_VERSION"
        
        NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
        if [ "$NODE_MAJOR" -ge 18 ]; then
            print_status "Node.js version meets requirements ($NODE_VERSION_REQUIREMENT)"
            return 0
        else
            print_warning "Node.js version is below requirement (>=18.x)"
            return 1
        fi
    else
        print_warning "Node.js or npm not found"
        return 1
    fi
}

if ! check_node_version; then
    print_status "Installing Node.js 20.x (LTS) via NodeSource..."
    
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    
    if command -v node &> /dev/null && command -v npm &> /dev/null; then
        print_status "Node.js installed successfully"
        print_status "  Node version: $(node -v)"
        print_status "  npm version:   $(npm -v)"
    else
        print_error "Failed to install Node.js or npm correctly."
        exit 1
    fi
fi

################################################################################
# Create service user
################################################################################

print_header "Creating Service User"

if id "$SERVICE_USER" &>/dev/null; then
    print_status "User $SERVICE_USER already exists"
else
    print_status "Creating user: $SERVICE_USER"
    useradd -r -s /bin/bash -d "$INSTALL_DIR" -c "Lightroute Service" "$SERVICE_USER"
    print_status "User created successfully"
fi

################################################################################
# Download repository
################################################################################

print_header "Downloading Lightroute"

print_status "Repository: $REPO_URL"
print_status "Temporary directory: $TEMP_DIR"

download_success=false

# Method 1: Try git clone
if command -v git &> /dev/null && [ "$download_success" = false ]; then
    print_status "Attempting download using git..."
    if git clone --depth 1 --quiet "$REPO_URL" "$TEMP_DIR/repo" 2>/dev/null; then
        download_success=true
        print_status "✓ Download successful via git"
    else
        print_warning "git clone failed, trying alternative methods..."
    fi
fi

# Method 2: Try wget + unzip
if command -v wget &> /dev/null && [ "$download_success" = false ]; then
    print_status "Attempting download using wget..."
    if wget -q --show-progress "$REPO_URL/archive/refs/heads/main.zip" -O "$TEMP_DIR/repo.zip"; then
        if unzip -q "$TEMP_DIR/repo.zip" -d "$TEMP_DIR" 2>/dev/null; then
            mv "$TEMP_DIR/Lightroute-main" "$TEMP_DIR/repo" 2>/dev/null
            download_success=true
            print_status "✓ Download successful via wget"
        else
            print_warning "wget download succeeded but unzip failed"
        fi
    else
        print_warning "wget download failed"
    fi
fi

# Method 3: Try curl + unzip
if command -v curl &> /dev/null && [ "$download_success" = false ]; then
    print_status "Attempting download using curl..."
    if curl -sL "$REPO_URL/archive/refs/heads/main.zip" -o "$TEMP_DIR/repo.zip"; then
        if unzip -q "$TEMP_DIR/repo.zip" -d "$TEMP_DIR" 2>/dev/null; then
            mv "$TEMP_DIR/Lightroute-main" "$TEMP_DIR/repo" 2>/dev/null
            download_success=true
            print_status "✓ Download successful via curl"
        else
            print_warning "curl download succeeded but unzip failed"
        fi
    else
        print_warning "curl download failed"
    fi
fi

if [ "$download_success" = false ]; then
    print_error "All download methods failed!"
    print_error "Please check your internet connection and try again."
    exit 1
fi

# Verify the application directory exists
if [ ! -d "$TEMP_DIR/repo/$APP_SUBDIR" ]; then
    print_error "Application directory not found at: $TEMP_DIR/repo/$APP_SUBDIR"
    print_status "Contents of downloaded repository:"
    ls -la "$TEMP_DIR/repo/" 2>/dev/null || echo "Unable to list directory"
    exit 1
fi

print_status "Repository downloaded and verified"

################################################################################
# Install application files
################################################################################

print_header "Installing Application Files"

# Backup existing installation if present
if [ -d "$INSTALL_DIR" ] && [ "$(ls -A $INSTALL_DIR 2>/dev/null)" ]; then
    print_warning "Existing installation found. Creating backup..."
    BACKUP_DIR="${INSTALL_DIR}_backup_$(date +%Y%m%d_%H%M%S)"
    mv "$INSTALL_DIR" "$BACKUP_DIR"
    print_status "Backup created at: $BACKUP_DIR"
fi

print_status "Creating installation directory..."
mkdir -p "$INSTALL_DIR"

print_status "Copying application files..."
cp -r "$TEMP_DIR/repo/$APP_SUBDIR/"* "$INSTALL_DIR/"

# Handle lightroute.js location
if [ ! -f "$INSTALL_DIR/lightroute.js" ]; then
    if [ -f "$TEMP_DIR/repo/lightroute.js" ]; then
        cp "$TEMP_DIR/repo/lightroute.js" "$INSTALL_DIR/"
        print_status "Copied lightroute.js from repo root"
    else
        print_warning "lightroute.js not found in expected locations"
    fi
fi

print_status "Files copied successfully"

################################################################################
# Create or copy package.json
################################################################################

print_header "Setting Up package.json"

if [ -f "$TEMP_DIR/repo/package.json" ]; then
    print_status "Found package.json in repo root, copying..."
    cp "$TEMP_DIR/repo/package.json" "$INSTALL_DIR/"
elif [ -f "$TEMP_DIR/repo/$APP_SUBDIR/package.json" ]; then
    print_status "Found package.json in application subdirectory, copying..."
    cp "$TEMP_DIR/repo/$APP_SUBDIR/package.json" "$INSTALL_DIR/"
else
    print_status "No package.json found in repository. Creating minimal package.json..."
    
    cat > "$INSTALL_DIR/package.json" <<EOF
{
  "name": "lightroute",
  "version": "1.0.0",
  "description": "Art-Net forwarder for remote lighting control",
  "main": "lightroute.js",
  "scripts": {
    "start": "node lightroute.js",
    "test": "node lightroute.js -v"
  },
  "dependencies": {
    "express": "^4.18.2",
    "body-parser": "^1.20.2"
  },
  "author": "",
  "license": "MIT"
}
EOF
    
    print_status "✓ Created minimal package.json with Express and body-parser"
fi

print_status "package.json is now available at $INSTALL_DIR/package.json"

################################################################################
# FIX: Set ownership and permissions BEFORE npm install
################################################################################

print_header "Setting Permissions and Ownership"

print_status "Setting ownership to $SERVICE_USER..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

print_status "Setting directory permissions..."
find "$INSTALL_DIR" -type d -exec chmod 755 {} \;
find "$INSTALL_DIR" -type f -exec chmod 644 {} \;

# Make scripts executable
if [ -f "$INSTALL_DIR/lightroute.js" ]; then
    chmod +x "$INSTALL_DIR/lightroute.js"
    print_status "Made lightroute.js executable"
fi

if [ -f "$INSTALL_DIR/install.sh" ]; then
    chmod +x "$INSTALL_DIR/install.sh"
fi

print_status "Permissions and ownership set successfully"

################################################################################
# Install Node.js dependencies (NOW the directory is owned by lightroute)
################################################################################

print_header "Installing Dependencies"

print_status "Changing to installation directory..."
cd "$INSTALL_DIR"

if [ ! -f "package.json" ]; then
    print_error "package.json not found in $INSTALL_DIR"
    print_status "Contents of installation directory:"
    ls -la "$INSTALL_DIR"
    exit 1
fi

print_status "Installing npm dependencies (production only)..."
# Run as the service user - NOW IT CAN WRITE!
su -s /bin/bash -c "cd $INSTALL_DIR && npm install --production --no-optional --silent" "$SERVICE_USER"

print_status "Dependencies installed successfully"

################################################################################
# Create systemd service
################################################################################

print_header "Creating Systemd Service"

SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

print_status "Creating service file: $SERVICE_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Lightroute Art-Net Forwarder
Documentation=https://github.com/emilsteixner/Lightroute
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/lightroute.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Network capabilities for Art-Net (UDP 6454)
AmbientCapabilities=CAP_NET_BIND_SERVICE

# Resource limits
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

print_status "Reloading systemd daemon..."
systemctl daemon-reload

print_status "Enabling service to start on boot..."
systemctl enable "$SERVICE_NAME"

################################################################################
# Create configuration directory and default config
################################################################################

print_header "Setting Up Configuration"

CONFIG_DIR="$INSTALL_DIR/config"
mkdir -p "$CONFIG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"

# Create default config if it doesn't exist
DEFAULT_CONFIG="$INSTALL_DIR/config.json"
if [ ! -f "$DEFAULT_CONFIG" ]; then
    print_status "Creating default configuration..."
    cat > "$DEFAULT_CONFIG" <<EOF
{
  "outbound_nodes": [],
  "bandwidth_save": false
}
EOF
    chown "$SERVICE_USER:$SERVICE_USER" "$DEFAULT_CONFIG"
    chmod 644 "$DEFAULT_CONFIG"
    print_status "Default config created at: $DEFAULT_CONFIG"
fi

################################################################################
# Final verification
################################################################################

print_header "Verifying Installation"

errors_found=0

if [ ! -f "$INSTALL_DIR/lightroute.js" ]; then
    print_error "lightroute.js not found in installation directory"
    errors_found=$((errors_found + 1))
fi

if [ ! -f "$INSTALL_DIR/package.json" ]; then
    print_error "package.json not found in installation directory"
    errors_found=$((errors_found + 1))
fi

if [ ! -f "$INSTALL_DIR/node_modules/express/package.json" ]; then
    print_error "Express dependency not installed"
    errors_found=$((errors_found + 1))
fi

if ! systemctl is-enabled "$SERVICE_NAME" &>/dev/null; then
    print_error "Service not enabled"
    errors_found=$((errors_found + 1))
fi

if [ $errors_found -eq 0 ]; then
    print_status "✓ All verifications passed"
else
    print_warning "⚠ $errors_found verification(s) failed"
fi

################################################################################
# Final steps and summary
################################################################################

print_header "Installation Complete"

echo ""
if [ $errors_found -eq 0 ]; then
    print_status "Lightroute has been successfully installed!"
else
    print_warning "Installation completed with $errors_found error(s)"
fi
echo ""
echo -e "${GREEN}Installation Details:${NC}"
echo "  Installation Directory: $INSTALL_DIR"
echo "  Service Name:           $SERVICE_NAME"
echo "  Service User:           $SERVICE_USER"
echo "  Config File:            $DEFAULT_CONFIG"
echo ""
echo -e "${GREEN}System Tools:${NC}"
echo "  Git:                    $(git --version | head -1)"
echo "  Node.js:                $(node -v)"
echo "  npm:                    $(npm -v)"
echo ""
echo -e "${GREEN}Installed Dependencies:${NC}"
if [ -d "$INSTALL_DIR/node_modules" ]; then
    echo "  Installed modules:"
    ls "$INSTALL_DIR/node_modules" | head -20
fi
echo ""
echo -e "${GREEN}Service Management:${NC}"
echo "  Start service:          systemctl start $SERVICE_NAME"
echo "  Stop service:           systemctl stop $SERVICE_NAME"
echo "  Restart service:        systemctl restart $SERVICE_NAME"
echo "  Enable on boot:         systemctl enable $SERVICE_NAME" (enabled by default)
echo "  Check status:           systemctl status $SERVICE_NAME"
echo "  View logs:              journalctl -u $SERVICE_NAME -f"
echo ""
echo -e "${GREEN}Access:${NC}"
echo "  Web UI:                 http://<device-ip>:3000"
echo "  Art-Net Port:           6454 (UDP)"
echo ""
print_warning "Next steps:"
echo "  1. Start the service: sudo systemctl start $SERVICE_NAME"
echo "  2 Check status: sudo systemctl status $SERVICE_NAME"
echo ""

print_status "Installation script finished!"