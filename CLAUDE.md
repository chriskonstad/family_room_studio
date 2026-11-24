# CLAUDE.md — working in the Family Room game dev kit

This repo is the **standalone dev kit** for Family Room, a local, serverless,
peer-to-peer party-game shell for phones. A game is a bundle of HTML + JS written
against one injected global, `Table`. The native shell (Swift) lives in the main
Family Room app repo, which vendors this repo as its `tools/` submodule — nothing
here needs Xcode, a simulator, or a Mac.

## Definition of done

```sh
npm ci && npx playwright-core install webkit   # once: the phone layout check needs WebKit
node check.mjs                                  # before every commit; CI runs exactly this
node check.mjs --quick                          # while iterating (skips phones + mutants)
```

A game change is done when `node check.mjs` is green. Everything below is ENFORCED
by it — you do not have to remember these, but you do have to satisfy them:

| Rule | Enforced by |
|---|---|
| Bump `manifest.json` version on any change to what ships | `harness/bumps.mjs` (vs. the base branch) |
| No `Table.onPlayerLeave` / `onPlayerJoin` / `hello` resync in a game | `validate.mjs --strict` |
| Never throws · always finishes · `endGame` once · no timers left armed | `harness/playtest.mjs` |
| Same seed replays move for move; a pause changes nothing but timing | playtest (determinism + pause twin) |
| A refused intent changes nothing | playtest `--hostile` |
| Every control the phone offers sends something the host accepts; whenever the rules allow a move, the screen offers one | playtest `--ui` + every-turn control check |
| A reconnect is invisible (warm) or rebuilds the same screen (cold) | playtest `--reconnect` |
| No phone shows what was sent privately to someone else | playtest (client leak watch) + the game's `invariants.mjs` |
| Every phone screen fits at six device sizes: nothing clipped, overlapping, under the home bar, smaller than 44pt to tap, or **needing a scroll** | `harness/phone.mjs` (real WebKit) |
| The TV/iPad screen fits, reads, and never draws anything private | `harness/screen.mjs` (non-interference probe) |
| The suite still catches the bugs it claims to | `harness/mutants.mjs` |

What check.mjs CANNOT tell you — so a human still should: whether the game is fun,
whether the pacing feels right, and whether it reads at a glance across a room.
`node harness/phone.mjs <game> --shots out/` writes a screenshot of every phase at
every device size (and every problem, outlined) to `out/<game>.html` — flip through it.

## Connections are the shell's job — games never see them

