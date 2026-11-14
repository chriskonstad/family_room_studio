#!/usr/bin/env node
/*
 * screen.mjs — play a real game and drive its shared screen, headless.
 *
 *   node harness/screen.mjs fishbowl
 *   node harness/screen.mjs --all --games 10
 *
 * A screen is an auxiliary display: it receives the host's public broadcasts and
 * never a private `sendTo`. That boundary is the whole safety story once a TV is
 * in the room, so this asserts it rather than trusting it:
 *
 *   never throws          a screen that crashes takes the room's focal point out
 *   draws something       a blank TV is indistinguishable from a broken one
 *   NEVER LEAKS           no string the host sent privately is ever drawn
 *
 * That last one is the reason this file exists. The harness already sees every
 * `sendTo` on the wire, so it knows exactly what is secret — the giver's phrase,
 * a player's hand — and a recorded frame is a list of ops, so it knows exactly
 * what was drawn. Checking one against the other is mechanical, which turns
 * "remember not to put the hand on the TV" from a review note into a test.
 *
 * No browser: the screen draws into the fr-screen recorder, so a frame is a value
 * and nothing needs rasterising to be checked.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { runGame, REPO } from './runner.mjs';

const SAMPLES = join(REPO, 'playtest/samples');

/* Same seeded generator shape the playtest bots get, so a screen run replays too. */
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

/** Every string anywhere in a payload — what a leak would look like. */
function strings(value, out = []) {
  if (typeof value === 'string') { if (value.length > 2) out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(v => strings(v, out)); return out; }
  if (value && typeof value === 'object') { Object.values(value).forEach(v => strings(v, out)); return out; }
  return out;
}

/** Boot a bundle's screen.js in its own context, with a Table that only listens. */
function bootScreen(dir) {
  const frScreen = readFileSync(join(REPO, 'sdk/fr-screen.js'), 'utf8');
  const src = readFileSync(join(dir, 'screen.js'), 'utf8');

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Error, isNaN,
    parseInt, parseFloat, Infinity, NaN
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(frScreen, sandbox);
  vm.runInContext(src, sandbox);

  const ctx = sandbox.FRScreen.context();
  let drawFn = null;
  const handlers = {};

  const screen = {
    dt: 16,
    onDraw(fn) { drawFn = fn; }
  };
  const Table = {
    isScreen: true,
    isHost: false,
    onMessage(cb) { handlers.message = cb; },
    onStart(cb) { handlers.start = cb; },
    onPlayerJoin() {}, onPlayerLeave() {}, onPause() {}, onResume() {}
  };

  sandbox.__boot = () => sandbox.createScreen(Table, screen);
  vm.runInContext('__boot()', sandbox);
  if (!drawFn) throw new Error('screen.js never called screen.onDraw');

  return {
    deliver(payload) { if (handlers.message) handlers.message('p0', payload); },
    /** Draw one frame and hand back what it would put on a display. */
    frame(env) {
      ctx.reset();
      drawFn(ctx, env);
      return { ops: ctx.ops(), texts: ctx.texts() };
    }
  };
}

/* A TV and an iPad, so a screen is exercised at both shapes every run. */
const SHAPES = [
  { name: 'Apple TV 1080p', width: 1920, height: 1080, safe: { top: 54, right: 96, bottom: 54, left: 96 } },
  { name: 'iPad landscape', width: 1180, height: 820, safe: { top: 24, right: 24, bottom: 24, left: 24 } },
  { name: 'iPad portrait',  width: 820, height: 1180, safe: { top: 24, right: 24, bottom: 24, left: 24 } }
];

