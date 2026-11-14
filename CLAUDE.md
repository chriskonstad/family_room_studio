# CLAUDE.md — working in the Family Room game dev kit

This repo is the **standalone dev kit** for Family Room, a local, serverless,
peer-to-peer party-game shell for phones. A game is a bundle of HTML + JS written
against one injected global, `Table`. The native shell (Swift) lives in the main
Family Room app repo, which vendors this repo as its `tools/` submodule — nothing
here needs Xcode, a simulator, or a Mac.

## The one command

```sh
node check.mjs
```

Run it before every commit; CI (`.github/workflows/check.yml`) runs it on every
push and PR. It runs, in order: the Table SDK conformance suite, the FR library's
own tests (including a fuzz soak), the fr-screen library's tests, bundle
validation, a headless bot playtest of every sample, and a headless run of every
shared screen at six screen shapes. All six must be green.

## Layout

| Path | What |
|---|---|
| `sdk/table-sdk.js` | The ONE `Table` implementation, shared verbatim with the iOS shell. Changing it changes every game on every device. |
| `sdk/fr-game.js` | `FR` — seeded RNG, decks, seats, standings, timers, and the `FR.host` intent reducer. `sdk/fr-game.test.mjs` is its suite. |
| `sdk/fr-feel.js` | Animations / haptics / sound. |
| `sdk/fr-screen.js` | `FRScreen` — the SHARED SCREEN drawing vocabulary (see below). `sdk/fr-screen.test.mjs` is its suite. |
| `harness/` | Headless runner + fuzzer. `runner.mjs` boots N virtual phones on a virtual clock (including `Date`); `playtest.mjs` plays bundles to completion under bots and asserts the invariants below. |
| `playtest/` | The browser Playtest Studio, plus `samples/<key>/` — the game bundles. |
| `validate.mjs` | Static bundle checks (manifest schema, offline-only, authoring lints). |
| `conformance/` | The spec both harnesses are held to. |

## Rules for writing or changing a game

1. **Bump `manifest.json` version on ANY game change.** The app replaces bundles
   by version; an unbumped change never reaches phones that already have the game.
2. **All randomness through `FR.rng(Table.seed)`.** Never `Math.random()`. The
   game must be a pure function of `(seed, intents)` or no failure can ever be
   reproduced. The harness asserts this (same seed → identical game).
3. **Host logic never reads `Date.now()` for elapsed time.** The shell freezes
   timers when the table pauses, but wall-clock time keeps passing — a
   `Date.now()` delta leaps forward on resume. Drive time from `FR.timers`
   ticks. Client-side display math is the only acceptable use.
4. **Build the host on `FR.host` and declare `options` for every intent that
   carries arguments** (or `hidden: true` for free text, with a `bot.mjs` to
   supply it). This is what makes the game playable and fuzzable with no DOM.
   Never teach the harness's DOM shim new tricks when declaring the move space
   would do — see `harness/known-gaps.json`'s comment.
5. **Name your timers (`FR.timers`) and `cancelAll()` when the game ends.** The
   harness fails a bundle that keeps ticking under the results screen.
6. **`Table.onPlayerLeave` must keep the game finishable** — eliminate the seat,
   re-check for a winner, never leave the table waiting on a ghost.
7. Games are plain ES5-ish scripts injected into WKWebView — no imports, no
   fetch, no external hosts. `validate.mjs` enforces most of this.

## Testing a game

```sh
node harness/playtest.mjs <key>                       # fuzz one bundle, all modes
node harness/playtest.mjs <key> --games 200           # harder soak
node harness/playtest.mjs <key> --seed N --players P [--hostile|--leave|--pause] --verbose
```

A failure prints a **reproduce command — run it verbatim**; it pins the seed,
player count and mode, and replays the exact game. Batches automatically rotate
through table sizes (2–8, clamped to the manifest), hostile input (intents no UI
offered, ghost senders), a mid-game disconnect, and a mid-game 45s pause.

