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
 *   fits                  nothing clipped or under the overscan, at six shapes
 *   reads                 no two labels drawn on top of each other
 *   NEVER LEAKS           no string the host sent privately is ever drawn
 *
 * The leak check is the reason this file exists, and it is run with a deliberate
 * PROBE rather than a hope: the screen is handed the host's private payloads too,
 * even though the shell never does that, and must still not draw a word of them.
 * A correct screen ignores every message type but its own public `state`; one
 * that stashes whatever it is given fails here instead of in a living room.
 *
 * The probe is delivered twice: once as the host actually sent it, and once with
 * every string swapped for a sentinel. Hunting for the real strings alone was a
 * check a game could pass by accident — SCRAMBLE draws its board in capitals, so
 * a screen that rendered a player's private word list drew "CATS" while the wire
 * said "cats", and the leak check shrugged. The sentinel has no case, no spelling
 * and no innocent explanation: if it reaches the glass, the screen rendered
 * something it was only handed.
 *
 * A string the host ALSO broadcasts is public by definition and is not treated as
 * a secret — a route colour is in both SUMMIT's private hand and its public board.
 * The other leak, a host that puts a secret INTO a broadcast, is not a screen bug
 * at all (it is already on every phone) and is caught by the per-game invariants:
 * see `fishbowl/invariants.mjs`.
 *
 * THE FRAMES A REAL RUN CANNOT REACH
 *
 * Playing a bundle for 160 ticks reaches its ordinary phases and not its last
 * one. HOLDEM's tournament takes longer than that to finish, so its game-over
 * frame — the one with the confetti on it — was never drawn here, which is the
 * precise frame fr-screen warns about: a celebration is the one thing that
 * reliably breaks the layout contract, and it only happens at the moment of
 * winning. A bundle may therefore ship `screen-states.mjs`:
 *
 *   export default [{ name: 'game over', payload: { t:'state', s: {...} } }];
 *
 * Each is delivered and drawn for a stretch of frames at every shape, held to
 * exactly the same layout rules. Hand-written state is a poor substitute for a
 * played game and a fine way to reach a frame a played game won't.
 *
 * No browser: the screen draws into the fr-screen recorder, so a frame is a value
 * and nothing needs rasterising to be checked.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { runGame, REPO } from './runner.mjs';
import FRScreenLib from '../sdk/fr-screen.js';

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

/* A string no game could draw on purpose. Lowercase, so a case-insensitive
 * comparison catches it however the screen chose to render it. */
const SENTINEL = 'zqxjvleak';
let markN = 0;

/**
 * The same payload with every string value replaced by a sentinel.
 *
 * `t` is left alone: it is the message TYPE, the thing a screen branches on, and
 * scrambling it would mean the probe never reached the code being tested.
 */
function marked(value, key) {
  if (typeof value === 'string') return key === 't' ? value : SENTINEL + (markN++).toString(36);
  if (Array.isArray(value)) return value.map(v => marked(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = marked(value[k], k);
    return out;
  }
  return value;
}

/** Every string anywhere in a payload — what a leak would look like. */
function strings(value, out = []) {
  if (typeof value === 'string') { if (value.length > 2) out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(v => strings(v, out)); return out; }
  if (value && typeof value === 'object') { Object.values(value).forEach(v => strings(v, out)); return out; }
  return out;
}

/** Boot a bundle's screen.js in its own context, with a Table that only listens.
 *
 *  Its Math.random is seeded and its clock is the frame clock, so two screens fed
 *  the same things draw the same frames, op for op. That is what lets the leak probe
 *  below compare a screen that was handed secrets with one that wasn't. */
function bootScreen(dir) {
  const frScreen = readFileSync(join(REPO, 'sdk/fr-screen.js'), 'utf8');
  const src = readFileSync(join(dir, 'screen.js'), 'utf8');

  const seeded = rng(0x5C4EE7);
  const SMath = Object.create(Math);
  SMath.random = () => seeded();
  let frameT = 0;
  const RealDate = Date;
  function SDate(...args) { return args.length ? new RealDate(...args) : new RealDate(1755000000000 + frameT); }
  SDate.now = () => 1755000000000 + frameT;
  SDate.prototype = RealDate.prototype;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math: SMath, Date: SDate, Object, Array, String, Number, Boolean, Error, isNaN,
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
      frameT = env.t || 0;
      ctx.reset();
      drawFn(ctx, env);
      return { ops: ctx.ops(), texts: ctx.texts() };
    }
  };
}

