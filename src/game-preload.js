// game-preload.js — injected into tcg-arena.fr/play
//
// Verified facts this script is built on (inspected live, June 2026):
//   • The site is a React app rendering plain DOM (no <canvas>).
//   • Card database: https://russeus.github.io/RB-TCG-Arena/Riftbound-CardList.json
//     keyed by card ID ("OGN-001", ...) with names, cost, type, and image URLs.
//   • Card <img> URLs contain "/cards/<CARD-ID>/", so any card on screen can be
//     identified from its image src — no OCR needed.
//   • The game log lives in an element with class "history" (entries like
//     "drew 4", "played Fury Rune from their runes deck").
//   • The pre-game deck popup is titled "Swap cards with your sideboard";
//     the mulligan screen is titled "Mulligan".
//
// Class names other than the ones above were not all verifiable outside a live
// game, so detection leans on heading text + innerText parsing, which survives
// CSS/class churn. Use window.__tracker.dump() in DevTools mid-game to capture
// exact markup and tighten selectors later.

const { ipcRenderer } = require('electron');

const CARD_LIST_URL =
  'https://russeus.github.io/RB-TCG-Arena/Riftbound-CardList.json';

// ---------------------------------------------------------------- state ----
const state = {
  cardDb: null,          // id -> { name, cost, type }
  imageHashToId: {},     // sanity-CDN image hash -> card id (for cards whose art
                         // comes from cmsassets.rgpub.io, which has no id in the URL)
  deck: new Map(),       // name -> { total, drawn }
  champion: null,
  sideboard: new Map(),
  deckSnapshotTaken: false,
  // Cards parked at the bottom, grouped into layers — one per recycle event.
  // Cards within a layer were bottomed together and are in random order relative
  // to each other; layers stack in draw order (earliest-recycled is drawn first
  // once the deck cycles down to the bottom). Each layer: { named: [name,...],
  // anonymous: <count of unknown copies> }.
  recycledLayers: []
};

// ---------------------------------------------------------- scry window -----
// The "Look and manage the top of your deck" modal (titled exactly that) shows
// the top cards of your deck during a scry. Cards are revealed one at a time via
// the "Show one more" button (header reads "Cards shown: 1/4"), and each one can
// be sent to hand / play / discard / removed, or all sent to the bottom.
//
// CRITICAL: scry cards are read ONLY from the modal's own DOM subtree. We must
// NOT use the global card stream — during a scry React re-renders board cards as
// fresh DOM nodes, which would pollute the scry set with unrelated cards.
//
// On every mutation we re-scan the modal:
//   • cards newly present  → "Show one more" revealed them
//   • cards newly absent    → actioned out (to hand/play/discard/remove);
//                             attributed as a draw on the next deck-count drop
//   • "put all N to bottom" log → whatever is still in the modal is recycled
let scryModal = null;          // dialog root element while the modal is open
let scryCards = [];            // names currently visible in the modal (multiset)
let scryActionedPending = [];  // names removed from modal, awaiting deck-count drop
let scryCardsTtl = null;       // timer that clears scryCards after the modal closes
let scryDrawnNames = [];       // cards drawn from deck during this scry ("drew X from
                               // deck") — excluded from the bulk-recycle set so a card
                               // sent to hand isn't also counted as recycled
let scryRecycledNames = [];    // cards individually bottomed during this scry ("put X
                               // from the top ... to the bottom") — so syncScry doesn't
                               // mistake their removal from the strip for a draw

function emit(type, data) {
  try { ipcRenderer.send('tracker-event', { type, data, ts: Date.now() }); }
  catch (e) { console.warn('[tracker] emit failed', e); }
}

// Total cards currently parked across all bottom layers.
function recycledCount() {
  let t = 0;
  for (const l of state.recycledLayers) t += l.named.length + l.anonymous;
  return t;
}

// Surface bottom layers back into the draw pool one at a time, in order. A layer
// becomes drawable only once every card above it is gone — i.e. when `remaining`
// has shrunk to just the parked layers, the earliest layer is now on top of the
// deck, so promote it (looping in case a tick drew past more than one boundary).
function promoteSurfacedLayers(remaining) {
  let promoted = false;
  while (state.recycledLayers.length > 0 && remaining <= recycledCount()) {
    state.recycledLayers.shift();
    promoted = true;
    emit('recycle-layer-promoted', { deckCount: remaining });
  }
  return promoted;
}

