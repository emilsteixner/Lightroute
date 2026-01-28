# Lightroute
Lightroute is a ArtNet and sACN over Internet Architecture based on Raspberrypi CM4 hardware and Linux Debian, leveraging technologies like Tailscale and Node.Js

# Install Lightroute on your Embedded Device

## The Lazy Install

Works For Debian13 Binaries with WGET installed.

```shell
wget https://raw.githubusercontent.com/emilsteixner/Lightroute/main/install.sh && sudo chmod +x install.sh && sudo ./install.sh
```

## Semi - Automatic Install

1. Install Git

   ```shell
   sudo apt update
   sudo apt upgrade
   sudo apt-get install git
   ```
1. clone github Repoy

   ```shell
   sudo git clone --recursive https://github.com/emilsteixner/Lightroute.git
   ```

  1. Optional: Edit Install Location

     ```shell
     sudo nano ./Lightroute/install.sh
     ```
      Edit `INSTALL_DIR="${INSTALL_DIR:-/usr/sbin/lightrouteService}"`
   
1. run install.sh (installs Dependencies)

   ```shell
   cd Lightroute
   sudo chmod +x ./install.sh
   sudo ./install.sh
   cd ~/
   ```
1. start service

   ```shell
   sudo systemctl start LightrouteService
   ```
1. Clean up

   ```shell
   sudo rm -rf ./Lightroute/
   ```
