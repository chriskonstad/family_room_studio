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
own tests (including a fuzz soak), bundle validation, and a headless bot playtest
of every sample. All four must be green.

## Layout

| Path | What |
|---|---|
| `sdk/table-sdk.js` | The ONE `Table` implementation, shared verbatim with the iOS shell. Changing it changes every game on every device. |
| `sdk/fr-game.js` | `FR` — seeded RNG, decks, seats, standings, timers, and the `FR.host` intent reducer. `sdk/fr-game.test.mjs` is its suite. |
| `sdk/fr-feel.js` | Animations / haptics / sound. |
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
  at game end ("exactly one bomb holder", "dice never increase"). See
  `playtest/samples/passbomb/invariants.mjs`.

The playtest also reports intents that were **never sent** across a batch —
treat that as an untested code path, not noise: either the bots can't reach it
(declare `options`) or the feature is dead.

## When the harness and a game disagree

The harness is deliberately dumb about rendering (regex-level DOM). If a healthy
game looks broken headlessly, fix the GAME's declarations (`options`, `when`,
`hidden`) before touching the shim, and only list a bundle in
`harness/known-gaps.json` as a last resort — that file is currently empty and
should stay that way.
