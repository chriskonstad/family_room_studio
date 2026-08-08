#!/usr/bin/env node
/*
 * playtest.mjs — play a real game bundle with bots, headless, and check it holds up.
 *
 *   node tools/harness/playtest.mjs streak
 *   node tools/harness/playtest.mjs streak --games 200 --players 4
 *   node tools/harness/playtest.mjs ./path/to/bundle --seed 42 --verbose
 *   node tools/harness/playtest.mjs --all
 *
 * This is the thing that replaces "open the studio and tap around" for an agent. It boots
 * the bundle on N virtual phones, has bots press whatever buttons are actually on screen,
 * advances a virtual clock so a 60-second game takes microseconds, and asserts the
 * properties that must hold no matter what anyone taps:
 *
 *   never throws            a game that crashes is broken however pretty it is
 *   always terminates       the commonest real failure — a game that gets stuck with
 *                           nobody able to move, which a human playtest finds only by
 *                           sitting there confused for a minute
 *   ends once               endGame is final; firing twice means two winners
 *   winner is a real player not a stale or departed id
 *   no leaked timers        a finished game must stop ticking
 *   host and clients agree  every phone was told the same thing
 *
 * A bot only ever presses buttons the game rendered for it, so it explores the same space
 * a player can. Illegal-input fuzzing is a separate mode (--hostile), which fires intents
 * nobody's UI offered — out of turn, in the wrong phase, from a player who left.
 *
 * Every run is seeded and prints the seed, so a failure reproduces exactly:
 *   node tools/harness/playtest.mjs streak --seed 137 --verbose
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runGame, REPO } from './runner.mjs';
import { discoverIntents, candidateValues, buildMessage } from './intents.mjs';

/* A tiny seeded RNG, same algorithm as FR.rng, so bot choices replay. */
function rng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (a) => (a.length ? a[r.int(a.length)] : undefined);
  return r;
}

const HOSTILE_INTENTS = ['flip', 'bank', 'next', 'target', 'tap', 'go', 'ready', 'skip', '', 'nonsense'];

/**
 * Play one game to completion (or until it stalls).
 * @returns {{ok:boolean, why?:string, turns:number, result:object}}
 */