/* A TV and an iPad, so a screen is exercised at both shapes every run. */
const SHAPES = [
  // Overscan is 5% a side on a TV — content outside the safe rect is inside the
  // canvas and still physically off the panel in somebody's living room.
  { name: 'Apple TV 1080p', width: 1920, height: 1080, safe: { top: 54, right: 96, bottom: 54, left: 96 } },
  { name: 'Apple TV 4K',    width: 3840, height: 2160, safe: { top: 108, right: 192, bottom: 108, left: 192 } },
  { name: 'TV 720p',        width: 1280, height: 720,  safe: { top: 36, right: 64, bottom: 36, left: 64 } },
  { name: 'iPad landscape', width: 1180, height: 820,  safe: { top: 24, right: 24, bottom: 24, left: 24 } },
  { name: 'iPad portrait',  width: 820,  height: 1180, safe: { top: 24, right: 24, bottom: 24, left: 24 } },
  { name: 'iPad mini',      width: 1024, height: 768,  safe: { top: 20, right: 20, bottom: 20, left: 20 } }
];

/* How far outside the safe rect we tolerate. Full-bleed backgrounds are legitimate
 * and deliberate, so a fill that covers the WHOLE canvas is exempt; anything else
 * poking out is content the room cannot read. */
const SLOP = 0.5;
/* Text boxes are estimated, not measured (see fr-screen's measureText), so a
 * hair of overlap is noise. A real collision is much larger than this. */
const OVERLAP_SLOP = 2;

/**
 * Does this frame fit?
 *
 * The question the whole headless screen story exists to answer: is anything
 * clipped, and does everything flow inside the usable area at every shape? A
 * recorded frame has coordinates, so this is arithmetic rather than eyeballing
 * screenshots — and it runs at six screen sizes on every check.
 */
function layoutProblems(ops, shape) {
  const { items } = FRScreenLib.bounds(ops);
  const s = shape.safe || { top: 0, right: 0, bottom: 0, left: 0 };
  const safe = { x: s.left, y: s.top, r: shape.width - s.right, b: shape.height - s.bottom };
  const problems = [];

  const covers = (it) => it.x <= SLOP && it.y <= SLOP
    && it.x + it.w >= shape.width - SLOP && it.y + it.h >= shape.height - SLOP;

  // THE CURTAIN. A results panel or a round-over card is drawn as a near-opaque
  // fill over the whole screen and then its own text on top. Everything painted
  // before that fill is behind it, so complaining that a card value sits under
  // the headline is complaining about something nobody can see. Find the last
  // full-screen fill solid enough to hide what it covers, and judge only what
  // comes after it.
  let curtain = -1;
  for (const it of items) {
    if (it.alpha >= 0.75 && (it.op === 'fill' || it.op === 'fillRect') && covers(it)) curtain = it.i;
  }

  const visible = items.filter(it => it.i >= curtain && it.alpha > 0.02);

  for (const it of visible) {
    if (covers(it)) continue;                 // a deliberate full-bleed background

    const what = it.text != null ? `text "${it.text}"` : it.op;

    // Off the canvas entirely — drawn but unseeable.
    if (it.x + it.w < 0 || it.y + it.h < 0 || it.x > shape.width || it.y > shape.height) {
      problems.push(`${what} is drawn completely off-screen at (${Math.round(it.x)},${Math.round(it.y)})`);
      continue;
    }
    // Cut by the canvas edge.
    if (it.x < -SLOP || it.y < -SLOP || it.x + it.w > shape.width + SLOP || it.y + it.h > shape.height + SLOP) {
      problems.push(`${what} is clipped by the screen edge: ` +
        `${Math.round(it.x)},${Math.round(it.y)} ${Math.round(it.w)}×${Math.round(it.h)} ` +
        `exceeds ${shape.width}×${shape.height}`);
      continue;
    }
    // Inside the canvas but under the overscan — invisible on a real TV.
    if (it.x < safe.x - SLOP || it.y < safe.y - SLOP || it.x + it.w > safe.r + SLOP || it.y + it.h > safe.b + SLOP) {
      problems.push(`${what} spills outside the safe area: ` +
        `${Math.round(it.x)},${Math.round(it.y)} ${Math.round(it.w)}×${Math.round(it.h)} ` +
        `is outside ${Math.round(safe.x)},${Math.round(safe.y)}–${Math.round(safe.r)},${Math.round(safe.b)}`);
    }
  }

  // TEXT ON TEXT. Fitting inside the screen is not the same as flowing on it: a
  // header and a banner can both be comfortably inside the safe area and still
  // land on top of each other at one aspect ratio. Two different strings in the
  // same frame overlapping is always a bug — nobody draws one label through
  // another on purpose. Identical strings are left alone, since drawing the same
  // text twice is how shadows and outlines are done.
  const texts = visible.filter(it => it.text != null && String(it.text).trim() !== '');
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], c = texts[j];
      if (a.text === c.text) continue;
      const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
      const oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      if (ox <= OVERLAP_SLOP || oy <= OVERLAP_SLOP) continue;
      // Ignore a nick at the corner: real collisions share a meaningful area.
      const share = (ox * oy) / Math.min(a.w * a.h, c.w * c.h);
      if (share < 0.12) continue;
      problems.push(`text "${a.text}" and "${c.text}" overlap by ` +
        `${Math.round(ox)}×${Math.round(oy)} (${Math.round(share * 100)}% of the smaller)`);
    }
  }
  return problems;
}

