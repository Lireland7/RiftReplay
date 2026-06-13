// form-preload.js — contextBridge for the "Record Game" window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recordForm', {
  // Tell main the form is loaded and ready to receive its prefill data.
  ready: () => ipcRenderer.send('record-form-ready'),
  // Receive prefill data (auto-detected + carried match fields).
  onPrefill: (cb) => ipcRenderer.on('prefill', (_e, data) => cb(data)),
  // Submit the game; action is 'continue' (more games) or 'complete' (match done).
  submit: (data, action) => ipcRenderer.send('record-form-submit', { data, action }),
  cancel: () => ipcRenderer.send('record-form-cancel')
});