Invariants every bundle must hold: never throws · always terminates · `endGame`
fires exactly once · winner is a seated player or team · no timers left armed ·
a refused intent changes nothing · nothing moves while paused · same seed
replays move for move.

Per-bundle hooks, dropped beside `game.js`:

- **`bot.mjs`** — supplies input the generic bot can't invent (typed text).
  See `playtest/samples/fishbowl/bot.mjs`.
- **`invariants.mjs`** — game-specific properties checked after every turn and
  at game end ("exactly one bomb holder", "dice never come back", "60 cards are
  always somewhere"). **Every sample ships one** — copy the closest game's.
  `summit`'s card-conservation check is the pattern worth stealing for anything
  with a deck; `streak`'s is the one for scores and per-player status.

  Assert only what is true at EVERY sample point: the hook runs once per turn
  and arbitrary game time can pass in between (several rounds, several taps), so
  "gained at most one point since last time" is a false positive waiting to
  happen. Monotonicity, bounds, conservation and cross-field consistency are the
  shapes that hold.

The playtest also reports intents that were **never sent** across a batch —
treat that as an untested code path, not noise: either the bots can't reach it
(declare `options`) or the feature is dead.

## The shared screen (Apple TV, an iPad, the Studio panel)

A screen is an auxiliary DISPLAY, not a player. It is handed the host's public
broadcasts and never a private `sendTo`, so a game's hands stay on the phones by
routing rather than by the author remembering. Declare it in `manifest.json`:

```json
"screen": "none" | "optional" | "required"
```

`optional` or `required` means the bundle ships a `screen.js` beside `game.js`:

```js
function createScreen(Table, screen) {
  var view = null;
  Table.onMessage(function (_from, msg) { if (msg.t === 'state') view = msg.s; });
  screen.onDraw(function (ctx, env) { /* env: width, height, safe, t, dt */ });
}
```

**There is no DOM here, and no HTML.** tvOS has no WebKit at all — not a
restricted one, none — so a screen cannot be a web page. `ctx` is a RECORDER
with exactly the canvas-2d vocabulary in `FRScreen.PROPS`/`METHODS`; anything
outside it throws on your laptop rather than drawing nothing on a TV. The
recorded frame is replayed onto a real `<canvas>` in the Studio and on an iPad,
and onto a SwiftUI Canvas on an Apple TV.

Helpers worth knowing: `FRScreen.box(env)` for a safe-area-aware layout box with
`u(fraction)`/`rows`/`cols`/`portrait`, `FRScreen.fitFont(text, maxWidth, max)`,
`FRScreen.motion()` for `follow`/`pulse`/`burst`/`particles`, and
`FRScreen.ease`. `ctx.measureText` is a consistent ESTIMATE, not a measurement —
deliberately wrong by the same amount on every renderer. Position with
`textAlign`/`textBaseline`, not arithmetic on it.

```sh
node harness/screen.mjs <key> --verbose      # one bundle, six screen shapes
node harness/screen.mjs --all --games 20     # harder soak
```

It plays a real game (using the bundle's `bot.mjs`), drives the screen at TV
1080p/4K/720p and iPad landscape/portrait/mini, and fails on: a throw, a blank
frame, anything **clipped by the edge or under a TV's overscan**, two different
labels **drawn on top of each other**, fewer than two game phases reached, and
any string the host sent privately being drawn — it probes that last one by
handing the screen private payloads the shell never would.

A host putting a secret INTO a broadcast is not a screen bug (it is already on
every phone); assert that in the game's `invariants.mjs`, as `fishbowl` does.

## When the harness and a game disagree

The harness is deliberately dumb about rendering (regex-level DOM). If a healthy
game looks broken headlessly, fix the GAME's declarations (`options`, `when`,
`hidden`) before touching the shim, and only list a bundle in
`harness/known-gaps.json` as a last resort — that file is currently empty and
should stay that way.
