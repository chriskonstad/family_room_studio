# Family Room — Game Dev Kit

Everything you need to **build and test games for Family Room**, entirely in the browser —
no iOS app source and no native toolchain required. This directory is **self-contained and
publishable on its own** (e.g. as its own GitHub repo or a GitHub Pages site).

Family Room is a local, serverless, peer-to-peer party-game shell: friends in the same room
each open the app on their phone, one hosts, the rest join, and everyone plays a shared
game. A **game** is just a bundle of HTML + JS + assets written against one injected global,
`Table`. The same bundle runs on every device; the host is authoritative.

## What's in here

| | |
|---|---|
| **[GAME-AUTHORING.md](GAME-AUTHORING.md)** | The complete author's guide — bundle/archive format, the full `Table` SDK, assets, a copy-paste starter game, and the rules every game must follow. Start here (and hand this to an LLM writing a game). |
| **[skills/game-dev/](skills/game-dev/SKILL.md)** | A Claude Code **skill** for game development — drop it into a project's `.claude/skills/` and Claude follows the canonical dev/test/version/ship workflow and UX standards automatically. |
| **[FR-GAME.md](FR-GAME.md)** | The `FR` game-structure library — seeded RNG, decks, seats and elimination, standings, timers, and a host reducer that refuses illegal intents. Written for a small model: cheat sheet, per-primitive rules, and a complete 40-line game to copy. |
| **[sdk/](sdk/)** | The runtimes both harnesses inject: `table-sdk.js` (the ONE `Table` implementation, shared with the iOS shell), `fr-feel.js` (animations/haptics/sound), `fr-game.js` (structure). |
| **[harness/](harness/)** | Run real bundles **headless** — N virtual phones, a virtual clock, bots. `playtest.mjs` plays a game to completion and checks it never throws, always terminates and leaks no timers. |
| **[validate.mjs](validate.mjs)** | Check a bundle (folder or `.zip`) before it goes near a phone: manifest schema, offline-only, no external hosts, viewport, size. |
| **[playtest/](playtest/)** | The **Playtest Studio** — a zero-dependency web tool that runs your game across multiple simulated players in iPhone-sized frames, with a wire-message log, disconnect testing, hot reload, and one-click **Export .zip**. |

## The one command

```sh
node tools/check.mjs
```

Conformance + the `FR` library suite + bundle validation + a headless bot playtest of every
bundle. Node only — no browser, no simulator, no Mac. If this is green, the only thing left
that a Mac can tell you is how the game *feels*.

## Quick start

```sh
# serve the dev-kit ROOT, not playtest/ — the studio loads sdk/fr-feel.js
python3 -m http.server 8777
# open http://localhost:8777/playtest/   (localhost is required for the folder picker)
```

Serving `playtest/` directly still works, but the studio can't reach `sdk/fr-feel.js`
from there, so games lose `Table.feel()` and the shared `fr-*` animations. The console
says so if it happens.

Then: pick a built-in **Sample** to see a game run, read
[GAME-AUTHORING.md](GAME-AUTHORING.md), write your own game folder
(`manifest.json` + `index.html` + `game.js`), **Open game folder…** to load it, play it
across players, and **Export .zip** when it's ready.

## Publishing / hosting

The whole kit is static files. Host `playtest/` on GitHub Pages, Cloudflare Pages, Netlify,
Vercel, or any static server (it needs `https`/`localhost` for the folder picker). To ship a
finished game to players, export its `.zip` and load it into the Family Room app via **Add
Game from Zip**; joiners who don't have it pull it from the host over the air.

The native shell that runs these bundles on-device (Swift/SwiftUI, Network.framework
peer-to-peer) lives in the main Family Room app repository; you don't need it to author or
test games.
