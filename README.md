# electron2web

**Your Electron app, in a browser tab.** Same main process, real IPC, every window in one
tab, so you can share it with a teammate and let AI browser agents (Playwright, Chrome
DevTools MCP, Claude in Chrome) drive your desktop app like a website.

```bash
npm install -g --allow-remote=all https://github.com/starhax4/electron2web/releases/latest/download/electron2web.tgz
electron2web -- npm run dev     # in your Electron app's folder
```

It prints a link. Open it in Chrome and your app is there: windows become panels you can
move, focus, minimize and close, with a taskbar at the bottom. Main-process code runs
unchanged; your preload is re-bundled for the browser and talks to the real `ipcMain` over a
WebSocket.

> **Status: beta.** Dev mode only, not packaged apps. Tested on Windows with Electron 33,
> electron-vite and a large webpack + React app. Feedback and issue reports are welcome.

## Why

- **AI agents and E2E tests:** browser agents can't see or click native Electron windows.
  In a tab they can, through the DOM and the accessibility tree.
- **Sharing:** `--public-host` serves the app through a tunnel (cloudflared, ngrok) so someone
  on another machine can use your dev build.
- **Browser tooling:** Chrome DevTools, extensions, responsive mode and Lighthouse work
  against your real app.

## Features

- `invoke`, `send`, `sendSync`, `event.reply`, `webContents.send`, `executeJavaScript`, with
  structured-clone values (Buffer, Date, Map, Set, BigInt, errors).
- Three layouts: `desktop` (panels and a taskbar), `tabs` and `single`.
- `BrowserWindow` state (focus, minimize, maximize, bounds, modal children) mirrored both
  ways, with the matching events.
- Fast: cached runtime and preload bundles, a keep-alive proxy to your dev server, HMR.
- Built for agents: `window.electron2web` API, `/__electron2web/state` JSON, stable
  `data-window-number` / `data-state` selectors, `~/.electron2web/session.json`.
- Loopback only, with token auth, Host and Origin checks. See [Security](packages/electron2web/README.md#security).

## Docs

- [Package README](packages/electron2web/README.md): options, how it works, security, what's not supported yet
- [HOW-TO-USE.md](HOW-TO-USE.md): step-by-step setup, troubleshooting, use from another machine
- [Roadmap: full Electron API coverage](docs/electron-api-coverage-plan.md)
- [Changelog](packages/electron2web/CHANGELOG.md)

## Repo layout

```
packages/electron2web/   the CLI and bridge (published to npm)
examples/basic-app/      electron-vite sample app with 12 IPC self-checks
docs/                    roadmap and release notes
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Hamza Islam