// Snapshot of the bottom-of-deck state for the overlay: the ordered layers plus
// aggregate per-name counts (for draw-pool math) and the grand total.
function recycledPayload() {
  let total = 0, anonymous = 0;
  const named = new Map();
  for (const layer of state.recycledLayers) {
    for (const n of layer.named) { named.set(n, (named.get(n) ?? 0) + 1); total += 1; }
    anonymous += layer.anonymous;
    total += layer.anonymous;
  }
  return {
    layers: state.recycledLayers.map(l => ({
      named: tally(l.named),     // [{ name, count }]
      anonymous: l.anonymous
    })),
    named: [...named.entries()].map(([name, count]) => ({ name, count })),
    anonymous,
    total
  };
}

// ----------------------------------------------------------- card database -
async function loadCardDb() {
  try {
    const res = await fetch(CARD_LIST_URL);
    const json = await res.json();
    state.cardDb = {};
    state.imageHashToId = {};
    for (const [id, card] of Object.entries(json)) {
      state.cardDb[id] = {
        name: card?.name?.en ?? id,
        cost: card?.cost ?? null,
        type: card?.type ?? null
      };
      // Index every Sanity-CDN image hash for this card. Newer sets render art
      // from cmsassets.rgpub.io/sanity/.../<40-hex-hash>-...png, which carries no
      // card id, so we map the hash back to the id here.
      for (const side of Object.values(card?.face ?? {})) {
        for (const url of Object.values(side?.image ?? {})) {
          if (typeof url !== 'string') continue;
          const h = url.match(/([a-f0-9]{40})/);
          if (h) state.imageHashToId[h[1]] = id;
        }
      }
    }
    emit('card-db-loaded', {
      count: Object.keys(state.cardDb).length,
      hashes: Object.keys(state.imageHashToId).length
    });
  } catch (e) {
    console.error('[tracker] card DB load failed', e);
    emit('error', { where: 'loadCardDb', message: String(e) });
  }
}

// Extract a card ID from an image URL. Two CDN shapes exist:
//   • OGN/older: ".../cards/<ID>/full-desktop-2x.avif"  → id is in the path
//   • newer sets: "cmsassets.rgpub.io/sanity/.../<40-hex>-...png" → id via hash map
function cardIdFromSrc(src) {
  if (!src) return null;
  const m = src.match(/\/cards\/([A-Za-z0-9]+-[A-Za-z0-9]+)\//);
  if (m) return m[1];
  const h = src.match(/([a-f0-9]{40})/);
  if (h && state.imageHashToId[h[1]]) return state.imageHashToId[h[1]];
  return null;
}

function cardNameFromId(id) {
  return state.cardDb?.[id]?.name ?? id;
}

// Resolve a card id from any element by checking each of its <img> sources
// (a .game-card has several: the art, a card-back, a shortcut icon). The art
// may come from either CDN shape, so we try them all and take the first hit.
function cardIdFromEl(el) {
  for (const img of el.querySelectorAll('img')) {
    const id = cardIdFromSrc(img.getAttribute('src') || img.src);
    if (id) return id;
  }
  return null;
}

// ------------------------------------------------- deck popup (snapshot) ---
// The popup's innerText looks like:
//   Chosen Champion (1)\n1\nAnnie, Stubborn\nDeck (39)\nGear\n1\n3\nLong Sword\n...
// Rows are: <row-index> <count> <card name>. Section headers reset context.
function parseDeckPopup(rootEl) {
  const lines = rootEl.innerText.split('\n').map(l => l.trim()).filter(Boolean);

  const deck = new Map();
  const sideboard = new Map();
  let champion = null;
  let section = null; // 'champion' | 'deck' | 'sideboard'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^Chosen Champion/i.test(line)) { section = 'champion'; continue; }
    if (/^Deck \(\d+\)/i.test(line))    { section = 'deck'; continue; }
    if (/^Sideboard \(\d+\)/i.test(line)) { section = 'sideboard'; continue; }
    // Type sub-headers within sections ("Gear", "Spell", "Unit") — skip.
    if (/^(Gear|Spell|Unit|Rune|Battlefield|Legend)$/i.test(line)) continue;

    // Champion row: "<idx>" then "<name>"
    if (section === 'champion' && /^\d+$/.test(line) && lines[i + 1]) {
      champion = lines[i + 1];
      i += 1;
      continue;
    }

    // Card row: "<idx>" "<count>" "<name>"
    if ((section === 'deck' || section === 'sideboard') &&
        /^\d+$/.test(line) && /^\d+$/.test(lines[i + 1] ?? '') && lines[i + 2]) {
      const count = parseInt(lines[i + 1], 10);
      const name = lines[i + 2];
      const target = section === 'deck' ? deck : sideboard;
      target.set(name, { total: count, drawn: 0 });
      i += 2;
    }
  }

  return { champion, deck, sideboard };
}

