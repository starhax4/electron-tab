'use strict';

// Loaded into every Node process started under `electron-tab` (via NODE_OPTIONS),
// including npm, Vite and electron-vite. It only acts inside Electron's main process.
if (!process.versions.electron) return;

const GUARD = Symbol.for('electron-tab.hook');
if (globalThis[GUARD]) return;
globalThis[GUARD] = true;

const Module = require('node:module');

let patched = null;
const originalLoad = Module._load;

Module._load = function (request, ...rest) {
  const loaded = originalLoad.call(this, request, ...rest);
  // process.type is not always set yet when NODE_OPTIONS preloads run, so check lazily.
  if (request !== 'electron' || process.type !== 'browser') return loaded;
  patched ??= safeInstall(loaded);
  return patched;
};

// If the bridge can't start, say why and let the app run as a normal Electron window
// rather than crashing it with an error dialog.
function safeInstall(electron) {
  try {
    return install(electron);
  } catch (err) {
    console.error(`\n[electron-tab] could not start the bridge; running as plain Electron instead.\n  ${err.message}`);
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error(`  Install electron-tab's dependencies: run "npm install" in ${require('node:path').dirname(__dirname)}\n`);
    }
    return electron;
  }
}

function install(electron) {
  const { createBridge } = require('./bridge-server.cjs');
  const patches = require('./patches/index.cjs');
  const bridge = createBridge({
    electron,
    port: Number(process.env.ELECTRON_TAB_PORT || 4400),
    token: process.env.ELECTRON_TAB_TOKEN,
    layout: process.env.ELECTRON_TAB_LAYOUT || 'desktop',
    publicUrl: process.env.ELECTRON_TAB_PUBLIC_HOST || null,
  });
  // Keep the token out of processes the app spawns and of crash reports that capture the env.
  delete process.env.ELECTRON_TAB_TOKEN;

  // `--native dialog,notification` keeps those features on the host's real OS UI.
  const native = new Set((process.env.ELECTRON_TAB_NATIVE || '').split(',').map((name) => name.trim()).filter(Boolean));
  const surface = (name) => (native.has(name) || native.has('all') ? 'native' : 'web');

  const overrides = {};
  for (const patch of patches) Object.assign(overrides, patch.install(electron, { bridge, surface }));

  // Electron's exports are lazy getters; mirror them and swap only what a patch replaced.
  const exports = {};
  for (const key of Object.keys(electron)) {
    Object.defineProperty(exports, key, {
      enumerable: true,
      get: () => (key in overrides ? overrides[key] : electron[key]),
    });
  }
  return exports;
}
