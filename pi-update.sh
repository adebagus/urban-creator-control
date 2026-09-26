#!/bin/bash
# Manual update for the Raspberry Pi install made by pi-install.sh.
#
# EXPERIMENTAL / UNTESTED: like pi-install.sh, this has NOT been tested by Urban Creator on real
# Raspberry Pi hardware. Run it yourself, on purpose - the application never updates itself.
#
# It fast-forwards ~/urban-creator-control to the latest master of
# https://github.com/adebagus/urban-creator-control, shows what will change and asks first. It never
# discards local changes (no "git reset --hard"): if you changed files in the folder, it stops.
# master is the development branch and can contain changes nobody has tested on a Pi yet.

cd ~/urban-creator-control || { echo "[FAILED] ~/urban-creator-control not found. Run pi-install.sh first."; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "[STOPPED] There are local changes in ~/urban-creator-control. Commit or undo them first:"
  git status --short
  exit 1
fi

git fetch origin || { echo "[FAILED] Could not reach GitHub."; exit 1; }

if [ -z "$(git log --oneline HEAD..origin/master)" ]; then
  echo "Already up to date."
  exit 0
fi

echo "Changes that will be installed:"
git log --oneline HEAD..origin/master | head -30
read -r -p "Update now? [y/N] " answer
case "$answer" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled, nothing changed."; exit 0 ;;
esac

git merge --ff-only origin/master || { echo "[FAILED] Cannot fast-forward. Nothing was changed."; exit 1; }

. ~/.nvm/nvm.sh
npm install
npm rebuild
~/urban-creator-control/node_modules/.bin/electron-rebuild
echo "[COMPLETE] Updated. Start Urban Creator CONTROL again."