// Clear all per-game tracking so a new game starts fresh. (The card DB and the
// image-hash map are global and kept.)
function resetGameState() {
  state.deck = new Map();
  state.sideboard = new Map();
  state.champion = null;
  state.recycledLayers = [];
  state.deckSnapshotTaken = false;
  lastDeckCount = null;
  pendingDraws = 0;
  clearTimeout(pendingTimer);
  prevHand = new Map();
  mulliganSelectedNames = [];
  firstStarter = null;
  localPlayerName = null; // re-detect for the new game (opponent may differ)
  resetScry();
}

function decksEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, v] of a) {
    const w = b.get(name);
    if (!w || w.total !== v.total) return false;
  }
  return true;
}

// The currently-open "Swap cards with your sideboard" popup, while it's up. We
// keep re-parsing it so that sideboard swaps (cards moved in/out before the game
// starts) are reflected in the final decklist — not just its initial state.
let sideboardContainer = null;

function snapshotFrom(container) {
  const { champion, deck, sideboard } = parseDeckPopup(container);
  if (deck.size === 0) return;                         // not rendered yet
  if (decksEqual(deck, state.deck) && champion === state.champion &&
      state.deckSnapshotTaken) return;                 // unchanged — nothing to emit

  state.deck = deck;
  state.sideboard = sideboard;
  state.champion = champion;
  state.deckSnapshotTaken = true;

  emit('deck-snapshot', {
    champion,
    deck: [...deck.entries()].map(([name, v]) => ({ name, ...v })),
    sideboard: [...sideboard.entries()].map(([name, v]) => ({ name, ...v }))
  });
}

// Detects the sideboard popup appearing (cheap textContent guard). On a NEW popup
// it resets the prior game's state, then takes an initial snapshot. Live swaps are
// then tracked by syncSideboard while the popup stays open.
function trySnapshotDeck(node) {
  if (!node.textContent || !node.textContent.includes('Swap cards with your sideboard')) return;

  let container = node;
  while (container.parentElement &&
         !(container.innerText || '').match(/Deck \(\d+\)/)) {
    container = container.parentElement;
  }
  if (container === sideboardContainer) return; // already tracking this popup

  // A fresh popup after a deck was already loaded means a new game began.
  if (state.deckSnapshotTaken) resetGameState();
  sideboardContainer = container;
  snapshotFrom(container);
}

// Re-parse the open sideboard popup each batch to catch swaps; when it closes,
// stop tracking (the last snapshot taken is the final, post-sideboard decklist).
function syncSideboard() {
  if (!sideboardContainer) return;
  if (!sideboardContainer.isConnected) { sideboardContainer = null; return; }
  snapshotFrom(sideboardContainer);
}

// --------------------------------------------------- scry modal -----
// The "Look and manage the top of your deck" UI renders the cards you're
// managing in a ".revealed-section" strip inside a fixed pe-none overlay —
// a SEPARATE DOM tree from the ".modal-dialog" that holds the heading/buttons.
// (Verified from a live DOM dump, June 2026.) So we anchor on .revealed-section
// directly rather than walking up from the heading text.
const SCRY_SECTION_SEL = '.revealed-section';

function getScryRoot() {
  return document.querySelector(SCRY_SECTION_SEL);
}

function tally(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count }));
}

// Elements in `a` that aren't matched (1:1) by an element in `b`.
function multisetSubtract(a, b) {
  const counts = {};
  for (const x of b) counts[x] = (counts[x] ?? 0) + 1;
  const out = [];
  for (const x of a) {
    if (counts[x] > 0) counts[x] -= 1;
    else out.push(x);
  }
  return out;
}

