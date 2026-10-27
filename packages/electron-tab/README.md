# electron-tab (beta)

Dev tool: run your whole Electron app in a normal Chrome tab, while the **real** Electron
main process keeps running underneath. Every window becomes a panel in one tab, so people and
AI browser agents can use the app with Chrome DevTools, extensions, Playwright, responsive
mode and Lighthouse, against your actual app, with no code changes.

```
Chrome tab: the shell (app.localhost:4400)          real Electron main process (dev)
┌──────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ panel: window 1                          │  WS    │ hook.cjs  (NODE_OPTIONS --require)   │
│  <iframe o1.app.localhost:4400>          │◄──────►│  patches/ window, ipc, dialog        │
│   boot.js     fake `electron`            │ msgpack│   • BrowserWindow → hidden subclass, │
│   preload.js  your preload, re-bundled   │        │     state mirrored from the panel    │
│   your UI     untouched                  │        │   • ipcMain.handle registry          │
│ panel: window 2 …                        │        │ bridge-server.cjs (127.0.0.1:4400)   │
│ taskbar / tab strip                      │◄──────►│  • shell socket: panel state, calls  │
└──────────────────────────────────────────┘  JSON  │  • proxies dev server + HMR socket   │
                                                    │  • or serves loadFile() directory    │
                                                    └──────────────────────────────────────┘
```

## Usage

```bash
# wrap whatever already starts Electron
npx electron-tab -- npm run dev
npx electron-tab -- electron-vite dev --watch
npx electron-tab            # defaults to: npx electron .
npx electron-tab --port 5000 --layout tabs -- npm start
```

| Option | What it does |
|---|---|
| `--port <n>` | Port for the bridge (default `4400`) |
| `--layout desktop` | Default. Every window is a panel you can move, resize, minimise, maximise and close |
| `--layout tabs` | One window at a time, with a tab strip |
| `--layout single` | No shell: the main window fills the tab (the old behaviour) |
| `--native <list>` | Keep features on the host's real OS UI, e.g. `--native dialog,notification` (or `all`). Reserved for the web surfaces landing in P1 |
| `--public-host <url>` | Also serve on a tunnel or reverse-proxy address (cloudflared, ngrok, localtunnel, nginx), e.g. `https://abc.trycloudflare.com`. See "Public host" |
| `--open` | Open the app in the default browser once ready (first start only) |
| `--debug` | Log window state changes and every IPC call with its timing |
| `--new-token` | Replace the saved access token |

Once Electron is up it prints `[electron-tab] ready. Open this in Chrome:` with an
`http://app.localhost:4400/__electron-tab/auth?token=…` URL. Open that one. **Don't** open the
dev server's own link (e.g. Vite's `http://localhost:5173`): that page has no Electron behind
it, so `window.api` is undefined.

The token is saved in `~/.electron-tab/token` and reused, so open tabs reconnect by themselves
after a restart. Old `http://127.0.0.1:4400/` bookmarks redirect to the shell.

- `http://app.localhost:4400/__electron-tab/` lists the windows, with an "open alone" link for
  each (one window per tab, no shell; handy for tests and agents).
- `http://app.localhost:4400/?__ew_win=<id>` opens one window alone.
- `http://app.localhost:4400/__electron-tab/state` returns every window's state as JSON
  (bounds, focus, visibility, title, URL).
- `~/.electron-tab/session.json` holds these URLs (plus port and pid) for the latest run, and
  `session-<port>.json` for each port; both are removed when that run quits cleanly.
- `--debug` (or `ELECTRON_TAB_DEBUG=1`) logs window state changes and IPC calls.
- Windows are numbered on their badge with the lowest free number, so numbers are reused after
  windows close (`BrowserWindow.id` never is). The app's first window opens maximized in the
  desktop layout, unless it is fixed-size.
- In the shell tab, `window.electronTab` has `windows()`, `focused()`, `focus(n)`,
  `minimize(n)`, `maximize(n)`, `restore(n)`, `close(n)` and `frame(n)`, where `n` is the window
  number. Panels and taskbar entries carry `data-window-number`, `data-window-id`
  (`BrowserWindow.id`) and `data-state` (`focused`, `background`, `minimized`, `hidden`).