export async function playOne(game, { seed = 1, players = 3, hostile = false, maxTurns = 4000, verbose = false, bot = null } = {}) {
  const r = rng(seed);
  let table;
  try {
    table = await runGame({ game, players, seed });
  } catch (e) {
    return { ok: false, why: `boot failed: ${e.message}`, turns: 0 };
  }

  const ids = table.players;
  // What this bundle can actually be sent, read out of its own source. Without this a bot
  // can only press `data-act` buttons, which drives STREAK and stalls everything else.
  const vocabulary = discoverIntents(table.source);
  let turns = 0, idleStreak = 0;

  while (!table.over && turns < maxTurns) {
    turns++;
    let acted = false;

    for (const id of ids) {
      // A bundle can ship its own bot when the generic one can't drive it — text entry,
      // or a selection step whose options aren't distinguishable from decoration. It gets
      // the same handles a player would touch, and returns true if it acted.
      if (bot) {
        let took = false;
        try { took = !!bot({ table, playerId: id, rng: r, send: (m) => table.send(id, m) }); }
        catch (e) { return { ok: false, why: `bot threw for ${id}: ${e.message}`, turns }; }
        if (took) { acted = true; continue; }
      }

      // Best case: the game is built on FR.host and can simply TELL us what's legal.
      // No DOM, no guessing, and every move offered is one the host will accept — which
      // is what makes a game with two-step selection or typed input fuzzable at all.
      const legal = table.legalMoves(id);
      if (legal && legal.length) {
        try { table.send(id, r.pick(legal)); } catch (e) {
          return { ok: false, why: `threw on a declared-legal move from ${id}: ${e.message}`, turns };
        }
        acted = true;
        continue;
      }
      if (legal) continue;      // FR.host game with nothing legal for this player yet

      // First choice: CLICK something the game rendered and wired up itself. That runs
      // the game's own handler, so selection state (pick a card, then play it) and any
      // client-side validation happen exactly as they would under a thumb.
      const live = table.clickable(id).filter(h => h.onclick);
      if (live.length && r() < 0.85) {
        try { r.pick(live).click(); } catch (e) {
          return { ok: false, why: `threw on a click from ${id}: ${e.message}`, turns };
        }
        acted = true;
        continue;
      }

      const acts = table.actions(id);
      let msg = null;
      if (acts.length) {
        const choice = r.pick(acts);
        // The DOM says WHICH action is available; the discovered vocabulary says what
        // FIELDS it carries. SUMMIT's button is data-act="play" but the intent is
        // {t:'play', card:…} — sending the bare verb is rejected forever, which looked
        // like the game hanging.
        const spec = vocabulary.find(v => v.fixed.t === choice.act || v.fixed.type === choice.act);
        msg = spec
          ? buildMessage(spec, candidateValues(table.handles(id), ids), r.pick)
          : { t: choice.act };
        if (choice.id) msg.id = choice.id;
      } else if (vocabulary.length) {
        // Nothing labelled on screen — fall back to the discovered vocabulary, filling
        // dynamic fields from the data-* values currently rendered for this player.
        const intent = r.pick(vocabulary);
        if (intent.fixed.t === 'hello' || intent.fixed.type === 'hello') continue;
        msg = buildMessage(intent, candidateValues(table.handles(id), ids), r.pick);
      }
      if (!msg) continue;
      try { table.send(id, msg); } catch (e) {
        return { ok: false, why: `threw on intent ${JSON.stringify(msg)} from ${id}: ${e.message}`, turns };
      }
      acted = true;
    }

    // Hostile mode: fire things no UI offered, from anyone, including a ghost.
    if (hostile) {
      const from = r.pick(ids.concat(['ghost-id']));
      const wild = r() < 0.5 && vocabulary.length
        ? buildMessage(r.pick(vocabulary), candidateValues(table.handles(r.pick(ids)), ids), r.pick)
        : { t: r.pick(HOSTILE_INTENTS) };
      try { table.send(from, wild); } catch (e) {
        return { ok: false, why: `threw on hostile intent ${JSON.stringify(wild)} from ${from}: ${e.message}`, turns };
      }
    }

    // Let timers run. Games that are waiting on a fuse or a hold need this to progress,
    // and it is also how we detect a genuine stall: nothing to press AND nothing pending.
    let fired;
    try { fired = table.advance(acted ? 250 : 2000); } catch (e) {
      return { ok: false, why: `threw in a timer: ${e.message}`, turns };
    }

    if (!acted && !fired) {
      if (++idleStreak > 5) {
        return { ok: false, why: 'stalled — no player has an action and no timer is pending', turns };
      }
    } else idleStreak = 0;
  }

  if (!table.over) return { ok: false, why: `did not finish in ${maxTurns} turns`, turns };

  const result = table.result;
  const errors = table.wire('error');
  if (errors.length) {
    return { ok: false, why: `game reported an error: ${errors[0].message}`, turns, result };
  }
  if (table.wire('endGame').length !== 1) {
    return { ok: false, why: `endGame fired ${table.wire('endGame').length} times`, turns, result };
  }
  if (result.winnerId && !ids.includes(result.winnerId)) {
    return { ok: false, why: `winner "${result.winnerId}" is not a player`, turns, result };
  }
  if (Array.isArray(result.standings)) {
    for (const row of result.standings) {
      if (row.playerId && !ids.includes(row.playerId)) {
        return { ok: false, why: `standings name "${row.playerId}", who is not a player`, turns, result };
      }
    }
  }
  // A finished game must stop ticking. Give it a long beat first — endGame legitimately
  // schedules a little settling work — then require silence.
  table.advance(10000);
  const before = table.clock.armed;
  table.advance(60000);
  if (table.clock.armed > 0 && before > 0) {
    return { ok: false, why: `left ${table.clock.armed} timers running after the game ended`, turns, result };
  }
  if (verbose) console.log(`    seed ${seed}: ${turns} turns, winner ${result.winnerId}`);
  return { ok: true, turns, result };
}

