'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { builtinModules } = require('node:module');
const esbuild = require('esbuild');
const log = require('./log.cjs');

const RUNTIME_ENTRY = path.join(__dirname, 'client', 'runtime.js');
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const MAP_PATH = '/__electron2web/map';

// Source maps are served separately (DevTools only fetches them when open), keyed by the
// hash of the code they belong to, so the scripts themselves stay small.
const sourceMaps = new Map();

const shimPlugin = {
  name: 'electron2web-shims',
  setup(build) {
    build.onResolve({ filter: /^electron(\/(renderer|common))?$/ }, (args) => ({ path: args.path, namespace: 'electron2web-electron' }));
    build.onLoad({ filter: /.*/, namespace: 'electron2web-electron' }, () => ({
      contents: 'module.exports = globalThis.__electronShim;',
      loader: 'js',
    }));

    build.onResolve({ filter: /^(node:)?[a-z_][a-z0-9_/]*$/ }, (args) =>
      NODE_BUILTINS.has(args.path) ? { path: args.path, namespace: 'electron2web-builtin' } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: 'electron2web-builtin' }, (args) => ({
      contents: `module.exports = globalThis.__electronShim.unsupportedModule(${JSON.stringify(args.path)});`,
      loader: 'js',
    }));
  },
};

const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);

// Bundles one entry and returns { code, hash, inputs }, with the source map stored aside.
async function bundle(options) {
  const result = await esbuild.build({
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    sourcemap: 'external',
    outfile: 'bundle.js',
    metafile: true,
    logLevel: 'silent',
    ...options,
  });
  const code = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const map = result.outputFiles.find((file) => file.path.endsWith('.map'))?.text;
  const hash = hashOf(code);
  if (map) sourceMaps.set(hash, map);
  const inputs = Object.keys(result.metafile.inputs)
    .filter((input) => !input.startsWith('electron2web-'))
    .map((input) => path.resolve(input));
  return { code: map ? `${code}//# sourceMappingURL=${MAP_PATH}/${hash}.js.map\n` : code, hash, inputs };
}

let runtimeBuild = null;

// The runtime never changes while the bridge runs, so it is built once and served under a
// URL that contains its hash (cached by the browser for good).
function getRuntime() {
  runtimeBuild ??= bundle({
    entryPoints: [RUNTIME_ENTRY],
    // The default build compiles record readers with `new Function`, which the app's CSP
    // usually blocks. Its eval probe runs before the CSP <meta> is parsed, so it can't tell.
    // (esbuild resolves alias targets from the cwd — the user's app — so pass an absolute path.)
    alias: { msgpackr: require.resolve('msgpackr/index-no-eval') },
  }).catch((err) => {
    runtimeBuild = null;
    throw err;
  });
  return runtimeBuild;
}

// Preload path → { promise, result }. A cached build is reused until one of the files it
// was built from changes, so reloading a window doesn't wait on esbuild.
const preloads = new Map();

async function isFresh(result) {
  try {
    const stats = await Promise.all(result.inputs.map((file) => fs.promises.stat(file)));
    return stats.every((stat, index) => stat.mtimeMs === result.mtimes[index]);
  } catch {
    return false;
  }
}

async function buildPreload(preloadPath) {
  try {
    const result = await bundle({
      entryPoints: [preloadPath],
      // Preloads see `process`/`global` from Electron; keep them out of the page's global scope.
      define: { process: 'globalThis.__electronShim.process', global: 'globalThis' },
      plugins: [shimPlugin],
    });
    result.mtimes = await Promise.all(result.inputs.map((file) => fs.promises.stat(file).then((stat) => stat.mtimeMs, () => -1)));
    return result;
  } catch (err) {
    const message = `failed to bundle preload ${preloadPath}:\n${err.message}`;
    log.error(message);
    const code = `console.error(${JSON.stringify(`[electron2web] ${message}`)});`;
    return { code, hash: hashOf(code), inputs: [preloadPath], mtimes: [NaN] };
  }
}

async function getPreload(preloadPath) {
  if (!preloadPath) return { code: '/* no preload configured */', hash: 'none' };
  const cached = preloads.get(preloadPath);
  if (cached && (await isFresh(await cached))) return cached;
  // Another request may have started a rebuild while this one checked.
  if (preloads.get(preloadPath) !== cached) return preloads.get(preloadPath);
  const previous = cached && (await cached);
  const pending = buildPreload(preloadPath);
  preloads.set(preloadPath, pending);
  const result = await pending;
  if (previous && previous.hash !== result.hash) sourceMaps.delete(previous.hash);
  return result;
}

function getSourceMap(hash) {
  return sourceMaps.get(hash);
}

module.exports = { getRuntime, getPreload, getSourceMap };
