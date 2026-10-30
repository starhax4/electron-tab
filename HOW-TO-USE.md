# electron2web: how to use

**electron2web** is a dev tool. It runs a whole Electron app in a normal Chrome tab, while the
app's real Electron main process keeps running hidden in the background. Every app window
becomes a panel inside that one tab. IPC (`invoke`, `send`, `sendSync`, `webContents.send`)
is carried between the two over a local WebSocket.

You get Chrome DevTools and extensions (React/Vue DevTools), Playwright/Cypress, responsive
mode and Lighthouse against your real app, without changing its code.

> Proof of concept. Tested on Windows with Node 24, Electron 33 and electron-vite 2.

---

## Quick start: install once, use in any app

Install it globally, like any other CLI tool. Then you don't need to add it to each app.

**On any PC with Node 18+**, straight from the GitHub release (no download, no clone):

```bash
npm install -g --allow-remote=all https://github.com/starhax4/electron2web/releases/latest/download/electron2web.tgz
```

Or, from this zip:

**Windows:** double-click **`install-global.cmd`** in this folder.
**macOS / Linux:** run `sh install-global.sh`.

Or run it by hand from this folder:

```bash
npm install -g ./electron2web-0.1.0-beta.2.tgz
```

Then, in **any** Electron app folder, wrap the command that normally starts it:

```bash
electron2web -- npm start
electron2web -- yarn start
electron2web -- npm run dev
electron2web
```

(The plain `electron2web` runs `npx electron .`.) The `--` is optional: `electron2web yarn start`
works too.

Open the URL it prints after `[electron2web] ready`.

Run more than one app at the same time by giving each its own port:

```bash
electron2web --port 4401 -- npm start
```

To update, run the installer again with a newer `.tgz`. To remove it: `npm uninstall -g electron2web`.

> npm may print `install scripts blocked` warnings for `esbuild` / `msgpackr-extract`. They're
> harmless: electron2web works without them.

The rest of this guide covers the sample app and installing per app instead.

---

## What's in this zip

```
electron2web/
├── HOW-TO-USE.md              ← this file
├── install-global.cmd         ← Windows: double-click to install the CLI globally
├── install-global.sh          ← macOS/Linux: same
├── electron2web-0.1.0-beta.2.tgz     ← the tool, packed (used by the installers / step 3)
├── packages/electron2web/     ← the tool's source (CLI + bridge)
│   ├── bin/cli.js
│   ├── src/                   ← hook, bridge server, bundler, browser runtime
│   └── README.md              ← technical details and how it works
└── examples/basic-app/        ← sample electron-vite app that tests itself
```

`node_modules` isn't included. You install it in step 1.

---

## Requirements

- **Node.js 18 or newer** (`node -v`)
- **Google Chrome** (or any Chromium browser)
- Internet for the first install (npm packages + the Electron binary, about 100 MB)

---

## 1. Setup on a new computer

Unzip anywhere, open a terminal in the unzipped `electron2web` folder, then:

```bash
cd packages/electron2web
npm install
cd ../../examples/basic-app
npm install
```

**Check that Electron downloaded.** Newer npm versions (11+) block package install scripts,
and Electron needs its install script to download its binary. Run this to be sure; it's
harmless if Electron is already there:

```bash
node node_modules/electron/install.js
```

If it prints `electron.exe` (Windows) or similar, you're good.

---

## 2. Run the sample app

From `examples/basic-app`:

```bash
npm run web
```

Wait until the terminal prints:

```
[electron2web] ready. Open this in Chrome: (Electron up in 0.4s · layout desktop · port 4400)

  ➜  Open:          http://app.localhost:4400/__electron2web/auth?token=xxxxxxxx&next=%2F
  ➜  Windows:       http://app.localhost:4400/__electron2web/
  ➜  State JSON:    http://app.localhost:4400/__electron2web/state
  ➜  Session file:  C:\Users\you\.electron2web\session.json
```