/** Play many seeded games of one bundle. */
export async function playtest(game, opts = {}) {
  // An optional `bot.mjs` beside the bundle, for games whose input isn't a button:
  //   export default function ({ table, playerId, rng, send }) { … return didSomething; }
  // Returning false hands control back to the generic bot, so a bundle only has to teach
  // the harness the one thing it can't infer.
  let bot = null;
  const botPath = join(REPO, 'tools/playtest/samples', game, 'bot.mjs');
  if (existsSync(botPath)) bot = (await import(pathToFileURL(botPath).href)).default;
  opts = { ...opts, bot };

  const games = opts.games || 40;
  const players = opts.players || 3;
  const first = opts.seed || 1;
  const failures = [];
  let totalTurns = 0;

  for (let i = 0; i < games; i++) {
    const seed = first + i;
    // Alternate: half honest play, half with hostile input mixed in.
    const res = await playOne(game, { ...opts, seed, players, hostile: i % 2 === 1 });
    totalTurns += res.turns;
    if (!res.ok) {
      failures.push({ seed, why: res.why, hostile: i % 2 === 1 });
      if (failures.length >= 5) break;       // five is plenty to diagnose
    }
  }
  return { games, players, totalTurns, failures };
}

/* ------------------------------------------------------------------ cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i === -1 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
  };
  const targets = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);

  const samplesDir = join(REPO, 'tools/playtest/samples');
  let list = targets.filter(t => !/^\d+$/.test(t));
  if (flag('all', false) || !list.length) {
    list = readdirSync(samplesDir).filter(d => existsSync(join(samplesDir, d, 'game.js')));
  }

  const opts = {
    games: Number(flag('games', 40)),
    players: Number(flag('players', 3)),
    seed: Number(flag('seed', 1)),
    verbose: !!flag('verbose', false)
  };

  const gapsPath = join(REPO, 'tools/harness/known-gaps.json');
  const gaps = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, 'utf8')) : {};

  let bad = 0, skipped = 0;
  for (const game of list) {
    // A known harness gap is reported loudly but doesn't fail the run: these bundles play
    // fine in the studio and on device, and treating them as failures would make --all
    // useless as a gate. Anything NOT listed here is expected to pass.
    if (gaps[game] && !targets.includes(game)) {
      console.log(`  ~ ${game.padEnd(12)} skipped — ${gaps[game]}`);
      skipped++;
      continue;
    }
    const label = game.padEnd(12);
    const t0 = Date.now();
    let out;
    try { out = await playtest(game, opts); }
    catch (e) { console.log(`  ✗ ${label} harness error: ${e.message}`); bad++; continue; }
    const ms = Date.now() - t0;
    if (!out.failures.length) {
      console.log(`  ✓ ${label} ${out.games} games, ${out.totalTurns} turns, ${ms}ms`);
    } else {
      bad++;
      console.log(`  ✗ ${label} ${out.failures.length} failing:`);
      for (const f of out.failures) {
        console.log(`      seed ${f.seed}${f.hostile ? ' (hostile)' : ''}: ${f.why}`);
        console.log(`        reproduce: node tools/harness/playtest.mjs ${game} --games 1 --seed ${f.seed} --players ${opts.players} --verbose`);
      }
    }
  }
  const ran = list.length - skipped;
  console.log(bad
    ? `\n${bad} bundle(s) failing${skipped ? `, ${skipped} skipped (known harness gaps)` : ''}`
    : `\nAll ${ran} playable bundle(s) pass${skipped ? `; ${skipped} skipped (known harness gaps)` : ''}`);
  process.exit(bad ? 1 : 0);
}
