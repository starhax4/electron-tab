import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    title: 'electron-tab basic app',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('app:hello', { startedAt: new Date(), pid: process.pid });
  });

  let ticks = 0;
  const timer = setInterval(() => win.webContents.send('clock:tick', ++ticks), 1000);
  win.on('closed', () => clearInterval(timer));

  loadRenderer(win);
}

function loadRenderer(win, hash = '') {
  if (process.env.ELECTRON_RENDERER_URL) return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash && `#${hash}`}`);
  return win.loadFile(join(__dirname, '../renderer/index.html'), { hash });
}

// A second window on the same page; in the browser it opens as a second panel in the shell.
ipcMain.handle('window:open', (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const [x, y] = parent.getPosition();
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    x: x + 120,
    y: y + 80,
    title: 'Second window',
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  });
  loadRenderer(win, 'second');
  return win.id;
});

ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender).close());

ipcMain.handle('window:state', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return { id: win.id, focusedId: BrowserWindow.getFocusedWindow()?.id ?? null, bounds: win.getBounds(), visible: win.isVisible() };
});

// main → page round trip: runs in the page and returns its result.
ipcMain.handle('exec:title', (event) => event.sender.executeJavaScript('document.title'));

ipcMain.handle('system:info', () => ({
  platform: process.platform,
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  electron: process.versions.electron,
}));

ipcMain.handle('fs:list', async (_event, dir) => {
  const entries = await readdir(dir || app.getPath('home'), { withFileTypes: true });
  return entries.slice(0, 15).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
});

ipcMain.handle('bytes:random', (_event, size) => randomBytes(size));

ipcMain.handle('roundtrip', (_event, value) => value);

ipcMain.handle('fails', () => {
  throw new Error('Deliberate failure from main');
});

ipcMain.handle('dialog:open', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile'] });
  return result.filePaths;
});

// Many apps print through a hidden helper window with no preload; it must stay real Electron.
ipcMain.handle('print:pdf', async () => {
  const helper = new BrowserWindow({ show: false });
  try {
    await helper.loadURL('data:text/html,<h1>Invoice</h1><p>Printed by a hidden window</p>');
    const pdf = await helper.webContents.printToPDF({});
    return pdf.length;
  } finally {
    helper.destroy();
  }
});

ipcMain.on('print:window', (event) => event.sender.print());

ipcMain.on('log',(_event, message) => console.log('[renderer says]', message));

ipcMain.on('echo:sync', (event, value) => {
  event.returnValue = { echoed: value, pid: process.pid };
});

ipcMain.on('ping', (event) => event.reply('pong', Date.now()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
