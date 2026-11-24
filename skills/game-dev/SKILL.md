---
name: game-dev
description: Create, edit, test, validate, review and ship a Family Room game bundle (JS games on the Table SDK). Use when writing a new game, changing or fixing an existing one (STREAK, SUMMIT, FISHBOWL, MELTDOWN, TAPAS, TEMPO, BLITZ, Pass the Bomb, The Detonator, Captain Says, Look Away, Liar's Dice, HOLD'EM, SCRAMBLE), reviewing a game's UX or phone layout, checking a game is ready for game night, or packaging a bundle as a .zip. Covers the FR library, the connection guarantees games may rely on, the headless harness, phone layout checks, mutation tests, and the validator.
---

# Family Room game development

You do not need a Mac, Xcode, or the app's source to write, test, validate and ship a
game. Games are pure web; everything here runs on node (plus a headless WebKit for
phone layouts). The dev kit's own `tools/CLAUDE.md` is the full reference — this is
the workflow.

## The workflow — follow it in order

1. **Read the closest existing game first** (`tools/playtest/samples/<key>/`). Copy its
   shape: `manifest.json`, `index.html`, `game.js`, `invariants.mjs`, and a
   `mutants.mjs`. HOLD'EM is the most complete example; BLITZ the smallest.
2. **Write the game on `FR.host`** (`tools/FR-GAME.md`). Declare every intent's
   `options`; put every guard in `when(ctx)` (it sees each concrete option as
   `ctx.msg`). Seed from `FR.rng(Table.seed)`. Time from `FR.timers`.
3. **Do not write any connection code.** No `onPlayerLeave`, no `onPlayerJoin`, no
   `hello`. The shell pauses the table when anyone drops and catches them up when they
   return — every message, in order, exactly once. The validator rejects it.
4. **Lay the phone out for an iPhone SE at the biggest table** with long names.
   Nothing scrolls. Every tap target ≥ 44pt. Content clear of the home indicator.
5. **Write `invariants.mjs`** — what is true at every moment (conservation, bounds,
   scores re-derived from public state, secrets that must not reach a phone).
6. **Write worked examples** for any rule a property can't judge (`*.test.mjs` with a
   stacked deck — see `holdem/hands.test.mjs`, `streak/rounds.test.mjs`).
7. **Add `mutants.mjs`** — your game's bugs put back on purpose. Every bug you fix
   gets one. They must all be caught.
8. **Bump `manifest.json` version.**
9. **`node tools/check.mjs`** until green. Fix the game, not the harness — unless the
   harness disagrees with the shell, in which case the harness is wrong.
10. **Look at it**: `node tools/harness/phone.mjs <key> --shots /tmp/shots` and open
    `/tmp/shots/<key>.html` — every phase at every device size, problems outlined.
    That review is the one step no check replaces.

## Definition of done (all enforced by `node tools/check.mjs`)

- version bumped · validates strict (no connection code, offline only)
- plays to a finish under bots: hostile input, pauses, warm and cold reconnects,
  real button presses, TV on/off — never throws, ends once, leaks no timers, replays
  exactly, a pause changes nothing but timing, a refused intent changes nothing
- every control sends something the host accepts; every legal move has a control
- no phone ever shows another player's private data
- every phone screen fits at six sizes — nothing clipped, overlapping, under the home
  bar, under 44pt, or scrolling (WebKit, `phone.mjs`)
- the shared screen (if any) fits, reads and draws nothing private (`screen.mjs`)
- the game's own tests pass and every mutant is caught (`mutants.mjs`)

Setup once: `cd tools && npm ci && npx playwright-core install webkit`.
While iterating: `node tools/check.mjs --quick` (skips phones and mutants).

## Commands

```sh
node tools/check.mjs                                        # the gate
node tools/harness/playtest.mjs <key> --games 200           # soak one game
node tools/harness/playtest.mjs <key> --seed 137 --players 4 --reconnect --verbose   # replay a failure (copy the printed command)
node tools/harness/phone.mjs <key> --shape se --shots /tmp/shots
node tools/harness/mutants.mjs <key> --verbose
node tools/validate.mjs ./mygame                            # or mygame.zip
```

## Two ways a game reaches players

1. **A .zip anyone can import.** `node tools/validate.mjs mygame.zip`, send the file.
2. **Built in to the app.** Live in `tools/playtest/samples/<key>/` — the app derives
   its built-in games from that folder; nothing else to register. Shipping is two
   commits: one in `tools/` (the public dev kit), one bumping the pointer in the app.

## Authoring rules worth knowing by heart

- One bundle runs on every device; branch on `Table.isHost`. The host is authoritative.
  Private info via `Table.sendTo`. End with `Table.endGame({winnerId, title, standings})`.
- Teams: manifest `"teams":"required"`, read `Table.teams`. Solo: `"minPlayers": 1`.
- A shared screen (`"screen": "optional" | "required"`) gets broadcasts only. Only the
  host knows if one is attached (`Table.screens`; `null` = assume none) — publish it.
- State a rebuilt page must show has to come from the host: a page rebuilt from the
  history loses only what the phone worked out for itself.
- Offline only: no `fetch()`, no external hosts, no CDNs.

## Game feel — `Table.feel()`

```js
Table.feel('bust', { el: row, mine: true });   // shake + haptic + sound together
Table.feel('turn', { el: myRow });             // persistent glow; {off:true} clears
Table.feel.deal(root.querySelectorAll('.card'));
```
Events: `gain win heal` · `bust eliminate hit freeze blocked` · `arrive pass reveal
tick countdown` · `turn urgent`. `mine: true` for the local player. Call it AFTER
writing the DOM, once per event, never per render.

## UX standards

- Touch targets ≥ 44pt; nothing scrolls; clear of the home indicator (all enforced).
- Viewport `width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no,
  viewport-fit=cover` plus `env(safe-area-inset-*)` padding (validated).
- State colours: danger red, frozen/locked blue, banked/inactive dim, active turn gold.
- Say WHY in the banner ("💥 Ava drew a second 7 — BUST!"), not just what.
- Don't rebuild DOM under a thumb or an open keyboard — patch text in place.
- Hide or disable a control that can't be used right now (a pressed control the host
  refuses fails the check).
