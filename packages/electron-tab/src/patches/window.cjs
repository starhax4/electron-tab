'use strict';

const { pathToFileURL } = require('node:url');

// Only windows with a preload can talk to main, so only those are moved into the browser.
// The rest are helpers (hidden print/PDF windows, external-link popups) that must keep
// loading and printing in real Electron.
function shouldBridge(options) {
  return Boolean(options.webPreferences?.preload);
}

module.exports = {
  name: 'window',
  install(electron, { bridge }) {
    return {
      BrowserWindow: createWindowClass(electron, bridge),
      webContents: patchWebContentsModule(electron, bridge),
    };
  },
};

// Bridged windows, by instance. A WeakSet rather than a private field: Electron's own
// constructor may call overridden methods before a subclass field would be initialised.
const bridged = new WeakSet();

function createWindowClass(electron, bridge) {
  const Base = electron.BrowserWindow;
  const view = (win) => bridge.view(win.id);
  const set = (win, changes) => bridge.setView(win.id, changes);

  // The real windows stay hidden; their visible state (bounds, focus, minimised, ...) is
  // mirrored from the panel in the browser, and setters move the panel.
  // The class must be named BrowserWindow: Electron's fromId() and getAllWindows() keep only
  // windows whose constructor.name is exactly that.
  return class BrowserWindow extends Base {
    static getFocusedWindow() {
      const id = bridge.focusedWindowId();
      return id == null ? Base.getFocusedWindow() : Base.fromId(id);
    }

    constructor(options = {}) {
      const isBridged = shouldBridge(options);
      super(isBridged ? { ...options, show: false } : options);
      if (!isBridged) {
        if (options.show !== false) bridge.log(`window ${this.id} has no preload — opening it as a normal Electron window`);
        return;
      }
      bridged.add(this);
      const handlers = new Map();
      bridge.registerWindow(this, options, handlers);
      patchContents(this, bridge, handlers);
    }

    loadURL(url) {
      return this.webContents.loadURL(url);
    }

    loadFile(file, opts) {
      return this.webContents.loadFile(file, opts);
    }

    show() {
      if (!bridged.has(this)) return super.show();
      set(this, { visible: true, minimized: false, focused: true });
    }

    showInactive() {
      if (!bridged.has(this)) return super.showInactive();
      set(this, { visible: true });
    }

    hide() {
      if (!bridged.has(this)) return super.hide();
      set(this, { visible: false, focused: false });
    }

    isVisible() {
      return bridged.has(this) ? view(this).visible : super.isVisible();
    }

    focus() {
      if (!bridged.has(this)) return super.focus();
      set(this, { visible: true, minimized: false, focused: true });
    }

    blur() {
      if (!bridged.has(this)) return super.blur();
      set(this, { focused: false });
    }

    isFocused() {
      return bridged.has(this) ? view(this).focused : super.isFocused();
    }

    minimize() {
      if (!bridged.has(this)) return super.minimize();
      set(this, { minimized: true, focused: false });
    }

    restore() {
      if (!bridged.has(this)) return super.restore();
      set(this, { visible: true, minimized: false });
    }

    isMinimized() {
      return bridged.has(this) ? view(this).minimized : super.isMinimized();
    }

    // Like Electron, maximize() also shows a hidden window (without focusing it).
    maximize() {
      if (!bridged.has(this)) return super.maximize();
      set(this, { visible: true, minimized: false, maximized: true });
    }

    unmaximize() {
      if (!bridged.has(this)) return super.unmaximize();
      set(this, { maximized: false });
    }

    isMaximized() {
      return bridged.has(this) ? view(this).maximized : super.isMaximized();
    }

    setFullScreen(flag) {
      if (!bridged.has(this)) return super.setFullScreen(flag);
      set(this, { fullscreen: Boolean(flag) });
    }

    isFullScreen() {
      return bridged.has(this) ? view(this).fullscreen : super.isFullScreen();
    }

    setBounds(bounds) {
      if (!bridged.has(this)) return super.setBounds(bounds);
      set(this, { bounds });
    }

    getBounds() {
      return bridged.has(this) ? { ...view(this).bounds } : super.getBounds();
    }

    // Panels have no separate frame size, so content bounds equal window bounds.
    setContentBounds(bounds) {
      if (!bridged.has(this)) return super.setContentBounds(bounds);
      set(this, { bounds });
    }

    getContentBounds() {
      return bridged.has(this) ? { ...view(this).bounds } : super.getContentBounds();
    }

    setSize(width, height) {
      if (!bridged.has(this)) return super.setSize(width, height);
      set(this, { bounds: { width, height } });
    }

    getSize() {
      if (!bridged.has(this)) return super.getSize();
      const { width, height } = view(this).bounds;
      return [width, height];
    }

    setContentSize(width, height) {
      if (!bridged.has(this)) return super.setContentSize(width, height);
      set(this, { bounds: { width, height } });
    }

    getContentSize() {
      return bridged.has(this) ? this.getSize() : super.getContentSize();
    }

    setPosition(x, y) {
      if (!bridged.has(this)) return super.setPosition(x, y);
      set(this, { bounds: { x, y } });
    }

    getPosition() {
      if (!bridged.has(this)) return super.getPosition();
      const { x, y } = view(this).bounds;
      return [x, y];
    }

    center() {
      if (!bridged.has(this)) return super.center();
      bridge.center(this.id);
    }

    setTitle(title) {
      if (!bridged.has(this)) return super.setTitle(title);
      set(this, { title: String(title) });
    }

    getTitle() {
      return bridged.has(this) ? view(this).title : super.getTitle();
    }
  };
}

