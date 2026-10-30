# Changelog

## 0.1.0-beta.2

Renamed from electron-tab to **electron2web**. Uninstall the old one first
(`npm uninstall -g electron-tab`). Everything that carried the old name changed with it:

- CLI and package: `electron2web` (was `electron-tab`).
- URL prefix: `/__electron2web/` (was `/__electron-tab/`). Old printed links stop working.
- Env vars: `ELECTRON2WEB_*` (was `ELECTRON_TAB_*`).
- Shell API: `window.electron2web` (was `window.electronTab`).
- Token and session files: `~/.electron2web/` (was `~/.electron-tab/`), so a new token is made
  on first run.

## 0.1.0-beta.1 (first beta)

Run an Electron app's windows in a Chrome tab, bridged to the real Electron main process.

- CLI: `electron2web [options] -- <command>` wraps any start script (electron-vite, npm/yarn).
- IPC: `invoke`, `send`, `sendSync`, `event.reply`, `webContents.send`, `executeJavaScript`,
  structured-clone values (Buffer, Date, Map, Set, BigInt, errors).
- Windows: `desktop` (movable panels and a taskbar), `tabs` and `single` layouts. The first
  window opens maximized; window numbers are reused after windows close; focus, minimize,
  maximize, modal children and close all map onto `BrowserWindow` events.
- Remote use: `--public-host <tunnel URL>` (cloudflared, ngrok, nginx), with gzip and
  WebSocket compression.
- Speed: cached runtime and preload bundles (ETag/304, immutable runtime URL), keep-alive
  proxy to the dev server, source maps.
- Agents and scripts: `window.electron2web` in the shell, `/__electron2web/state` JSON,
  `~/.electron2web/session.json`, stable `data-window-number` / `data-state` attributes.
- Terminal: colored output (`NO_COLOR` respected), `--open`, `--debug`.
- Security: loopback only, Host allowlist, token → HttpOnly SameSite=Strict cookie, Origin
  checks on sockets and `sendSync`, no-referrer on bridge pages, call results accepted only from
  their target, malformed frames can't crash the main process.
- Fixed before release: closing a window from the taskbar no longer crashes Electron.
