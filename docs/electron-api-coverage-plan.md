# electron-tab: plan for full Electron API coverage

**Goal:** run a whole Electron app inside one browser tab, so that both people and AI browser
agents (Playwright MCP, Chrome DevTools MCP, Claude in Chrome, and others) can use **every** part
of it. "Every part" includes the pieces that are drawn by the OS today: dialogs, menus, tray,
notifications, and extra windows.

Status: **P0 is built** (see §8). Everything else is planned; built items are marked ✅.

---

## 1. Principles

1. **Everything an app shows must end up in the DOM.** A native file picker or message box
   that opens on the host desktop is invisible to a browser agent, and to anyone viewing the tab
   from another machine. Each feature therefore gets a **web surface**: HTML in the tab, with
   ARIA roles (`dialog`, `menu`, `menuitem`, `alert`) so agents can find it in the
   accessibility tree.
2. **Two surfaces per feature: `web` and `native`.** `web` draws the feature in the tab and is
   the default. `native` is today's behaviour, where the real OS UI opens on the host. Users can
   opt a feature back to native, for example `--native dialog,notification`.
3. **Main stays real.** The app's main process keeps running unmodified in real Electron. We
   patch the Electron modules it `require`s, and the app's code doesn't change.
4. **Return the same shapes Electron returns.** A web message box resolves
   `{ response, checkboxChecked }`; a web open dialog resolves `{ canceled, filePaths }` with
   **real host paths**. App code can't tell the difference.
5. **Fail loudly, never silently.** An API with no fallback logs one clear
   `[electron-tab] X is not supported` line and returns a harmless value. It never crashes main.

---

## 2. Architecture changes (foundation)

These come first. Every feature row in §3 builds on them.

### 2.1 Patch registry (main process)

Today `hook.cjs` only swaps `BrowserWindow` and wraps `dialog`. Change it to one module per
patched API:

```
src/patches/
  window.cjs        BrowserWindow, BaseWindow, WebContentsView, webContents statics
  dialog.cjs
  menu.cjs          Menu, MenuItem, app menu, context popups
  tray.cjs
  notification.cjs
  shell.cjs
  clipboard.cjs
  screen.cjs        screen, nativeTheme
  protocol.cjs      protocol, session.webRequest, net bridging
  shortcuts.cjs     globalShortcut, accelerators
  misc.cjs          powerSaveBlocker, app badge/dock, autoUpdater stubs
```

Each module exports `{ name, install(electron, bridge, surface) }`. `hook.cjs` builds the
patched `electron` export from the registry, and a module installs only when its surface is
`web`.

### 2.2 Two-way RPC (main ↔ tab)

Today messages go tab → main (`invoke`, `send`), and main can only push events back. Add
**main → tab requests** that return a reply:

```
main → tab   { type: 'call', id, op: 'ui.messageBox', payload }
tab  → main  { type: 'call-result', id, value | error }
```

- **Target:** the focused window's socket; otherwise the shell (§2.3).
- **No tab connected:** queue the request until a tab connects. After a timeout (default 60 s),
  fall back to `native` and log it.
- **Uses:** dialogs, `executeJavaScript`, `clipboard.readText`, `capturePage`, screen info,
  `printToPDF` snapshots.

### 2.3 Shell page: one tab that holds the whole app

`/` stops serving the main window directly. It serves the **shell**, a small desktop inside the
tab:

```
┌ menubar (app menu, roles, accelerators) ─────────────── tray icons ┐
│ ┌ window panel: main ───────────────────┐                          │
│ │ <iframe src=//w1.localhost:4400/>      │  ┌ modal panel ────────┐ │
│ │                                        │  │ child BrowserWindow │ │
│ └────────────────────────────────────────┘  └─────────────────────┘ │
│                                    toasts (Notification) ─────────▶ │
└ dialog layer (message box, file browser, context menus) ───────────┘
```

- **Each `BrowserWindow` is an iframe in a panel.** Panels can be dragged and resized, can be
  minimised or maximised, and can go full screen (Fullscreen API).
- **`modal: true` with a `parent`** → an overlay panel with a backdrop that blocks the parent.
- **`frame: false`** → no panel chrome. `-webkit-app-region: drag` areas move the panel, and
  `titleBarOverlay` draws the window controls.
- **Layout modes:**
  - `--layout desktop` (default): floating panels.
  - `--layout tabs`: one panel at a time, with a tab strip.
  - `--layout single`: the main window fills the page, the old behaviour.
