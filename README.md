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
| **[playtest/](playtest/)** | The **Playtest Studio** — a zero-dependency web tool that runs your game across multiple simulated players in iPhone-sized frames, with a wire-message log, disconnect testing, hot reload, and one-click **Export .zip**. |

## Quick start

```sh
cd playtest
python3 -m http.server 8777
# open http://localhost:8777  (localhost is required for the folder picker)
```

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