- Terminal output is colored (chalk); `NO_COLOR=1` turns it off.

## How it works

- **Hook.** The CLI sets `NODE_OPTIONS=--require hook.cjs` and runs your command. Every Node
  process loads the hook, but it only acts inside Electron's main process. It intercepts
  `require('electron')` and builds the export from the patch registry in `src/patches/`
  (one module per Electron API, each `{ name, install(electron, { bridge, surface }) }`).
- **Windows.** The `BrowserWindow` subclass creates the real window hidden and never loads
  content. `loadURL`/`loadFile` record the target. `ready-to-show`, `dom-ready` and
  `did-finish-load` fire when the page in the tab reaches those points, and `loadURL()`
  resolves then too. Only windows with a preload are bridged; helpers stay real Electron.
- **Shell and origins.** Chrome resolves `*.localhost` to loopback. The shell is
  `app.localhost:<port>`, and each page origin the app loads gets `o<n>.app.localhost:<port>`
  (one per origin, or per folder for `loadFile()`), so windows on the same origin share
  storage as in Electron, and windows on different origins each route to the right server.
  All of them are the same *site*, so the `SameSite=Strict` auth cookie still reaches the
  shell's iframes. Each iframe is named `__ew:<id>`, which tells the injected loader which
  window it is.
- **Window state.** Bounds, focus, visibility, minimised, maximised, full screen and title live
  in main and are mirrored from the panels. The patched getters (`getBounds`, `isFocused`,
  `isVisible`, `BrowserWindow.getFocusedWindow()`, `webContents.getFocusedWebContents()`, …)
  read it. Setters move the panel, and the matching events (`focus`, `blur`, `show`, `hide`,
  `resize`, `move`, `minimize`, `maximize`, `enter-full-screen`, `page-title-updated`, …)
  fire when the user changes a panel.
- **Main → browser calls.** `bridge.call(windowId | 'shell', op, payload)` sends a request to
  the page or the shell and resolves with its reply. Calls wait for a tab to connect and reject
  with `code: 'ETIMEDOUT'` after 60 s. `webContents.executeJavaScript()` uses it: the code is
  served as a same-origin `<script src>`, so a `script-src 'self'` CSP still allows it.
- **IPC.**
  - `invoke` → handlers registered via `ipcMain.handle` / `webContents.ipc.handle`.
  - `send` → `webContents.ipc.emit` then `ipcMain.emit`, with an event whose `sender` is the
    real `webContents`, so `event.sender.send` and `event.reply` work.
  - `webContents.send` → pushed to the window's tab(s).
  - `sendSync` → synchronous XHR; `event.returnValue` comes back.
- **Encoding.** msgpack with records + structured-clone extensions. `Buffer` arrives as
  `Uint8Array`. `Date`, `Map`, `Set`, `BigInt`, `Error`, `undefined` and cycles survive.
- **Preload.** Re-bundled with esbuild for the browser when the window is created, and again only
  when one of its files changes (served with an ETag, so reloads get a 304). `electron` maps to the shim, and Node
  built-ins become stubs that throw clear errors. `process` is scoped to the preload, so the
  page doesn't see a fake Node environment.
- **Runtime.** The browser side (IPC, msgpack) is built once and served as
  `runtime.<hash>.js`, cached by the browser for good; source maps are separate files.
- **Dev server.** Requests reuse keep-alive connections to the dev server. HTML is proxied with one `<script src="/__electron-tab/loader.js">` injected
  first in `<head>` (external, so a `script-src 'self'` CSP still allows it).
  `X-Frame-Options` and CSP `frame-ancestors` are dropped so the page can sit in a panel.
  Other WebSocket upgrades (Vite HMR) are piped through to that origin's server.
- **Restarts.** When Electron restarts (`electron-vite --watch`), the shell shows a banner,
  waits for the bridge, and reloads.
- **Dialogs.** `dialog.*` stays native for now (in-tab dialogs are P1), with the hidden parent
  window removed so the dialog actually appears.

The roadmap for the rest of the Electron API is in `docs/electron-api-coverage-plan.md`.

## Public host (tunnels and proxies)

`--public-host https://abc.trycloudflare.com` makes the bridge also answer on that host, and
prints a second auth link for it. A tunnel gives one hostname, so the `o<n>` subdomains
don't exist there:

