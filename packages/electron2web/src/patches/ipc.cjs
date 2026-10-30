'use strict';

// ipcMain.handle() handlers are kept in Electron's private registry; mirror them so the
// bridge can answer invoke() calls coming from the browser.
module.exports = {
  name: 'ipc',
  install({ ipcMain }, { bridge }) {
    const handlers = bridge.globalHandlers;
    const { handle, handleOnce, removeHandler } = ipcMain;
    ipcMain.handle = function (channel, fn) {
      const result = handle.call(this, channel, fn);
      handlers.set(channel, fn);
      return result;
    };
    ipcMain.handleOnce = function (channel, fn) {
      const result = handleOnce.call(this, channel, fn);
      handlers.set(channel, (...args) => {
        handlers.delete(channel);
        return fn(...args);
      });
      return result;
    };
    ipcMain.removeHandler = function (channel) {
      handlers.delete(channel);
      return removeHandler.call(this, channel);
    };
  },
};
