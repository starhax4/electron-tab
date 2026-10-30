// Runs first in the Chrome tab: provides the `electron` renderer API that the app's
// preload imports, backed by a WebSocket to the bridge in Electron's main process.
import { pack, unpack } from '../codec.cjs';

const PREFIX = '/__electron2web';
const config = globalThis.__ELECTRON2WEB__;

// ------------------------------------------------------------------ connection

let socket = null;
let open = false;
let windowClosed = false;
const outbox = [];
const pending = new Map();
let nextInvokeId = 1;

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}${PREFIX}/ipc?win=${config.winId}`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    open = true;
    for (const frame of outbox.splice(0)) socket.send(frame);
  };
  socket.onmessage = (event) => receive(unpack(new Uint8Array(event.data)));
  socket.onclose = () => {
    open = false;
    for (const { reject } of pending.values()) reject(new Error('[electron2web] lost connection to the Electron main process'));
    pending.clear();
    // A closed window stays closed; reloading would attach the page to another window.
    if (windowClosed) return;
    showBanner('Lost connection to the Electron main process — waiting for it to come back…');
    waitForBridge();
  };
}

function post(message) {
  // After its window closed, the page's messages have nowhere to go (invoke rejects).
  if (windowClosed) {
    if (message.type === 'invoke') throw new Error('[electron2web] the window was closed');
    return;
  }
  const frame = pack(message);
  if (open) socket.send(frame);
  else outbox.push(frame);
}

// When Electron restarts (e.g. electron-vite rebuilt main), reload once the bridge is back.
function waitForBridge() {
  setTimeout(async () => {
    try {
      const res = await fetch(`${PREFIX}/ping`, { cache: 'no-store' });
      if (res.ok) return location.reload();
      if (res.status === 401) return showBanner('Not authorized — reopen the URL printed by electron2web.');
    } catch {}
    waitForBridge();
  }, 400);
}

function receive(message) {
  switch (message.type) {
    case 'result': {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) {
        const { name, message: text } = message.error;
        call.reject(new Error(`Error invoking remote method '${call.channel}': ${name}: ${text}`));
      } else {
        call.resolve(message.value);
      }
      break;
    }
    case 'push':
      dispatch(message.channel, message.args);
      break;
    case 'reload':
      location.reload();
      break;
    case 'navigate': {
      const target = config.base + message.path;
      if (target === location.pathname + location.search + location.hash) location.reload();
      else location.assign(target);
      break;
    }
    case 'call':
      runCall(message);
      break;
    case 'print':
      // Let the message handler return before the print dialog blocks the page.
      setTimeout(() => window.print());
      break;
    case 'closed':
      windowClosed = true;
      showBanner('The Electron window behind this tab was closed.');
      break;
  }
}

// ------------------------------------------------------------------ main → page calls

// Operations main can ask this page to run (webContents.executeJavaScript and friends).
const ops = {
  executeJavaScript: ({ key }) => runExecScript(key),
};

async function runCall({ id, op, payload }) {
  try {
    if (!Object.hasOwn(ops, op)) throw new Error(`[electron2web] unknown operation '${op}'`);
    const value = await ops[op](payload);
    post({ type: 'call-result', id, value });
  } catch (err) {
    post({ type: 'call-result', id, error: { name: err?.name ?? 'Error', message: err?.message ?? String(err) } });
  }
}

// The code is served by the bridge as a same-origin script, which the page's CSP allows
// where eval usually isn't. The script hands its function back through __electron2webExec.
const execWaiting = new Map();
globalThis.__electron2webExec = (key, fn) => {
  execWaiting.get(key)?.(fn);
  execWaiting.delete(key);
};

async function runExecScript(key) {
  const fn = await new Promise((resolve, reject) => {
    execWaiting.set(key, resolve);
    const script = document.createElement('script');
    script.src = `${PREFIX}/exec?win=${config.winId}&key=${encodeURIComponent(key)}`;
    const fail = (reason) => {
      if (execWaiting.delete(key)) reject(new Error(`[electron2web] executeJavaScript failed: ${reason}`));
    };
    // A script that loads but never calls back had a syntax error (reported in the console).
    script.onload = () => (script.remove(), fail('the code could not be parsed'));
    script.onerror = () => (script.remove(), fail('the code could not be loaded'));
    document.head.append(script);
  });
  return fn();
}

// ------------------------------------------------------------------ ipcRenderer

const listeners = new Map();

function addListener(channel, fn, once) {
  if (!listeners.has(channel)) listeners.set(channel, []);
  listeners.get(channel).push({ fn, once });
  return ipcRenderer;
}

function removeListener(channel, fn) {
  const list = listeners.get(channel);
  if (!list) return ipcRenderer;
  const index = list.findIndex((entry) => entry.fn === fn);
  if (index !== -1) list.splice(index, 1);
  if (list.length === 0) listeners.delete(channel);
  return ipcRenderer;
}

function dispatch(channel, args) {
  const list = listeners.get(channel);
  if (!list) return;
  const event = { sender: ipcRenderer, senderId: 0, ports: [] };
  for (const entry of [...list]) {
    if (entry.once) removeListener(channel, entry.fn);
    try {
      entry.fn(event, ...args);
    } catch (err) {
      console.error(`[electron2web] listener for '${channel}' threw`, err);
    }
  }
}

function unsupported(name) {
  return () => {
    throw new Error(`[electron2web] ${name} is not supported yet`);
  };
}

const ipcRenderer = {
  invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = nextInvokeId++;
      pending.set(id, { resolve, reject, channel });
      try {
        post({ type: 'invoke', id, channel, args });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  },
  send(channel, ...args) {
    post({ type: 'send', channel, args });
  },
  sendSync(channel, ...args) {
    // Synchronous XHR is deprecated but still allowed on the main thread, and it is
    // the only way to block for a reply the way Electron's sendSync does.
    if (windowClosed) throw new Error(`[electron2web] sendSync('${channel}') failed: the window was closed`);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${PREFIX}/sync?win=${config.winId}`, false);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.send(pack({ channel, args }));
    if (xhr.status !== 200) throw new Error(`[electron2web] sendSync('${channel}') failed: ${xhr.status} ${xhr.responseText}`);
    return unpack(Uint8Array.from(atob(xhr.responseText), (c) => c.charCodeAt(0))).value;
  },
  on: (channel, fn) => addListener(channel, fn, false),
  addListener: (channel, fn) => addListener(channel, fn, false),
  once: (channel, fn) => addListener(channel, fn, true),
  off: removeListener,
  removeListener,
  removeAllListeners(channel) {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
    return ipcRenderer;
  },
  listenerCount: (channel) => listeners.get(channel)?.length ?? 0,
  sendToHost: unsupported('ipcRenderer.sendToHost'),
  postMessage: unsupported('ipcRenderer.postMessage (MessagePort IPC)'),
};