Open the **Open** URL in Chrome (or start with `--open` to have it opened for you). (`*.localhost` addresses always point at your own computer;
Chrome needs no setup for them.)

> ⚠️ **Don't** open the `http://localhost:5173` link Vite prints. That page has no Electron
> behind it. The UI shows up, but there's no data from main (`window.api` is undefined).

### What you should see

- "Running in a regular browser tab via electron2web"
- **Clock from main** counting up every second (pushed from the main process)
- **12 rows of PASS** in the IPC checks table
- An **Open native file dialog** button that opens a real OS file picker
- An **Open a second window** button: the new window opens as a second panel you can drag,
  resize, minimise and close
- A **taskbar** at the bottom: one entry per window with its window number (`BrowserWindow.id`),
  the focused one highlighted, minimised ones faded. Click to focus, × or middle-click to close.
  On the right, a dot shows whether the tab is connected to Electron and how many windows are open.
- A **Print this window** button that opens Chrome's print dialog

### Things to try

| Do this | Expected |
|---|---|
| Edit `src/renderer/style.css` | Style updates instantly (hot reload) |
| Edit `src/main/index.js` and save | Red banner → Electron restarts → tab reloads by itself |
| Press F12 | Normal Chrome DevTools on your Electron UI |
| Open `http://app.localhost:4400/__electron2web/` | Control page listing the app's windows |
| Open `http://app.localhost:4400/__electron2web/state` | Every window's state as JSON |

To compare with normal Electron, stop it (Ctrl+C) and run `npm run dev`.

After the first visit, the token is remembered in `~/.electron2web/token`, so
`http://app.localhost:4400/` keeps working across restarts.

---

## 3. Use it with your own Electron app

If you installed it globally (Quick start), skip to **Run it** and drop the `npx`.

### Or install it into your app only

From your app's folder, install the **`.tgz`** file (adjust the path to where you unzipped this):

```bash
npm install -D C:/path/to/electron2web/electron2web-0.1.0-beta.2.tgz
```

or with yarn:

```bash
yarn add -D C:/path/to/electron2web/electron2web-0.1.0-beta.2.tgz
```

> ⚠️ Install the `.tgz`, **not** the `packages/electron2web` folder. npm only symlinks a folder
> and skips its dependencies, which gives `Cannot find module 'ws'`.

### Run it

If your app starts with `npm start` / `yarn start`:

```bash
npx electron2web -- npm start
npx electron2web -- yarn start
```

### Or add a script

In your app's `package.json`, wrap the command you already use to start Electron:

```json
"scripts": {
  "dev": "electron-vite dev --watch",
  "web": "electron2web -- electron-vite dev --watch"
}
```

Other examples:

```json
"web": "electron2web -- npm run dev"
"web": "electron2web -- electron-forge start"
"web": "electron2web"
```

(The last one runs `npx electron .` for you.)

Then run `npm run web` and open the URL printed after `ready`.

> Don't put `electron2web` inside the `start` script itself; it would call itself in a loop.

### Your app works best if

- ✅ The main process is **CommonJS** (`require`). electron-vite's default output is fine.
- ✅ It uses a **preload** with `contextBridge.exposeInMainWorld(...)` and `ipcRenderer`.
- ✅ The preload only imports `electron`, not `fs`, `path`, `child_process`, etc.
- ✅ It runs in **dev mode** (not a packaged `.exe`/`.app`).

### Which windows move to the browser

Only windows created **with a preload** are shown in Chrome, each as a panel in the shell.
Moving, resizing, focusing, minimising, maximising and closing a panel updates the real
window's state in main, so `getBounds()`, `isFocused()`, `BrowserWindow.getFocusedWindow()`
and events like `focus`, `resize` and `close` behave as in Electron. Windows without one stay
normal Electron windows: hidden print/PDF helper windows keep working, and popups for
external links open as real windows.

Printing:

- `webContents.print()` on a window shown in Chrome opens **Chrome's** print dialog.
- Printing through a hidden helper window (`loadFile(pdf)` + `window.print()`, or
  `printToPDF`) runs in real Electron, so you get the **native** print dialog on your desktop.
- `printToPDF()` on a window shown in Chrome isn't supported. Do it in a helper window.

### Not supported yet

- `nodeIntegration: true` (Node APIs used directly in page code)
- Preloads that use Node modules. They load, but calls into them throw.
- `<webview>`, `BrowserView` / `WebContentsView`, `MessagePort` IPC (`ipcRenderer.postMessage`)
- Custom protocol schemes (`app://…`) used inside the page
- In-tab dialogs, menus, tray and notifications (planned; see `docs/electron-api-coverage-plan.md`).
  Dialogs still open natively on your desktop.
- Browsers other than Chrome/Edge/Chromium: untested
- Yarn 2+ Plug'n'Play (no `node_modules` folder): untested
- ESM main process (`"type": "module"` with `import ... from 'electron'`)
- Packaged/production builds

---

## Options

```bash
electron2web [--port <n>] [--layout desktop|tabs|single] [--native <list>] [--public-host <url>] [--open] [--debug] [--new-token] [-- <command>]
```

| Option | What it does |
|---|---|
| `--port 5000` | Use another port (default `4400`) |
| `--layout desktop` | Default. Every window is a panel you can move and resize, with a taskbar |
| `--layout tabs` | One window at a time, with a tab strip on top |
| `--layout single` | No shell: the main window fills the tab (simplest target for tests and agents) |
| `--native dialog,notification` | Keep these on the host's real OS UI once their in-tab versions exist (`all` for everything) |
| `--public-host https://abc.trycloudflare.com` | Also serve the app on a tunnel or proxy address, for another machine. See "Use it from another machine" |
| `--open` | Open the app in your default browser once it's ready (only the first time, not on Electron restarts) |
| `--debug` | Log every window state change and IPC call (channel, time taken, reply size) |
| `--new-token` | Make a new access token, which signs out all open tabs |
| `-- <command>` | The command that starts your app (default `npx electron .`) |

## For AI agents and test scripts

- **The URLs** are written to `~/.electron2web/session.json` (latest run) and
  `~/.electron2web/session-<port>.json` (one per port, removed on a clean quit) each time Electron starts
  (`url`, `publicUrl`, `stateUrl`, `windowsUrl`, `port`, `pid`), so a script that starts
  electron2web in the background doesn't need to parse the terminal.
- **Window state from main**: `GET http://app.localhost:4400/__electron2web/state` (after opening
  the auth link once in that browser).
- **Window numbers**: each window shows a number on its badge and taskbar entry. It is the
  lowest number free when the window opens, so after closing windows 2 and 3 the next one is
  2 again. The app's own `BrowserWindow.id` (which never repeats) is listed next to it.