The shell gives a game a connection like TCP gives a program a pipe: every message,
in order, exactly once. A phone that drops — backgrounded to answer a text, the app
suspended, wifi blinking, iOS killing the app — **pauses the whole table** (every
device's timers freeze; the overlay names who and why) and, when it comes back, is
caught up: just what it missed if its page survived, or a fresh page rebuilt from
the **whole history** of the game if it didn't. Its own taps sent into a dying
socket are resent and applied once. There is no "leaving" mid-game: the host can
end the game for everyone, and that is all.

So a game has **no departure to handle and nothing to resync**: no
`onPlayerLeave`, no `onPlayerJoin`, no `hello` handshake. A game that reacts to
connectivity is doing the shell's job, and that code is where nearly every real bug
the harness ever found lived. (The app's side is `GameEngine/Shared/TableLink.swift`,
proven by `TableLinkTests` including a randomized network that fails at random.)

The one thing a rebuilt page can lose is state that never crossed the wire — what
the phone worked out for itself (a selected card, a local timer). Put anything the
player must see after a rebuild into what the host sends (CAPTAIN publishes WHETHER
each sailor has tapped; TEMPO streams its track position with its score).

## Layout

| Path | What |
|---|---|
| `sdk/table-sdk.js` | The ONE `Table` implementation, shared verbatim with the iOS shell. Changing it changes every game on every device. |
| `sdk/fr-game.js` | `FR` — seeded RNG, decks, seats, standings, timers, and the `FR.host` intent reducer. `sdk/fr-game.test.mjs` is its suite. |
| `sdk/fr-feel.js` | Animations / haptics / sound. |
| `sdk/fr-screen.js` | `FRScreen` — the SHARED SCREEN drawing vocabulary (see below). |
| `harness/runner.mjs` | Boots N virtual phones on a virtual clock and models the shell exactly — including the connection layer (warm/cold reconnects with full history). |
| `harness/playtest.mjs` | Plays bundles to completion under bots in every mode and asserts the rules above. |
| `harness/phone.mjs` | Rebuilds each phone, event for event, in real WebKit and measures its layout. |
| `harness/screen.mjs` | Plays a game and draws its shared screen at six TV/iPad shapes. |
| `harness/mutants.mjs` | Puts known bugs back on purpose and requires the suite to catch each. |
| `harness/bumps.mjs` | Version bumps, vs. the base branch. |
| `playtest/` | The browser Playtest Studio, plus `samples/<key>/` — the game bundles. |
| `validate.mjs` | Static bundle checks (manifest schema, offline-only, authoring lints). |
| `conformance/` | The spec both harnesses are held to. |

## Rules for writing or changing a game

1. **Bump `manifest.json` version on ANY change** (enforced). The app replaces
   bundles by version; an unbumped change never reaches phones that already have it.
2. **All randomness through `FR.rng(Table.seed)`.** Never `Math.random()`.
3. **Host logic never reads `Date.now()` for elapsed time.** Drive time from
   `FR.timers`; a pause freezes those and must change nothing but timing.
4. **Build the host on `FR.host` and declare `options` for every intent that
   carries arguments** (or `hidden: true` for free text, with a `bot.mjs`). Guards
   go in `when(ctx)` — it is checked against each concrete option, so `ctx.msg` is
   always there and legalMoves never offers a move `handle` would refuse. A guard
   inside `run` that silently ignores a bad intent is a dead button no check can see.
5. **Name your timers (`FR.timers`) and `cancelAll()` when the game ends.**
6. **Don't handle connections** (enforced): see above.
7. **Nothing on a phone scrolls** (enforced). Design for an iPhone SE (375×603 for
   the game) with the biggest table the manifest allows and the longest names. Dense
   layouts at high player counts (STREAK, TAPAS, LIAR'S DICE), fanned hands (SUMMIT)
   and "+N earlier" folds (SCRAMBLE) are the patterns.
8. Games are plain ES5-ish scripts injected into WKWebView — no imports, no fetch,
   no external hosts.

## Testing a game

```sh
node harness/playtest.mjs <key>                       # fuzz one bundle, all modes
node harness/playtest.mjs <key> --games 200           # harder soak
node harness/playtest.mjs <key> --seed N --players P [--hostile|--pause|--ui|--reconnect|--screens N|--toggle-screen] --verbose
node harness/phone.mjs <key> [--shape se,i17] [--shots out/]
node harness/mutants.mjs <key> [--verbose]
```

A failure prints a **reproduce command — run it verbatim**; it pins the seed,
player count and every mode.

Batches rotate table sizes (2–8, clamped to the manifest) and modes: hostile input
(intents no UI offered, ghost senders); a 44s pause (replayed without the pause —
the game must say exactly the same things); one player driven entirely through
their phone's real controls; a reconnect right after a player acts — warm (must be
invisible: compared with the same game where the table only paused), cold-replace
(the rebuilt page plays on, and what it SENDS is real) or cold-shadow (rebuilt
beside a phone that never dropped; the screens must agree); and, for
`"screen": "optional"` games, with and without a TV and with one switched on or off
mid-game.

Per-bundle hooks, dropped beside `game.js`:

- **`invariants.mjs`** — game-specific properties checked after every turn and at
  game end. Every sample ships one. Assert what is true at EVERY sample point —
  conservation, monotonicity, bounds, cross-field consistency — and recompute what
  you can from public state (HOLD'EM re-derives every pot from the revealed cards;
  STREAK re-scores every line). Read the wire (`table.wire('broadcast')`) to check
  every state, not only the latest. `export const reconnectIgnore = [/…/]` names
  text a game knowingly recomputes after a rebuild (TEMPO's local HUD).
- **`*.test.mjs`** — worked examples a property can't judge, discovered and run by
  check.mjs: `rules.test.mjs` (HOLD'EM's evaluator), `hands.test.mjs` (whole hands
  with a stacked deck via the runner's `beforeGame` hook), `rounds.test.mjs`
  (STREAK). Resolve the runner via `process.env.FR_REPO` and run against the
  test's own directory, so a mutated copy tests the copy.
- **`bot.mjs`** — supplies input the generic bot can't invent (typed text), or
  plays a game the way a person does (TEMPO plays its track instead of skipping it).
- **`phone-states.mjs`** — phone screens a played game rarely reaches (eighteen
  words found, a hand all in one route, eight seats at a showdown), drawn under the
  same layout rules: `[{ name, as: 'p1', players, messages: [payload, …] }]`.
- **`mutants.mjs`** — `[{ name, file, find, replace, checks?, games? }]`: real bug
  classes put back on purpose; the suite must catch every one. When you fix a bug,
  add its mutant. A survivor is a hole in the tests.

The playtest also reports intents never legal / never sent across a batch,
measured against FR.host's own intent table — an untested path, not noise.

## The shared screen (Apple TV, an iPad, the Studio panel)

A screen is an auxiliary DISPLAY, not a player. It is handed the host's public
broadcasts and never a private `sendTo`. Declare it in `manifest.json`:

```json
"screen": "none" | "optional" | "required"
```

`required`: the shell won't start without a display (SCRAMBLE scores its round on
the TV). `optional`: the game works either way — **only the host knows whether a
screen is attached** (`Table.screens`: a number on the host, `null` elsewhere or on
an old shell; treat `null` as "no TV"), so the host publishes it in its state and
the phones lay themselves out from that. `Table.onScreensChange(cb)` fires on the
host when a TV comes or goes; republish. HOLD'EM is the example: with a TV the
phone is your hand; without one every phone is the whole table.

`screen.js` defines `createScreen(Table, screen)` and draws through a RECORDER with
exactly the canvas-2d vocabulary in `FRScreen.PROPS`/`METHODS` — tvOS has no WebKit.
Helpers: `FRScreen.box(env)`, `FRScreen.fitFont`, `FRScreen.motion()`
(`follow`/`pulse`/`burst`/`particles`/`once`), `FRScreen.ease`. Fire a celebration
with `motion().once(key)`, never `pulse`; bound confetti with `{bounds}`.

`screen.mjs` fails on a throw, a blank frame, anything clipped or under a TV's
overscan, two labels drawn over each other, fewer than two phases reached — and any
private payload changing the picture. That last one is a non-interference probe: a
second copy of the screen sees only public state, the probed copy is ALSO handed
every private payload (as sent, and with every string swapped for a sentinel), and
the two must draw identical frames. Matching strings alone missed HOLD'EM's hole
cards, which are numbers. `screen-states.mjs` adds frames a played game won't reach.

## When the harness and a game disagree

The harness models the shell; when they differ, the harness is wrong and gets
fixed (the runner once delivered a client's first messages before its `onStart`,
which is why every game grew a `hello`). The DOM shim in `runner.mjs` is regex-level
and only has to be good enough for bots and text; real layout is `phone.mjs`'s job.
Fix the GAME's declarations (`options`, `when`, `hidden`) before teaching the shim
new tricks. `harness/known-gaps.json` is empty and should stay that way.