// Card names (deck cards only) inside a given root element.
function cardNamesInModal(root) {
  const out = [];
  // Revealed-section cards are bare <img> (often .card-front), not .game-card
  // wrappers, so scan every image and resolve it via either CDN shape.
  for (const img of root.querySelectorAll('img')) {
    const id = cardIdFromSrc(img.getAttribute('src') || img.src);
    if (!id) continue;
    const name = cardNameFromId(id);
    if (state.deck.has(name)) out.push(name);
  }
  return out;
}

// Reconcile our scry state with the live .revealed-section each mutation batch.
// Handles open (section appears), reveals/actions (cards added/removed), and
// close (section gone). Card-set comparison is by NAME (multiset), so React
// re-rendering the same cards as fresh nodes produces no spurious diffs.
function syncScry() {
  const root = getScryRoot();

  if (!root) {
    if (scryModal) {
      // Section gone — scry closed. Keep scryCards briefly so a trailing
      // "put all N to bottom" log line can still resolve them by name.
      scryModal = null;
      clearTimeout(scryCardsTtl);
      scryCardsTtl = setTimeout(() => { scryCards = []; scryActionedPending = []; }, 2500);
    }
    return;
  }

  const current = cardNamesInModal(root);

  if (!scryModal) {
    // Newly opened.
    clearTimeout(scryCardsTtl);
    scryModal = root;
    scryCards = current;
    scryActionedPending = [];
    emit('scry-opened', { cards: tally(scryCards) });
    return;
  }

  // Already open — reconcile. Removed cards were actioned out (to hand / play /
  // discard / remove); attribute them as draws on the next deck-count drop.
  // EXCEPT cards individually bottomed ("put X ... to the bottom") — those leave
  // the strip too but stay in the deck, so they must not be counted as draws.
  scryModal = root;
  const removed = multisetSubtract(scryCards, current);
  for (const name of removed) {
    const ri = scryRecycledNames.indexOf(name);
    if (ri >= 0) { scryRecycledNames.splice(ri, 1); continue; }
    scryActionedPending.push(name);
  }
  scryCards = current;
}

function resetScry() {
  scryModal = null;
  scryCards = [];
  scryActionedPending = [];
  scryDrawnNames = [];
  scryRecycledNames = [];
  clearTimeout(scryCardsTtl);
}

// ----------------------------------------------------- draw detection ------
// Verified structure (from a live game dump):
//   • ALL cards render as ".game-card" elements inside one flat layer
//     ".visible-cards" — there is no nested per-zone hand container.
//   • The element ".deck" displays the authoritative remaining count
//     as text (e.g. "34\nDraw").
// Strategy: when the .deck counter decreases, a draw happened. The new
// face-up .game-card that appears within the correlation window — and whose
// name is in our decklist — is the card that was drawn. Opponent draws stay
// face-down (no readable img URL), so they can't trigger false positives.

let lastDeckCount = null;
let pendingDraws = 0;
let pendingTimer = null;

