#!/bin/sh
# Installs the electron2web command globally, so it works in any Electron app folder.
set -e
cd "$(dirname "$0")"
echo "Installing electron2web globally..."
npm install -g ./electron2web-0.1.0-beta.2.tgz
echo
echo "Done. In any Electron app folder, run:"
echo "    electron2web -- npm start"