- **In the shell tab**, `window.electron2web` drives the windows by that number, without hunting
  for buttons: `windows()` (each with `number` and `id`), `focused()`, `focus(n)`,
  `minimize(n)`, `maximize(n)`, `restore(n)`, `close(n)`, `frame(n)` (the window's `<iframe>`).
- **Stable selectors**: panels are `section.ew-panel[data-window-number="2"]` and taskbar entries
  `.ew-strip-item[data-window-number="2"]`, both with `data-state` = `focused`, `background`,
  `minimized` or `hidden` (`data-window-id` holds the `BrowserWindow.id`). Taskbar buttons have
  labels like "Window 2: Settings (background)".
- **One window per tab**, no shell: `http://app.localhost:4400/?__ew_win=<BrowserWindow.id>`, or
  `--layout single`.

---

## Use it from another machine (cloudflared, ngrok, localtunnel, nginx)

Start a tunnel to the bridge port, then pass the tunnel's public URL to `--public-host`:

```bash
cloudflared tunnel --url http://localhost:4400
electron2web --public-host https://<the-name-it-printed>.trycloudflare.com -- npm run dev
```

Other tunnels work the same way: `ngrok http 4400` or `npx localtunnel --port 4400`, then
pass the URL they print. The tunnel can start before or after electron2web. A quick tunnel's
URL changes every time, so pass the new one each run.

electron2web then prints a second link, `https://…/__electron2web/auth?token=…`. Open that on
the other machine.

How it differs from local use:

- All windows share the one tunnel hostname. The app's dev server is served at `/` and
  `loadFile()` pages under `/__electron2web/s<n>/`. If the app loads a **second** http(s)
  origin, those windows show a "not available over the public host" note; they still work locally.
- Windows on different origins share storage there (locally each origin keeps its own).
- The tunnel must pass the original `Host` header (cloudflared, ngrok and localtunnel do by
  default). Behind nginx, either keep it (`proxy_set_header Host $host;`) or send
  `X-Forwarded-Host`. Also forward WebSocket upgrades:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:4400;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1d;
  }
  ```

Without `--public-host`, a tunnel gets `403 Forbidden host`, and the terminal tells you which
`--public-host` to pass.

> **Anyone with that link controls your app's main process** (files, shell, everything main
> can do). Share it only with people you trust. For a longer-lived tunnel, put a login in front
> (for example Cloudflare Access), and run `electron2web --new-token` to revoke old links.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Unknown argument: yarn` (PowerShell) | Old version: PowerShell drops the `--`. Reinstall the latest `.tgz`, or run it from `cmd`. |
| `'electron2web' is not recognized` / `command not found` | Not installed globally. Run `install-global.cmd`, or use `npx electron2web` inside an app that has it installed. Open a new terminal after installing. |
| `Cannot find module 'ws'` / `missing dependencies: ws, msgpackr, esbuild` | You installed the `packages/electron2web` **folder**. Install the `.tgz` instead (step 3), or run `npm install` inside `packages/electron2web`. |
| UI shows but no data from main (clock stays `–`) | You opened Vite's `localhost:5173` link. Open the `app.localhost:4400/__electron2web/auth?token=…` URL instead. |
| `app.localhost` doesn't load | Your browser doesn't send `*.localhost` to your own computer. Use Chrome or Edge. |
| An AI browser agent can't see the app's buttons | Its tool may not read inside iframes. Use `--layout single`, or open one window alone from the control page. |
| Page says **Not authorized** | Open the full URL with `?token=` from the terminal again. |
| `Forbidden host` through a tunnel or proxy | Start with `--public-host <the tunnel's URL>`. Behind nginx, also keep the `Host` header (see "Use it from another machine"). |
| `could not listen on 127.0.0.1:4400` | An old run is still alive. Close it, or use `--port 4401`. On Windows, end leftover `electron.exe` in Task Manager if needed. |
| `Electron failed to install correctly` | Run `node node_modules/electron/install.js` in the app folder. |
| Console: `preload imports Node module 'fs'…` | Your preload uses Node APIs that can't run in a browser. Move that code into main behind an `ipcMain.handle`. |
| Main changes don't restart Electron | electron-vite needs `--watch`: `electron-vite dev --watch`. |
| Print hangs, or UI breaks after clicking Print | Old version: it also moved hidden print windows into the browser. Reinstall the latest `.tgz`. |
| A window has no preload and pops up as a real Electron window | Expected: only windows with a preload are moved to the browser (see "Which windows move to the browser"). |
| Real Electron window pops up | The hook didn't load. Make sure you started through `electron2web` (it sets `NODE_OPTIONS`). |

---

## Security note

The bridge gives the browser tab access to your main process, which has full file and
system access. It's locked down: it only listens on `127.0.0.1`, needs the token, and
rejects other websites (Origin and Host checks). Still:

- Expose it to other machines only through `--public-host`, and only to people you trust.
  Never bind it to `0.0.0.0`.
- Don't share your `~/.electron2web/token` file.
