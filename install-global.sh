#!/bin/sh
# Installs the electron-tab command globally, so it works in any Electron app folder.
set -e
cd "$(dirname "$0")"
echo "Installing electron-tab globally..."
npm install -g ./electron-tab-0.1.0.tgz
echo
echo "Done. In any Electron app folder, run:"
echo "    electron-tab -- npm start"
