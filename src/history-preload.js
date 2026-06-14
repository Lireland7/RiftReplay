const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('matchHistory', {
  getMatches: ()       => ipcRenderer.invoke('get-match-history'),
  deleteMatch: (id)    => ipcRenderer.invoke('delete-match', id)
});