- **One origin per target origin.** The shell is `app.localhost:4400` and each target origin
  gets `o<n>.app.localhost:4400` (Chrome resolves `*.localhost` to loopback). Both share the
  site `app.localhost`, which is what lets the Strict auth cookie reach the iframes; a
  `127.0.0.1` shell with `w<n>.localhost` iframes is cross-site and the cookie is withheld.
  - Windows that load the same origin share a subdomain, so `localStorage` and cookies are
    shared as they are in Electron.
  - This fixes today's "multiple windows loading different origins" gap, because the proxy can
    route by `Host` header.
- **Auth:** each subdomain needs its own cookie, so the shell loads iframes through
  `/__electron-tab/auth?token=…&next=/`.
- **The old per-window URL keeps working:** `/?__ew_win=<id>` redirects to that window's
  `o<n>.app.localhost` origin and shows it alone, for tests and agents that want a single target.

### 2.4 Window state mirroring

The real windows are hidden, so today several of these lie:

- `isVisible()`, `isFocused()`, `getBounds()`
- `BrowserWindow.getFocusedWindow()`, which returns `null`

Many apps call `getFocusedWindow()` when they open dialogs and menus. Fix: the shell reports
each panel's state (bounds, focused, minimised, full screen, visible) to main. The patched
getters and statics read that state, and the matching window events fire from it: `focus`,
`blur`, `resize`, `move`, `minimize`, `maximize`, `enter-full-screen`, `show`, `hide`.

### 2.5 Runtime additions (tab side)

`runtime.js` grows interceptors. Each one is described in its row in §3.

- `window.open` and `<a target=_blank>`
- `beforeunload` / `window.close()`
- keydown forwarding (accelerators, `before-input-event`)
- `contextmenu` → `context-menu`
- title and favicon reporting
- a `fetch`/XHR/`src` rewriter for `app://` and `file://` URLs and CORS
- file drag-drop paths

---

## 3. Coverage matrix

Legend: ✅ works today · 🟡 partial · P1–P4 planned phase (§4) · ⛔ stub (no-op plus log)

### 3.1 Windows and views

| Electron API | Today | Web fallback | Phase |
|---|---|---|---|
| `BrowserWindow` with preload | ✅ panel in the shell | | P0 ✅ |
| `BrowserWindow` without preload (helpers) | ✅ stays real Electron | Unchanged. Visible popups like this can optionally go into a panel (load the URL in an iframe) | P1 |
| `parent` + `modal: true` | 🔲 | Overlay panel with backdrop; parent blocked | P1 |
| `setTitle`, `page-title-updated` | ✅ panel title + shell `document.title` | | P0 ✅ |
| `setBounds/getBounds/setSize/center/setPosition` | ✅ panel geometry, mirrored (§2.4) | | P0 ✅ |
| `minimize/maximize/restore/setFullScreen/isX()` | ✅ panel state (full screen fills the tab; no Fullscreen API yet) | | P0 ✅ |
| `close()`, `close` event + `preventDefault`, `closed` | ✅ panel ✕ → real `win.close()` | | P0 ✅ |
| `hide()/show()`, `isVisible()` | ✅ panel hidden/shown (hidden panels keep loading) | | P0 ✅ |
| `focus()`, `getFocusedWindow()`, `focus/blur` events | ✅ panel z-order and focus, reported to main | | P0 ✅ |
| `frame: false`, `-webkit-app-region`, `titleBarOverlay` | 🔲 | Drag regions move the panel; controls drawn by the shell | P1 |
| `setAlwaysOnTop`, `setOpacity`, `transparent`, `vibrancy` | 🔲 | z-order pin / CSS opacity / transparent panel; vibrancy ignored | P3 |
| `setProgressBar`, `flashFrame`, `setOverlayIcon` | 🔲 | Progress strip on the panel, title flash, favicon badge | P3 |
| `BrowserView`, `WebContentsView`, `BaseWindow` | ⛔ | Positioned iframes inside the panel (`setBounds` → CSS) | P3 |
| `<webview>` tag | ⛔ | Custom element that wraps an iframe; cross-origin pages go through the proxy | P3 |
| `window.open`, `setWindowOpenHandler`, `did-create-window` | 🔲 | Runtime intercepts → asks main's handler. `deny` → nothing (or `shell.openExternal`); `allow` → new panel with `overrideBrowserWindowOptions` | P1 |

### 3.2 webContents

