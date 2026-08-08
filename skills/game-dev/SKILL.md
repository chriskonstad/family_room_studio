---
name: game-dev
description: Create, edit, test, validate and ship a Family Room game bundle (JS games on the Table SDK). Use when writing a new game, changing an existing one (STREAK/SUMMIT/FISHBOWL/MELTDOWN/TAPAS/TEMPO/BLITZ/Pass the Bomb/The Detonator/Captain Says/Look Away), reviewing game UX, or packaging a bundle as a .zip. Covers the FR library, the headless test harness, the validator, and the two ways a game reaches players.
---

# Family Room game development

**You do not need a Mac, Xcode, or the app's source to write, test, validate and ship a
game.** Games are pure web; the iOS harness is a separate concern. Everything in this skill
runs on plain node.

## The one command

```sh
node tools/check.mjs
```

Conformance + the FR library suite + bundle validation + a headless bot playtest of every
bundle. Green means the game imports cleanly and plays to a finish under pressure. Run it
before every commit.

## Two ways a game reaches players

1. **A .zip anyone can import.** Author anywhere, `node tools/validate.mjs mygame.zip`, send
   the file. The app imports it. This needs nothing from the iOS repo.
2. **Built in to the app.** Live in `tools/playtest/samples/<key>/`, which the Xcode project
   folder-references, so a rebuild picks the game up. Also add `<key>` to
   `GameLibrary.embeddedGameKeys` and its id to `embeddedGameIDs`, and register it in
   `tools/playtest/samples/index.json`.

Either way a bundle is `manifest.json` + `index.html` + `game.js` (+ assets). Files may sit
at the zip root or under one top-level folder.

`tools/` is a git submodule (the public dev kit, github.com/chriskonstad/family_room_studio);
the private app repo pins a commit. **There is one copy of everything** — no syncing. Shipping
a change to a built-in game is two commits:
```sh
cd tools && git commit -am "…" && git push     # the game
cd ..     && git commit -am "Bump dev kit"     # the app's pinned pointer
```

## Versioning

**Bump `manifest.json` version on ANY change.** The library replaces bundles *by version*:
the app upgrades an installed older version to a newer embedded one at launch and never
downgrades a user-imported newer one. The same `id@version` must be byte-identical on every
device — that is what makes the authoritative-host model safe.

## Authoring rules (full reference: `tools/GAME-AUTHORING.md`)

- One bundle runs on every device; branch on `Table.isHost`. The host is authoritative and
  validates every intent. Clients send intents and render broadcasts; `hello` resyncs on start.
- Private info via `Table.sendTo` (hands). End with
  `Table.endGame({winnerId, title, standings})`. Restart is the shell's job, not yours.
- Teams: manifest `"teams":"required"`, read `Table.teams` / `me.teamId`. Never build a team picker.
- Solo: `"minPlayers": 1`.
- **Disconnect and pause are the shell's job.** When anyone drops, every device pauses and
  all JS timers freeze — `setTimeout`/`setInterval` are shimmed in the injected SDK, so
  fuses and clocks stop and resume with zero game code. Never measure elapsed time with bare
  `Date.now()` deltas across a frame you don't control; a paused game must not catch up.
- **Reconnect is handled too**: the host replays its last broadcast and each player's last
  `sendTo`, so a rejoiner lands mid-game.
- Offline only. No `fetch()`, no external hosts, no CDNs — inline everything. The validator
  enforces this; otherwise it breaks *only on real phones*.

## Build on `FR` — don't rebuild game structure

`tools/sdk/fr-game.js` is injected alongside the SDK, so `FR` is simply there. Full
reference with a complete example game: **`tools/FR-GAME.md`**.

- `FR.rng(seed)` — **never call `Math.random()`.** A game that isn't replayable can't have
  its bugs reproduced or fuzzed. Seed once, store the seed in state.
- `FR.deck(cards, r)` — draw/discard/auto-reshuffle; `deck.left` for the on-screen counter.
- `FR.seats(ids)` — turn order. `setStatus` is temporary (cleared by `startRound`);
  `eliminate` is permanent and its order becomes the final ranking.
