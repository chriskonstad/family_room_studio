---
name: game-dev
description: Develop, test, and ship a Family Room game bundle (Table SDK JS games). Use when creating a new game, editing an existing game (STREAK/SUMMIT/FISHBOWL/MELTDOWN/TAPAS/TEMPO/BLITZ), or reviewing game UX. Covers the canonical file layout, sync-to-app step, versioning, UX standards, studio + simulator testing, and the TestFlight ship checklist.
---

# Family Room game development

## Where game code lives (two copies — keep them in sync)

1. **Canonical source**: `tools/playtest/samples/<key>/` → `manifest.json`, `index.html`, `game.js`.
   (`tools/` is its OWN git repo, pushed to github.com/chriskonstad/family_room_studio.)
2. **App-embedded copy**: `GameEngine/GameEngine/<key>-manifest.json`, `<key>-index.html`,
   `<key>-game.js` (flat names — synchronized Xcode groups flatten folders).

**Always edit the canonical sample first, then sync:**
```sh
for f in manifest:manifest.json index:index.html game:game.js; do :; done  # (conceptually)
cp tools/playtest/samples/<key>/manifest.json GameEngine/GameEngine/<key>-manifest.json
cp tools/playtest/samples/<key>/index.html    GameEngine/GameEngine/<key>-index.html
cp tools/playtest/samples/<key>/game.js       GameEngine/GameEngine/<key>-game.js
```
New built-in game? Also add `<key>` to `GameLibrary.embeddedGameKeys` and its id to
`embeddedGameIDs`, and register it in `tools/playtest/samples/index.json`.

## Versioning (matters — the library replaces by version)

- **Bump `manifest.json` version on ANY change** (semver-ish). The app upgrades an
  installed older version to the embedded newer one at launch and never downgrades a
  user-imported newer version. Same id@version must be byte-identical everywhere.
- **Don't touch `CURRENT_PROJECT_VERSION` for releases.** Xcode Cloud assigns build
  numbers itself and overrides the project value (its counter is set clear of the builds
  1-9 that were uploaded by hand before CI existed).

## Authoring rules (full reference: tools/GAME-AUTHORING.md)

- One bundle, branch on `Table.isHost`; host is authoritative and validates every intent.
- Clients send intents, render host broadcasts; `hello` resync on client start.
- Private info via `Table.sendTo` (hands). End with `Table.endGame({winnerId,title,standings})`
  (standings entries take `playerId` OR `teamId`). Restart is the shell's job.
- Teams: manifest `"teams": "required"`; read `Table.teams` / `me.teamId`; never build a team picker.
- Solo games: set `"minPlayers": 1` (the shell allows solo start).
- **Disconnect/pause is the shell's job, not yours.** When anyone drops, the shell
  pauses every device (input-blocking overlay) and *freezes all JS timers* —
  `setTimeout`/`setInterval` are shimmed in the injected SDK, so fuses and round
  clocks stop and resume where they left off with zero game code. Optional hooks:
  `Table.onPause(cb)` / `Table.onResume(cb)` / `Table.isPaused` (only for cosmetics).
  Never measure elapsed time with bare `Date.now()` deltas across a frame you don't
  control — a paused game must not "catch up" on resume.
- **Reconnect state is also handled**: the host shell caches your last `broadcast`
  and last per-player `sendTo`, and replays them to a player who rejoins, so they
  land mid-game instead of a blank board. Still handle `hello` with a full state
  publish if you can — it's cheap and makes the resync instant.
- Offline only. No runtime `fetch()` of bundle files (breaks in studio) — inline data.

## Game feel: use the shared runtime, don't hand-roll

The harness injects `tools/sdk/fr-feel.js` next to the Table SDK, so every game already has
a shared animation vocabulary and semantic feedback. **Reach for `Table.feel()` before
writing CSS keyframes or calling haptic/sound directly.**

```js
Table.feel('bust', { el: row, mine: true });   // shake + error haptic + boom together
Table.feel('turn', { el: myRow });             // persistent glow; {off:true} clears it
Table.feel.deal(root.querySelectorAll('.card'));
```
Events: `gain win heal` · `bust eliminate hit freeze blocked` · `arrive pass reveal tick
countdown` · `turn urgent`. Classes if you need them bare: `fr-pop fr-shake fr-flash-good
fr-flash-bad fr-flash-cool fr-glow fr-blink fr-deal`. Base reset, safe-area padding,
rounded font and tabular numerals come with it — don't re-declare them.

