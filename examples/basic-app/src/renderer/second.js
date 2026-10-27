const { api } = window;
const $ = (id) => document.getElementById(id);

document.title = 'Second window';
document.body.innerHTML = '<h1>Second window</h1><p id="state"></p><p><button id="close-self">Close this window</button></p>';
const state = await api.windowState();
$('state').textContent = `window ${state.id}, ${state.bounds.width}×${state.bounds.height}`;
$('close-self').addEventListener('click', () => api.closeWindow());