function readDeckCount() {
  const el = document.querySelector('.deck');
  if (!el) return null;
  const m = (el.innerText || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function checkDeckCounter() {
  const count = readDeckCount();
  if (count === null || count === lastDeckCount) return;

  if (lastDeckCount !== null && count < lastDeckCount) {
    const delta = lastDeckCount - count;
    pendingDraws += delta;
    clearTimeout(pendingTimer);

    // If cards were actioned out of the scry modal (to hand/play/discard/remove),
    // those departures caused this deck-count drop. Mark them drawn immediately
    // rather than waiting for a new face-up card to appear (they may go to
    // discard/exile/play, not to hand). Capped by the authoritative departures so
    // we never collide with syncHand (which runs right after) on the same card.
    const scryDrains = Math.min(scryActionedPending.length, delta);
    for (let i = 0; i < scryDrains; i++) {
      const name = scryActionedPending.shift();
      if (name && currentDrawnCount() < deckTotalCount() - count) {
        pendingDraws -= 1;
        markDrawn(null, name, 'scry-action');
      }
    }

    pendingTimer = setTimeout(() => { pendingDraws = 0; }, 3000);
  }

  promoteSurfacedLayers(count);

  emit('deck-count', {
    remaining: count,
    recycled: recycledPayload()
  });
  lastDeckCount = count;
}

function markDrawn(id, name, source) {
  const entry = state.deck.get(name);
  if (entry && entry.drawn < entry.total) entry.drawn += 1;
  emit('card-drawn', {
    id, name, source,
    remaining: entry ? entry.total - entry.drawn : null
  });
}

// ----------------------------------------------------- hand tracking -------
// React REUSES .game-card DOM nodes (it swaps the inner image rather than adding
// a new node), so a draw produces no childList mutation and addedNode-based
// detection misses it. Instead we POLL the hand each tick and diff it.
//
// The zone is encoded on the .game-card element's own class (verified live):
// face-up hand cards are ".game-card.Hand.card-hidden-no". Any net new copy in
// the hand is a draw, capped by the authoritative count of cards that have
// actually left the deck (deck total − current remaining) so bounce/return-to-
// hand effects can't inflate per-card draws beyond reality.
let prevHand = new Map(); // name -> count seen in hand on the previous tick
let firstStarter = null;  // name from the first "<name> starting turn 1" log line
// Local player's username — the last `.pseudo.my-auto` element in DOM order
// (opponent is at the top of the screen, local player at the bottom). Detected
// lazily because the element only appears once a game lobby loads.
let localPlayerName = null;

// During the mulligan, the opening hand renders in ".mulligan-section" (NOT in
// ".game-card.Hand"), and cards toggled for replacement get a "selected" class on
// their ".wrapper". We track the live selection so that when the mulligan is
// confirmed ("mulliganed N cards") we can send those exact cards to a random
// bottom layer. Holds its last value after the screen tears down.
let mulliganSelectedNames = [];

// Reads the local player's username from the in-game player name badges.
// The game renders two `.pseudo.my-auto` elements: opponent first (top of screen),
// local player second (bottom) — so the last one is always us.
function detectLocalPlayerName() {
  const els = document.querySelectorAll('.pseudo.my-auto');
  if (!els.length) return null;
  return els[els.length - 1].innerText.trim() || null;
}

// Returns true if this history log line is an action by the local player.
// The game prefixes log lines with the acting player's name (e.g.
// "Dokgebi sent X to the bottom of their deck"). We skip events whose
// prefix belongs to the opponent so we don't corrupt our own deck state.
function isMyHistoryLine(text) {
  if (!localPlayerName) return true; // name not detected yet → process everything (safe)
  if (text.startsWith(localPlayerName)) return true;
  // Lines beginning with a bare verb have no player prefix → treat as ours.
  if (/^(you\s|sent\s|put\s|drew\s|played\s|looked\s|mulliganed\s|has\s)/i.test(text)) return true;
  return false; // non-empty name prefix that isn't ours → opponent's action
}

function syncMulligan() {
  if (!document.querySelector('.mulligan-section')) return; // screen not up — keep last
  const names = [];
  for (const w of document.querySelectorAll('.mulligan-section .wrapper.selected')) {
    const id = cardIdFromEl(w);
    if (!id) continue;
    const name = cardNameFromId(id);
    if (state.deck.has(name)) names.push(name);
  }
  mulliganSelectedNames = names;
}

function deckTotalCount() {
  let t = 0;
  for (const v of state.deck.values()) t += v.total;
  return t;
}

function currentDrawnCount() {
  let d = 0;
  for (const v of state.deck.values()) d += v.drawn;
  return d;
}

function handMultiset() {
  const m = new Map();
  for (const el of document.querySelectorAll('.game-card.Hand.card-hidden-no')) {
    const id = cardIdFromEl(el);
    if (!id) continue;
    const name = cardNameFromId(id);
    if (state.deck.has(name)) m.set(name, (m.get(name) ?? 0) + 1);
  }
  return m;
}

function syncHand() {
  if (!state.deckSnapshotTaken || lastDeckCount === null) return;
  const cur = handMultiset();
  // How many cards have provably left the deck — our hard ceiling on total draws.
  const authDrawn = Math.max(0, deckTotalCount() - lastDeckCount);

  for (const [name, n] of cur) {
    let added = n - (prevHand.get(name) ?? 0);
    while (added > 0 && currentDrawnCount() < authDrawn) {
      const entry = state.deck.get(name);
      if (!entry || entry.drawn >= entry.total) break; // this card maxed out
      entry.drawn += 1;
      emit('card-drawn', {
        id: null, name, source: 'hand',
        remaining: entry.total - entry.drawn
      });
      added -= 1;
    }
  }
  prevHand = cur;
}

// --------------------------------------------------------- history log -----
// Verified element: <div class="history"> — receives lines like
// "Snackmuncher - 03:56 PM", "drew 4", "played Fury Rune from their runes deck".
// Dedup by NODE identity (not text): the same event fires once, but two distinct
// events with identical text (e.g. recycling the same card twice across scries)
// must both be processed.
const seenHistoryNodes = new WeakSet();

function handleHistoryAddition(node) {
  if (seenHistoryNodes.has(node)) return;
  seenHistoryNodes.add(node);
  const text = (node.innerText || node.textContent || '').trim();
  if (!text) return;

  // Record who took the first turn — runs for ALL players (we need this even for
  // opponent's turn so we can determine wentFirst in collectGameData).
  let fm;
  if (!firstStarter && (fm = text.match(/^(.+?)\s+starting turn 1\b/i))) {
    firstStarter = fm[1].trim();
  }

  // All deck-state mutations (recycle, scry, mulligan) must only fire for OUR
  // deck. The history log shows both players' actions, so gate them.
  const myAction = isMyHistoryLine(text);

  let m;
  if ((m = text.match(/looked at the top (\d+) cards? of (their|your) deck/i))) {
    if (myAction) {
      scryDrawnNames = [];
      scryRecycledNames = [];
      emit('scry-started', { count: parseInt(m[1], 10), raw: text });
    }
  } else if ((m = text.match(/drew (.+?) from deck/i))) {
    if (myAction) {
      scryDrawnNames.push(m[1]);
      emit('log-drew-named', { card: m[1], raw: text });
    }
  } else if ((m = text.match(/sent (.+?) to the bottom of (their|your) deck/i))) {
    if (myAction) {
      // Single named card recycled → its own layer of one (no randomness).
      state.recycledLayers.push({ named: [m[1]], anonymous: 0 });
      if (lastDeckCount !== null) promoteSurfacedLayers(lastDeckCount);
      emit('recycled-update', { ...recycledPayload(), raw: text });
    }
  } else if ((m = text.match(/put (.+?) from the top of (their|your) deck to the bottom/i))) {
    if (myAction) {
      // Single card bottomed from a scry. Its own layer of one. The card leaves
      // the scry strip but stays in the deck, so prevent syncScry miscounting it.
      const name = m[1];
      state.recycledLayers.push({ named: [name], anonymous: 0 });
      const ai = scryActionedPending.indexOf(name);
      if (ai >= 0) scryActionedPending.splice(ai, 1);
      else scryRecycledNames.push(name);
      if (lastDeckCount !== null) promoteSurfacedLayers(lastDeckCount);
      emit('recycled-update', { ...recycledPayload(), raw: text });
    }
  } else if ((m = text.match(/put all (\d+) looked cards? to the bottom/i))) {
    if (myAction) {
      // Bulk scry-recycle → one layer (randomized). Cards still in the strip
      // MINUS any drawn to hand during this scry (game keeps drawn card visible
      // until the action resolves, so exclude to avoid double-counting).
      const count = parseInt(m[1], 10);
      const named = multisetSubtract(scryCards, scryDrawnNames);
      const anonymous = Math.max(0, count - named.length);
      state.recycledLayers.push({ named, anonymous });
      if (lastDeckCount !== null) promoteSurfacedLayers(lastDeckCount);
      resetScry();
      emit('recycled-update', { ...recycledPayload(), raw: text });
    }
  } else if ((m = text.match(/drew (\d+)/i))) {
    emit('log-drew', { count: parseInt(m[1], 10), raw: text });
  } else if ((m = text.match(/played (.+?) from/i))) {
    emit('log-played', { card: m[1], raw: text });
  } else if ((m = text.match(/mulliganed (\d+) cards?/i))) {
    if (myAction) {
      // Mulligan confirmed. Cards toggled "selected" on the mulligan screen are
      // shuffled to the bottom in random order → one bottom layer.
      const n = parseInt(m[1], 10);
      const named = mulliganSelectedNames.slice(0, n);
      const anonymous = Math.max(0, n - named.length);
      state.recycledLayers.push({ named, anonymous });
      mulliganSelectedNames = [];
      if (lastDeckCount !== null) promoteSurfacedLayers(lastDeckCount);
      emit('recycled-update', { ...recycledPayload(), raw: text });
    }
  } else if (/mulligan/i.test(text)) {
    emit('log-mulligan', { raw: text });
  } else {
    emit('log-other', { raw: text });
  }
}

// ------------------------------------------------------------ observers ----
function startObservers() {
  // One observer on <body>: cheap enough at this DOM size (~100s of nodes),
  // and survives React remounting entire subtrees.
  const obs = new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // 1. Deck popup snapshot (also detects a new game and resets)
        trySnapshotDeck(node);

        // 2. History log lines
        if (node.closest?.('.history') || node.classList?.contains('history')) {
          handleHistoryAddition(node);
        }
      }
    }
    // Reconcile the open popups/zones and re-read the deck counter. All cheap and
    // idempotent, so we run them on every batch — removals and React node-reuse
    // don't reliably show up in addedNodes.
    syncSideboard();
    syncScry();
    checkDeckCounter();
    syncHand();
    syncMulligan();
  });

  obs.observe(document.body, { childList: true, subtree: true });
  // Counter/hand can also change via in-place updates that add no elements
  // (React reuses nodes), so poll on a timer as well as on mutations.
  // Also lazily detect the local player name (only appears after a game loads).
  setInterval(() => {
    if (!localPlayerName) localPlayerName = detectLocalPlayerName();
    checkDeckCounter(); syncHand(); syncMulligan();
  }, 1000);
  emit('observer-started', {});
}