export async function checkScreen(gameKey, { games = 6, seed = 1, verbose = false } = {}) {
  const dir = join(SAMPLES, gameKey);
  if (!existsSync(join(dir, 'screen.js'))) return { skipped: 'no screen.js' };

  // Some bundles need their own bot to get past a phase the generic one can't drive
  // (FISHBOWL's phrases are typed). Without it the game sits in its first phase and
  // every frame is the same waiting screen — which looks like a pass and tests nothing.
  let bot = null;
  const botPath = join(dir, 'bot.mjs');
  if (existsSync(botPath)) bot = (await import(pathToFileURL(botPath).href)).default;

  const failures = [];
  let frames = 0, drew = 0, phases = new Set();

  for (let g = 0; g < games; g++) {
    const s = seed + g;
    const table = await runGame({ game: gameKey, seed: s });
    const r = rng(s);
    const screen = bootScreen(dir);
    const secrets = new Set();
    let t = 0;

    const tick = () => {
      // Everything the host has EVER said privately is off-limits on the screen.
      for (const e of table.wire('sendTo')) strings(e.payload).forEach(x => secrets.add(x));
      const last = table.wire('broadcast').slice(-1)[0];
      if (last) {
        screen.deliver(last.payload);
        const ph = last.payload && last.payload.s && last.payload.s.phase;
        if (ph) phases.add(ph);
      }

      for (const shape of SHAPES) {
        t += 16;
        let out;
        try {
          out = screen.frame({ width: shape.width, height: shape.height, safe: shape.safe, t, dt: 16 });
        } catch (e) {
          failures.push({ seed: s, why: `screen threw on ${shape.name}: ${e.message}` });
          return false;
        }
        frames++;
        if (out.ops.length > 0) drew++;
        else failures.push({ seed: s, why: `drew nothing on ${shape.name} — a blank screen reads as broken` });

        for (const text of out.texts) {
          for (const secret of secrets) {
            if (text.includes(secret)) {
              failures.push({ seed: s, why: `LEAK: drew "${text}" containing private "${secret}"` });
              return false;
            }
          }
        }
      }
      return true;
    };

    if (!tick()) break;
    for (let i = 0; i < 160 && !table.over; i++) {
      let acted = false;
      for (const p of table.players) {
        if (bot) {
          try { if (bot({ table, playerId: p, rng: r, send: (m) => table.send(p, m) })) { acted = true; continue; } }
          catch (e) { failures.push({ seed: s, why: `bot threw: ${e.message}` }); break; }
        }
        const legal = table.legalMoves(p);
        if (legal && legal.length) { table.send(p, legal[0]); acted = true; }
      }
      table.advance(acted ? 250 : 1500);
      if (!tick()) break;
      if (failures.length) break;
    }
    if (failures.length) break;
  }

  // A run that only ever saw one phase proves almost nothing. Say so rather than
  // reporting a confident tick over a screen that was never exercised.
  if (phases.size < 2) {
    failures.push({ seed, why: `only reached phase(s) [${[...phases]}] — the screen was never exercised` });
  }
  if (verbose) console.log(`    ${frames} frames, ${drew} with content, phases: ${[...phases].join(', ')}`);
  return { frames, drew, phases: [...phases], failures };
}

/* ------------------------------------------------------------------ cli --- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
  let list = args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a));
  if (flag('all', false) || !list.length) {
    list = readdirSync(SAMPLES).filter(d => existsSync(join(SAMPLES, d, 'screen.js')));
  }
  if (!list.length) { console.log('  no bundles ship a screen.js yet'); process.exit(0); }

  let bad = 0;
  for (const key of list) {
    const out = await checkScreen(key, { games: Number(flag('games', 6)), verbose: !!flag('verbose', false) });
    if (out.skipped) { console.log(`  ~ ${key.padEnd(12)} ${out.skipped}`); continue; }
    if (out.failures.length) {
      bad++;
      console.log(`  ✗ ${key.padEnd(12)} ${out.failures.length} problem(s)`);
      for (const f of out.failures.slice(0, 4)) {
        console.log(`      seed ${f.seed}: ${f.why}`);
        console.log(`        reproduce: node harness/screen.mjs ${key} --games 1 --seed ${f.seed} --verbose`);
      }
    } else {
      console.log(`  ✓ ${key.padEnd(12)} ${out.frames} frames · ${SHAPES.length} shapes · phases: ${out.phases.join(', ')} · no leaks`);
    }
  }
  console.log(bad ? `\n${bad} screen(s) failing` : `\nAll ${list.length} screen(s) pass`);
  process.exit(bad ? 1 : 0);
}
