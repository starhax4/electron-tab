'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { fileURLToPath } = require('node:url');
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const { WebSocketServer } = require('ws');
const codec = require('./codec.cjs');
const { getRuntime, getPreload, getSourceMap } = require('./bundler.cjs');
const logger = require('./log.cjs');

const PREFIX = '/__electron-tab';
const COOKIE = 'electron_tab_token';
// Chrome resolves *.localhost to loopback. The shell lives on app.localhost and each page
// origin the app loads gets its own o<n>.app.localhost. They all share the site
// "app.localhost", so the SameSite=Strict auth cookie is still sent inside the shell's iframes.
const SHELL_DOMAIN = 'app.localhost';
const CLIENT_DIR = path.join(__dirname, 'client');
const CALL_TIMEOUT_MS = 60_000;
const LAYOUTS = new Set(['desktop', 'tabs', 'single']);
const pack = (value) => Buffer.from(codec.pack(value));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

function createBridge({ electron, port, token, layout, publicUrl }) {
  if (!token) {
    throw new Error('[electron-tab] ELECTRON_TAB_TOKEN is missing — start the app through the electron-tab CLI.');
  }
  if (!LAYOUTS.has(layout)) throw new Error(`[electron-tab] unknown layout '${layout}' (use desktop, tabs or single)`);

  const log = logger.info;
  const windows = new Map();
  const globalHandlers = new Map();
  const shellHost = `${SHELL_DOMAIN}:${port}`;
  const legacyHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const tokenBuffer = Buffer.from(token);
  const wss = new WebSocketServer({ noServer: true });
  // Through a tunnel, IPC replies cross a slow upload link; compress the larger frames there.
  // (Locally, compression would only add latency.)
  const wssPublic = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });

  // --public-host: the address a tunnel or reverse proxy (cloudflared, ngrok, nginx, ...)
  // serves the bridge on. A tunnel gives one hostname, so there every window shares that one
  // origin instead of getting its own o<n> subdomain (see slotFor).
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const publicHost = publicOrigin ? new URL(publicOrigin).host : null;
  const publicDefaultPort = publicOrigin?.startsWith('https:') ? '443' : '80';

  // ---------------------------------------------------------------- origin slots

  // One browser origin per page origin the app loads (or per folder, for file:// pages), so
  // windows on the same origin share localStorage and cookies, as they do in Electron.
  const slots = new Map();
  const slotsByNumber = new Map();
  // On the public host, the first http(s) origin is served at the root (dev servers use
  // absolute paths) and loadFile() folders under PREFIX/s<n> (their builds use relative
  // paths). Any further http(s) origin has no place there; its windows stay local-only.
  let rootSlot = null;

  function slotFor(target) {
    const root = target.protocol === 'file:' ? path.dirname(fileURLToPath(target)) : null;
    const key = root ? `file:${root}` : target.origin;
    let slot = slots.get(key);
    if (!slot) {
      const number = slots.size + 1;
      const isHttp = target.protocol === 'http:' || target.protocol === 'https:';
      const publicBase = root ? `${PREFIX}/s${number}` : isHttp && !rootSlot ? '' : null;
      slot = { number, root, origin: root ? null : target.origin, protocol: target.protocol, host: `o${number}.${SHELL_DOMAIN}:${port}`, publicBase };
      if (publicBase === '') rootSlot = slot;
      slots.set(key, slot);
      slotsByNumber.set(number, slot);
    }
    return slot;
  }

  function windowsIn(slot) {
    return [...windows.values()].filter((state) => state.slot === slot);
  }

  // The path to load inside the window's origin.
  function pathFor(state) {
    const target = state.target;
    if (!target) return '/';
    if (target.protocol !== 'file:') return target.pathname + target.search + target.hash;
    const relative = path.relative(state.slot.root, fileURLToPath(target)).split(path.sep).map(encodeURIComponent).join('/');
    return `/${relative}${target.search}${target.hash}`;
  }

  // The path to load on the public host, or null when the window's origin can't be served there.
  function publicPathFor(state) {
    const base = state.slot?.publicBase;
    return base == null ? null : base + pathFor(state);
  }

  function isPublicHost(host) {
    return publicHost !== null && (host === publicHost || host === `${publicHost}:${publicDefaultPort}`);
  }

  function classifyHost(req) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host === shellHost) return { kind: 'shell' };
    if (isPublicHost(host)) return { kind: 'public' };
    if (legacyHosts.has(host)) {
      // A proxy that rewrites Host to the upstream address (nginx's default) still names the
      // public host here. Only local processes can reach this address, and a page can't set
      // the header cross-origin without a CORS preflight, which the bridge never grants.
      const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
      if (isPublicHost(forwarded)) return { kind: 'public' };
      if (req.headers['x-forwarded-for']) hintOnce('proxied', `a request came through a proxy as ${host}. To use electron-tab through a tunnel or proxy, start it with --public-host <its public URL>.`);
      return { kind: 'legacy' };
    }
    const match = /^o(\d+)\.app\.localhost:(\d+)$/.exec(host);
    const slot = match && Number(match[2]) === port ? slotsByNumber.get(Number(match[1])) : null;
    if (slot) return { kind: 'slot', slot };
    if (req.headers['x-forwarded-for']) hintOnce(`host:${host}`, `refused a proxied request for host '${host}'. If that is your tunnel, restart with --public-host https://${host}`);
    return null;
  }

  const hinted = new Set();
  function hintOnce(key, message) {
    if (hinted.has(key)) return;
    hinted.add(key);
    logger.warn(message);
  }

  function authUrl(host, next) {
    return `http://${host}${PREFIX}/auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  }

  function publicAuthUrl(next) {
    return `${publicOrigin}${PREFIX}/auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  }

  // ---------------------------------------------------------------- windows

  let viewport = { width: 1280, height: 800 };
  let focusedId = null;
  let focusHistory = [];

  function registerWindow(win, options, handlers) {
    const width = options.width ?? 800;
    const height = options.height ?? 600;
    const state = {
      id: win.id,
      win,
      options,
      handlers,
      target: null,
      slot: null,
      sockets: new Set(),
      shown: false,
      loadWaiters: [],
      // Bumped whenever the shell must point the window's iframe at a new URL.
      nav: 0,
      // Centred by us rather than placed by the app; refitted once the shell reports its size.
      autoPlaced: options.x === undefined || options.y === undefined,
      view: {
        visible: false,
        focused: false,
        minimized: false,
        maximized: false,
        fullscreen: false,
        bounds: { x: options.x ?? centered(viewport.width, width), y: options.y ?? centered(viewport.height, height), width, height },
        title: options.title ?? '',
      },
    };
    // The app's first window opens maximized, as an app's main window usually is. Fixed-size
    // and child windows keep their size; the tabs and single layouts fill the tab anyway.
    const maximized =
      layout === 'desktop' && windows.size === 0 && !options.parent && !options.fullscreen && options.maximizable !== false && options.resizable !== false;
    windows.set(win.id, state);
    // Bundle the preload now, so it is ready by the time the tab asks for it.
    getPreload(options.webPreferences?.preload).catch(() => {});
    if (options.webPreferences?.nodeIntegration) {
      logger.warn(`window ${win.id} uses nodeIntegration — Node APIs in its renderer will not work in the browser.`);
    }
    win.once('closed', () => {
      windows.delete(state.id);
      focusHistory = focusHistory.filter((id) => id !== state.id);
      if (focusedId === state.id) focusedId = null;
      broadcast(state, { type: 'closed' });
      // The page may still be sending (unload handlers, timers); its webContents is gone.
      for (const ws of state.sockets) ws.close(1000, 'window closed');
      broadcastShell({ type: 'removed', id: state.id });
      refocus();
    });
    setView(state.id, {
      visible: options.show !== false,
      focused: options.show !== false && options.focusable !== false,
      maximized,
      fullscreen: Boolean(options.fullscreen),
    });
  }

  function view(id) {
    return windows.get(id)?.view ?? {};
  }

  function targetOf(id) {
    return windows.get(id)?.target?.href ?? null;
  }

  function focusedWindowId() {
    return focusedId;
  }

  // Applies a change to a window's mirrored state, fires the matching BrowserWindow
  // events, and tells the shell. Called by the patched BrowserWindow methods and by the
  // shell when the user moves, focuses or minimises a panel.
  function setView(id, changes) {
    const state = windows.get(id);
    if (!state) return;
    logger.debug(`window ${id} state`, JSON.stringify(changes));
    const view = state.view;
    const before = { ...view, bounds: { ...view.bounds } };

    if (changes.bounds) {
      changes = { ...changes, bounds: normalizeBounds({ ...view.bounds, ...changes.bounds }) };
      state.autoPlaced = false;
    }
    if (changes.visible === false || changes.minimized === true) changes = { ...changes, focused: false };
    Object.assign(view, changes);

    if (view.focused && focusedId !== id) {
      const previous = focusedId;
      focusedId = id;
      focusHistory = [...focusHistory.filter((other) => other !== id), id];
      if (windows.has(previous)) setView(previous, { focused: false });
    } else if (!view.focused && focusedId === id) {
      focusedId = null;
    }

    emitViewEvents(state, before, view);
    broadcastShell({ type: 'window', view: describe(state) });
    if (before.focused && !view.focused && focusedId === null && !changes.focused) refocus(id);
  }

  // When the focused window hides, minimises or closes, focus goes to the window used before it.
  function refocus(except) {
    if (focusedId !== null) return;
    const next = [...focusHistory].reverse().find((id) => {
      const other = windows.get(id);
      return id !== except && other?.view.visible && !other.view.minimized;
    });
    if (next !== undefined) setView(next, { focused: true });
  }

  function center(id) {
    const { width, height } = view(id).bounds;
    setView(id, { bounds: { x: centered(viewport.width, width), y: centered(viewport.height, height) } });
  }

  // Like Electron on a small screen: shrink to the work area, then centre.
  function fitToViewport(id) {
    const bounds = view(id).bounds;
    const width = Math.min(bounds.width, viewport.width);
    const height = Math.min(bounds.height, viewport.height);
    setView(id, { bounds: { x: centered(viewport.width, width), y: centered(viewport.height, height), width, height } });
    windows.get(id).autoPlaced = true;
  }

  const VIEW_EVENTS = [
    ['visible', 'show', 'hide'],
    ['focused', 'focus', 'blur'],
    ['minimized', 'minimize', 'restore'],
    ['maximized', 'maximize', 'unmaximize'],
    ['fullscreen', 'enter-full-screen', 'leave-full-screen'],
  ];

  function emitViewEvents(state, before, after) {
    for (const [key, on, off] of VIEW_EVENTS) {
      if (before[key] !== after[key]) emitWindow(state, after[key] ? on : off);
    }
    const a = before.bounds;
    const b = after.bounds;
    if (a.width !== b.width || a.height !== b.height) emitWindow(state, 'resize', 'resized');
    if (a.x !== b.x || a.y !== b.y) emitWindow(state, 'move', 'moved');
  }

  function emitWindow(state, ...names) {
    for (const name of names) {
      try {
        state.win.emit(name, { sender: state.win, preventDefault() {} });
      } catch (err) {
        logger.error(`a '${name}' listener on window ${state.id} threw:`, err);
      }
    }
  }

  // The number people and agents see on a window's badge: the lowest one free when the window
  // first shows, so closing windows frees their numbers. (BrowserWindow.id never repeats.)
  function numberOf(state) {
    if (state.number || !state.view.visible || !state.slot) return state.number ?? null;
    const taken = new Set([...windows.values()].map((other) => other.number));
    state.number = 1;
    while (taken.has(state.number)) state.number++;
    return state.number;
  }

  // What the shell needs to draw a window's panel.
  function describe(state) {
    const { options } = state;
    return {
      id: state.id,
      number: numberOf(state),
      ...state.view,
      host: state.slot?.host ?? null,
      path: pathFor(state),
      publicPath: publicPathFor(state),
      nav: state.nav,
      modal: Boolean(options.modal && options.parent),
      parentId: options.parent?.id ?? null,
      frame: options.frame !== false,
      resizable: options.resizable !== false,
      minimizable: options.minimizable !== false,
      maximizable: options.maximizable !== false,
      closable: options.closable !== false,
      minWidth: options.minWidth ?? 0,
      minHeight: options.minHeight ?? 0,
    };
  }

  function setTarget(id, url) {
    const state = windows.get(id);
    if (!state) return Promise.resolve();
    const previousSlot = state.slot;
    state.target = new URL(url);
    state.slot = slotFor(state.target);
    log(`window ${logger.c.bold(id)} ${logger.c.dim('→')} ${state.target.href}`);
    // Same origin: the page navigates itself. Otherwise the shell repoints the iframe.
    if (state.slot === previousSlot && state.sockets.size > 0) broadcast(state, { type: 'navigate', path: pathFor(state) });
    else state.nav++;
    broadcastShell({ type: 'window', view: describe(state) });
    // Like Electron, loadURL() settles once the page (here: the browser tab) has loaded.
    return new Promise((resolve) => state.loadWaiters.push(resolve));
  }

  function reload(id) {
    const state = windows.get(id);
    if (!state) return;
    if (state.sockets.size > 0) return broadcast(state, { type: 'reload' });
    state.nav++;
    broadcastShell({ type: 'window', view: describe(state) });
  }

  function print(id) {
    const state = windows.get(id);
    if (state) broadcast(state, { type: 'print' });
  }

  function push(id, channel, args) {
    const state = windows.get(id);
    if (!state) return;
    let frame;
    try {
      frame = pack({ type: 'push', channel, args });
    } catch (err) {
      logger.warn(`could not serialize message on '${channel}': ${err.message}`);
      return;
    }
    for (const ws of state.sockets) ws.send(frame);
  }

  function broadcast(state, message) {
    const frame = pack(message);
    for (const ws of state.sockets) ws.send(frame);
  }

  function primaryWindow() {
    for (const state of windows.values()) if (state.target) return state;
    return null;
  }

  // ---------------------------------------------------------------- main → browser calls

  // Main can ask a window's page (target = window id) or the shell (target = 'shell') to do
  // something and reply. Calls wait for a tab to connect; after the timeout they reject with
  // code ETIMEDOUT so callers can fall back to native behaviour.
  const calls = new Map();
  let nextCallId = 1;

  function call(target, op, payload, { timeout = CALL_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      const timer = setTimeout(() => {
        calls.delete(id);
        const err = new Error(`[electron-tab] no browser tab answered '${op}' within ${timeout / 1000}s`);
        reject(Object.assign(err, { code: 'ETIMEDOUT' }));
      }, timeout);
      calls.set(id, { target, message: { type: 'call', id, op, payload }, socket: null, resolve, reject, timer });
      deliver(id);
    });
  }

  function socketFor(target) {
    const sockets = target === 'shell' ? shellSockets : windows.get(target)?.sockets;
    if (!sockets) return null;
    return [...sockets].reverse().find((ws) => ws.readyState === ws.OPEN) ?? null;
  }

  function deliver(id) {
    const pending = calls.get(id);
    const socket = socketFor(pending.target);
    pending.socket = socket;
    if (!socket) return;
    socket.send(pending.target === 'shell' ? JSON.stringify(pending.message) : pack(pending.message));
  }

  // A new socket picks up calls that were queued (or sent to a socket that has since closed).
  function redeliver(target) {
    for (const [id, pending] of calls) {
      if (pending.target === target && (!pending.socket || pending.socket.readyState !== pending.socket.OPEN)) deliver(id);
    }
  }

  // `from` is the window id (or 'shell') of the socket the result came in on: only the target
  // of a call may answer it.
  function settleCall({ id, value, error }, from) {
    const pending = calls.get(id);
    if (!pending || pending.target !== from) return;
    calls.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(Object.assign(new Error(error.message), { name: error.name ?? 'Error' }));
    else pending.resolve(value);
  }

  // Code runs from a same-origin <script src>, because the page's CSP usually blocks eval.
  const execScripts = new Map();

  async function executeJavaScript(id, code) {
    const key = randomBytes(12).toString('hex');
    let body;
    try {
      new Function(`return (${code}\n)`);
      body = `return (${code}\n);`;
    } catch {
      body = `${code}\n`;
    }
    execScripts.set(key, `globalThis.__electronTabExec(${JSON.stringify(key)}, async () => {\n${body}});`);
    try {
      return await call(id, 'executeJavaScript', { key });
    } finally {
      execScripts.delete(key);
    }
  }

  // ---------------------------------------------------------------- IPC

  function makeEvent(state) {
    const contents = state.win.webContents;
    const frame = {
      url: state.target?.href ?? '',
      origin: state.target?.origin ?? '',
      processId: -1,
      routingId: -1,
      frameTreeNodeId: -1,
      parent: null,
      send: (channel, ...args) => push(state.id, channel, args),
    };
    frame.top = frame;
    return {
      sender: contents,
      senderFrame: frame,
      frameId: -1,
      processId: -1,
      ports: [],
      returnValue: undefined,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      reply: (channel, ...args) => push(state.id, channel, args),
    };
  }

  // Electron delivers renderer messages to webContents.ipc first, then ipcMain.
  function emitIpc(state, channel, event, args) {
    state.win.webContents.ipc.emit(channel, event, ...args);
    electron.ipcMain.emit(channel, event, ...args);
  }

  async function handleInvoke(state, ws, { id, channel, args }) {
    const started = performance.now();
    let reply;
    try {
      const handler = state.handlers.get(channel) ?? globalHandlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      reply = { type: 'result', id, value: await handler(makeEvent(state), ...args) };
    } catch (err) {
      reply = { type: 'result', id, error: serializeError(err) };
    }
    let frame;
    try {
      frame = pack(reply);
    } catch (err) {
      frame = pack({ type: 'result', id, error: { name: 'Error', message: `An object could not be cloned. (${err.message})` } });
    }
    if (ws.readyState === ws.OPEN) ws.send(frame);
    logger.debug(`window ${state.id} invoke '${channel}' ${reply.error ? 'failed' : 'ok'} in ${(performance.now() - started).toFixed(1)}ms (${frame.length} bytes)`);
  }

  function handleLifecycle(state, eventName) {
    const contents = state.win.webContents;
    const event = { sender: contents, preventDefault() {} };
    if (eventName === 'dom-ready') {
      contents.emit('dom-ready', event);
    } else if (eventName === 'did-finish-load') {
      if (!state.shown) {
        state.shown = true;
        state.win.emit('ready-to-show', event);
      }
      contents.emit('did-finish-load', event);
      for (const resolve of state.loadWaiters.splice(0)) resolve();
    }
  }

  // Electron's window title follows the page title unless a listener prevents it.
  function handleTitle(state, title) {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    state.win.webContents.emit('page-title-updated', event, title, true);
    state.win.emit('page-title-updated', event, title, true);
    if (!event.defaultPrevented) setView(state.id, { title });
  }

  function attachSocket(state, ws) {
    state.sockets.add(ws);
    ws.on('close', () => {
      state.sockets.delete(ws);
      redeliver(state.id);
    });
    ws.on('message', (data) => {
      let message;
      try {
        message = codec.unpack(data);
      } catch (err) {
        logger.warn(`dropped malformed message: ${err.message}`);
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'call-result') return settleCall(message, state.id);
      if (!isAlive(state)) {
        logger.debug(`window ${state.id} is closed; dropped its '${message.type}' message`);
        if (message.type === 'invoke' && ws.readyState === ws.OPEN) {
          ws.send(pack({ type: 'result', id: message.id, error: { name: 'Error', message: 'The window was closed' } }));
        }
        return;
      }
      // A throw here would reach Electron as an uncaught exception and its crash dialog.
      try {
        if (message.type === 'invoke') {
          handleInvoke(state, ws, message);
        } else if (message.type === 'send') {
          logger.debug(`window ${state.id} send '${message.channel}'`);
          emitIpc(state, message.channel, makeEvent(state), message.args);
        } else if (message.type === 'lifecycle') {
          handleLifecycle(state, message.event);
        } else if (message.type === 'title') {
          handleTitle(state, String(message.title));
        } else if (message.type === 'focus') {
          if (state.view.visible && !state.view.focused) setView(state.id, { focused: true, minimized: false });
        }
      } catch (err) {
        logger.error(`window ${state.id}: handling '${message.type}'${message.channel ? ` on '${message.channel}'` : ''} threw:`, err);
      }
    });
    redeliver(state.id);
  }

  // False once the window is closed: its webContents is destroyed and can't be used.
  function isAlive(state) {
    return windows.get(state.id) === state && !state.win.isDestroyed();
  }

  async function handleSync(state, req, res) {
    if (!isAlive(state)) return send(res, 410, 'The window was closed');
    const { channel, args } = codec.unpack(await readBody(req));
    const event = makeEvent(state);
    emitIpc(state, channel, event, args);
    send(res, 200, pack({ value: event.returnValue }).toString('base64'), 'text/plain');
  }

  // ---------------------------------------------------------------- shell socket

  const shellSockets = new Set();
  // Only what the user can change by handling a panel; visibility stays main's call.
  const PANEL_FIELDS = ['focused', 'minimized', 'maximized', 'fullscreen', 'bounds'];

  function broadcastShell(message) {
    const frame = JSON.stringify(message);
    for (const ws of shellSockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  }

  function attachShell(ws) {
    shellSockets.add(ws);
    ws.on('close', () => {
      shellSockets.delete(ws);
      redeliver('shell');
    });
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      try {
        if (message.type === 'viewport') {
          viewport = { width: Number(message.width) || viewport.width, height: Number(message.height) || viewport.height };
          for (const state of windows.values()) if (state.autoPlaced) fitToViewport(state.id);
        } else if (message.type === 'panel') {
          const changes = {};
          for (const field of PANEL_FIELDS) if (field in (message.changes ?? {})) changes[field] = message.changes[field];
          setView(Number(message.id), changes);
        } else if (message.type === 'close') {
          const state = windows.get(Number(message.id));
          if (state && isAlive(state) && state.options.closable !== false) state.win.close();
        } else if (message.type === 'call-result') {
          settleCall(message, 'shell');
        }
      } catch (err) {
        logger.error(`shell: handling '${message.type}' threw:`, err);
      }
    });
    ws.send(JSON.stringify({ type: 'init', layout, windows: [...windows.values()].map(describe) }));
    redeliver('shell');
  }

  // ---------------------------------------------------------------- auth

  function tokenMatches(value) {
    if (!value) return false;
    const candidate = Buffer.from(value);
    return candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer);
  }

  // Requests that change state must come from the page's own origin.
  function sameOrigin(req, host) {
    const expected = host.kind === 'public' ? publicOrigin : `http://${String(req.headers.host).toLowerCase()}`;
    return req.headers.origin === expected;
  }

  // ---------------------------------------------------------------- HTTP

  async function handleRequest(req, res) {
    // Host check blocks DNS-rebinding pages from reaching the bridge.
    const host = classifyHost(req);
    if (!host) return send(res, 403, 'Forbidden host. To reach electron-tab through a tunnel or proxy, start it with --public-host <its URL>.');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isPublic = host.kind === 'public';

    if (url.pathname === `${PREFIX}/auth`) {
      if (!tokenMatches(url.searchParams.get('token'))) return send(res, 401, 'Invalid token');
      // No cookie on 127.0.0.1/localhost: cookies ignore ports, so every local server would get it.
      if (host.kind === 'legacy') return redirect(res, authUrl(shellHost, '/'));
      const secure = isPublic && publicOrigin.startsWith('https:') ? '; Secure' : '';
      res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
      // Navigate from a page on this origin rather than with a 302: if this request came from
      // another site (127.0.0.1 → app.localhost), a redirect would still count as cross-site
      // and the browser would hold back the Strict cookie on the next request.
      const next = JSON.stringify(safeNext(url.searchParams.get('next'))).replace(/</g, '\\u003c');
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>electron-tab</title><script>location.replace(${next})</script>`, 'text/html');
    }

    if (!tokenMatches(readCookie(req, COOKIE))) {
      return send(res, 401, page('Not authorized', '<p>Open the URL that <code>electron-tab</code> printed in your terminal.</p>'), 'text/html');
    }

    // Not on the app's own origins: its links carry the token, and the app's scripts could read them.
    if ((url.pathname === PREFIX || url.pathname === `${PREFIX}/`) && host.kind !== 'slot') {
      return send(res, 200, controlPage(isPublic), 'text/html');
    }
    if (url.pathname === `${PREFIX}/ping`) return send(res, 200, 'ok');
    // Machine-readable view of every window, for tests and browser agents.
    if (url.pathname === `${PREFIX}/state`) {
      const body = { layout, focusedWindowId: focusedId, focusedWindowNumber: windows.get(focusedId)?.number ?? null, windows: [...windows.values()].map((state) => ({ ...describe(state), url: state.target?.href ?? null })) };
      return send(res, 200, JSON.stringify(body, null, 2), 'application/json');
    }

    if (isPublic) return handlePublic(host, req, url, res);
    if (host.kind === 'slot') return handleSlot(host.slot, host, req, url, res);

    // `/?__ew_win=<id>` shows that one window on its own, without the shell.
    const requested = windows.get(Number(url.searchParams.get('__ew_win')));
    if (requested?.slot) return redirect(res, authUrl(requested.slot.host, pathFor(requested)));
    // Old bookmarks (127.0.0.1 / localhost) move to the shell.
    if (host.kind === 'legacy') return redirect(res, authUrl(shellHost, '/'));

    if (url.pathname === '/') {
      if (layout !== 'single') return send(res, 200, shellPage(false), 'text/html');
      const state = primaryWindow();
      if (state) return redirect(res, authUrl(state.slot.host, pathFor(state)));
      return waitingPage(res);
    }
    if (url.pathname === `${PREFIX}/shell.js` || url.pathname === `${PREFIX}/shell.css`) {
      return serveStatic(path.join(CLIENT_DIR, path.basename(url.pathname)), req, res);
    }
    return send(res, 404, 'Not found');
  }

  // The public host: the shell lives at PREFIX/app, loadFile() folders at PREFIX/s<n>/, and
  // everything else belongs to the root slot (the app's dev server).
  async function handlePublic(host, req, url, res) {
    const pathname = url.pathname;
    req.ewCompress = true;
    if (pathname === `${PREFIX}/app`) {
      if (layout !== 'single') return send(res, 200, shellPage(true), 'text/html');
      const state = primaryWindow();
      if (!state) return waitingPage(res);
      const target = publicPathFor(state);
      return target ? redirect(res, target) : send(res, 200, unreachablePage(state), 'text/html');
    }
    if (pathname === `${PREFIX}/shell.js` || pathname === `${PREFIX}/shell.css`) {
      return serveStatic(path.join(CLIENT_DIR, path.basename(pathname)), req, res);
    }
    if (pathname === `${PREFIX}/unreachable`) {
      const state = windows.get(Number(url.searchParams.get('win')));
      return state ? send(res, 200, unreachablePage(state), 'text/html') : send(res, 404, 'Not found');
    }
    const fileSlot = new RegExp(`^${PREFIX}/s(\\d+)(/.*)$`).exec(pathname);
    if (fileSlot) {
      const slot = slotsByNumber.get(Number(fileSlot[1]));
      return slot?.root ? serveFile(slot, req, fileSlot[2], res) : send(res, 404, 'Not found');
    }
    if (pathname.startsWith(`${PREFIX}/`)) return handleEndpoint(host, req, url, res);
    if (!rootSlot) return send(res, 404, 'Not found');
    return proxyHttp(rootSlot, req, res);
  }

  async function handleSlot(slot, host, req, url, res) {
    if (url.pathname.startsWith(`${PREFIX}/`)) return handleEndpoint(host, req, url, res);
    if (slot.protocol === 'file:') return serveFile(slot, req, url.pathname, res);
    if (slot.protocol === 'http:' || slot.protocol === 'https:') return proxyHttp(slot, req, res);
    return send(res, 501, `electron-tab cannot serve ${slot.protocol} URLs yet`);
  }

  // Whether a window's page may talk to the bridge from this host: on an o<n> host only that
  // slot's windows; on the public host (one origin for all) any window served there.
  function windowAllowed(host, state) {
    if (!state?.slot) return false;
    return host.kind === 'public' ? state.slot.publicBase != null : state.slot === host.slot;
  }

  // Endpoints a window's page calls. On the public host every slot shares one origin, so
  // loader.js learns its slot from the query rather than the host.
  async function handleEndpoint(host, req, url, res) {
    if (url.pathname === `${PREFIX}/loader.js`) {
      const slot = host.kind === 'slot' ? host.slot : slotsByNumber.get(Number(url.searchParams.get('slot')));
      const ids = slot ? windowsIn(slot).map((state) => state.id) : [];
      const runtime = `${PREFIX}/runtime.${(await getRuntime()).hash}.js`;
      return send(res, 200, `(${loader})(${JSON.stringify(ids)}, ${JSON.stringify(PREFIX)}, ${JSON.stringify(runtime)});`, 'text/javascript');
    }
    // The runtime's URL carries its hash, so the browser keeps it for good.
    const runtimeFile = new RegExp(`^${PREFIX}/runtime\\.(\\w+)\\.js$`).exec(url.pathname);
    if (runtimeFile) {
      const runtime = await getRuntime();
      if (runtime.hash !== runtimeFile[1]) return send(res, 404, 'Not found');
      return sendCached(req, res, runtime.code, 'text/javascript; charset=utf-8', { etag: `"${runtime.hash}"`, immutable: true });
    }
    const mapFile = new RegExp(`^${PREFIX}/map/(\\w+)\\.js\\.map$`).exec(url.pathname);
    if (mapFile) {
      const map = getSourceMap(mapFile[1]);
      return map ? sendCached(req, res, map, 'application/json; charset=utf-8', { etag: `"${mapFile[1]}"`, immutable: true }) : send(res, 404, 'Not found');
    }

    const endpoints = ['boot.js', 'preload.js', 'sync', 'exec'].map((name) => `${PREFIX}/${name}`);
    if (!endpoints.includes(url.pathname)) return send(res, 404, 'Not found');
    const state = windows.get(Number(url.searchParams.get('win')));
    if (!windowAllowed(host, state)) {
      if (url.pathname === `${PREFIX}/sync`) return send(res, 410, 'the window was closed');
      return send(res, 404, `console.error('[electron-tab] unknown window');`, 'text/javascript');
    }
    if (url.pathname === `${PREFIX}/boot.js`) {
      const base = host.kind === 'public' ? state.slot.publicBase : '';
      return sendCached(req, res, `globalThis.__ELECTRON_TAB__ = ${JSON.stringify(bootConfig(state, base))};\n`, 'text/javascript; charset=utf-8');
    }
    if (url.pathname === `${PREFIX}/preload.js`) {
      // Rebuilt only when one of its source files changed; otherwise the browser gets a 304.
      const preload = await getPreload(state.options.webPreferences?.preload);
      return sendCached(req, res, preload.code, 'text/javascript; charset=utf-8', { etag: `"${preload.hash}"` });
    }
    if (url.pathname === `${PREFIX}/exec`) {
      const script = execScripts.get(url.searchParams.get('key'));
      return script ? send(res, 200, script, 'text/javascript') : send(res, 404, 'Not found');
    }
    if (req.method !== 'POST' || !sameOrigin(req, host)) return send(res, 403, 'Forbidden');
    return handleSync(state, req, res);
  }

  // base: the path the window's slot is served under in this tab ('' except for loadFile()
  // folders on the public host), so navigations from main land in the right place.
  function bootConfig(state, base) {
    const prefs = state.options.webPreferences ?? {};
    return {
      winId: state.id,
      base,
      contextIsolated: prefs.contextIsolation !== false,
      sandboxed: prefs.sandbox ?? !prefs.nodeIntegration,
      platform: process.platform,
      versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        v8: process.versions.v8,
      },
    };
  }

  function injectBoot(html, slot) {
    const tag = `<script src="${PREFIX}/loader.js?slot=${slot.number}"></script>`;
    const head = /<head[^>]*>/i.exec(html);
    if (!head) return tag + html;
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }

  function proxyHttp(slot, req, res, retried = false) {
    const target = new URL(slot.origin);
    const headers = upstreamHeaders(req, target);
    delete headers['accept-encoding'];

    const upstream = upstreamRequest(
      target,
      { method: req.method, path: req.url, headers },
      (upRes) => {
        const isHtml = (upRes.headers['content-type'] ?? '').includes('text/html');
        if (!isHtml) {
          upRes.pipe(startBody(req, res, upRes.statusCode, { ...upRes.headers }));
          return;
        }
        const chunks = [];
        upRes.on('data', (chunk) => chunks.push(chunk));
        upRes.on('end', () => {
          const body = injectBoot(Buffer.concat(chunks).toString('utf8'), slot);
          const outHeaders = allowFraming({ ...upRes.headers });
          delete outHeaders['content-length'];
          startBody(req, res, upRes.statusCode, outHeaders).end(body);
        });
      },
    );
    upstream.on('error', (err) => {
      // A kept-alive connection the dev server closed just as we reused it: send it again on
      // a fresh one (only bodiless requests, whose body isn't already spent).
      const bodiless = req.method === 'GET' || req.method === 'HEAD';
      if (upstream.reusedSocket && bodiless && !retried && !res.headersSent && err.code === 'ECONNRESET') {
        return proxyHttp(slot, req, res, true);
      }
      upstreamAddresses.delete(target.host);
      logger.debug(`proxy ${req.method} ${req.url} → ${target.origin} failed: ${err.message}`);
      if (res.headersSent) return res.destroy();
      send(res, 502, `electron-tab could not reach ${target.origin}: ${err.message}`);
    });
    if (retried) upstream.end();
    else req.pipe(upstream);
  }

  // Dev-server requests reuse connections, and connect straight to the address that worked
  // last time: "localhost" resolves to ::1 first, and a dev server listening on 127.0.0.1
  // only would otherwise cost a failed IPv6 attempt on every new connection.
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
  };
  const upstreamAddresses = new Map();

  function upstreamRequest(target, options, onResponse) {
    const client = target.protocol === 'https:' ? https : http;
    const known = upstreamAddresses.get(target.host);
    const request = client.request(
      {
        ...options,
        protocol: target.protocol,
        hostname: known ?? target.hostname,
        servername: target.hostname,
        port: target.port,
        agent: options.agent ?? agents[target.protocol],
      },
      onResponse,
    );
    if (!known) {
      request.once('socket', (socket) => {
        socket.once('connect', () => {
          if (socket.remoteAddress) upstreamAddresses.set(target.host, socket.remoteAddress);
        });
      });
    }
    return request;
  }

  function serveFile(slot, req, pathname, res) {
    const root = slot.root;
    let relative = decodeURIComponent(pathname.slice(1));
    if (relative === '') {
      const first = windowsIn(slot)[0];
      if (!first) return send(res, 404, 'Not found');
      relative = path.relative(root, fileURLToPath(first.target));
    }
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden path');

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      if (type.startsWith('text/html')) {
        return fs.readFile(file, 'utf8', (readErr, html) => {
          if (readErr) return send(res, 500, readErr.message);
          sendText(req, res, 200, injectBoot(html, slot), type);
        });
      }
      const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        return res.end();
      }
      fs.createReadStream(file).pipe(startBody(req, res, 200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache', etag }));
    });
  }

  // ---------------------------------------------------------------- WebSocket upgrades

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    // A throw here (a malformed URL, say) would reach Electron as an uncaught exception.
    try {
      upgrade(req, socket, head);
    } catch (err) {
      logger.error(`upgrade ${req.url} failed:`, err);
      socket.destroy();
    }
  }

  function upgrade(req, socket, head) {
    const host = classifyHost(req);
    if (!host) return rejectUpgrade(socket, 403);
    if (!tokenMatches(readCookie(req, COOKIE))) return rejectUpgrade(socket, 401);
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Browsers don't apply CORS to WebSockets; the Origin check is what keeps other sites out.
    if ((host.kind === 'shell' || host.kind === 'public') && url.pathname === `${PREFIX}/shell`) {
      if (!sameOrigin(req, host)) return rejectUpgrade(socket, 403);
      return (host.kind === 'public' ? wssPublic : wss).handleUpgrade(req, socket, head, attachShell);
    }
    if (host.kind !== 'slot' && host.kind !== 'public') return rejectUpgrade(socket, 404);

    if (url.pathname === `${PREFIX}/ipc`) {
      if (!sameOrigin(req, host)) return rejectUpgrade(socket, 403);
      const state = windows.get(Number(url.searchParams.get('win')));
      if (!windowAllowed(host, state)) return rejectUpgrade(socket, 404);
      return (host.kind === 'public' ? wssPublic : wss).handleUpgrade(req, socket, head, (ws) => attachSocket(state, ws));
    }

    // Anything else (e.g. Vite's HMR socket) goes to the dev server.
    const slot = host.kind === 'slot' ? host.slot : rootSlot;
    if (!slot?.origin) return rejectUpgrade(socket, 404);
    proxyUpgrade(new URL(slot.origin), req, socket, head);
  }

  function proxyUpgrade(target, req, socket, head) {
    const upstream = upstreamRequest(target, { method: req.method, path: req.url, headers: upstreamHeaders(req, target), agent: false });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    upstream.on('response', (upRes) => {
      upRes.resume();
      rejectUpgrade(socket, upRes.statusCode);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  function upstreamHeaders(req, target) {
    const headers = { ...req.headers, host: target.host };
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, target.origin);
    // Never pass on the bridge's own pages (the /auth URL holds the token).
    if (headers.referer?.startsWith(`${target.origin}${PREFIX}`)) delete headers.referer;
    const cookie = stripCookie(headers.cookie, COOKIE);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    return headers;
  }

  // ---------------------------------------------------------------- pages

  // On the public host the windows share the shell's origin and its cookie, so the shell
  // doesn't need the token to authorise them.
  function shellPage(isPublic) {
    const config = JSON.stringify({ token: isPublic ? null : token, layout, public: isPublic }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>electron-tab</title><link rel="stylesheet" href="${PREFIX}/shell.css">
<script id="ew-config" type="application/json">${config}</script><script src="${PREFIX}/shell.js" defer></script>
</head><body class="ew-layout-${layout}"></body></html>`;
  }

  function controlPage(isPublic) {
    const aloneUrl = (s) => {
      if (!isPublic) return authUrl(s.slot.host, pathFor(s));
      const target = publicPathFor(s);
      if (target === null) return null;
      const url = new URL(target, publicOrigin);
      url.searchParams.set('__ew_win', String(s.id));
      return url.pathname + url.search + url.hash;
    };
    const rows = [...windows.values()]
      .map((s) => {
        const title = escapeHtml(s.view.title || s.win.getTitle());
        const target = s.target ? escapeHtml(s.target.href) : '<em>not loaded</em>';
        const alone = s.slot ? aloneUrl(s) : null;
        const link = alone ? `<a href="${escapeHtml(alone)}">open alone</a>` : s.slot ? 'local only' : '';
        return `<tr><td>${s.number ?? '–'}</td><td>${s.id}</td><td>${title}</td><td>${target}</td><td>${s.view.visible ? 'yes' : 'no'}</td><td>${s.sockets.size}</td><td>${link}</td></tr>`;
      })
      .join('');
    return page(
      'electron-tab',
      `<p><a href="${escapeHtml(isPublic ? `${PREFIX}/app` : authUrl(shellHost, '/'))}">Open the app (all windows)</a></p>
<table><thead><tr><th>Window</th><th>BrowserWindow.id</th><th>Title</th><th>Loads</th><th>Visible</th><th>Tabs</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No windows yet.</td></tr>'}</tbody></table>`,
      3,
    );
  }

  function waitingPage(res) {
    return send(res, 503, page('Waiting for the app', '<p>No Electron window has loaded a page yet. This tab refreshes automatically.</p>', 1), 'text/html');
  }

  function unreachablePage(state) {
    return page(
      'Not available over the public host',
      `<p>This window loads <code>${escapeHtml(state.target?.origin ?? '')}</code>. Through <code>--public-host</code> only one
http(s) origin can be served (here <code>${escapeHtml(rootSlot?.origin ?? '')}</code>), plus <code>loadFile()</code> pages.
Open it on this machine instead, with the Open link electron-tab printed in its terminal.</p>`,
    );
  }

  // ---------------------------------------------------------------- server lifecycle

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error(`request ${req.url} failed:`, err);
      if (!res.headersSent) send(res, 500, `electron-tab: ${err?.message ?? err} (details in the terminal)`);
      else res.destroy();
    });
  });
  server.on('upgrade', handleUpgrade);

  // electron-vite restarts Electron on main-process changes; the old process may hold the port briefly.
  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && ++attempts < 40) return setTimeout(() => server.listen(port, '127.0.0.1'), 250);
    logger.error(`could not listen on 127.0.0.1:${port}: ${err.message}`);
    if (err.code === 'EADDRINUSE') logger.warn(`is another electron-tab still running? Stop it or pass --port <n>.`);
  });
  server.once('listening', () => {
    // Printed after the dev server's own output, which advertises its direct URL
    // (e.g. Vite's localhost:5173). That URL skips the bridge, so window.api won't exist.
    const { c } = logger;
    const session = {
      pid: process.pid,
      port,
      layout,
      url: authUrl(shellHost, '/'),
      publicUrl: publicOrigin ? publicAuthUrl(`${PREFIX}/app`) : null,
      windowsUrl: `http://${shellHost}${PREFIX}/`,
      stateUrl: `http://${shellHost}${PREFIX}/state`,
      startedAt: new Date().toISOString(),
    };
    const sessionFile = writeSessionFile(session);
    // --open: the CLI leaves a marker; whichever Electron process removes it opens the browser,
    // so restarts (electron-vite --watch) don't open another tab.
    const openMarker = process.env.ELECTRON_TAB_OPEN;
    if (openMarker) {
      fs.unlink(openMarker, (err) => {
        if (!err) electron.shell.openExternal(session.url).catch((openErr) => logger.warn(`could not open the browser: ${openErr.message}`));
      });
    }
    const row = (label, value, note = '') => `  ${c.green('➜')}  ${c.bold(label.padEnd(15))}${value}${note && `  ${c.dim(note)}`}\n`;
    console.log(
      `\n${c.cyan('[electron-tab]')} ${c.bold.green('ready.')} Open this in Chrome: ` +
        c.dim(`(Electron up in ${process.uptime().toFixed(1)}s · layout ${layout} · port ${port})`) +
        '\n\n' +
        row('Open:', logger.url(session.url)) +
        (publicOrigin ? row('Remote:', logger.url(session.publicUrl), `through ${publicOrigin}`) : '') +
        row('Windows:', c.cyan(session.windowsUrl), 'list, open one alone') +
        row('State JSON:', c.cyan(session.stateUrl), 'for tests and agents') +
        (sessionFile ? row('Session file:', c.cyan(sessionFile), 'these URLs, for scripts') : '') +
        `\n  ${c.dim("Not the dev server's own localhost link: it has no Electron behind it.")}\n` +
        (process.env.ELECTRON_TAB_DEBUG ? `  ${c.dim('debug on: window state and IPC calls are logged')}
` : '') +
        (publicOrigin ? `  ${c.yellow.bold('!')} ${c.yellow("Anyone with the Remote link controls this app's main process (files, shell). Share it carefully.")}\n` : ''),
    );
  });
  server.listen(port, '127.0.0.1');
  getRuntime().catch((err) => logger.error('could not bundle the browser runtime:', err));

  electron.app.once('will-quit', () => {
    for (const client of [...wss.clients, ...wssPublic.clients]) client.terminate();
    server.close();
    removeSessionFiles(port);
  });

  return {
    globalHandlers,
    registerWindow,
    setTarget,
    reload,
    print,
    push,
    log,
    view,
    setView,
    center,
    targetOf,
    focusedWindowId,
    call,
    executeJavaScript,
  };
}

