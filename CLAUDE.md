# RiftReplay — Project Context

Electron deck-tracker overlay for Riftbound games played on https://tcg-arena.fr/play.
Passive/read-only: it observes the game's DOM and never sends input to the game.

## Architecture

- `src/main.js` — opens two BrowserWindows: the game (tcg-arena.fr/play, with
  `game-preload.js` injected) and a frameless always-on-top overlay. Relays
  `tracker-event` IPC messages game → overlay.
- `src/game-preload.js` — the core. One MutationObserver on `document.body`
  drives a set of per-batch reconcilers (`syncSideboard`, `syncScry`,
  `checkDeckCounter`, `syncHand`, `syncMulligan`) plus a 1s polling fallback.
  Runs with `contextIsolation: true`, `sandbox: false` (needs `ipcRenderer`).
- `src/overlay-preload.js` — contextBridge event bridge for the overlay
  (`window.tracker.onEvent`). Note: contextBridge works for the OVERLAY window
  but NOT in the game preload (see below).
- `overlay/overlay.html` — vanilla JS tracker UI: main draw list (drawable
  count, depletion bar, draw %) + a "Bottom of deck" section grouped by recycle
  layer. Listens to `deck-snapshot`, `deck-count`, `card-drawn`,
  `recycled-update`, `recycle-cleared`.
- `riftreplay.sln` / `riftreplay.esproj` — VS 2022 wrapper; F5 runs `npm start`.
  Note: user launches via `npm start` (VS F5 had a startup-project issue).

## Card identification (two CDN shapes — important)

The card DB (`https://russeus.github.io/RB-TCG-Arena/Riftbound-CardList.json`,
987 cards, keyed by id e.g. `OGN-001`, `UNL-022`) is loaded at boot. Entries have
`name.en`, `cost`, `type`, and `face.front.image.<lang>` URLs. Card art comes from
**two CDNs**, so `cardIdFromSrc` handles both:

- Older sets (~376 cards): `cdn.rgpub.io/.../cards/<ID>/...avif` — id is in the path.
- Newer sets (~575 cards, e.g. SFD/UNL): `cmsassets.rgpub.io/sanity/.../<40-hex-hash>-...png`
  — **no id in the URL**. At load we build `state.imageHashToId` (hash → id) from
  the DB's image URLs; `cardIdFromSrc` falls back to it. `cardIdFromEl` checks
  every `<img>` on an element (art, card-back, shortcut icon) and takes the first hit.

A card's image may be a lazy placeholder until scrolled into view, so always
resolve via `cardIdFromEl` (all imgs), not a single `img[src*="/cards/"]` query.

## Verified DOM facts (live dumps, June 2026)

- Pure-DOM React app, no `<canvas>`, Bootstrap-style utility classes.
- **React REUSES `.game-card` nodes** — a draw swaps the inner image rather than
  adding a node, so addedNode/MutationObserver events are unreliable for draws.
  Detection therefore POLLS the DOM each batch and diffs, not addedNodes.
- Card visibility: `.card-hidden-no` = face-up, `.card-hidden-yes` = face-down.
- Zone is encoded on the `.game-card` element's OWN class, e.g.
  `game-card Hand card-hidden-no index-1 reversed-index-2`. Hand cards =
  `.game-card.Hand.card-hidden-no`. Other zones seen: `Legend`, `Chosen_Champion`,
  `Sideboard`, `Mana`, `Runes`, `Battlefields`, `ExileHidden`.
- `.deck` element shows the authoritative remaining count as text ("34\nDraw").
- Game log: `.history` (see log formats below). Chat: `.chatbox`.
- Pre-game deck popup titled "Swap cards with your sideboard"; parsed from
  innerText (rows: index, count, name; sections: Chosen Champion / Deck /
  Sideboard; type subheaders Gear/Spell/Unit).
- Scry UI ("Look and manage the top of your deck"): the cards being managed live
  in a `.revealed-section` strip inside a separate `position-fixed pe-none`
  overlay — NOT under the `.modal-dialog` that holds the heading.
- Mulligan screen: opening hand renders in `.mulligan-section` (its own overlay,
  NOT in `.game-card.Hand`); a card toggled for replacement gets a `selected`
  class on its `.wrapper`.
- `contextBridge.exposeInMainWorld` does NOT expose to the page in the game
  preload (Electron v31 here); `window.__tracker` never appears. (It DOES work in
  the overlay preload.) Removed — no longer used.

## Relevant `.history` log formats

- `drew N` — count only (opening hand / per-turn). Names unknown from the log.
- `drew <Card> from deck` — a named draw from a look/scry effect.
- `played <Card> from <zone>` (hand / their runes deck …).
- `mulliganed N cards`, `has finished taking their mulligan`.
- Recycle (three forms): `sent <Card> to the bottom of their deck`;
  `put <Card> from the top of their deck to the bottom` (single, from scry);
  `put all N looked cards to the bottom of their deck in a random order` (bulk).

## Detection strategy (current)

- **Decklist**: snapshot from the sideboard popup; `syncSideboard` re-parses it
  while open so sideboard swaps are captured; last state before it closes is final.
- **Draws** (`syncHand`): poll `.game-card.Hand.card-hidden-no`, diff vs previous
  hand; each net-new copy is a draw, capped by authoritative departures
  (deck total − `.deck` remaining) so bounce/return-to-hand can't over-count.
- **Scry** (`syncScry`): anchor on `.revealed-section`; diff its cards by name.
  Cards leaving + a deck-count drop = drawn (`scry-action`); `put all N to bottom`
  recycles whatever's still shown, minus `drew X from deck` names (avoids
  double-count as both drawn and recycled).
- **Mulligan** (`syncMulligan`): track `.mulligan-section .wrapper.selected`
  names; on `mulliganed N cards` send those to a random bottom layer. Replacements
  are caught normally by `syncHand`.
- **Recycle layers**: `state.recycledLayers` = one layer per recycle event
  (`{ named:[…], anonymous:N }`), random order within a layer, stacked in draw
  order. Excluded from draw % until they resurface. `promoteSurfacedLayers`
  returns the earliest layer to the draw pool once the cards above it are gone.
- **New game**: a fresh "Swap cards with your sideboard" popup (new container)
  triggers `resetGameState()`, then loads the new decklist.

## Open items / next steps

- Played/board-state tracking: distinguish board zones via the `.game-card`
  class token (`Mana`, `Battlefields`, etc.) if we want to show what's in play.
- "Replay" features (the app's namesake): persist the event stream
  (deck-snapshot, card-drawn, recycled-update, log-*) to disk per game for playback.
- VS F5 launch: likely needs the JS/TS workload or an esproj SDK bump; `npm start`
  is the reliable path meanwhile.

## Conventions

- Never automate game actions; observation only. Respect tcg-arena.fr ToS.
- Prefer text/structure (headings, innerText patterns, stable semantic classes
  like `.deck`, `.history`, `.game-card`, `.revealed-section`, `.mulligan-section`)
  over brittle utility-class chains.
- Detection runs as per-batch reconcilers that re-read the live DOM (idempotent),
  because React reuses nodes — don't rely on MutationObserver addedNodes for state.
