'use strict';

// One module per patched Electron API. Each exports `{ name, install(electron, ctx) }`,
// where ctx is `{ bridge, surface }` and `surface(name)` is 'web' or 'native'.
// install() returns the `electron` exports it replaces (or nothing).
module.exports = [require('./ipc.cjs'), require('./dialog.cjs'), require('./window.cjs')];
