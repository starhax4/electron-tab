'use strict';

// Terminal output shared by the CLI and the bridge. The bridge runs inside Electron, whose
// stdout often doesn't look like a terminal, so the CLI passes its color level down in
// ELECTRON2WEB_COLOR. NO_COLOR turns colors off everywhere.
const chalk = require('chalk');

function colorLevel() {
  if (process.env.NO_COLOR) return 0;
  const passed = process.env.ELECTRON2WEB_COLOR;
  if (passed !== undefined && passed !== '') return Number(passed) || 0;
  return chalk.supportsColor ? chalk.supportsColor.level : 0;
}

const c = new chalk.Instance({ level: colorLevel() });
const TAG = c.cyan('[electron2web]');

module.exports = {
  c,
  level: c.level,
  info: (...args) => console.log(TAG, ...args),
  warn: (...args) => console.warn(TAG, c.yellow(args.map(String).join(' '))),
  error: (...args) => console.error(TAG, c.red(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '))),
  debug: (...args) => process.env.ELECTRON2WEB_DEBUG && console.log(TAG, c.dim(args.map(String).join(' '))),
  url: (value) => c.bold.green(value),
};
