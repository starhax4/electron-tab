# electron-tab v1 beta: launch guide

Where things stand (27 Oct 2026) and the shortest path to a public beta.

## 1. What's ready

| Area | State |
| --- | --- |
| Core bridge (IPC, windows, preload, executeJavaScript) | Done; example app passes 12/12 checks |
| Shell UX (desktop/tabs/single, taskbar, numbering, maximized main window) | Done |
| Speed (caching, keep-alive proxy, 304s, gzip over tunnels) | Done |
| CLI/DX (colors, `--open`, `--debug`, session file) | Done |
| Agents (`window.electronTab`, `/state`, stable selectors) | Done |
| Security pass (referrer leak, token exposure, crash-on-bad-frame, call spoofing, open redirect) | Fixed; see README "Security" |
| Real app | A large webpack + React production app runs on it |

## 2. Before you publish: must do

1. ~~Pick a name~~: **electron-tab** (free on npm as of 27 Oct 2026).
2. ~~LICENSE~~: MIT, Hamza Islam.
3. ~~Git repo~~: github.com/starhax4/electron-tab, with CI, issue templates, CONTRIBUTING and
   SECURITY.
4. **Test on more real apps**, ideally a plain `electron .` app (no Vite) and a
   `loadFile()` production build. Both paths are coded but not yet checked against a real app.
5. **Try one real https tunnel** (`cloudflared tunnel --url http://localhost:4400` plus
   `--public-host`). It works with a stand-in tunnel; it has never been tried against a real one.
6. **Test on macOS** at least once. Everything so far ran on Windows.

## 3. Publish steps

```bash
cd packages/electron-tab
npm version 0.1.0-beta.1 --no-git-tag-version
npm pack --dry-run
npm login
npm publish --tag beta --access public
```

- `--tag beta` keeps plain `npm i electron-tab` from picking up the beta.
- Testers install with `npm i -D electron-tab@beta`, or `npx electron-tab@beta -- npm run dev`.
- Then update `install-global.*` and HOW-TO-USE to the new version (or drop the tgz in
  favour of npm).

## 4. Beta announcement: what to say

- **One line:** "Open your Electron app in Chrome: same main process, real IPC, and every
  window in one tab, so Playwright, DevTools MCP and Claude in Chrome can drive it."
- **Who it's for:** Electron teams that want browser-based E2E tests and AI agents on their
  desktop app, or want to demo or test it remotely through a tunnel.
- **Be upfront about:**
  - it's a dev-mode tool, not for packaged apps;
  - `nodeIntegration` renderers, `<webview>`, `BrowserView` and MessagePort IPC aren't
    supported yet;
  - native dialogs, menus, tray and notifications still open on the host machine (the plan
    for drawing them in the tab is in `electron-api-coverage-plan.md`).
- **Ask testers for:** their Electron version, OS, bundler, layout, and the first
  `[electron-tab]` error line. Running with `--debug` gives the most detail.

## 5. Known limits to state in the README (already listed)

- Any script on a window's page can call IPC directly (same as a preload in Electron), so
  don't load untrusted remote content in a window that has a preload.
- The access token is long-lived (`~/.electron-tab/token`). Rotate it with `--new-token` if a
  link leaks. Per-run session cookies are on the roadmap.
- Window numbers are display numbers; `BrowserWindow.id` (in `windows()[i].id`) is unchanged.

## 6. After the beta: suggested order

1. Web surfaces for dialogs (`showOpenDialog`, `showMessageBox`) in the tab. Agents can't see
   native dialogs, so this is the biggest gap.
2. Menus and context menus, then notifications.
3. Per-run session cookie with one-time per-origin auth nonces (security hardening).
4. Move HTTP serving into a worker thread if profiling shows main-thread stalls.
5. ESM main-process support (a loader hook) and `nodeIntegration` shims.
6. 1.0: once three or more real apps run without workarounds.
