// main.js — Electron main process
// Launches two windows:
//   1. gameWin    — loads tcg-arena.fr/play with our observer preload injected
//   2. overlayWin — frameless, always-on-top deck tracker UI
// All tracker events flow: game-preload --IPC--> main --IPC--> overlay.

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let gameWin = null;
let overlayWin = null;

function createGameWindow() {
  gameWin = new BrowserWindow({
    width: 1600,
    height: 950,
    title: 'RiftReplay — TCG Arena',
    webPreferences: {
      preload: path.join(__dirname, 'game-preload.js'),
      contextIsolation: true,   // page JS cannot touch our preload internals
      nodeIntegration: false,
      sandbox: false            // preload needs ipcRenderer
    }
  });

  gameWin.loadURL('https://tcg-arena.fr/play');

  // tcg-arena.fr registers a beforeunload handler (to warn about leaving a
  // match), which otherwise vetoes the window's close button and leaves the app
  // running until killed in Task Manager. Let the unload proceed.
  gameWin.webContents.on('will-prevent-unload', (event) => event.preventDefault());

  gameWin.on('closed', () => {
    gameWin = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  });
}

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWin = new BrowserWindow({
    width: 340,
    height: 640,
    x: width - 360,
    y: 60,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver'); // stays above fullscreen-ish windows
  overlayWin.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
}

// Relay every tracker event from the game page to the overlay.
ipcMain.on('tracker-event', (_evt, payload) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('tracker-event', payload);
  }
  // Mirror to terminal for debugging
  console.log('[tracker]', JSON.stringify(payload).slice(0, 300));
});

app.whenReady().then(() => {
  createGameWindow();
  createOverlayWindow();
});

app.on('window-all-closed', () => app.quit());
