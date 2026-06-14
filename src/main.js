// main.js — Electron main process
// Launches two windows:
//   1. gameWin    — loads tcg-arena.fr/play with our observer preload injected
//   2. overlayWin — frameless, always-on-top deck tracker UI
// All tracker events flow: game-preload --IPC--> main --IPC--> overlay.

const { app, BrowserWindow, ipcMain, screen, shell, session, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  dialog.showMessageBox({ type: 'info', title: 'Update available', message: 'A new version of RiftReplay is downloading in the background. You\'ll be prompted to restart when it\'s ready.' });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info', title: 'Update ready',
    message: 'RiftReplay update downloaded.',
    detail: 'Restart now to apply the update, or it will install automatically when you close the app.',
    buttons: ['Restart now', 'Later']
  }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
});

// ─── Supabase config ─────────────────────────────────────────────────────────
// Fill in your Project URL and anon key from supabase.com → Settings → API.
// The anon key is intentionally public — it is protected by Row Level Security.
const SUPABASE_URL = 'https://xgylbxjehhsmmkhphwrl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhneWxieGplaGhzbW1raHBod3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NDY0MDYsImV4cCI6MjA5NzAyMjQwNn0.XHgXTeD44wVVZjNO37vmV_b-BljAGRKZ5RRd1MnK5u0';
// ─────────────────────────────────────────────────────────────────────────────

let gameWin = null;
let overlayWin = null;
let recordWin = null;
let historyWin = null;
let statsWin = null;

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
  'deck', 'deck_name',
  'took_mulligan', 'mulligan_cards', 'turns', 'cards_drawn', 'sideboard_cards_drawn'
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
    deck: data.deck, deck_name: data.deckName,
    took_mulligan: data.tookMulligan ? 'yes' : 'no',
    mulligan_cards: data.mulliganCards || '',
    turns: data.turns || '',
    cards_drawn: data.cardsDrawn || '',
    sideboard_cards_drawn: data.sideboardCardsDrawn || ''
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

// ----------------------------------------------------- match history --------
function parseCSVLine(line) {
  const vals = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      vals.push(cur); cur = '';
    } else cur += c;
  }
  vals.push(cur);
  return vals;
}

function readMatchesFromCSV() {
  const file = path.join(app.getPath('documents'), 'RiftReplay', 'matches.csv');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    return row;
  });
}

function getMatchHistory() {
  const rows = readMatchesFromCSV();
  const matchMap = new Map();
  for (const row of rows) {
    if (!matchMap.has(row.match_id)) matchMap.set(row.match_id, []);
    matchMap.get(row.match_id).push(row);
  }
  const matches = [...matchMap.values()].map(games => ({
    id: games[0].match_id,
    games: games.sort((a, b) => parseInt(a.game_no) - parseInt(b.game_no))
  }));
  // Most recent match first (by timestamp of the last game in the match).
  matches.sort((a, b) => {
    const ta = a.games[a.games.length - 1]?.timestamp || '';
    const tb = b.games[b.games.length - 1]?.timestamp || '';
    return tb.localeCompare(ta);
  });
  return matches;
}

function deleteMatchFromCSV(matchId) {
  const file = path.join(app.getPath('documents'), 'RiftReplay', 'matches.csv');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim()).filter(Boolean);
  if (lines.length < 1) return;
  const headers = parseCSVLine(lines[0]);
  const idIdx = headers.indexOf('match_id');
  const kept = lines.slice(1).filter(line =>
    idIdx < 0 || parseCSVLine(line)[idIdx] !== matchId
  );
  fs.writeFileSync(file, [lines[0], ...kept].join('\n') + '\n');
}