| Electron API | Today | Web fallback | Phase |
|---|---|---|---|
| `send`, `ipc.handle/on` | ✅ | | |
| `loadURL`, `loadFile`, `reload` | ✅ | | |
| `did-finish-load`, `dom-ready`, `ready-to-show` | ✅ | | |
| `did-navigate`, `did-navigate-in-page`, `will-navigate` (cancellable), `did-fail-load` | 🔲 | Runtime reports `popstate`/`pushState`/link clicks; `will-navigate` asks main first | P1 |
| `executeJavaScript` | ✅ `call` RPC → same-origin `<script src>` (CSP-safe) → result returned. `…InIsolatedWorld`: P1 | | P0 ✅ |
| `insertCSS`, `removeInsertedCSS` | 🔲 | RPC → `<style>` tag | P1 |
| `print()` | ✅ Chrome print dialog | Web surface: Chrome dialog. For agents, also offer "print to PDF and show it in a panel" | ✅/P2 |
| `printToPDF()` | ⛔ throws | Tab sends a DOM snapshot (inlined CSS, base URL) → hidden real helper window loads it → real `printToPDF` | P2 |
| `capturePage()` | 🔲 | Same snapshot trick → helper `capturePage`. Faster alternative: Chrome DevTools Protocol screenshot when the browser was launched by us | P2 |
| `findInPage`, `found-in-page` | 🔲 | `window.find()` + match counting | P3 |
| `undo/redo/cut/copy/paste/selectAll/delete` | 🔲 | `document.execCommand` in the iframe | P1 |
| `setZoomFactor/Level`, `zoom-changed` | 🟡 renderer only | RPC → CSS zoom | P2 |
| `goBack/goForward/canGoBack/getURL/getTitle/isLoading` | 🔲 | History state reported by the runtime | P1 |
| `context-menu` event (with `params`) | 🔲 | Runtime `contextmenu` → builds Electron's `params` (x, y, selectionText, isEditable, linkURL, srcURL, mediaType) | P1 |
| `before-input-event` | 🔲 | keydown/keyup forwarding; `preventDefault` honoured with a sync round-trip for listed keys only | P1 |
| `console-message` | 🔲 | Runtime forwards console calls | P2 |
| `render-process-gone`, `unresponsive` | 🔲 | Socket closed with no reload → `render-process-gone`; missed heartbeat → `unresponsive` | P2 |
| `setUserAgent`, `navigator.userAgent` contains `Electron` | 🔲 | Opt-in: boot script overrides `navigator.userAgent` (apps that branch on it) | P2 |
| `openDevTools` | ✅ ignored | Chrome DevTools (F12) | |
| `setAudioMuted`, `isCurrentlyAudible` | 🔲 | Mute all media elements | P4 |
| `webContents.getAllWebContents/fromId/getFocusedWebContents` | ✅ `getFocusedWebContents` uses the mirrored state | | P0 ✅ |

### 3.3 IPC and renderer-side modules

| Electron API | Today | Web fallback | Phase |
|---|---|---|---|
| `ipcRenderer.invoke/send/sendSync/on/once` | ✅ | | |
| `contextBridge.exposeInMainWorld` | ✅ | | |
| `ipcRenderer.postMessage`, `MessageChannelMain`, `MessagePortMain` | ⛔ | Port proxy over the WebSocket: each port gets an id; `postMessage`/`start`/`close` relayed in both directions. Also covers `utilityProcess` ↔ renderer ports | P3 |
| `contextBridge.exposeInIsolatedWorld` | ⛔ | Same as main world (no isolated worlds in a tab) | P3 |
| `webFrame` zoom/insertCSS/executeJavaScript | ✅ | | |
| `webUtils.getPathForFile`, `File.path` | 🟡 returns `""` | Files picked through the web file dialog carry real paths. Files dropped from the OS are uploaded to a temp folder in main, and that temp path is returned | P2 |
| `clipboard` in renderer (non-sandboxed) | 🔲 | `navigator.clipboard`, falling back to main's clipboard | P2 |
| `nativeImage` in renderer | 🔲 | Thin browser version (`createFromDataURL`, `toDataURL`, `toPNG`, `getSize`) | P3 |
| `process.env/argv/cwd()` in preload | 🟡 empty | Snapshot from main (env filtered to an allowlist) | P2 |
| Node builtins in preload (`fs`, `path`, `os`, …) | ⛔ throws | **Node RPC:** pure modules (`path`, `events`, `util`, `buffer`, `url`) get browser polyfills. `fs`, `os`, `child_process`, … are proxied to main (async via WS, `*Sync` via sync XHR) | P3 |
| `nodeIntegration: true` (Node in page code) | ⛔ | Same Node RPC, exposed as `require` in the page | P3 |
| `@electron/remote` / `remote` | ⛔ | Object-handle RPC on top of the Node RPC | P3 |
| `alert/confirm/prompt` | Chrome native | Leave as Chrome's (Playwright and agents already handle them). Optional: HTML modal | P4 |

