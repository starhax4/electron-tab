// The shell: one browser tab that shows every Electron window of the app as a panel.
// Main owns each window's state (bounds, focus, minimised, ...); the shell draws it and
// reports what the user does with a panel back to main.
(() => {
  const PREFIX = '/__electron2web';
  const config = JSON.parse(document.getElementById('ew-config').textContent);
  const layout = config.layout;

  const views = new Map(); // window id → state from main
  const panels = new Map(); // window id → DOM parts
  let zOrder = []; // window ids, back to front
  let socket = null;

  // ---------------------------------------------------------------- DOM skeleton

  const el = (tag, className, attrs = {}) => Object.assign(document.createElement(tag), { className }, attrs);

  // The strip lists the windows (a tab strip on top in the tabs layout, a taskbar at the
  // bottom on the desktop) and ends with the connection status.
  const strip = el('nav', layout === 'tabs' ? 'ew-strip ew-tabs' : 'ew-strip ew-taskbar');
  strip.setAttribute('aria-label', 'Windows');
  const stripItems = el('div', 'ew-strip-items', { role: layout === 'tabs' ? 'tablist' : 'toolbar' });
  stripItems.setAttribute('aria-label', 'Open windows');
  const status = el('div', 'ew-status', { role: 'status' });
  const statusDot = el('span', 'ew-dot');
  const statusText = el('span', 'ew-status-text', { textContent: 'Connecting…' });
  status.append(statusDot, statusText);
  strip.append(stripItems, status);
  const desktop = el('main', 'ew-desktop');
  desktop.setAttribute('aria-label', 'App windows');
  const empty = el('p', 'ew-empty', { textContent: 'Waiting for the app to open a window…' });
  const banner = el('div', 'ew-banner', { role: 'alert', hidden: true });
  desktop.append(empty);
  document.body.append(banner, ...(layout === 'tabs' ? [strip, desktop] : [desktop, strip]));

  // ---------------------------------------------------------------- connection

  let connected = false;

  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}${PREFIX}/shell`);
    socket.onopen = () => {
      connected = true;
      reportViewport();
      renderStatus();
    };
    socket.onmessage = (event) => receive(JSON.parse(event.data));
    socket.onclose = () => {
      connected = false;
      renderStatus();
      showBanner('Lost connection to the Electron main process — waiting for it to come back…');
      waitForBridge();
    };
  }

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  // When Electron restarts, window ids start over, so reload the whole shell once it is back.
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
      case 'init':
        views.clear();
        for (const view of message.windows) views.set(view.id, view);
        render();
        break;
      case 'window':
        views.set(message.view.id, message.view);
        render();
        break;
      case 'removed':
        views.delete(message.id);
        render();
        break;
      case 'call':
        runCall(message);
        break;
    }
  }

  // Operations main can ask the shell to run. Dialogs, menus and toasts plug in here.
  const ops = {};

  async function runCall({ id, op, payload }) {
    try {
      if (!Object.hasOwn(ops, op)) throw new Error(`unknown shell operation '${op}'`);
      send({ type: 'call-result', id, value: await ops[op](payload) });
    } catch (err) {
      send({ type: 'call-result', id, error: { name: err?.name ?? 'Error', message: err?.message ?? String(err) } });
    }
  }

  function showBanner(text) {
    banner.textContent = `electron2web: ${text}`;
    banner.hidden = false;
  }

  let viewportTimer = 0;
  function reportViewport() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => send({ type: 'viewport', width: desktop.clientWidth, height: desktop.clientHeight }), 100);
  }
  new ResizeObserver(reportViewport).observe(desktop);

  // ---------------------------------------------------------------- panel actions

  const change = (id, changes) => send({ type: 'panel', id, changes });
  const focusWindow = (id) => views.get(id)?.focused || change(id, { focused: true, minimized: false });
  const closeWindow = (id) => send({ type: 'close', id });
  const numberOf = (view) => view.number ?? '·';
  const labelOf = (view) => view.title || `Window ${numberOf(view)}`;
  // Agents address windows by the number on their badge; main keys them by BrowserWindow.id.
  const idOf = (number) => [...views.values()].find((view) => view.number === Number(number))?.id;
  const stateOf = (view) => (view.minimized ? 'minimized' : !view.visible ? 'hidden' : view.focused ? 'focused' : 'background');

  // For browser agents and tests: drive the windows without hunting for buttons. Windows are
  // addressed by the number on their badge. (GET /__electron2web/state returns the same list.)
  window.electron2web = Object.freeze({
    windows: () =>
      [...views.values()]
        .filter((view) => view.host)
        .sort((a, b) => numberOf(a) - numberOf(b))
        .map((view) => ({
          number: view.number,
          id: view.id,
          title: labelOf(view),
          state: stateOf(view),
          focused: view.focused,
          visible: view.visible,
          minimized: view.minimized,
          maximized: view.maximized,
          bounds: { ...view.bounds },
        })),
    focused: () => [...views.values()].find((view) => view.focused)?.number ?? null,
    focus: (number) => focusWindow(idOf(number)),
    minimize: (number) => change(idOf(number), { minimized: true }),
    maximize: (number) => change(idOf(number), { maximized: true, minimized: false }),
    restore: (number) => change(idOf(number), { maximized: false, minimized: false }),
    close: (number) => closeWindow(idOf(number)),
    frame: (number) => panels.get(idOf(number))?.frame ?? null,
  });

  // ---------------------------------------------------------------- rendering

  function render() {
    // Only windows that have loaded something get a panel. Hidden windows keep theirs (out of
    // sight) so the page still loads, which is what fires ready-to-show.
    const shown = [...views.values()].filter((view) => view.host);
    for (const id of panels.keys()) if (!views.get(id)?.host) removePanel(id);

    for (const view of shown) {
      if (!zOrder.includes(view.id)) zOrder.push(view.id);
      if (view.focused) raise(view.id);
    }
    zOrder = zOrder.filter((id) => panels.has(id) || shown.some((view) => view.id === id));

    for (const view of shown) updatePanel(panels.get(view.id) ?? createPanel(view), view);
    zOrder.forEach((id, index) => {
      const panel = panels.get(id);
      if (panel) panel.root.style.zIndex = String(10 + index * 2);
    });

    const visible = shown.filter(isOnScreen);
    empty.hidden = visible.length > 0;
    if (layout !== 'single') renderStrip();
    renderStatus();
    const focused = shown.find((view) => view.focused);
    document.title = focused?.title || 'electron2web';
  }

  const isOnScreen = (view) => view.visible && !view.minimized;

  // Keeps a modal child above its parent when the parent is raised.
  function raise(id) {
    zOrder = [...zOrder.filter((other) => other !== id), id];
    for (const child of views.values()) {
      if (child.modal && child.parentId === id && isOnScreen(child)) zOrder = [...zOrder.filter((other) => other !== child.id), child.id];
    }
  }

  function createPanel(view) {
    const id = view.id;
    const root = el('section', 'ew-panel ew-opening');
    root.addEventListener('animationend', () => root.classList.remove('ew-opening'), { once: true });
    root.dataset.windowId = String(id);
    const bar = el('header', 'ew-titlebar');
    const number = el('span', 'ew-num');
    const title = el('span', 'ew-title');
    const controls = el('div', 'ew-controls');
    const minimize = el('button', 'ew-min', { type: 'button', textContent: '–' });
    const maximize = el('button', 'ew-max', { type: 'button', textContent: '□' });
    const close = el('button', 'ew-close', { type: 'button', textContent: '×' });
    controls.append(minimize, maximize, close);
    bar.append(number, title, controls);
    const frame = el('iframe', 'ew-frame', { name: `__ew:${id}` });
    frame.dataset.windowId = String(id);
    // Once a page has loaded on a host, the auth cookie is set there; later loads skip /auth.
    // (The initial about:blank also fires load, before any src is set.)
    frame.addEventListener('load', () => {
      const panel = panels.get(id);
      if (panel?.authHost && frame.getAttribute('src')) authorizedHosts.add(panel.authHost);
    });
    // Cross-origin iframes only get these features when the embedder delegates them.
    frame.allow = 'clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture; geolocation; autoplay';
    frame.allowFullscreen = true;
    const blocker = el('div', 'ew-blocker');
    const grip = el('div', 'ew-grip');
    grip.setAttribute('aria-hidden', 'true');
    root.append(bar, frame, blocker, grip);
    desktop.append(root);

    root.addEventListener('pointerdown', () => focusWindow(id), true);
    blocker.addEventListener('pointerdown', () => {
      const child = [...views.values()].find((other) => other.modal && other.parentId === id && isOnScreen(other));
      if (child) focusWindow(child.id);
    });
    minimize.addEventListener('click', () => change(id, { minimized: true }));
    maximize.addEventListener('click', () => change(id, { maximized: !views.get(id).maximized }));
    close.addEventListener('click', () => closeWindow(id));
    bar.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button') && views.get(id).maximizable) change(id, { maximized: !views.get(id).maximized });
    });
    drag(bar, id, (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }));
    drag(grip, id, (start, dx, dy) => {
      const view = views.get(id);
      return { ...start, width: Math.max(start.width + dx, view.minWidth || 160), height: Math.max(start.height + dy, view.minHeight || 100) };
    });

    const panel = { root, bar, number, title, minimize, maximize, close, frame, blocker, grip, nav: -1 };
    panels.set(id, panel);
    return panel;
  }

  function updatePanel(panel, view) {
    const label = labelOf(view);
    panel.root.dataset.state = stateOf(view);
    if (view.number) panel.root.dataset.windowNumber = String(view.number);
    panel.number.textContent = String(numberOf(view));
    panel.number.title = `Window ${numberOf(view)} (BrowserWindow.id ${view.id})`;
    panel.title.textContent = label;
    panel.frame.title = label;
    panel.root.setAttribute('role', view.modal ? 'dialog' : 'region');
    panel.root.setAttribute('aria-label', label);
    if (view.modal) panel.root.setAttribute('aria-modal', 'true');
    else panel.root.removeAttribute('aria-modal');
    panel.minimize.setAttribute('aria-label', `Minimize ${label}`);
    panel.maximize.setAttribute('aria-label', `${view.maximized ? 'Restore' : 'Maximize'} ${label}`);
    panel.close.setAttribute('aria-label', `Close ${label}`);
    panel.minimize.hidden = !view.minimizable;
    panel.maximize.hidden = !view.maximizable;
    panel.close.hidden = !view.closable;

    const cls = panel.root.classList;
    cls.toggle('ew-hidden', !isOnScreen(view) || (layout === 'tabs' && !view.focused));
    cls.toggle('ew-focused', view.focused);
    cls.toggle('ew-maximized', view.maximized || layout === 'tabs');
    cls.toggle('ew-fullscreen', view.fullscreen);
    cls.toggle('ew-frameless', !view.frame);
    cls.toggle('ew-fixed', !view.resizable);
    cls.toggle('ew-blocked', [...views.values()].some((child) => child.modal && child.parentId === view.id && isOnScreen(child)));
    if (!panel.dragging) place(panel.root, view.bounds);

    if (panel.nav !== view.nav) {
      panel.nav = view.nav;
      panel.authHost = config.public || authorizedHosts.has(view.host) ? null : view.host;
      panel.frame.src = frameUrl(view);
    }
  }

  function frameUrl(view) {
    // Through --public-host every window shares the shell's origin, and its cookie.
    if (config.public) return view.publicPath ?? `${PREFIX}/unreachable?win=${view.id}`;
    // Locally the first load on each origin goes through /auth to set the cookie there.
    if (authorizedHosts.has(view.host)) return `http://${view.host}${view.path}`;
    return `http://${view.host}${PREFIX}/auth?token=${encodeURIComponent(config.token)}&next=${encodeURIComponent(view.path)}`;
  }
  const authorizedHosts = new Set();

  function place(root, { x, y, width, height }) {
    // Keep at least the title bar reachable inside the desktop.
    const maxX = Math.max(0, desktop.clientWidth - 80);
    const maxY = Math.max(0, desktop.clientHeight - 32);
    Object.assign(root.style, {
      left: `${Math.min(Math.max(x, 80 - width), maxX)}px`,
      top: `${Math.min(Math.max(y, 0), maxY)}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  function removePanel(id) {
    panels.get(id)?.root.remove();
    panels.delete(id);
  }

  // Dragging the title bar moves the panel; dragging the corner grip resizes it. Bounds are
  // sent to main when the drag ends, and main fires move/resize on the BrowserWindow.
  function drag(handle, id, compute) {
    handle.addEventListener('pointerdown', (event) => {
      const view = views.get(id);
      const panel = panels.get(id);
      if (event.button !== 0 || event.target.closest('button') || view.maximized || view.fullscreen || layout === 'tabs') return;
      if (handle === panel.grip && !view.resizable) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('ew-dragging');
      panel.dragging = true;
      const start = { x: event.clientX, y: event.clientY };
      let bounds = view.bounds;
      const move = (ev) => {
        bounds = compute(view.bounds, ev.clientX - start.x, ev.clientY - start.y);
        place(panel.root, bounds);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        document.body.classList.remove('ew-dragging');
        panel.dragging = false;
        if (bounds !== view.bounds) change(id, { bounds });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end, { once: true });
      handle.addEventListener('pointercancel', end, { once: true });
    });
  }

  // The tab strip (tabs layout) and taskbar (desktop layout) list the visible windows by their
  // number, so people and agents can tell them apart even when titles repeat. Items are kept between renders so hover and focus survive updates.
  const stripEntries = new Map(); // window id → { item, button, number, label, close }

  function createStripEntry(id) {
    const item = el('div', 'ew-strip-item ew-new');
    item.dataset.windowId = String(id);
    const button = el('button', 'ew-strip-focus', { type: 'button' });
    if (layout === 'tabs') button.setAttribute('role', 'tab');
    const number = el('span', 'ew-num');
    const label = el('span', 'ew-strip-label');
    button.append(number, label);
    const close = el('button', 'ew-strip-close', { type: 'button', textContent: '×' });
    item.append(button, close);
    button.addEventListener('click', () => focusWindow(id));
    // Middle-click closes, as on a browser tab.
    item.addEventListener('auxclick', (event) => event.button === 1 && views.get(id)?.closable && closeWindow(id));
    close.addEventListener('click', () => closeWindow(id));
    item.addEventListener('animationend', () => item.classList.remove('ew-new'), { once: true });
    const entry = { item, button, number, label, close };
    stripEntries.set(id, entry);
    return entry;
  }

  function renderStrip() {
    const listed = [...views.values()].filter((view) => view.host && view.visible).sort((a, b) => numberOf(a) - numberOf(b) || a.id - b.id);
    for (const [id, entry] of stripEntries) {
      if (!listed.some((view) => view.id === id)) {
        entry.item.remove();
        stripEntries.delete(id);
      }
    }
    listed.forEach((view, index) => {
      const entry = stripEntries.get(view.id) ?? createStripEntry(view.id);
      const label = labelOf(view);
      const state = stateOf(view);
      const number = numberOf(view);
      entry.item.dataset.state = state;
      if (view.number) entry.item.dataset.windowNumber = String(view.number);
      entry.number.textContent = String(number);
      entry.label.textContent = label;
      entry.button.title = `${label}\nWindow ${number} · ${state}${view.path ? ` · ${view.path}` : ''}`;
      entry.button.setAttribute('aria-label', `Window ${number}: ${label}${state === 'focused' ? '' : ` (${state})`}`);
      if (layout === 'tabs') entry.button.setAttribute('aria-selected', String(view.focused));
      else entry.button.setAttribute('aria-pressed', String(view.focused));
      entry.close.hidden = !view.closable;
      entry.close.setAttribute('aria-label', `Close window ${number}: ${label}`);
      if (stripItems.children[index] !== entry.item) stripItems.insertBefore(entry.item, stripItems.children[index] ?? null);
    });
  }

  function renderStatus() {
    const count = [...views.values()].filter((view) => view.host && view.visible).length;
    status.dataset.connection = connected ? 'open' : 'closed';
    statusText.textContent = connected ? `${count} window${count === 1 ? '' : 's'}` : 'Reconnecting…';
    status.title = connected ? 'Connected to the Electron main process' : 'Waiting for the Electron main process';
  }

  connect();
})();