function openMatchHistory() {
  if (historyWin && !historyWin.isDestroyed()) { historyWin.focus(); return; }
  historyWin = new BrowserWindow({
    width: 740,
    height: 640,
    title: 'Match History — RiftReplay',
    backgroundColor: '#0d1017',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'history-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  historyWin.setMenuBarVisibility(false);
  historyWin.loadFile(path.join(__dirname, '..', 'overlay', 'history.html'));
  historyWin.on('closed', () => { historyWin = null; });
}

ipcMain.on('open-match-history', openMatchHistory);
ipcMain.handle('get-match-history', () => getMatchHistory());
ipcMain.handle('delete-match', (_e, matchId) => {
  deleteMatchFromCSV(matchId);
  return getMatchHistory();
});

// ----------------------------------------------------- deck stats -----------
function openStatsWindow() {
  if (statsWin && !statsWin.isDestroyed()) { statsWin.focus(); return; }
  statsWin = new BrowserWindow({
    width: 860,
    height: 720,
    title: 'Deck Stats — RiftReplay',
    backgroundColor: '#0d1017',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'stats-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  statsWin.setMenuBarVisibility(false);
  statsWin.loadFile(path.join(__dirname, '..', 'overlay', 'stats.html'));
  statsWin.on('closed', () => { statsWin = null; });
}

ipcMain.on('open-stats', openStatsWindow);
ipcMain.handle('get-deck-stats', () => readMatchesFromCSV());

// ------------------------------------------------- community / Supabase -----
function getOrCreateDeviceId() {
  const file = path.join(app.getPath('userData'), 'device.json');
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d.deviceId) return d.deviceId; } catch {}
  const deviceId = randomUUID();
  fs.writeFileSync(file, JSON.stringify({ deviceId }));
  return deviceId;
}

function readSyncState() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'sync.json'), 'utf8')); } catch {}
  return { optedIn: false, uploadedCount: 0, lastSync: null };
}
function writeSyncState(s) {
  fs.writeFileSync(path.join(app.getPath('userData'), 'sync.json'), JSON.stringify(s));
}

async function doSubmitStats() {
  const rows = readMatchesFromCSV();
  if (!rows.length) return { uploaded: 0 };
  const deviceId = getOrCreateDeviceId();

  const records = rows.map(r => ({
    device_id:            deviceId,
    timestamp:            r.timestamp            || null,
    match_id:             r.match_id             || null,
    game_no:              r.game_no   !== '' ? parseInt(r.game_no)  : null,
    match_complete:       r.match_complete        || null,
    result:               r.result                || null,
    format:               r.format                || null,
    seat:                 r.seat                  || null,
    who_went_first:       r.who_went_first        || null,
    opponent:             r.opponent              || null,
    my_score:             r.my_score  !== '' ? parseInt(r.my_score)  : null,
    opp_score:            r.opp_score !== '' ? parseInt(r.opp_score) : null,
    my_legend:            r.my_legend            || null,
    opp_legend:           r.opp_legend           || null,
    my_battlefield:       r.my_battlefield       || null,
    opp_battlefield:      r.opp_battlefield      || null,
    baron_pit:            r.baron_pit            || null,
    brush:                r.brush                || null,
    deck:                 r.deck                 || null,
    deck_name:            r.deck_name            || null,
    took_mulligan:        r.took_mulligan        || null,
    mulligan_cards:       r.mulligan_cards       || null,
    turns:                r.turns !== '' ? parseInt(r.turns) : null,
    sideboard_cards_drawn: r.sideboard_cards_drawn || null
    // cards_drawn excluded — too large for community upload
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(records)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const sync = readSyncState();
  sync.optedIn = true;
  sync.uploadedCount = records.length;
  sync.lastSync = new Date().toISOString();
  writeSyncState(sync);
  return { uploaded: records.length };
}

async function doFetchCommunity() {
  const cols = [
    'device_id','result','format','who_went_first',
    'my_legend','opp_legend','my_battlefield','took_mulligan',
    'turns','sideboard_cards_drawn','deck','deck_name'
  ].join(',');

  let all = [], from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/matches?select=${cols}&order=submitted_at.desc`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Range-Unit': 'items',
          Range: `${from}-${from + PAGE - 1}`
        }
      }
    );
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < PAGE) break;
    from += PAGE;
    if (from >= 100_000) break; // safety cap
  }
  return { games: all, deviceId: getOrCreateDeviceId() };
}

ipcMain.handle('get-sync-state',         () => readSyncState());
ipcMain.handle('submit-community-stats', async () => {
  try { return await doSubmitStats(); }
  catch (e) { return { error: String(e) }; }
});
ipcMain.handle('get-community-stats', async () => {
  try { return await doFetchCommunity(); }
  catch (e) { return { error: String(e) }; }
});

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

  // Check for updates silently on launch; only bothers the user if one is found.
  autoUpdater.checkForUpdates().catch(() => {});
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