// ------------------------------------------------------------------ other renderer modules

const contextBridge = {
  exposeInMainWorld(key, api) {
    Object.defineProperty(globalThis, key, { value: api, enumerable: true });
  },
  exposeInIsolatedWorld: unsupported('contextBridge.exposeInIsolatedWorld'),
};

let zoomFactor = 1;
let cssKey = 0;
const insertedCss = new Map();
const webFrame = {
  getZoomFactor: () => zoomFactor,
  setZoomFactor(factor) {
    zoomFactor = factor;
    document.documentElement.style.zoom = String(factor);
  },
  getZoomLevel: () => Math.log(zoomFactor) / Math.log(1.2),
  setZoomLevel(level) {
    webFrame.setZoomFactor(Math.pow(1.2, level));
  },
  setVisualZoomLevelLimits() {},
  insertCSS(css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const key = `electron2web-${++cssKey}`;
    insertedCss.set(key, style);
    return key;
  },
  removeInsertedCSS(key) {
    insertedCss.get(key)?.remove();
    insertedCss.delete(key);
  },
  executeJavaScript: async (code) => (0, eval)(code),
};

const webUtils = {
  getPathForFile() {
    console.warn('[electron2web] webUtils.getPathForFile() cannot see real paths in the browser; returning ""');
    return '';
  },
};

const processShim = {
  type: 'renderer',
  platform: config.platform,
  versions: config.versions,
  contextIsolated: config.contextIsolated,
  sandboxed: config.sandboxed,
  env: {},
  argv: [],
  browser: true,
  cwd: () => '/',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  on() {},
  once() {},
  off() {},
};

function unsupportedModule(name) {
  console.warn(`[electron2web] preload imports Node module '${name}', which does not exist in the browser. Calls into it will throw.`);
  const fail = (prop) => () => {
    throw new Error(`[electron2web] '${name}.${String(prop)}' is not available in the browser`);
  };
  return new Proxy(function () {}, {
    get: (_, prop) => (prop === '__esModule' ? false : fail(prop)),
    apply: () => fail('default')(),
  });
}

globalThis.__electronShim = { ipcRenderer, contextBridge, webFrame, webUtils, process: processShim, unsupportedModule };

// ------------------------------------------------------------------ status banner

let banner = null;
function showBanner(text) {
  const render = () => {
    banner ??= Object.assign(document.createElement('div'), { id: 'electron2web-banner' });
    banner.textContent = `electron2web: ${text}`;
    banner.style.cssText =
      'position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:8px 12px;font:13px system-ui,sans-serif;background:#b42318;color:#fff';
    document.body.append(banner);
  };
  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', render, { once: true });
}

// ------------------------------------------------------------------ lifecycle → main process

document.addEventListener('DOMContentLoaded', () => post({ type: 'lifecycle', event: 'dom-ready' }), { once: true });
window.addEventListener('load', () => post({ type: 'lifecycle', event: 'did-finish-load' }), { once: true });

// The title drives page-title-updated and the panel's title; focus drives getFocusedWindow().
let lastTitle = '';
function reportTitle() {
  if (!document.title || document.title === lastTitle) return;
  lastTitle = document.title;
  post({ type: 'title', title: lastTitle });
}
document.addEventListener(
  'DOMContentLoaded',
  () => {
    reportTitle();
    new MutationObserver(reportTitle).observe(document.head ?? document.documentElement, { subtree: true, childList: true, characterData: true });
  },
  { once: true },
);
// A click inside the page never reaches the shell (the iframe is cross-origin), and 'focus'
// doesn't fire while the browser itself lacks OS focus, so report both.
window.addEventListener('focus', () => post({ type: 'focus' }));
window.addEventListener('pointerdown', () => post({ type: 'focus' }), true);

connect();