### 3.4 Main-process modules that show UI (the main web-surface work)

| Electron API | Today | Web fallback | Phase |
|---|---|---|---|
| `dialog.showMessageBox` | 🟡 native, unparented | HTML modal: title, message, detail, buttons (`defaultId`, `cancelId`), checkbox, icon, `type` → `{ response, checkboxChecked }` | P1 |
| `dialog.showErrorBox` | native | HTML alert modal | P1 |
| `dialog.showOpenDialog` | 🟡 native | **Web file browser** backed by main: lists the real host folders, with `filters`, `properties` (`openFile`, `openDirectory`, `multiSelections`, `showHiddenFiles`), and `defaultPath` → `{ canceled, filePaths }` with real paths | P1 |
| `dialog.showSaveDialog` | 🟡 native | Same browser with a filename field and an overwrite confirmation → `{ canceled, filePath }` | P1 |
| `dialog.*Sync` variants | native | Main is blocked inside these, so the bridge can't answer. v1: stay native. v2: move the bridge server into a `worker_thread`; main waits with `Atomics.wait` while the worker asks the tab | P1 native / P4 web |
| `Menu.setApplicationMenu`, `Menu.buildFromTemplate` | 🔲 invisible | Shell menubar: labels, submenus, separators, checkbox/radio, `enabled`/`visible`, accelerators shown and bound. Click → `item.click(item, win, event)` in main. Live updates when items change | P1 |
| Menu `role`s (`copy`, `paste`, `undo`, `reload`, `toggleDevTools`, `zoomIn`, `quit`, `minimize`, `close`, `togglefullscreen`, …) | 🔲 | Mapped to tab or panel actions; `quit` → `app.quit()` | P1 |
| `Menu.popup()` (context menus) | 🔲 native, unseen | HTML context menu at the cursor (or at `x/y`), in the right panel; `menu-will-close` | P1 |
| `Tray` (icon, tooltip, menu, click events, `displayBalloon`) | 🔲 invisible | Icons on the right of the shell menubar; click/right-click → events and context menu; balloon → toast | P3 |
| `Notification` (main) | native toast | In-tab toast (title, body, icon, actions, `reply`) → `click`/`action`/`close`/`reply` events. Optional: also the browser Notification API | P1 |
| `shell.openExternal` | opens the host browser | New browser tab (`window.open` from the shell, with a banner link if popups are blocked) | P1 |
| `shell.openPath`, `showItemInFolder` | host | Stays native, plus a toast "Opened X on the host". Optional: in-tab preview for text and images | P2 |
| `shell.beep` | host | WebAudio beep | P4 |
| `app.setBadgeCount`, `dock.setBadge`, `dock.bounce` | ⛔ | Favicon badge, title prefix, panel flash | P3 |

### 3.5 Main-process modules with no UI, but tied to the tab's environment

