const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deckStats', {
  getGames:           () => ipcRenderer.invoke('get-deck-stats'),
  getSyncState:       () => ipcRenderer.invoke('get-sync-state'),
  submitStats:        () => ipcRenderer.invoke('submit-community-stats'),
  getCommunityStats:  () => ipcRenderer.invoke('get-community-stats')
});
