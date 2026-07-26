# Writing a Game for Family Room

This is the complete guide to authoring a game bundle that runs on the Family Room shell
(iOS app) and in the [Playtest Studio](playtest/). If you're an LLM generating a game,
**read this whole file first** — the rules in [§9](#9-rules--limits-read-before-you-write)
are load-bearing: code that ignores them compiles and looks right but behaves wrong.

Companion doc: [playtest/README.md](playtest/README.md) — how to test what you write. (The
shell's internal design lives in the Family Room app repo as `Engine-Shell-SDK-Spec.md`;
you don't need it to write a game — everything you need is here.)

---

## 1. What a game is

A game is a **bundle of plain HTML + JS + assets** — no native code, no frameworks
required, no build step. The **same bundle runs on every player's device.** The shell
parameterizes each copy with a **role** (`host` or `client`) and the **roster**, and
injects one global, **`Table`**, that the game is written against.

**The host is authoritative.** Exactly one device is the host; it owns all game state, the
deck/RNG/shuffle, and validates every input. Clients are thin: they render the state the
host sends and send back intents ("flip", "tap", "choose target"). You write both sides in
one file and branch on `Table.isHost`.

```
        intents (send)                         state (broadcast/sendTo)
 client ───────────────▶  HOST (authoritative)  ───────────────▶ all clients
                          owns state + RNG,        renders received state
                          validates everything
```

The host is also a player: its own `Table.send(...)` loops straight back to its local
`onMessage`, so you never special-case "the host's own move."

---

## 2. Bundle format & the archive

A bundle is a **zip** that expands to a folder:

```
mygame/
  manifest.json     # required — identity + metadata
  index.html        # required — the entry point loaded into the webview
  game.js           # your game (any name; referenced from index.html)
  assets/…          # optional — images, sounds, css, fonts
```

Archive rules:

- **Zip layout:** the files may sit at the **zip root** *or* under a **single top-level
  folder** (e.g. `mygame/manifest.json`). Both are accepted; the loader finds `manifest.json`
  and treats its directory as the bundle root.
- **Compression:** `stored` (none) or `deflate`. No password, no zip64.
- **Housekeeping:** dotfiles and `__MACOSX/` entries are ignored.
- **Keep it small.** Bundles transfer phone-to-phone over the air when friends join; a few
  MB is fine, tens of MB is rude.

Easiest way to produce a valid archive: open the folder in the Playtest Studio and click
**Export .zip** — it writes exactly the `id@version` zip the app imports.

### `manifest.json`

```json
{
  "id": "com.you.mygame",     // stable unique id — reverse-DNS or a UUID. NEVER reused for a different game.
  "version": "1.0.0",         // semver; bump every release
  "name": "My Game",          // shown in the game list
  "entry": "index.html",      // the file loaded into the webview (defaults to index.html)
  "iconEmoji": "🎲",          // shown next to the name
  "minPlayers": 2,            // roster lower bound (the shell won't start below this)
  "maxPlayers": 8,            // roster upper bound
  "teams": "required",        // OPTIONAL — declare a team game (see "Teams" below)
  "author": "You",
  "description": "One or two sentences on how it plays."  // shown on press-and-hold
}
```

`description` is worth writing: players press and hold a game in the library to get a card
explaining what it is before they commit to hosting it. Say how it *plays* ("push your luck
flipping cards…"), not what genre it is.

`id` + `version` uniquely identify a bundle. **Every device in a session must run the exact
same `id@version`, byte-for-byte** — that's what makes the authoritative-host model safe. If
you change anything, bump `version`. Keep `id` stable across versions of the *same* game.

---

## 3. Quick start — a complete minimal game

This is a full, working two-file game. Copy it, rename, and grow it.

**`manifest.json`**
```json
{ "id": "com.you.tapduel", "version": "1.0.0", "name": "Tap Duel", "entry": "index.html",
  "iconEmoji": "⚡️", "minPlayers": 2, "maxPlayers": 8, "author": "You" }
```

**`index.html`** — minimal shell. `Table` is already injected before this runs; do **not**
include your own copy of it.
```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>
  html,body{height:100%;margin:0;font-family:-apple-system,system-ui,sans-serif}
  body{display:flex;flex-direction:column;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom)}
  #scores{flex:1}
  .row{display:flex;justify-content:space-between;padding:10px;font-size:18px}
  .row.me{font-weight:700}
  button{padding:20px;font-size:22px;border:0;border-radius:16px;background:#e8b34a}
</style>
</head>
<body>
  <h2>Tap Duel ⚡️ — first to 10</h2>
  <div id="scores"></div>
  <button id="tap">TAP</button>
  <script src="game.js"></script>
</body>
</html>
```

**`game.js`** — the whole game. Note the `isHost` branch and the "hello" resync.
```js
const root   = document.getElementById('scores');
const GOAL   = 10;
let roster   = [];
let scores   = {};

function render() {
  root.innerHTML = roster.map(p =>
    `<div class="row ${p.id === Table.me.id ? 'me' : ''}">${p.emoji} ${p.name}` +
    `<span>${scores[p.id] || 0}</span></div>`).join('');
}

Table.onStart(players => {
  roster = players;
  players.forEach(p => scores[p.id] = 0);
  if (!Table.isHost) Table.send({ type: 'hello' });   // ask the host for current state
  render();
});

if (Table.isHost) {
  Table.onMessage((fromId, msg) => {
    if (msg.type === 'tap') scores[fromId] = (scores[fromId] || 0) + 1;
    Table.broadcast({ type: 'state', scores });        // push new state to everyone
    render();                                           // host renders its own copy too

    const winner = roster.find(p => (scores[p.id] || 0) >= GOAL);
    if (winner) Table.endGame({                         // hand the result to the shell
      winnerId: winner.id,
      standings: roster.slice().sort((a,b)=>(scores[b.id]||0)-(scores[a.id]||0))
                        .map(p => ({ playerId: p.id, score: scores[p.id] || 0 }))
    });
  });
} else {
  Table.onMessage((_from, msg) => {
    if (msg.type === 'state') { scores = msg.scores; render(); }
  });
}

document.getElementById('tap').onclick = () => Table.send({ type: 'tap' });
```

That's a complete multiplayer game: authoritative host, live state sync, a native results
screen, and Play-Again (free — see [§6](#6-ending-a-game)).

---

## 4. The `Table` SDK — full reference

`Table` is a global, injected **before your scripts run**. It is the **only** interface to
the platform (see [§9](#9-rules--limits-read-before-you-write) — there is no filesystem,
no sockets, no device APIs).

### Identity & roster
```js
Table.me         // { id, name, emoji, isHost, teamId? } — this device's player
Table.isHost     // boolean convenience
Table.players    // [{ id, name, emoji, teamId? }, …] — the finalized roster, in SEAT ORDER
Table.teams      // null, or [{ id, name, color, playerIds }, …] for team games (see "Teams")
```
- **Seat order is turn order.** `Table.players[0]` is the first seat (and is the host). The
  host arranges seats in the lobby before starting; respect that order for turns.
- Player **ids are opaque strings** (e.g. `"p0"`, `"p1"`). Never hard-code them — read
  `Table.me.id` and iterate `Table.players`.

### Teams (shell-managed)
Declare `"teams": "required"` in the manifest and the **shell owns team setup** — don't
build your own team picker:
- The **host's lobby** shows a team-count stepper (2–4) and a colored chip per player;
  tapping a chip moves that player to the next team. Joiners are auto-assigned to the
  smallest team. The game can't start until every player has a team and ≥2 teams are
  non-empty. (The Playtest Studio mirrors this in its roster editor.)
- Your game receives the result: `Table.teams` is an array of
  `{ id, name, color, playerIds }` (e.g. `{id:'t0', name:'Red Team', color:'#e0564b',
  playerIds:['p0','p2']}`), each roster entry carries `teamId`, and `Table.me.teamId` is
  this device's team.
- Treat teams as **final at `onStart`**, like seats. Filter out empty teams defensively
  (`Table.teams.filter(t => t.playerIds.length)`).
- To rank **teams** on the results screen, use `teamId` in `endGame` standings (below).
- Games without `"teams"` in the manifest get `Table.teams === null` and no team UI.

### Lifecycle (shell → your game)
```js
Table.onStart((players) => { … })       // session begins (or restarts). Roster is final. Init here.
Table.onMessage((fromId, payload) => {}) // a message arrived
Table.onPlayerLeave((playerId) => { … }) // a player LEFT FOR GOOD (see pause, below)
Table.onPlayerJoin((player) => { … })    // a player (re)joined mid-game
Table.onPause(() => { … })               // optional: play frozen (someone dropped)
Table.onResume(() => { … })              // optional: play resumed
Table.isPaused                           // optional: current freeze state
```
- **`onStart` fires once when the game begins and again on every restart** (Play Again
  reloads the bundle). Treat it as "initialize a brand-new game." Do all setup here.
- Register your handlers synchronously at top level so they exist when `onStart` fires.

### Disconnects, pause and reconnect (the shell handles this — don't reinvent it)

If anyone's phone backgrounds, sleeps, or drops off the network, the shell **pauses the
whole table**: every device shows a "Paused — waiting for <player>" overlay that blocks
input, the dropped player's seat is held, and their app reconnects and resumes that same
seat automatically. `onPlayerLeave` fires only when they leave for good (they tapped Leave,
or the host chose "Continue without them") — a brief disconnect never reaches your game.

**Your clocks freeze automatically.** `setTimeout` / `setInterval` are shimmed in the
injected SDK, so a lit fuse or round timer stops while paused and resumes with the exact
time remaining — no game code required. The one rule this imposes:

> Never derive game timing from raw `Date.now()` deltas across a pause. Drive time with
> `setTimeout`/`setInterval` (which freeze) rather than by comparing wall-clock stamps
> (which don't) — otherwise a paused game "catches up" all at once on resume.

On reconnect the host shell also **replays your last `broadcast` and that player's last
`sendTo`**, so a returning player lands mid-game rather than on an empty board. Handling
`{type:'hello'}` with a state publish (below) is still recommended — it makes the resync
immediate and is the documented contract.

### Messaging (your game → shell → wire)
```js
Table.send(payload)             // client → host. (On the host, loops back to its own onMessage.)
Table.broadcast(payload)        // host → all clients. Host-only (no-op on clients).
Table.sendTo(playerId, payload) // host → one client (e.g. a private hand). Host-only.
```
- `payload` is **any JSON-serializable object** — plain data only (no functions, DOM nodes,
  class instances). It is structured-cloned across the boundary.
- Delivery is **reliable and ordered** while connected (a TCP-like stream): messages arrive
  in the order sent, without loss. But it is **asynchronous** — never assume a `send` has
  been handled by the next line.
- **Clients only `send`; the host `broadcast`/`sendTo`.** Clients never mutate authoritative
  state directly — they send an intent and wait for the host's next state broadcast.

### Ending the game
```js
Table.endGame({ winnerId, title, standings: [{ playerId | teamId, score, detail }] })
```
Host-only. Standings rank players — or whole teams via `teamId`. See [§6](#6-ending-a-game).

### Optional persistence (stretch; may be a no-op in some shells)
```js
Table.saveState(obj)   // host persists authoritative state (crash/relaunch recovery)
Table.loadState()      // returns the last saved state, or null
```

---

## 5. The authoritative-host pattern (how to structure a game)

The reliable shape for almost every game:

1. **`onStart`** — build initial state. On the **host**, create the authoritative state
   (deck, scores, whose turn). On a **client**, `Table.send({type:'hello'})` and wait.
2. **Host `onMessage`** — validate the intent (is it this player's turn? is the move
   legal?), mutate authoritative state, then `Table.broadcast({type:'state', …})` a public
   snapshot. Ignore illegal intents. Handle `{type:'hello'}` by broadcasting current state
   (this resyncs a client whose webview loaded late).
3. **Client `onMessage`** — on `{type:'state', …}`, replace local view and re-render. Clients
   are pure render functions of the host's state.
4. **`onPlayerLeave`** (host) — a player dropped; fold them out so the game can continue
   (e.g. auto-bank/skip them, advance the turn if it was theirs), then broadcast.
5. **`Table.endGame(...)`** (host) — when the game is decided.

Why the `hello` handshake matters: a client's webview may finish loading *after* the host's
first `broadcast`, missing it. Having the client announce itself and the host reply with the
current state closes that race. (The shell also refires `onStart` on reconnect.)

**Randomness / secrets:** only the host should use `Math.random()` (shuffles, dice). Clients
render host state, so they never diverge. Deal private info with `sendTo(playerId, …)` so a
hidden hand never rides on a `broadcast`.

---

## 6. Ending a game

Don't build your own game-over screen. Call `Table.endGame(...)` on the host and the shell
renders a **consistent native results screen on every device** and owns restart:

```js
Table.endGame({
  winnerId: "p2",              // optional — player to highlight. Defaults to standings[0].
  title: "Ben wins!",          // optional — headline override. Defaults to "<winner> wins!".
  standings: [                 // ranked best-first; the shell renders this list in order
    { playerId: "p2", score: 203, detail: "🔥 Full streak" },
    { playerId: "p0", score: 197 },
    { playerId: "p1", score: 0, detail: "busted out" }
  ]
})
```
- `score` may be a **number or a string** (`42`, `"DNF"`); both optional.
- `detail` is optional secondary text under the name.
- **Team games:** put `teamId` in a standing instead of `playerId` to rank whole teams —
  the shell renders the team's color, name, and member emojis, and `winnerId` may be a
  team id:
  ```js
  Table.endGame({ winnerId: 't0',
    standings: [ { teamId:'t0', score: 24 }, { teamId:'t1', score: 12 } ] })
  ```
- The shell shows the winner (trophy + headline), the ranked standings, and a **"Play
  Again"** button to the host (clients see "waiting"). **Play Again reloads the bundle on
  every device → `onStart` fires fresh.** You need no rematch/restart code of your own —
  just make `onStart` set up a new game.
- After `endGame`, stop processing further intents for the finished game (the shell overlays
  the results, but guard your `onMessage` too).

---

## 7. Assets (images, sound, fonts, CSS)

Put asset files in the bundle (an `assets/` folder is conventional) and reference them
**relatively from HTML or CSS**:

```html
<img src="assets/card-back.png">
<audio id="ding" src="assets/ding.mp3" preload="auto"></audio>
<link rel="stylesheet" href="assets/theme.css">
```
```css
.board { background: url(assets/felt.png); }
@font-face { font-family: Game; src: url(assets/game.woff2); }
```

Supported types include png/jpg/gif/svg/webp, mp3/wav/ogg/m4a, css, woff/woff2/ttf/otf,
mp4. The loader rewrites `src`/`href` on `<script>`, `<link>`, `<img>`, `<audio>`,
`<video>`, `<source>`, inline `<style>` `url(...)`, and `url(...)` inside linked CSS.

**Portability rule — reference assets declaratively, don't `fetch()` them at runtime.** In
the Playtest Studio, bundle files are served as blob URLs, so a runtime
`fetch('assets/data.json')` from `game.js` won't resolve (it works in the native shell but
not the studio). For data you'd otherwise fetch:
- inline it in `game.js`, or
- embed it in `index.html` as `<script type="application/json" id="data">…</script>` and
  read it with `JSON.parse(document.getElementById('data').textContent)`.

**No remote resources.** Games run fully offline over peer-to-peer. Do not load anything
from the internet (CDNs, web fonts, analytics, remote images) — there is no connectivity and
requests are blocked. Everything the game needs ships in the bundle.

---

## 8. UI & rendering conventions

- The game fills a **phone-sized webview** (iPhone 16 Pro / 17 Pro ≈ **402×874 logical
  points**; see the studio for other sizes). Design **mobile-first, portrait**, touch-sized
  targets.
- Always include the viewport meta and respect the notch/home indicator:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  ```
  Pad with `env(safe-area-inset-*)`.
- **Lay out for a variable player count** (`minPlayers`…`maxPlayers`) — the roster size is
  set in the lobby. Don't assume exactly two players.
- Each device renders **its own** view. Use `Table.me.id` to mark "you" and to show only the
  local player's controls (e.g. Flip/Bank buttons appear only on the current player's phone).
- Do your own `Table`-free thing for visuals — animations, sound, haptics via vibration are
  all fine; they're just web APIs inside the webview.

---

## 9. Rules & limits (read before you write)

A checklist. Violating these produces code that runs but misbehaves.

1. **One bundle, both roles.** Ship a single JS file that branches on `Table.isHost`. Don't
   write separate host/client bundles.
2. **Only the host mutates game state.** Clients `send` intents and render the host's
   broadcasts. Never let a client change authoritative state locally.
3. **The host validates every intent.** Check turn ownership and legality in the host's
   `onMessage`; ignore anything illegal. Never trust a client to send only legal moves.
4. **Initialize in `onStart`, and expect it to fire again** (restart reloads the bundle).
   Don't stash "already initialized" flags that survive a reload — a reload is a clean slate.
5. **Messages are async, ordered, JSON-only.** Payloads must be plain JSON-serializable data.
   Don't rely on a `send` completing synchronously.
6. **Turn order = `Table.players` order.** Don't invent your own seating.
7. **Don't hard-code player ids or counts.** Read `Table.me`, iterate `Table.players`, honor
   `minPlayers`/`maxPlayers`.
8. **End with `Table.endGame(...)`**, not a homegrown game-over screen. Let the shell own
   winners + Play Again.
9. **Offline only.** No network requests, no CDNs/web-fonts/remote assets. Bundle everything.
10. **Reference assets via HTML/CSS, not runtime `fetch()`** (studio portability).
11. **`Table` is the whole platform.** No filesystem, sockets, or device APIs beyond standard
    in-webview web APIs. Don't include your own copy of the `Table` SDK — it's injected.
12. **Randomness lives on the host.** Shuffles/dice use `Math.random()` on the host only.
13. **Keep the bundle small** (it transfers over the air to every joiner).
14. **Bump `version` on any change; keep `id` stable.** Same `id@version` must be identical
    on every device.

---

## 10. Test & ship

- **Test:** open the [Playtest Studio](playtest/) (`cd playtest && python3 -m
  http.server`, then browse to it). Load your game **folder**, add players, run them across
  iPhone device sizes, watch the **message log** to debug your wire protocol, exercise
  **Drop/Reconnect**, and drive an end-to-end game including `endGame` → Play Again. Edit
  files and hit **Reload → Start** to hot-reload.
- **Package:** click **Export .zip** in the studio (or zip the folder). That's your bundle.
- **Ship:** in the Family Room app, **Add Game from Zip** installs it into the library; it
  then appears in "Choose a game" and can be hosted. Joiners who lack it pull it from the
  host over the peer-to-peer link automatically.