export async function checkScreen(gameKey, { games = 6, seed = 1, verbose = false } = {}) {
  const dir = gameKey.includes('/') ? gameKey : join(SAMPLES, gameKey);
  if (!existsSync(join(dir, 'screen.js'))) return { skipped: 'no screen.js' };

  // Some bundles need their own bot to get past a phase the generic one can't drive
  // (FISHBOWL's phrases are typed). Without it the game sits in its first phase and
  // every frame is the same waiting screen — which looks like a pass and tests nothing.
  let bot = null;
  const botPath = join(dir, 'bot.mjs');
  if (existsSync(botPath)) bot = (await import(pathToFileURL(botPath).href)).default;

  // Frames a played game cannot reach in its budget — a finished tournament, a
  // table of eight all-in at once. See the note at the top of this file.
  let extraStates = [];
  const statesPath = join(dir, 'screen-states.mjs');
  if (existsSync(statesPath)) extraStates = (await import(pathToFileURL(statesPath).href)).default || [];

  const failures = [];
  const seenLayout = new Set();
  let frames = 0, drew = 0, phases = new Set();

  for (let g = 0; g < games; g++) {
    const s = seed + g;
    const table = await runGame({ game: dir, seed: s, screens: 1 });
    const r = rng(s);
    const screen = bootScreen(dir);
    // The control: an identical screen that only ever sees public broadcasts.
    const clean = bootScreen(dir);
    const secrets = new Set();
    const told = new Set();
    let t = 0;

    const tick = () => {
      // Everything the host has EVER said privately is off-limits on the screen —
      // MINUS everything it has also said publicly.
      //
      // That subtraction is not a loophole, it is the definition. A private
      // payload is a mix of secrets and structure: SUMMIT deals `{t:'hand',
      // hand:[{c:'reef',v:8}]}`, and "reef" is the name of a route printed on the
      // public board. Without this, the public banner "Ava played 8 on reef"
      // reads as a leak of a card nobody can see. A string the host has
      // broadcast to every player is public by construction, so it cannot be the
      // thing a screen must not show.
      for (const e of table.wire('broadcast')) strings(e.payload).forEach(x => told.add(x));
      for (const e of table.wire('sendTo')) {
        strings(e.payload).forEach(x => { if (!told.has(x)) secrets.add(x); });
      }
      for (const x of told) secrets.delete(x);   // a later broadcast declassifies it

      // THE PROBE. The shell routes nothing private to a screen, so without this
      // the leak assertion below could never fail and would be a test that passes
      // by construction. Hand the screen the private payload anyway: a screen is
      // only safe if it renders the public state and ignores everything else.
      //
      // Then hand it the same payload with every string replaced by a sentinel.
      // Matching the real strings is necessary but not sufficient: a screen that
      // uppercases, truncates or reformats what it renders would slip past it. A
      // sentinel on the glass is proof the screen drew what it was handed,
      // whatever it did to the characters on the way.
      const last = table.wire('broadcast').slice(-1)[0];
      if (last) {
        screen.deliver(last.payload);
        clean.deliver(last.payload);
        const ph = last.payload && last.payload.s && last.payload.s.phase;
        if (ph) phases.add(ph);
      }
      // AFTER the public state, not before. Delivered first, the next broadcast wiped
      // out whatever a leaky screen had stashed from it before a frame was drawn — so a
      // screen that copied a hole card into its own state passed. A real leak lives in
      // the gap between broadcasts; this puts the probe in that gap.
      const priv = table.wire('sendTo').slice(-1)[0];
      if (priv) { screen.deliver(priv.payload); screen.deliver(marked(priv.payload)); }

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

        // NON-INTERFERENCE. The probed screen and the clean one were handed the same
        // public state; the probed one ALSO got every private payload. If they draw
        // different frames, something private changed the picture — whatever its type.
        // Matching strings alone could not see this: HOLD'EM's hole cards are numbers,
        // `{r:14, s:0}`, and a screen that drew every one it was handed passed as
        // "no leaks".
        let control;
        try { control = clean.frame({ width: shape.width, height: shape.height, safe: shape.safe, t, dt: 16 }); }
        catch (e) { control = null; }
        if (control && JSON.stringify(control.ops) !== JSON.stringify(out.ops)) {
          const extra = out.texts.filter(x => !control.texts.includes(x));
          failures.push({ seed: s, why: `LEAK: on ${shape.name} the screen drew a different frame after it was `
            + `handed a private ${priv && priv.payload && priv.payload.t ? `"${priv.payload.t}" ` : ''}payload`
            + (extra.length ? ` — it drew ${extra.slice(0, 3).map(x => `"${x}"`).join(', ')}` : '')
            + `. A screen must draw the public state and nothing else` });
          return false;
        }

        // Clipping and overflow, at every shape, every frame.
        for (const problem of layoutProblems(out.ops, shape)) {
          const key = shape.name + '|' + problem;
          if (!seenLayout.has(key)) {           // one report per distinct problem, not per frame
            seenLayout.add(key);
            failures.push({ seed: s, why: `${shape.name}: ${problem}` });
          }
        }
        if (failures.length > 6) return false;

        for (const text of out.texts) {
          if (text.toLowerCase().includes(SENTINEL)) {
            failures.push({ seed: s, why: `LEAK: drew "${text}" — a payload the host sent privately` });
            return false;
          }
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

  /* The hand-written frames. Drawn over a stretch of frames rather than once,
   * because a celebration's confetti is in flight for seconds and it is the
   * flight that leaves the screen — a single frame catches none of it. Time is
   * advanced faster than real so a particle's whole life is covered. */
  if (extraStates.length && !failures.length) {
    const screen = bootScreen(dir);
    let t = 1e6;
    for (const entry of extraStates) {
      const label = entry.name || 'extra state';
      try { screen.deliver(entry.payload); }
      catch (e) { failures.push({ seed, why: `${label}: delivering it threw: ${e.message}` }); break; }
      if (entry.payload && entry.payload.s && entry.payload.s.phase) phases.add(entry.payload.s.phase);
      for (const shape of SHAPES) {
        for (let f = 0; f < 90; f++) {
          t += 33;
          let out;
          try {
            out = screen.frame({ width: shape.width, height: shape.height, safe: shape.safe, t, dt: 33 });
          } catch (e) {
            failures.push({ seed, why: `${label} threw on ${shape.name}: ${e.message}` });
            break;
          }
          frames++;
          if (out.ops.length > 0) drew++;
          else failures.push({ seed, why: `${label}: drew nothing on ${shape.name}` });
          for (const problem of layoutProblems(out.ops, shape)) {
            const key = shape.name + '|' + label + '|' + problem;
            if (!seenLayout.has(key)) {
              seenLayout.add(key);
              failures.push({ seed, why: `${shape.name}, ${label}: ${problem}` });
            }
          }
          if (failures.length > 6) break;
        }
        if (failures.length > 6) break;
      }
      if (failures.length > 6) break;
    }
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
  let list = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--games', '--seed'].includes(args[i - 1])));
  if (flag('all', false) || !list.length) {
    list = readdirSync(SAMPLES).filter(d => existsSync(join(SAMPLES, d, 'screen.js')));
  }
  if (!list.length) { console.log('  no bundles ship a screen.js yet'); process.exit(0); }

  let bad = 0;
  for (const key of list) {
    // --seed used to be printed in every reproduce command and then ignored here, so
    // "reproduce" replayed seed 1 whatever had failed.
    const out = await checkScreen(key, { games: Number(flag('games', 6)), seed: Number(flag('seed', 1)),
                                         verbose: !!flag('verbose', false) });
    if (out.skipped) { console.log(`  ~ ${key.padEnd(12)} ${out.skipped}`); continue; }
    if (out.failures.length) {
      bad++;
      console.log(`  ✗ ${key.padEnd(12)} ${out.failures.length} problem(s)`);
      for (const f of out.failures.slice(0, 4)) {
        console.log(`      seed ${f.seed}: ${f.why}`);
        console.log(`        reproduce: node harness/screen.mjs ${key} --games 1 --seed ${f.seed} --verbose`);
      }
    } else {
      console.log(`  ✓ ${key.padEnd(12)} ${out.frames} frames · ${SHAPES.length} shapes · phases: ${out.phases.join(', ')} · fits, no leaks`);
    }
  }
  console.log(bad ? `\n${bad} screen(s) failing` : `\nAll ${list.length} screen(s) pass`);
  process.exit(bad ? 1 : 0);
}