- `FR.standings.byScore` / `.byElimination` — the exact `Table.endGame` payload.
- `FR.timers()` — named; `cancelAll()` when the game ends.
- `FR.host({...})` — refuses unknown, frozen, unseated, wrong-phase and out-of-turn intents.
  **Declare `options(ctx)` on each intent** (plus `when(ctx)` for guards the built-ins can't
  express, `hidden:true` for free text). That is what lets `table.legalMoves()` enumerate the
  move space, so the harness can play and fuzz your game with no screen — it is how SUMMIT,
  TAPAS and FISHBOWL went from undriveable to fully tested.
  Use `table.hold(ms, fn)` / `table.sequence(ms, steps)` for timed sequences: they freeze
  input, which is what prevents the Flip-3 class of bug.
- **`FR.rng(Table.seed)`** — seed from the table, never `Date.now()`, or `--seed N` can't
  replay the failure the fuzzer just found.

## Game feel — use the shared runtime

`Table.feel()` fires the right animation, haptic and sound together. Reach for it before
writing keyframes.

```js
Table.feel('bust', { el: row, mine: true });   // shake + boom haptic + sound
Table.feel('turn', { el: myRow });             // persistent glow; {off:true} clears
Table.feel.deal(root.querySelectorAll('.card'));
```
Events: `gain win heal` · `bust eliminate hit freeze blocked` · `arrive pass reveal tick
countdown` · `turn urgent`.

- **`mine: true` for the local player.** Your own disaster should hit harder; six phones
  buzzing at full strength is worse than silence.
- **Call `feel()` AFTER writing the DOM, with the live element** — that's what stops
  animations replaying on every render.
- Haptic styles: `light medium heavy soft rigid selection success warning error` plus the
  sustained `thud buzz boom`. Don't fire `success`/`warning`/`error` in a tight loop — they
  are ~½s patterns and a new one cancels the last; use an impact style for anything rhythmic.
- Audio: `Table.sound()` needs no gesture unlock and plays through the ring switch. Reach for
  WebAudio only for sample-accurate scheduling, and create AND resume the `AudioContext`
  inside a tap handler or iOS leaves it suspended and your game ships silent.

## UX standards

- **Touch targets ≥ 44pt.** Buttons ≥ 12-13px vertical padding.
- **Viewport + safe areas** on every `index.html`:
  `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`
  plus `env(safe-area-inset-*)` padding. The validator checks this.
- **State colours**: danger/bust red, frozen/locked blue, banked/inactive dim, active turn gold.
- **Say WHY in the banner** ("💥 Ava drew a second 7 — BUST!"), not just what.
- **Animations fire once per event, never per render.**
- **Don't rebuild DOM under a thumb or an open keyboard** — patch text nodes in place.

## Test

```sh
node tools/check.mjs                                        # everything
node tools/harness/playtest.mjs streak --games 200          # bot-play one bundle hard
node tools/harness/playtest.mjs streak --seed 137 --verbose # reproduce a failure exactly
node tools/validate.mjs ./mygame                            # or mygame.zip
```

The harness boots N virtual phones against the real SDK with a virtual clock, so a
60-second game costs microseconds. It asserts the game never throws, always terminates,
ends once, names a real winner, and leaves no timers armed.

All eleven built-in bundles play headlessly. If yours doesn't, the fix is almost always to
declare `options` on its intents rather than to make its UI more scrapeable.

Genuinely un-enumerable input (free text, a drawn gesture) is the exception: mark that intent
`hidden` and ship a `bot.mjs` beside the bundle —
`export default function ({table, playerId, rng, send}) { … return didAct; }`. Return false to
hand back to the generic bot. FISHBOWL is the worked example.

**Studio (to see and feel it):** `cd tools && python3 -m http.server 8777`, open
`http://localhost:8777/playtest/`. Serve the dev-kit ROOT — from inside `playtest/` the
studio can't reach `sdk/` and games silently lose `Table.feel` and `FR`.

**Native** only matters for what the web can't tell you: real haptics, WebKit rendering,
and pacing on an actual phone. That needs a Mac and is a spot-check, not the loop.
