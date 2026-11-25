# Family Room — Playtest Studio

A zero-dependency, self-contained web tool for **authoring and testing Table SDK game
bundles across multiple simulated players — no iOS simulator required.** Each player is a
real `<iframe>` "phone" running the game's `index.html`; the page itself is the
authoritative star-topology router (client → host, host → clients), mirroring the native
iOS Family Room shell.

It's just `index.html` + a `samples/` folder — **static files, trivial to host** (drop it
on any web server or GitHub Pages) and easy to zip for deployment.

> Writing a game? See the author's guide next door: **[../GAME-AUTHORING.md](../GAME-AUTHORING.md)**.

## Run it

Folder-picking (`showDirectoryPicker`) needs a secure context, so serve over localhost or
https. Serve the dev-kit ROOT, not this folder: the Studio loads the shared runtimes
(`sdk/table-sdk.js`, `fr-game.js`, `fr-feel.js`, `fr-screen.js`) from `../sdk/`, and served
from inside `playtest/` they are out of reach and the Studio runs without them.

```sh
cd tools
python3 -m http.server 8777
# open http://localhost:8777/playtest/
```

(Opening via `file://` also works but only through the folder-**input** fallback, not the
directory picker or hot-reload.)

## Use it

1. **Load a game** — click **Open game folder…** and pick a folder containing
   `manifest.json` + `index.html` + `game.js` (+ any assets), **drag that folder** onto the
   page, or pick one of the fourteen built-in **Samples** (listed in `samples/index.json`):
   BLITZ ⚡️ (tap race), Captain Says 🫡 (obey only the Captain), The Detonator 🧨 (one
   live plunger), FISHBOWL 🐟 (teams), HOLD'EM 🂡 (poker, with or without a TV), Liar's
   Dice 🎲 (bluffing), Look Away 👀 (one looks, everyone else hides), MELTDOWN ☢️ (co-op
   shouting), Pass the Bomb 💣 (hidden fuse), SCRAMBLE 🔡 (word grid on the TV), STREAK 🔥
   (push-your-luck), SUMMIT 🏔 (two-player expeditions), TAPAS 🫒 (simultaneous drafting)
   and TEMPO 🎵 (rhythm).
2. **Set up players** — add/remove seats (bounded by the manifest's `minPlayers`/
   `maxPlayers`), rename, cycle emoji, reorder (seat order = turn order), and choose which
   seat is the authoritative **host**.
3. **Pick devices** — a default-device dropdown plus a per-phone override.
   **iPhone 16 Pro and iPhone 17 Pro** are the defaults (seat 1 → 16 Pro, seat 2 → 17 Pro).
   Sizes are **logical points** (CSS px), the unit layouts use — *not* physical pixels,
   which are 3× larger (402×874 pt = 1206×2622 px @3×). Sizing to points is what makes the
   layout match the device 1:1; sizing to physical pixels would render everything at ⅓
   scale. Both 16 Pro and 17 Pro are 6.3″ / 402×874 pt so they render identically; Pro Max
   (440×956), 15 Pro (393×852), and SE (375×667) are also included. Zoom scales all phones
   to fit your monitor.
4. **Start** — freezes the roster and boots every phone (fires `Table.onStart`). Click
   around in any phone; state routes to the others live.
5. **Inspect** — the **Message log** at the bottom shows every wire message
   (`send` / `broadcast` / `sendTo`, plus `pause` / `resume` / `screens` / errors)
   with direction and payload — your debugger for game logic.
6. **Test disconnects** — each phone's **Drop** button pauses the table (nobody's game
   hears a thing); **Reconnect** catches it up with exactly what it missed, or rebuilds
   it from the whole history (cold: the app was killed). Games never see either event.
7. **Iterate** — edit your `game.js`/`index.html`, hit **↻ Reload** then **Start** to
   re-boot with the new code (hot reload uses the retained directory handle).
8. **Ship** — **Export .zip** packages the loaded bundle into the exact
   `id@version` zip the iOS shell imports (verified: `unzip -t` clean, `manifest.json` +
   `index.html` + `game.js` at the root).

## The Table SDK it injects

The same file the native shell injects (`sdk/table-sdk.js`), so a game that runs here
runs on device unchanged:

```js
Table.me            // { id, name, emoji, teamId?, isHost }
Table.isHost
Table.players       // finalized roster (seat order)
Table.teams         // [{ id, name, color, playerIds }] for a "teams":"required" game, else null
Table.seed          // one seed the whole table shares: FR.rng(Table.seed)
Table.onStart(players => …)
Table.onMessage((fromId, payload) => …)   // delivered asynchronously, never inside your call
Table.onPause(() => …)          // the table paused: every timer freezes until onResume
Table.onResume(() => …)         // carry on; a returning phone is caught up by the shell
Table.isPaused
Table.send(payload)             // client → host (host's own send loops back to it)
Table.broadcast(payload)        // host → all clients
Table.sendTo(playerId, payload) // host → one client
Table.endGame({ winnerId, title, standings:[{playerId,score,detail}] })
                                // host → shell renders a native results screen on every
                                // device (winner + ranked standings) with Play Again
Table.saveState(obj) / Table.loadState()   // persisted on THIS device, per game
Table.screens                   // HOST: shared screens attached (number); null elsewhere
Table.onScreensChange(n => …)   // HOST: a TV came or went — republish
Table.haptic(style) / Table.sound(name)    // shell-owned room feedback
Table.feel(event, opts)         // semantic feedback + shared animations (sdk/fr-feel.js)
```

`endGame` is rendered by the studio itself (mirroring the native shell): a results overlay
appears on every phone — host sees **Play Again** (reboots all phones → fresh `onStart`),
clients wait. Every sample calls it.

## Known limits

- Games are loaded via blob URLs, so `game.js` doing its own `fetch()` of bundle-relative
  files won't resolve (script `src`, `link`, `img`, `<style> url(...)`, and linked-CSS
  `url(...)` **are** rewritten to the loaded assets). The Table games don't need runtime
  fetches.
- Export produces a **stored** (uncompressed) zip — small and universally readable
  (the shell's `ZipArchive` handles stored + deflate).
- This tool trusts the loaded code (same-origin `srcdoc` iframes). It's a dev tool; don't
  point it at untrusted bundles.