// Runs first in every page served for a window (stringified into loader.js). Works out which
// window this frame belongs to, then loads that window's runtime and preload ahead of the
// page's own scripts. The shell names each iframe `__ew:<id>`; a plain tab uses ?__ew_win=<id>.
function loader(ids, prefix, runtime) {
  const fromName = /^__ew:(\d+)$/.exec(window.name)?.[1];
  // Electron runs preloads in the main frame only, so skip the page's own same-origin subframes.
  // (On the public host the shell shares the page's origin; its frames are the named ones.)
  try {
    if (!fromName && window.parent !== window && window.parent.location.host === location.host) return;
  } catch {}
  const fromQuery = new URLSearchParams(location.search).get('__ew_win');
  // An explicit ?__ew_win wins: window.name survives navigations within the same tab.
  const id = [fromQuery, fromName].map(Number).find((n) => ids.includes(n)) ?? ids[0];
  if (id === undefined) return console.error('[electron-tab] no Electron window is loading this page');
  window.name = `__ew:${id}`;
  document.write(`<script src="${prefix}/boot.js?win=${id}"><\/script><script src="${runtime}"><\/script><script src="${prefix}/preload.js?win=${id}"><\/script>`);
}

// The ready URLs, for scripts and agents that start electron-tab in the background:
// session.json for the latest run, session-<port>.json for each run, so two apps on
// different ports don't hide each other.
const SESSION_DIR = path.join(os.homedir(), '.electron-tab');