function patchContents(win, bridge, handlers) {
  const contents = win.webContents;
  const id = win.id;

  contents.send = (channel, ...args) => bridge.push(id, channel, args);
  contents.loadURL = async (url) => bridge.setTarget(id, url);
  contents.loadFile = async (file, opts = {}) => {
    const url = pathToFileURL(file);
    if (opts.search) url.search = opts.search;
    if (opts.hash) url.hash = opts.hash;
    if (opts.query) url.search = new URLSearchParams(opts.query).toString();
    return bridge.setTarget(id, url.href);
  };
  contents.reload = () => bridge.reload(id);
  contents.getURL = () => bridge.targetOf(id) ?? '';
  contents.getTitle = () => bridge.view(id).title;
  contents.isFocused = () => bridge.view(id).focused;
  contents.focus = () => win.focus();
  contents.executeJavaScript = (code) => bridge.executeJavaScript(id, String(code));
  contents.openDevTools = () => bridge.log('openDevTools() ignored — use Chrome DevTools in the tab instead');
  // The page lives in the Chrome tab, so print there (Chrome's own print dialog).
  contents.print = (opts, callback) => {
    bridge.print(id);
    callback?.(true, '');
  };
  contents.printToPDF = async () => {
    throw new Error('[electron-tab] printToPDF() is not supported for windows shown in the browser');
  };

  const { handle, handleOnce, removeHandler } = contents.ipc;
  contents.ipc.handle = (channel, fn) => (handle.call(contents.ipc, channel, fn), handlers.set(channel, fn));
  contents.ipc.handleOnce = (channel, fn) => {
    handleOnce.call(contents.ipc, channel, fn);
    handlers.set(channel, (...args) => (handlers.delete(channel), fn(...args)));
  };
  contents.ipc.removeHandler = (channel) => (removeHandler.call(contents.ipc, channel), handlers.delete(channel));
}

// Electron's module exports may be read-only getters, so wrap rather than assign.
function patchWebContentsModule({ webContents, BrowserWindow }, bridge) {
  return Object.create(webContents, {
    getFocusedWebContents: {
      enumerable: true,
      value() {
        const id = bridge.focusedWindowId();
        return id == null ? webContents.getFocusedWebContents() : (BrowserWindow.fromId(id)?.webContents ?? null);
      },
    },
  });
}