// ------------------------------------------------ record-game collection ---
// Best-effort auto-fill for the Record Game form, gathered from the live DOM.
// Card zones are on the .game-card element's own class; the local player's area
// is the ".player-section.current-player".
function nameOfCardIn(root, selector) {
  if (!root) return '';
  for (const el of root.querySelectorAll(selector)) {
    const id = cardIdFromEl(el);
    if (id) return cardNameFromId(id);
  }
  return '';
}

function collectGameData() {
  let data = {};
  try {
    const sections = [...document.querySelectorAll('.player-section')];
    const mySec = document.querySelector('.player-section.current-player') || sections[0] || null;
    const oppSec = sections.find(s => s !== mySec) || null;

    // "who went first": compare firstStarter directly to the detected local player name.
    // localPlayerName = last .pseudo.my-auto in DOM (opponent is top/first, me is bottom/last).
    let wentFirst = 'Unknown';
    if (firstStarter && localPlayerName) {
      wentFirst = firstStarter === localPlayerName ? 'Me' : 'Opponent';
    }

    // Opponent name: the .pseudo.my-auto that isn't the local player.
    const pseudos = [...document.querySelectorAll('.pseudo.my-auto')];
    const oppName = pseudos.find(p => p.innerText.trim() !== localPlayerName)?.innerText.trim() || '';

    // Opponent battlefield: first Battlefields card NOT inside my own section.
    let oppBattlefield = nameOfCardIn(oppSec, '.game-card.Battlefields.card-hidden-no');
    if (!oppBattlefield) {
      for (const el of document.querySelectorAll('.game-card.Battlefields.card-hidden-no')) {
        if (mySec && mySec.contains(el)) continue;
        const id = cardIdFromEl(el);
        if (id) { oppBattlefield = cardNameFromId(id); break; }
      }
    }

    // Opponent legend: try their section, then scan for Legend/Chosen_Champion outside mine.
    let oppLegend = nameOfCardIn(oppSec, '.game-card.Chosen_Champion.card-hidden-no') ||
                    nameOfCardIn(oppSec, '.game-card.Legend.card-hidden-no') || '';
    if (!oppLegend) {
      for (const zone of ['Chosen_Champion', 'Legend']) {
        for (const el of document.querySelectorAll(`.game-card.${zone}.card-hidden-no`)) {
          if (mySec && mySec.contains(el)) continue;
          const id = cardIdFromEl(el);
          if (id) { oppLegend = cardNameFromId(id); break; }
        }
        if (oppLegend) break;
      }
    }

    data = {
      // Prefer Chosen_Champion (the specific deck identity) then Legend on board, then DB snapshot.
      myLegend: nameOfCardIn(mySec, '.game-card.Chosen_Champion.card-hidden-no') ||
                nameOfCardIn(mySec, '.game-card.Legend.card-hidden-no') ||
                state.champion || '',
      oppLegend,
      myBattlefield: nameOfCardIn(mySec, '.game-card.Battlefields.card-hidden-no'),
      oppBattlefield,
      wentFirst,
      opponent: oppName,
      deck: state.champion || '',
      deckName: '',
      _debug: gatherGameDebug(mySec, oppSec, sections)
    };
  } catch (e) {
    data = { _debug: { error: String(e) } };
  }
  return data;
}

