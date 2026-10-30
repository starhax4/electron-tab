#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE = `Usage: electron2web [options] [-- <command that starts electron>]

Options:
  --port <n>         port for the bridge (default 4400)
  --layout <name>    desktop (default): every window is a panel you can move and resize
                     tabs: one window at a time, with a tab strip
                     single: the main window fills the tab, no shell
  --native <list>    keep these features on the host's real OS UI instead of the tab,
                     e.g. --native dialog,notification (or --native all)
  --public-host <url>
                     also accept requests for this address, e.g. the URL of a
                     cloudflared/ngrok/localtunnel tunnel or an nginx proxy in front of
                     the bridge: --public-host https://abc.trycloudflare.com
                     Anyone with the printed link controls the app's main process.
  --open             open the app in your default browser once it is ready
  --debug            log every window state change and IPC call
  --new-token        replace the saved access token (signs out every open tab)

Examples:
  electron2web                         # runs "npx electron ."
  electron2web -- npm run dev          # wraps your existing dev script
  electron2web yarn start              # the -- is optional
  electron2web --open -- npm run dev   # also opens the browser
  electron2web --port 5000 --layout tabs -- npx electron-vite dev
  electron2web --public-host https://abc.trycloudflare.com -- npm run dev`;

const LAYOUTS = ['desktop', 'tabs', 'single'];

// chalk ships with the package, but a broken install should still get a readable message
// from checkDependencies(), so fall back to plain output.
function loadLogger() {
  try {
    return require('../src/log.cjs');
  } catch {
    const c = new Proxy((value) => value, { get: () => c });
    const print = (stream) => (...args) => stream('[electron2web]', ...args);
    return { c, level: 0, info: print(console.log), warn: print(console.warn), error: print(console.error), url: c };
  }
}
const log = loadLogger();
const { c } = log;

function usage() {
  return USAGE.replace(/^(Usage|Options|Examples):/gm, (title) => c.bold(title))
    .replace(/^ {2}(--?[\w-]+(?: <[\w-]+>)?)/gm, (_, flag) => `  ${c.cyan(flag)}`)
    .replace(/# .*$/gm, (comment) => c.dim(comment));
}

function fail(message) {
  console.error(`${c.red.bold('error')} ${message}\n\n${usage()}`);
  process.exit(1);
}

const TOKEN_FILE = path.join(os.homedir(), '.electron2web', 'token');

function parseArgs(argv) {
  const opts = { port: 4400, newToken: false, open: false, debug: false, layout: 'desktop', native: '', publicHost: '', command: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts.command = argv.slice(i + 1);
      break;
    } else if (arg === '--open') {
      opts.open = true;
    } else if (arg === '--debug') {
      opts.debug = true;
    } else if (arg === '--new-token') {
      opts.newToken = true;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++i]);
    } else if (arg === '--layout') {
      opts.layout = argv[++i];
    } else if (arg === '--native') {
      opts.native = argv[++i] ?? '';
    } else if (arg === '--public-host') {
      opts.publicHost = parsePublicHost(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      // PowerShell drops a bare `--` when calling npm's .ps1 shim, so the command arrives
      // without it. The first non-option argument starts the command either way.
      opts.command = argv.slice(i);
      break;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    fail('Invalid --port value.');
  }
  if (!LAYOUTS.includes(opts.layout)) {
    fail(`Invalid --layout value (use ${LAYOUTS.join(', ')}).`);
  }
  if (opts.command.length === 0) opts.command = ['npx', 'electron', '.'];
  return opts;
}

// Accepts a bare host (https is assumed, as tunnels serve https) or an origin URL.
function parsePublicHost(value) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value ?? '') ? value : `https://${value}`);
  } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.username) {
    fail(`Invalid --public-host value '${value ?? ''}' (expected e.g. https://abc.trycloudflare.com).`);
  }
  if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
    log.warn(`--public-host ${url.origin} is plain http: the access token and cookie cross the network unencrypted. Use an https tunnel.`);
  }
  return url.origin;
}

function createOpenMarker() {
  const marker = path.join(os.tmpdir(), `electron2web-open-${process.pid}`);
  try {
    fs.writeFileSync(marker, '');
    return marker;
  } catch {
    return '';
  }
}

function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

// The token is kept between runs so open tabs and bookmarks keep working after a restart.
function loadToken(forceNew) {
  if (!forceNew) {
    try {
      const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (/^[\w-]{32,}$/.test(saved)) return saved;
    } catch {}
  }
  const token = randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (err) {
    log.warn(`could not save token (${err.message}); open tabs will need the new URL after each restart.`);
  }
  return token;
}

// The bridge runs inside Electron and needs these next to the package. A folder installed
// with `npm install <path>` is only symlinked, without its dependencies.
function checkDependencies() {
  const packageDir = path.join(__dirname, '..');
  const missing = ['ws', 'msgpackr', 'esbuild'].filter((name) => {
    try {
      require.resolve(name, { paths: [packageDir] });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length === 0) return;
  console.error(`${c.red.bold('[electron2web] missing dependencies:')} ${missing.join(', ')}

Fix one of these ways:
  - install the packed version into your app (brings its dependencies along):
      npm install -D <path>/electron2web-<version>.tgz
  - or install them in the tool's own folder:
      cd "${packageDir}"
      npm install`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
checkDependencies();
const token = loadToken(opts.newToken);
// Forward slashes keep NODE_OPTIONS parsing simple on Windows.
const hookPath = path.join(__dirname, '..', 'src', 'hook.cjs').replace(/\\/g, '/');

const env = {
  ...process.env,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${hookPath}"`.trim(),
  ELECTRON2WEB_PORT: String(opts.port),
  ELECTRON2WEB_TOKEN: token,
  ELECTRON2WEB_LAYOUT: opts.layout,
  ELECTRON2WEB_NATIVE: opts.native,
  ...(opts.debug && { ELECTRON2WEB_DEBUG: '1' }),
  // The bridge opens the browser once, then removes this marker so Electron restarts don't.
  ...(opts.open && { ELECTRON2WEB_OPEN: createOpenMarker() }),
  ELECTRON2WEB_PUBLIC_HOST: opts.publicHost,
  // Electron's stdout may not look like a terminal; pass our color support down.
  ELECTRON2WEB_COLOR: String(log.level),
};

console.log();
log.info(`starting ${c.bold(opts.command.join(' '))}`);
log.info(c.dim('the link to open is printed once Electron is up\n'));

const child = spawn(opts.command.map(quote).join(' '), { shell: true, stdio: 'inherit', env });

// On Windows the shell wrapper doesn't forward signals, so Electron and the dev server
// would outlive us; kill the whole tree instead.
function stopChild(signal) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stopChild(signal));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
