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
https:

```sh
cd tools/playtest
python3 -m http.server 8777
# open http://localhost:8777
```

(Opening via `file://` also works but only through the folder-**input** fallback, not the
directory picker or hot-reload.)

## Use it

1. **Load a game** — click **Open game folder…** and pick a folder containing
   `manifest.json` + `index.html` + `game.js` (+ any assets), **drag that folder** onto the
   page, or pick a built-in **Sample** (STREAK, BLITZ).
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
   (`send` / `broadcast` / `sendTo`, plus `leave` / `join` / errors) with direction and
   payload — your debugger for game logic.
6. **Test disconnects** — each phone's **Drop** button fires `onPlayerLeave` to the others
   (host auto-bank paths, etc.); **Reconnect** rebuilds it and fires `onPlayerJoin`.
7. **Iterate** — edit your `game.js`/`index.html`, hit **↻ Reload** then **Start** to
   re-boot with the new code (hot reload uses the retained directory handle).
8. **Ship** — **Export .zip** packages the loaded bundle into the exact
   `id@version` zip the iOS shell imports (verified: `unzip -t` clean, `manifest.json` +
   `index.html` + `game.js` at the root).

## The Table SDK it injects

Identical surface to the native shell, so a game that runs here runs on device unchanged:

```js
Table.me            // { id, name, emoji, isHost }
Table.isHost
Table.players       // finalized roster (seat order)
Table.onStart(players => …)
Table.onMessage((fromId, payload) => …)
Table.onPlayerJoin(player => …)
Table.onPlayerLeave(playerId => …)
Table.send(payload)             // client → host (host's own send loops back to it)
Table.broadcast(payload)        // host → all clients
Table.sendTo(playerId, payload) // host → one client
Table.endGame({ winnerId, title, standings:[{playerId,score,detail}] })
                                // host → shell renders a native results screen on every
                                // device (winner + ranked standings) with Play Again
Table.saveState(obj) / Table.loadState()
```

`endGame` is rendered by the studio itself (mirroring the native shell): a results overlay
appears on every phone — host sees **Play Again** (reboots all phones → fresh `onStart`),
clients wait. Both samples call it (STREAK at 200 pts, BLITZ at 10 taps).

## Known limits

- Games are loaded via blob URLs, so `game.js` doing its own `fetch()` of bundle-relative
  files won't resolve (script `src`, `link`, `img`, `<style> url(...)`, and linked-CSS
  `url(...)` **are** rewritten to the loaded assets). The Table games don't need runtime
  fetches.
- Export produces a **stored** (uncompressed) zip — small and universally readable
  (the shell's `ZipArchive` handles stored + deflate).
- This tool trusts the loaded code (same-origin `srcdoc` iframes). It's a dev tool; don't
  point it at untrusted bundles.
