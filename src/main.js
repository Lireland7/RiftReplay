// main.js — Electron main process
// Launches two windows:
//   1. gameWin    — loads tcg-arena.fr/play with our observer preload injected
//   2. overlayWin — frameless, always-on-top deck tracker UI
// All tracker events flow: game-preload --IPC--> main --IPC--> overlay.

const { app, BrowserWindow, ipcMain, screen, shell, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let gameWin = null;
let overlayWin = null;
let recordWin = null;

// The only origin the game window is allowed to load in-app.
const GAME_ORIGIN = 'https://tcg-arena.fr';

// Match state carried across games (Bo3). Null when no match is in progress.
let currentMatch = null;          // { id, games, carry:{…} }
let pendingPrefill = null;        // data waiting to populate the record form

function createGameWindow() {
  gameWin = new BrowserWindow({
    width: 1600,
    height: 950,
    title: 'RiftReplay — TCG Arena',
    webPreferences: {
      preload: path.join(__dirname, 'game-preload.js'),
      contextIsolation: true,   // page JS cannot touch our preload internals
      nodeIntegration: false,
      sandbox: true             // preload only needs ipcRenderer/fetch/DOM
    }
  });

  gameWin.loadURL('https://tcg-arena.fr/play');

  // Keep in-app navigation on tcg-arena.fr; send anything else to the real
  // browser instead of loading untrusted content with our preload attached.
  gameWin.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(GAME_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  gameWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

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

// ----------------------------------------------------- record game ---------
function createRecordWindow() {
  recordWin = new BrowserWindow({
    width: 760,
    height: 740,
    title: 'Record Game — RiftReplay',
    backgroundColor: '#0d1017',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'form-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  recordWin.setMenuBarVisibility(false);
  recordWin.loadFile(path.join(__dirname, '..', 'overlay', 'record.html'));
  recordWin.on('closed', () => { recordWin = null; });
}

// Merge auto-detected data with the in-progress match's carried fields.
function buildPrefill(detected) {
  const p = { ...(detected || {}) };
  if (currentMatch) {
    const carry = currentMatch.carry || {};
    for (const k of ['format', 'opponent', 'seat', 'myLegend', 'oppLegend', 'deck', 'deckName']) {
      if (carry[k]) p[k] = carry[k];
    }
    p.matchInProgress = true;
    p.gameNo = currentMatch.games + 1;
  } else {
    p.matchInProgress = false;
    p.gameNo = 1;
  }
  return p;
}

function showRecordForm(detected) {
  // Pull the diagnostic dump out before it reaches the form, write it to disk.
  if (detected && detected._debug) {
    try {
      const dir = path.join(app.getPath('documents'), 'RiftReplay');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'game-state-debug.json'),
        JSON.stringify(detected._debug, null, 2));
    } catch (_) {}
    delete detected._debug;
  }
  pendingPrefill = buildPrefill(detected);
  if (recordWin && !recordWin.isDestroyed()) {
    recordWin.webContents.send('prefill', pendingPrefill);
    recordWin.focus();
    return;
  }
  createRecordWindow();
}

// Open the form, auto-detecting from the live game first if it's running.
function openRecordForm() {
  if (gameWin && !gameWin.isDestroyed()) {
    gameWin.webContents.send('request-game-data'); // game-preload replies with 'game-data'
  } else {
    showRecordForm({});
  }
}

ipcMain.on('open-record-form', openRecordForm);
ipcMain.on('game-data', (_e, detected) => showRecordForm(detected));
ipcMain.on('record-form-ready', () => {
  if (recordWin && !recordWin.isDestroyed() && pendingPrefill) {
    recordWin.webContents.send('prefill', pendingPrefill);
  }
});
ipcMain.on('record-form-cancel', () => {
  if (recordWin && !recordWin.isDestroyed()) recordWin.close();
});
ipcMain.on('record-form-submit', (_e, { data, action }) => {
  try {
    const file = saveGameRow(data, action);
    console.log('[record] saved game →', file);
  } catch (e) {
    console.error('[record] save failed', e);
  }
  if (recordWin && !recordWin.isDestroyed()) recordWin.close();
});

const CSV_HEADER = [
  'timestamp', 'match_id', 'game_no', 'match_complete', 'result', 'format',
  'seat', 'who_went_first', 'opponent', 'my_score', 'opp_score', 'my_legend',
  'opp_legend', 'my_battlefield', 'opp_battlefield', 'baron_pit', 'brush',
  'deck', 'deck_name'
];

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function saveGameRow(data, action) {
  const dir = path.join(app.getPath('documents'), 'RiftReplay');
  const file = path.join(dir, 'matches.csv');
  fs.mkdirSync(dir, { recursive: true });
  const newFile = !fs.existsSync(file);

  if (!currentMatch) currentMatch = { id: 'm_' + Date.now(), games: 0 };
  const gameNo = currentMatch.games + 1;
  const complete = action === 'complete';

  const row = {
    timestamp: new Date().toISOString(),
    match_id: currentMatch.id,
    game_no: gameNo,
    match_complete: complete ? 'yes' : 'no',
    result: data.result, format: data.format, seat: data.seat,
    who_went_first: data.wentFirst, opponent: data.opponent,
    my_score: data.myScore, opp_score: data.oppScore,
    my_legend: data.myLegend, opp_legend: data.oppLegend,
    my_battlefield: data.myBattlefield, opp_battlefield: data.oppBattlefield,
    baron_pit: data.baronPit ? 'yes' : '', brush: data.brush ? 'yes' : '',
    deck: data.deck, deck_name: data.deckName
  };

  let out = newFile ? CSV_HEADER.join(',') + '\n' : '';
  out += CSV_HEADER.map(h => csvEscape(row[h])).join(',') + '\n';
  fs.appendFileSync(file, out);

  if (complete) {
    currentMatch = null;
  } else {
    currentMatch = {
      id: currentMatch.id,
      games: gameNo,
      carry: {
        format: data.format, opponent: data.opponent, seat: data.seat,
        myLegend: data.myLegend, oppLegend: data.oppLegend,
        deck: data.deck, deckName: data.deckName
      }
    };
  }
  return file;
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
  // The tracker is read-only; the remote page never needs device permissions.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  createGameWindow();
  createOverlayWindow();

  // Hotkey to open the record form (works while the game window is focused).
  globalShortcut.register('CommandOrControl+Shift+R', openRecordForm);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