function writeSessionFile(session) {
  const body = `${JSON.stringify(session, null, 2)}\n`;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSION_DIR, `session-${session.port}.json`), body, { mode: 0o600 });
    fs.writeFileSync(path.join(SESSION_DIR, 'session.json'), body, { mode: 0o600 });
    return path.join(SESSION_DIR, 'session.json');
  } catch {
    return null;
  }
}

// On quit, remove the files that still describe this process (not a newer run's).
function removeSessionFiles(port) {
  for (const name of [`session-${port}.json`, 'session.json']) {
    const file = path.join(SESSION_DIR, name);
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
    } catch {}
  }
}

function centered(outer, inner) {
  return Math.max(0, Math.round((outer - inner) / 2));
}

function normalizeBounds({ x, y, width, height }) {
  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// Pages are shown inside the shell's iframes, so drop headers that forbid framing.
function allowFraming(headers) {
  delete headers['x-frame-options'];
  const csp = headers['content-security-policy'];
  if (csp) {
    headers['content-security-policy'] = String(csp)
      .split(';')
      .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
      .join(';');
  }
  return headers;
}

// Only a path on the same origin. Parsing (not prefix checks) catches tricks like "/\t/evil.com".
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  try {
    const base = 'http://same.invalid';
    const url = new URL(value, base);
    return url.origin === base ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

// Through a tunnel every byte crosses this machine's upload link, which is often slow, and
// dev bundles are mostly text that gzip shrinks about 5x. So on the public host, compress
// text bodies (handlePublic sets req.ewCompress). Returns the stream to write the body to.
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)|\+(json|xml)\b/i;

function startBody(req, res, status, headers) {
  const compress =
    req.ewCompress &&
    req.method !== 'HEAD' &&
    status !== 204 &&
    status !== 304 &&
    !headers['content-encoding'] &&
    COMPRESSIBLE.test(String(headers['content-type'] ?? '')) &&
    /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (!compress) {
    res.writeHead(status, headers);
    return res;
  }
  delete headers['content-length'];
  headers['content-encoding'] = 'gzip';
  headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding';
  res.writeHead(status, headers);
  const gzip = zlib.createGzip();
  gzip.pipe(res);
  return gzip;
}

function sendText(req, res, status, body, type) {
  startBody(req, res, status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
}

// Sends a body the browser may keep: it revalidates with If-None-Match and gets a 304 while
// the content is unchanged. `immutable` is for URLs that change whenever their content does.
// Bodies compressed for the public host are kept, so repeat requests skip the gzip work.
const gzipped = new Map();

async function sendCached(req, res, body, type, { etag, immutable = false } = {}) {
  etag ??= `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const headers = { etag, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-type'] = type;
  const compress = req.ewCompress && req.method !== 'HEAD' && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (!compress) {
    res.writeHead(200, headers);
    return res.end(body);
  }
  let zipped = gzipped.get(etag);
  if (!zipped) {
    zipped = await new Promise((resolve, reject) => zlib.gzip(body, (err, out) => (err ? reject(err) : resolve(out))));
    gzipped.set(etag, zipped);
    if (gzipped.size > 32) gzipped.delete(gzipped.keys().next().value);
  }
  res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': zipped.length });
  res.end(zipped);
}

// The bridge's own responses never send a Referer onward: URLs like /auth?token=… must not
// reach the app's page (document.referrer), its analytics, or its servers.
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}

function serveStatic(file, req, res) {
  fs.readFile(file, (err, body) => {
    if (err) return send(res, 404, 'Not found');
    sendCached(req, res, body, MIME[path.extname(file)] ?? 'application/octet-stream');
  });
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\n\r\n`);
}

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function stripCookie(header, name) {
  if (!header) return '';
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name}=`))
    .join('; ');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title, body, refreshSeconds) {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem .7rem;text-align:left}code{background:#f2f2f2;padding:0 .3rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

module.exports = { createBridge };
