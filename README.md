# RiftReplay (tcg-arena.fr)

An Electron app that opens tcg-arena.fr/play in its own window, watches the
page's DOM, and renders a live deck-tracker overlay: which cards remain in
your deck, what you've drawn, and draw odds.

No OCR, no screen capture. The site is a plain-DOM React app, so everything
is read directly from page elements. The full Riftbound card database is
fetched from the same public JSON the site itself uses.

## Run it

**Visual Studio 2022:** open `riftreplay.sln` (requires the *Node.js development*
or *JavaScript and TypeScript* workload from the VS Installer). VS restores npm
packages automatically on first open — or right-click the project → *Install npm
packages*. Press **F5** (configured to run `npm start`).

**Command line:**

```bash
npm install
npm start
```

Two windows open: the game (tcg-arena.fr/play) and a frameless always-on-top
overlay. Log in, load a deck, and play — the tracker fills in automatically.

## How each piece works

| File | Role |
| --- | --- |
| `src/main.js` | Spawns both windows; relays tracker events game → overlay via IPC. |
| `src/game-preload.js` | The core. MutationObserver on the game DOM: snapshots the "Swap cards with your sideboard" popup, parses the `.history` game log, and identifies card images by their `/cards/<ID>/` CDN URLs mapped through `Riftbound-CardList.json`. |
| `src/overlay-preload.js` | Safe context-bridge so the overlay page receives events. |
| `overlay/overlay.html` | The tracker UI: remaining counts, depletion bars, draw odds. |

## One calibration step you must do

The deck popup, mulligan screen, and history log were verified against the
live site. The **in-game hand container's class name** could not be confirmed
from the lobby, so hand-draw detection ships with placeholder selectors.

During a real game:

1. In the game window press `Ctrl+Shift+I` to open DevTools.
2. Run `__tracker.dump()` in the console.
3. Find the container whose `imgs` count equals your hand size and note its
   class (e.g. `.hand-zone`).
4. Add that class to `HAND_SELECTORS` near the top of `src/game-preload.js`.

Other handy console helpers: `__tracker.snapshot()` re-parses the deck
popup if it's open; `__tracker.state()` shows live tracker state.

## Etiquette / ToS

This is a passive, read-only tracker: it never clicks, types, or sends
anything to the game. Still, check tcg-arena.fr's rules on companion tools,
and consider mentioning it to the developer (the project appears to be a
community effort — the card data is hosted on a public GitHub Pages repo).
