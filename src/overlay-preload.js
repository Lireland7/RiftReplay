// overlay-preload.js — exposes a safe one-way event bridge to the overlay UI.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  onEvent(callback) {
    ipcRenderer.on('tracker-event', (_evt, payload) => callback(payload));
  },
  openRecordForm() { ipcRenderer.send('open-record-form'); },
  openMatchHistory() { ipcRenderer.send('open-match-history'); },
  openStats() { ipcRenderer.send('open-stats'); }
});