**`mine: true` for the local player**, default for everyone else: your own disaster should
hit harder, and six phones buzzing at full strength is worse than silence.

**Call `feel()` AFTER writing the DOM, with the live element.** It animates a real node
rather than a class in your HTML string — that is what stops animations replaying on every
render, and it removes most of the `seen*`/`prev*` bookkeeping older games needed.

Use the raw primitives when the feedback isn't a game event: `haptic('medium')` to confirm
the local player's own tap before the host replies, `sound('count')` for a metronome or
per-second countdown. Full table in GAME-AUTHORING.md §"Feedback".

**Audio/haptics rule:** use `Table.sound()`/`Table.haptic()`/`feel()` — they need no
user-gesture unlock and play through the ring/silent switch. `navigator.vibrate` does not
exist on iOS. Reach for WebAudio ONLY for sample-accurate scheduling (a metronome), and if
you do, create AND resume the `AudioContext` inside a tap handler — never from `onStart`, a
broadcast or a timer, or iOS leaves it suspended and your game ships silent (TEMPO did).
Don't layer a shell cue on top of your own audio for the same event; use `{silent:true}`.

## Game structure: build on `FR` (tools/sdk/fr-game.js)

Injected by both harnesses — no import, no bundling. Reference: `tools/FR-GAME.md`.

- `FR.rng(seed)` — **never call `Math.random()`**; a game must be replayable from its seed.
- `FR.deck(cards, r)` — draw/discard/auto-reshuffle, `deck.left` for the on-screen counter.
- `FR.seats(ids)` — turn order; `setStatus` is temporary (cleared by `startRound`),
  `eliminate` is permanent and its order becomes the ranking.
- `FR.standings.byScore` / `.byElimination` — the exact `Table.endGame` payload.
- `FR.timers()` — named; `cancelAll()` when the game ends.
- `FR.host({...})` — refuses unknown / frozen / unseated / wrong-phase / out-of-turn intents.
  Use `table.hold(ms, fn)` and `table.sequence(ms, steps)` for timed sequences: they freeze
  input, which is what stops the Flip-3 class of bug.

## UX standards (learned from the review passes)

- **Touch targets ≥ 44pt** (Apple HIG). Buttons: padding ≥ 12-13px vertical. Cards that are
  tap targets: ≥ 44pt on a side.
- **Viewport meta + safe areas** on every index.html:
  `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover`
  and `env(safe-area-inset-*)` padding.
- **State colors**: danger/bust = red tint + border; frozen/locked = blue; banked/inactive =
  dimmed grey; active turn = gold border (+ subtle glow animation).
- **Explain WHY in the banner** ("💥 Ava drew a second 7 — BUST!"), not just what.
- **Animations fire once per event, never per render.** Full re-renders replay CSS
  animations — guard with bookkeeping (prev counts / sequence numbers / signatures), e.g.
  STREAK `seenChips`, SUMMIT `prevHandLen`+`playSeq`, TAPAS `lastHandSig`.
- **Don't rebuild DOM under the user's fingers or keyboard.** If a broadcast can arrive
  while the user types or mid-animation, patch text nodes in place (FISHBOWL entry counter,
  TEMPO score strip) instead of re-rendering.
- Standard animation vocabulary: `pop` (new card/chip), `shake` (bad event), color `flash`
  (freeze/damage), `glow` pulse (whose turn), banner emphasis for big moments.

## Test

- **Studio (fast, primary)**: `cd tools && python3 -m http.server 8777` →
  `http://localhost:8777/playtest/` (serve the dev-kit ROOT — from inside `playtest/` the
  studio can't reach `sdk/fr-feel.js` and games silently lose `Table.feel`), pick the
  sample, add players (team chips appear for team games),
  play across the phones; watch the wire log; use Drop/Reconnect; verify endGame + Play Again.
- **Native (spot-check)**: build & install on two booted sims (see project memory for UDIDs),
  drive with `axe` (`--id` for native UI; coordinate taps for webview content — points = px/3).
  DEBUG builds reinstall embedded bundles each launch, so a rebuilt app picks up game edits.
- Run unit tests: `xcodebuild ... test -only-testing:GameEngineTests`.

## Ship checklist

1. Sample edited + manifest version bumped. No sync step — the app folder-references
   the submodule, so a rebuild picks it up (but commit tools/ AND bump the pointer).
2. Studio-verified; native spot-check if shell code changed.
3. Commit app repo AND tools repo; `git push` tools (GitHub).
4. Bump the app build number, archive/export a distribution build, and upload to
   TestFlight (see the app repo's tooling; signing keys are machine-specific).
