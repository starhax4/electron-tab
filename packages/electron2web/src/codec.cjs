'use strict';

// Shared by the bridge (Node) and the browser runtime (bundled by esbuild).
// Electron IPC uses structured clone; these options get msgpack close to it:
// records carry plain objects, so msgpack maps can decode as real Maps, and
// structuredClone adds Set, Date, Error, RegExp, cycles and undefined.
const { Packr } = require('msgpackr');

const packr = new Packr({
  structuredClone: true,
  useRecords: true,
  mapsAsObjects: false,
  useBigIntExtension: true,
});

// msgpackr reuses its output buffer between calls; copy so queued frames stay intact.
const pack = (value) => new Uint8Array(packr.pack(value));
const unpack = (bytes) => packr.unpack(bytes);

module.exports = { pack, unpack };