| Electron API | Today | Web fallback | Phase |
|---|---|---|---|
| `clipboard` (main) | host clipboard | `web`: `writeText` → pushed to the tab's `navigator.clipboard`; `readText` → read from the tab (asks permission), falling back to host. Matters when the browser runs on another machine | P2 |
| `screen.getPrimaryDisplay/getAllDisplays/getCursorScreenPoint`, `display-*` events | host values | The tab reports `window.screen`, viewport and devicePixelRatio, so layouts fit the tab | P2 |
| `nativeTheme.shouldUseDarkColors`, `themeSource`, `updated` | host | Taken from the tab's `prefers-color-scheme`; `themeSource` → `color-scheme` on the shell and iframes | P2 |
| `globalShortcut.register` | host-wide | Tab keydown listener (works only while the tab has focus; documented) | P2 |
| `powerSaveBlocker` | host | Screen Wake Lock API in the tab | P4 |
| `powerMonitor` (`suspend`, `resume`, `lock-screen`, `getSystemIdleTime`) | host | Keep host; add Page Visibility as `lock-screen`/`unlock-screen` when tab-driven mode is on | P4 |
| `protocol.handle`, `registerFileProtocol`, custom schemes (`app://`) | ⛔ 501 | Route `/__electron-tab/proto/<scheme>/…` → build a `Request` → call the app's handler in main → stream the `Response`. Pages loaded from `app://` are served under that route. The runtime rewrites `app://` in `src`/`href`/`fetch`/XHR/CSS `url()` | P2 |
| `file://` URLs inside the page (local images, videos) | 🔲 broken | Route `/__electron-tab/file?p=…`, allowed only for paths under the app folder or paths main already handed out (dialogs, drops) | P2 |
| CORS: `webSecurity: false`, `session.webRequest` header rewriting | 🔲 fails in Chrome | Runtime sends cross-origin `fetch`/XHR to `/__electron-tab/net`, which runs `net.fetch` in main under the window's session, so `webRequest` hooks and session cookies apply | P2 |
| `session.cookies` | host session | Unchanged for main-side requests; documented that the tab's own cookies are Chrome's | P2 |
| `session.on('will-download')`, `webContents.downloadURL`, `DownloadItem` | 🔲 | `web`: stream the file to the tab as a browser download (agent-visible); `native`: save on host (today) | P2 |
| `session.setPermissionRequestHandler` (camera, mic, notifications) | 🔲 | Chrome's own permission prompts; when main's handler denies, the runtime blocks that API | P4 |
| `desktopCapturer.getSources` | host | `getDisplayMedia` in the tab (the user picks; agents can't) | P4 |
| `app.setAsDefaultProtocolClient`, `open-url`, `second-instance`, `open-file` | host | Control page and `/__electron-tab/open-url?url=…` endpoint to fire these by hand or from tests | P3 |
| `app.getPath/getVersion/getLocale/…` | ✅ host | | |
| `fs`, `child_process`, `net`, `safeStorage`, `systemPreferences`, `utilityProcess` in main | ✅ host | | |
| `autoUpdater`, `crashReporter`, `contentTracing`, `netLog` | host | ⛔ stub in dev (`update-not-available`, no-op) | P4 |
| `TouchBar`, `inAppPurchase`, `pushNotifications`, jump lists, thumbar buttons, `ShareMenu` | host | ⛔ stub; `ShareMenu` → Web Share API | P4 |

---

## 4. Phases

Ordered by how many real apps each phase unblocks. A large webpack + React app (print service, PDF
preview) is the reference app for P0–P2.

| Phase | Scope | Done when | Size |
|---|---|---|---|
| **P0 Foundation** ✅ | Patch registry (§2.1); two-way RPC (§2.2); shell with panels and `*.localhost` origins (§2.3); window state mirroring and `getFocusedWindow` (§2.4); `--layout`, `--native` flags | Sample app runs inside the shell; two windows open side by side; existing 10 checks still pass | L |
| **P1 Visible UI** | Web dialogs (message, error, open, save with real paths); app menu + roles + accelerators; context menus (`Menu.popup` + `context-menu` event); `window.open`/`setWindowOpenHandler`; modal/child windows; frameless windows; Notification toasts; `shell.openExternal`; `executeJavaScript`/`insertCSS`; navigation events; `before-input-event`; edit commands | An agent using only the browser (Playwright MCP) can open a file, use every menu item, answer every dialog, and use a modal window in the sample app and in a large real-world app | L |
| **P2 Plumbing** | Custom protocols; `file://` assets; CORS via `net`; downloads; drag-drop paths / `getPathForFile`; clipboard; `screen`/`nativeTheme`; `globalShortcut`; `printToPDF`/`capturePage` through DOM snapshots; `console-message`, crash events; UA option; env snapshot | A real app's print, PDF and file flows all work from the tab with no native window appearing | L |
| **P3 Compatibility** | MessagePort IPC; Node RPC (preload builtins, `nodeIntegration`, `@electron/remote`); `BrowserView`/`WebContentsView`/`<webview>`; Tray; badges and progress; deep links; always-on-top/opacity | One older app (nodeIntegration + remote) and one `WebContentsView` app run unchanged | XL |
| **P4 Agent tooling and polish** | `/__electron-tab/state` JSON (windows, open dialogs, menus); event log; ARIA audit; `--headless` (no native window may ever appear: helpers stay offscreen); dialog auto-answer rules for tests; sync dialogs via worker bridge; MCP server (`electron-tab mcp`: list windows, click menu item, answer dialog, read IPC log); remaining stubs | An agent can drive a full app flow with only the shell URL, with no human help on the host | L |

P0 → P1 → P2 must happen in order. P3 and P4 items are independent of each other and can be
done in any order after P1.

---

## 5. Hard limits (cannot be made faithful in a browser)

- **Sync dialogs** from main block Electron's event loop. They can only go web after the bridge
  moves into a worker thread (P4).
- **Global shortcuts** only fire while the tab has focus.
- **True OS windows:** transparent click-through windows, vibrancy, always-on-top above *other
  apps*, and multi-monitor placement can only be approximated inside the tab.
- **Native Node addons** loaded in the renderer (`.node` files). These need the Node RPC, and
  only work if their API can be serialised.
- **`desktopCapturer` and screen share** need a human to pick the source in Chrome's own
  picker.
- **The host's clipboard and the tab's clipboard** are different when the browser runs on
  another machine. `web` mode follows the tab.
- **Performance:** every main ↔ renderer call now crosses a WebSocket. Fine for UI; heavy
  streaming (hundreds of MB/s over IPC) will be slower than in Electron.

---

## 6. Open decisions

1. **Default surface:** `web` everywhere (best for agents and remote viewing) or `native` for
   dialogs when the tab is on the same machine (familiar for humans)? Proposal: `web` by
   default, plus a `--native` flag.
2. **Default layout:** `desktop` (floating panels) or `tabs`? Proposal: `desktop`; agents can
   pass `--layout single` for one simple target.
3. **Node RPC scope:** proxying `fs`/`child_process` from page code is powerful and risky.
   Proposal: off by default, enabled per app with `--node-rpc`, only on `127.0.0.1`.
4. **MCP server:** build it into the CLI (`electron-tab mcp`) or ship it as a separate package?

---

## 7. Test plan

- **Kitchen-sink sample app** (extends `examples/basic-app`). It has one button or check per
  matrix row: dialogs, menus, tray, notifications, modal and child windows, `window.open`,
  custom protocol, file drop, downloads, clipboard, theme, and so on.
- **Playwright suite** drives it in Chrome. Every row in §3 links to a test. The suite runs on
  Windows, macOS and Linux.
- **Agent test:** an agent (Playwright MCP or Claude in Chrome) gets one task per phase, such as
  "open invoice.pdf from Documents and print it", with only the shell URL. It passes when the
  agent finishes without a native window appearing.
- **Real apps:**
  - a large webpack + React 18 app with a print service
  - one Electron Forge + webpack template app
  - one older `nodeIntegration` + `@electron/remote` app
  - one `WebContentsView` app

---

## 8. P0 build notes (2026-10-27)

Built: patch registry (`src/patches/{ipc,dialog,window}.cjs`), two-way RPC (`bridge.call`),
shell (`src/client/shell.{js,css}`) with `desktop`/`tabs`/`single` layouts, per-origin
`o<n>.app.localhost` routing, window state mirroring, `executeJavaScript`, title and focus
reporting, `/__electron-tab/state` JSON, `--layout` and `--native` flags. The sample app has
12 checks (all pass) and an "Open a second window" button.

§6 defaults taken: surface `web` (flag `--native` exists; nothing uses it until P1), layout
`desktop`. Node RPC and MCP packaging are still open.

Findings worth knowing:

- **Electron filters windows by class name.** `BrowserWindow.fromId()`, `getAllWindows()` and
  `getFocusedWindow()` keep only windows whose `constructor.name === 'BrowserWindow'`. The
  old `WebBrowserWindow` subclass was silently missing from all three. The subclass is now
  named `BrowserWindow`.
- **Cookies and `*.localhost`.** See §2.3: the shell and window origins must share a site.
  The `/auth` endpoint now navigates with a same-origin script instead of a 302, so a hop from
  `127.0.0.1` to `app.localhost` doesn't count as cross-site.
- **Clicks inside an iframe never reach the shell,** and `window.focus` doesn't fire while the
  browser lacks OS focus (common under automation). The page runtime reports `pointerdown`
  as focus.
- **Agents and iframes.** Some browser-agent tools read only the top frame's accessibility
  tree and can't see inside the shell's cross-origin iframes (the Claude desktop browser's
  `find` couldn't). Playwright handles frames. Until P4 adds agent tooling, agents should use
  `--layout single` or the control page's "open alone" links. P4 should decide between
  same-origin panels (one origin when all windows share one) and an agent-facing API.
