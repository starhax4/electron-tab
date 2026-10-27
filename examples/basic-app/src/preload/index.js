import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  isContextIsolated: process.contextIsolated,
  systemInfo: () => ipcRenderer.invoke('system:info'),
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  randomBytes: (size) => ipcRenderer.invoke('bytes:random', size),
  roundtrip: (value) => ipcRenderer.invoke('roundtrip', value),
  fail: () => ipcRenderer.invoke('fails'),
  openFile: () => ipcRenderer.invoke('dialog:open'),
  printToPdf: () => ipcRenderer.invoke('print:pdf'),
  printWindow: () => ipcRenderer.send('print:window'),
  openWindow: () => ipcRenderer.invoke('window:open'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  windowState: () => ipcRenderer.invoke('window:state'),
  execTitle: () => ipcRenderer.invoke('exec:title'),
  log: (message) => ipcRenderer.send('log', message),
  echoSync: (value) => ipcRenderer.sendSync('echo:sync', value),
  ping: () => ipcRenderer.send('ping'),
  onPong: (callback) => ipcRenderer.once('pong', (_event, time) => callback(time)),
  onHello: (callback) => ipcRenderer.on('app:hello', (_event, info) => callback(info)),
  onTick: (callback) => {
    const listener = (_event, count) => callback(count);
    ipcRenderer.on('clock:tick', listener);
    return () => ipcRenderer.removeListener('clock:tick', listener);
  },
});