// Rich dump so the remaining fields (opponent legend, battlefields split, scores,
// player names, result) can be wired to precise selectors. Written to disk by main.
function gatherGameDebug(mySec, oppSec, sections) {
  const COUNTER_SEL = [
    '[class*="counter" i]', '[class*="player-info" i]', '[class*="score" i]',
    '[class*="point" i]', '[class*="life" i]', '[class*="health" i]',
    '[class*="hp" i]', '[class*="star" i]'
  ].join(', ');
  const NAME_SEL = [
    '[class*="player-name" i]', '[class*="username" i]', '[class*="pseudo" i]',
    '[class*="nickname" i]', '[class*="handle" i]', '[class*="avatar" i]',
    '[class*="profile" i]'
  ].join(', ');

  const dumpSection = (sec) => {
    if (!sec) return null;
    const cardsByZone = {};
    for (const el of sec.querySelectorAll('.game-card')) {
      const cls = (typeof el.className === 'string' ? el.className : '');
      const zone = (cls.match(/game-card (\w+)/) || [])[1] || '?';
      const id = cardIdFromEl(el);
      (cardsByZone[zone] = cardsByZone[zone] || []).push(id ? cardNameFromId(id) : null);
    }
    const counters = [...sec.querySelectorAll(COUNTER_SEL)]
      .map(e => ({ cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60), text: (e.innerText || '').slice(0, 40) }))
      .filter(x => x.text).slice(0, 20);
    // Player name label candidates (short text nodes in name/user/profile elements).
    const nameLabels = [...sec.querySelectorAll(NAME_SEL)]
      .map(e => ({ cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60), text: (e.innerText || '').trim().slice(0, 60) }))
      .filter(x => x.text && x.text.length < 40).slice(0, 8);
    // All short leaf-node texts that could be a username (1–20 chars, no spaces or 1 word).
    const leafTexts = [...sec.querySelectorAll('*')]
      .filter(e => e.children.length === 0)
      .map(e => ({ cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60), text: (e.innerText || '').trim().slice(0, 40) }))
      .filter(x => x.text && x.text.length >= 3 && x.text.length <= 24 && !/^\d+$/.test(x.text))
      .slice(0, 20);
    return { cls: (typeof sec.className === 'string' ? sec.className : '').slice(0, 80), cardsByZone, counters, nameLabels, leafTexts };
  };

  // Also search for player names in the page header/nav (global username display).
  const globalNameEls = [...document.querySelectorAll(NAME_SEL)]
    .filter(e => !mySec?.contains(e) && !oppSec?.contains(e))
    .map(e => ({ cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60), text: (e.innerText || '').trim().slice(0, 60) }))
    .filter(x => x.text && x.text.length < 40).slice(0, 6);

  // Dump parent + siblings of each .pseudo.my-auto to find the adjacent score element.
  const pseudoContexts = [...document.querySelectorAll('.pseudo.my-auto')].map(el => {
    const parent = el.parentElement;
    return {
      pseudoText: (el.innerText || '').trim(),
      parentCls: (typeof parent?.className === 'string' ? parent.className : '').slice(0, 80),
      siblings: [...(parent?.children || [])].map(c => ({
        cls: (typeof c.className === 'string' ? c.className : '').slice(0, 70),
        text: (c.innerText || '').trim().slice(0, 30)
      }))
    };
  });

  return {
    ts: new Date().toISOString(),
    firstStarter,
    localPlayerName,
    sectionCount: sections.length,
    allSectionClasses: sections.map(s => (typeof s.className === 'string' ? s.className : '').slice(0, 80)),
    mySection: dumpSection(mySec),
    oppSection: dumpSection(oppSec),
    globalNameEls,
    pseudoContexts,
    allBattlefields: [...document.querySelectorAll('.game-card.Battlefields')].map(el => {
      const id = cardIdFromEl(el);
      return { cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70), name: id ? cardNameFromId(id) : null };
    })
  };
}

ipcRenderer.on('request-game-data', () => {
  try { ipcRenderer.send('game-data', collectGameData()); }
  catch (e) { ipcRenderer.send('game-data', { _debug: { error: String(e) } }); }
});

// ---------------------------------------------------------------- boot -----
window.addEventListener('DOMContentLoaded', () => {
  loadCardDb();
  startObservers();
  console.log('%c[RiftReplay] preload active', 'color:#7ce38b');
});
