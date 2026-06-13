// overlay-preload.js — exposes a safe one-way event bridge to the overlay UI.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  onEvent(callback) {
    ipcRenderer.on('tracker-event', (_evt, payload) => callback(payload));
  }
});
