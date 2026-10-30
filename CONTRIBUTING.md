# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/starhax4/electron2web.git
cd electron2web/packages/electron2web && npm install
cd ../../examples/basic-app && npm install
npm run web          # starts the sample app through electron2web
```

Open the printed link in Chrome. The sample app's "IPC checks" table should show 12 × PASS.
Run with `--debug` (edit the `web` script) to log every window change and IPC call.

## Where things live

- `bin/cli.js`: argument parsing; starts your command with `NODE_OPTIONS=--require src/hook.cjs`
- `src/hook.cjs`: runs inside Electron's main process and swaps in the patched `electron` module
- `src/patches/`: `BrowserWindow`, `ipcMain` and `dialog` replacements
- `src/bridge-server.cjs`: HTTP/WebSocket server, auth, proxy, window state
- `src/client/runtime.js`: the fake `electron` renderer API inside each page
- `src/client/shell.js` and `shell.css`: the panels and taskbar UI

## Pull requests

- Keep changes focused. Match the surrounding style (CommonJS in `src/`, no build step).
- Run `node --check` on the files you touched, and check the sample app still shows 12/12 PASS.
- For a new Electron API, add a check to `examples/basic-app/src/renderer/checks.js` when you can.
- Note user-visible changes in `packages/electron2web/CHANGELOG.md`.

## Reporting bugs

Please include your OS, Electron version, bundler (Vite, webpack, none), the layout, and the
first `[electron2web]` error line from the terminal. Output from `--debug` helps most.