- the shell is at `/__electron-tab/app`;
- the first http(s) origin the app loads (its dev server) is served at `/`;
- `loadFile()` folders are served under `/__electron-tab/s<n>/` (built renderers use
  relative paths);
- a second http(s) origin can't be served there; its windows show a note and stay local-only;
- all windows share one origin, so they share storage, and the shell needs no token;
- text responses (JS, CSS, HTML, JSON) are gzipped, since everything crosses this machine's
  upload link (a 10 MB webpack dev bundle becomes about 2 MB), and WebSocket IPC frames over
  1 KB are compressed.

Requests must arrive with `Host` set to that host (cloudflared, ngrok and localtunnel keep it),
or from a loopback proxy that names it in `X-Forwarded-Host` (nginx). Origin checks expect
the public origin, including `https`, and the cookie gets `Secure` over https. Local access
keeps working unchanged at the same time.

## Security

The bridge exposes your main process, which has full filesystem and native access. It:

- binds to `127.0.0.1` only;
- rejects any `Host` other than `app.localhost:<port>`, its `o<n>.` subdomains, and
  `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding);
- requires a random token (saved in `~/.electron-tab/token`), exchanged per origin for an
  `HttpOnly; SameSite=Strict` cookie;
- requires a same-origin `Origin` on every WebSocket and on `sendSync`. Browsers don't apply
  CORS to WebSockets, so this check is what stops other sites from connecting;
- sends `Referrer-Policy: no-referrer` on its own pages and drops Referers that point at
  them, so `/auth?token=…` never reaches the app's `document.referrer`, analytics or servers;
- never serves token-bearing pages (the window list) on the app's own origins, and removes
  `ELECTRON_TAB_TOKEN` from the main process's environment once read;
- only lets the window (or shell) a call was sent to answer it, caps `sendSync` bodies at
  64 MB, and survives malformed socket frames without an uncaught exception.

The shell page embeds the token so it can authorise its iframes; it is served only to a
browser that already holds the cookie, on the shell's own origin. Expose the port only through
`--public-host` (https): anyone with that link controls the main process. Never bind it to
`0.0.0.0`. If a link leaks, run once with `--new-token`.

Known limits, as in Electron itself with a preload:

- any script on a window's page can talk IPC directly, not only through what the preload
  exposes. Don't load untrusted remote content in a window that has a preload.
- the shell delegates camera, microphone, geolocation, clipboard and fullscreen to the app's
  iframes, so the app can ask for them as it would in Electron.

## Verified (examples/basic-app, Electron 33, electron-vite 2, Windows, Chromium)

- `invoke`, `send`, `event.reply`, `sendSync`, `webContents.send` stream
- 1 MB `Buffer` → `Uint8Array`; Date/Map/Set/BigInt/undefined round-trip
- error propagation with Electron's message format
- `executeJavaScript` from main under a `script-src 'self'` CSP
- shell: a second window opens as a second panel; drag sends new bounds to main; clicking a
  panel moves `getFocusedWindow()`; closing a window removes its panel and refocuses the other;
  `--layout tabs` switches windows from the tab strip
- auto-reconnect after an Electron main-process restart
- `--public-host` through a stand-in tunnel (another hostname and port): all IPC checks pass,
  Vite HMR connects, a second window gets its preload, `loadFile()` build loads under
  `/__electron-tab/s1/`; foreign Host, wrong Origin on WebSocket and `sendSync`, and
  missing cookie are refused; nginx-style `X-Forwarded-Host` is accepted. Not yet tried
  against a real https tunnel.

Not yet verified: native dialogs (manual click), `loadFile()` builds, macOS/Linux, Firefox
(needs `*.localhost` to resolve to loopback).

## Not supported yet

- `nodeIntegration: true` renderers (Node APIs in page code)
- preloads that use `fs`, `path`, etc.: these throw on use
- `<webview>`, `BrowserView`/`WebContentsView`, `MessagePort` IPC (`postMessage`)
- custom `protocol.handle` schemes referenced from the DOM
- ESM main processes (`import` from `electron` bypasses `Module._load`; needs a loader hook)
- packaged apps (fuses/asar). This is a dev-mode tool by design.
