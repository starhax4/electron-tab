const { api } = window;
const $ = (id) => document.getElementById(id);

$('runtime').textContent = navigator.userAgent.includes('Electron')
  ? 'Running inside Electron'
  : 'Running in a regular browser tab via electron-tab';

api.onTick((count) => {
  $('clock').textContent = String(count);
});
api.onHello((info) => {
  $('hello').textContent = `pid ${info.pid}, started ${info.startedAt.toLocaleTimeString()} (Date survived: ${info.startedAt instanceof Date})`;
});

async function check(name, run) {
  const row = document.createElement('tr');
  row.innerHTML = '<td></td><td>…</td><td></td>';
  row.cells[0].textContent = name;
  $('checks').append(row);
  try {
    const detail = await run();
    row.cells[1].textContent = 'PASS';
    row.cells[2].textContent = detail;
    row.dataset.status = 'pass';
  } catch (err) {
    row.cells[1].textContent = 'FAIL';
    row.cells[2].textContent = err.message;
    row.dataset.status = 'fail';
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await check('preload sees contextIsolated', async () => {
  assert(api.isContextIsolated === true, `got ${api.isContextIsolated}`);
  return 'true';
});

await check('invoke → ipcMain.handle', async () => {
  const info = await api.systemInfo();
  return `${info.platform}, ${info.cpus} CPUs, Electron ${info.electron}`;
});

await check('invoke with native fs in main', async () => {
  const entries = await api.listDir();
  assert(Array.isArray(entries) && entries.length > 0, 'empty listing');
  return `${entries.length} entries in home dir`;
});

await check('binary Buffer → Uint8Array', async () => {
  const bytes = await api.randomBytes(1024 * 1024);
  assert(bytes instanceof Uint8Array, `got ${Object.prototype.toString.call(bytes)}`);
  assert(bytes.length === 1024 * 1024, `length ${bytes.length}`);
  return `${bytes.length} bytes`;
});

await check('structured clone types round-trip', async () => {
  const value = { when: new Date(0), tags: new Set(['a', 'b']), map: new Map([['k', 1]]), nothing: undefined, big: 2n ** 70n };
  const back = await api.roundtrip(value);
  assert(back.when instanceof Date && back.when.getTime() === 0, 'Date lost');
  assert(back.tags instanceof Set && back.tags.has('b'), 'Set lost');
  assert(back.map instanceof Map && back.map.get('k') === 1, 'Map lost');
  assert('nothing' in back && back.nothing === undefined, 'undefined lost');
  assert(back.big === 2n ** 70n, 'BigInt lost');
  return 'Date, Set, Map, undefined, BigInt';
});

await check('invoke error propagates', async () => {
  try {
    await api.fail();
  } catch (err) {
    assert(err.message.includes('Deliberate failure from main'), err.message);
    return err.message;
  }
  throw new Error('expected rejection');
});

await check('sendSync → event.returnValue', async () => {
  const result = api.echoSync('hi');
  assert(result.echoed === 'hi', JSON.stringify(result));
  return `echoed from pid ${result.pid}`;
});

await check('send → event.reply round-trip', async () => {
  const time = await new Promise((resolve, reject) => {
    api.onPong(resolve);
    api.ping();
    setTimeout(() => reject(new Error('no pong within 2s')), 2000);
  });
  return `pong at ${new Date(time).toLocaleTimeString()}`;
});

await check('webContents.send stream', async () => {
  const count = await new Promise((resolve, reject) => {
    const stop = api.onTick((n) => {
      stop();
      resolve(n);
    });
    setTimeout(() => reject(new Error('no tick within 3s')), 3000);
  });
  return `tick #${count}`;
});

await check('executeJavaScript (main → page call)', async () => {
  const title = await api.execTitle();
  assert(title === document.title, `got ${JSON.stringify(title)}`);
  return title;
});

await check('window state mirrored from the tab', async () => {
  const state = await api.windowState();
  assert(state.visible, 'isVisible() is false');
  assert(state.focusedId === state.id, `getFocusedWindow() is ${state.focusedId}, expected ${state.id}`);
  assert(state.bounds.width > 0 && state.bounds.height > 0, JSON.stringify(state.bounds));
  return `focused, ${state.bounds.width}×${state.bounds.height}`;
});

await check('hidden helper window printToPDF', async () => {
  const bytes = await api.printToPdf();
  if (!(bytes > 1000)) throw new Error(`PDF too small: ${bytes} bytes`);
  return `${bytes} byte PDF`;
});

api.log('renderer finished checks');

$('print-window').addEventListener('click', () => api.printWindow());
$('open-window').addEventListener('click', () => api.openWindow());

$('open-file').addEventListener('click', async () => {
  const paths = await api.openFile();
  $('picked').textContent = paths.length ? paths.join(', ') : 'cancelled';
});
