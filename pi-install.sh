echo "---------------------------------------------------"
echo "[STARTING]  URBAN CREATOR CONTROL INSTALL SCRIPT:  "
echo "            Please wait for each step to complete. "
echo "---------------------------------------------------"
echo "WARNING: EXPERIMENTAL - this Raspberry Pi install path has NOT been"
echo "tested by Urban Creator on real Raspberry Pi hardware. It is provided"
echo "as-is, use it at your own risk. (Inherited from upstream OpenBuilds CONTROL.)"
echo "---------------------------------------------------"
# Assumes: Raspberry Pi OS, the default user "pi" (the icon path in pi-shortcut.desktop is /home/pi/...),
# and a working internet connection. The application does NOT update itself: run pi-update.sh manually.
echo "(1/10) Updating Repositories..."
sudo apt-get update
echo "(2/10) Upgrading RaspiOS..."
sudo apt-get upgrade -y
echo "(3/10) Installing local and remote desktop (LightDM, TightVNC and XRDP)..."
sudo apt install -y tightvncserver xrdp lightdm
echo "(4/10) Installing GIT..."
sudo apt-get install -y git
echo "(5/10) Installing NVM and NodeJS..."
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install lts/iron
nvm alias default lts/iron
echo "(6/10) Updating npm..."
nvm install-latest-npm
echo "(7/10) Downloading Urban Creator CONTROL source code..."
cd ~; git clone https://github.com/adebagus/urban-creator-control.git || { echo "[FAILED] Could not download the source code. Stopping."; exit 1; }
cd ~/urban-creator-control || { echo "[FAILED] ~/urban-creator-control not found. Stopping."; exit 1; }
echo "(8/10) Installing Urban Creator CONTROL dependencies..."
npm install
echo "(9/10) Recompiling Urban Creator CONTROL dependencies..."
npm rebuild
npm install electron-rebuild
~/urban-creator-control/node_modules/.bin/electron-rebuild
echo "(10/10) Creating Menu and Desktop Shortcuts..."
cp ~/urban-creator-control/pi-shortcut.desktop ~/Desktop/urban-creator-control.desktop
sudo cp ~/urban-creator-control/pi-shortcut.desktop /usr/share/applications/urban-creator-control.desktop
echo "---------------------------------------------------"
echo "[COMPLETE] Install Complete!  Thank you!"
echo "To update later, run ~/urban-creator-control/pi-update.sh yourself."
echo "---------------------------------------------------"
