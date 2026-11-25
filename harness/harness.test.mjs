#!/usr/bin/env node
/*
 * harness.test.mjs — the dev kit's tests of its own tooling.
 *
 *     node harness/harness.test.mjs
 *
 * The gate is only as good as the tools inside it, and each of these was once wrong in
 * a way that reported GREEN: a validator fooled by a `//` inside a string, a version
 * check blind to manifest edits, a mutant "caught" because the bundle no longer booted,
 * a runner that unpaused the whole table while a second phone was still away, a pause
 * mode that never paused a short game. Each test here builds the smallest bundle (or
 * git history) that shows the hole, and fails if it opens again.
 *
 * Nothing here touches playtest/samples: every bundle is written to a temp directory.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceViews, validateBundle } from '../validate.mjs';
import { checkBumps } from './bumps.mjs';
import { mutate } from './mutants.mjs';
import { runGame } from './runner.mjs';
import { playtest } from './playtest.mjs';
import { engineOrder } from './phone.mjs';
import { checkScreen } from './screen.mjs';

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); }
}
function section(name) { results.push(`\n${name}`); }

const temps = [];
function tempDir(tag) { const d = mkdtempSync(join(tmpdir(), `fr-selftest-${tag}-`)); temps.push(d); return d; }

/* ------------------------------------------------------- a minimal bundle --- */

/**
 * TAP: every player taps; the host counts to GOAL and ends the game. Small enough to
 * read at a glance, and it passes every playtest mode — so whatever a test changes
 * about it is the only thing that can make a check fail.
 *
 *   goal      taps to finish
 *   tickMs    the host publishes a tick counter this often (FR.timers), 0 for none
 *   buzz      clients buzz (Table.haptic) on every state they are handed
 *   lateSeed  the host throws once Table.seed is above this
 *   noPauseBy the host throws at this game time (ms) if no pause has happened yet
 *   deal      the host deals every other player a private card at the start
 *   pausedTaps the host counts taps it handled while the table was paused (state.pt)
 *   endTwice  the host calls endGame twice, the second time naming someone else
 *   probe     clients answer every state with a 'seen'; the host counts any message
 *            that reaches it while it is still inside its own broadcast (state.re),
 *            and any own tap handled before its click handler's next line (state.sync)
 */
function tapGame({ goal = 60, tickMs = 0, buzz = false, lateSeed = 0, noPauseBy = 0, deal = false, pausedTaps = false, endTwice = false, probe = false } = {}) {
  return `
function createGame(Table, root) {
  var GOAL = ${goal};
  var G = null, table = null, sawPause = false, ms = 0, inBroadcast = false;
  Table.onPause(function () { sawPause = true; });
  function wire() {
    var b = root.querySelector('[data-act="tap"]');
    if (b) b.onclick = function () {
      var before = G ? G.n : null;
      Table.send({ t: 'tap' });
      if (G && G.n !== before) G.sync++;
    };
  }
  function render(s) {
    root.innerHTML = !s ? '<p>Waiting</p>'
      : s.phase === 'play' ? '<p>Taps ' + s.n + ' ticks ' + s.ticks + '</p><button data-act="tap">Tap</button>'
      : '<p>Done</p>';
    wire();
  }
  function publish() { var s = { phase: G.phase, n: G.n, ticks: G.ticks${pausedTaps ? ', pt: G.pt' : ''}${probe ? ', re: G.re, sync: G.sync' : ''} };
    inBroadcast = true; Table.broadcast({ t: 'state', s: s }); inBroadcast = false; render(s); }
  if (Table.isHost) {
    Table.onStart(function (players) {
      ${lateSeed ? `if (Table.seed > ${lateSeed}) throw new Error('late seed');` : ''}
      G = { phase: 'play', n: 0, ticks: 0, pt: 0, re: 0, sync: 0, by: {} };
      players.forEach(function (p) { G.by[p.id] = 0; });
      table = FR.host({ state: G, players: players.map(function (p) { return p.id; }), hostId: Table.me.id,
        phase: function () { return G.phase; }, publish: publish,
        intents: { tap: { phase: 'play', run: function (ctx) {
          G.n++; G.by[ctx.from]++; if (Table.isPaused) G.pt++;
          if (G.n >= GOAL) { G.phase = 'over'; table.stop(); Table.endGame(FR.standings.byScore(G.by));
            ${endTwice ? "Table.endGame({ winnerId: 'p1', standings: [] });" : ''} }
        } } } });
      ${deal ? `players.forEach(function (p) { if (p.id !== Table.me.id) Table.sendTo(p.id, { t: 'card', card: 'secret-' + p.id }); });` : ''}
      ${tickMs ? `table.timers.every('tick', ${tickMs}, function () {
        G.ticks++; ms += ${tickMs};
        ${noPauseBy ? `if (ms >= ${noPauseBy} && !sawPause) throw new Error('never paused');` : ''}
        publish();
      });` : ''}
      publish();
    });
    Table.onMessage(function (from, msg) { if (inBroadcast) G.re++; if (table && msg.t !== 'seen') table.handle(from, msg); });
  } else {
    Table.onStart(function () { render(null); });
    Table.onMessage(function (from, msg) {
      if (msg.t === 'state') { ${buzz ? "Table.haptic('light');" : ''} render(msg.s); ${probe ? "Table.send({ t: 'seen' });" : ''} }
    });
  }
}`;
}

/** Write a bundle into `<root>/<key>/` and return its directory. */
function writeBundle(root, key, gameSrc, manifest = {}) {
  const dir = join(root, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id: 'test.' + key, version: '1.0.0', name: key.toUpperCase(), entry: 'index.html',
    minPlayers: 2, maxPlayers: 4, description: 'self-test', iconEmoji: '🧪', ...manifest }, null, 2));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head>'
    + '<meta name="viewport" content="width=device-width,viewport-fit=cover">'
    + '<style>body{padding-bottom:env(safe-area-inset-bottom)}</style></head>'
    + '<body><div id="app"></div><script src="game.js"></script>'
    + "<script>createGame(window.Table, document.getElementById('app'));</script></body></html>");
  writeFileSync(join(dir, 'game.js'), gameSrc);
  return dir;
}

/* ------------------------------------------------------------- validate --- */
section('validate.mjs — what counts as code');

const code = (s) => sourceViews(s).codeOnly;
const hasDateNow = (s) => /\bDate\s*\.\s*now\s*\(/.test(code(s));

await test('a // inside a string does not hide a Date.now() later on the line', () => {
  assert.equal(hasDateNow("var u = 'http://x'; var t = Date.now();"), true);
});
await test("a '/*' inside a string does not swallow the lines after it", () => {
  assert.equal(hasDateNow('var s = "/*";\nvar t = Date.now();'), true);
});
await test('a // inside a regex literal does not hide a Date.now()', () => {
  assert.equal(hasDateNow('var re = /\\/\\//g; var t = Date.now();'), true);
});
await test('Date.now() inside a template expression is code', () => {
  assert.equal(hasDateNow('var s = `at ${Date.now()}`;'), true);
});
await test('a string, a template string or a comment that only MENTIONS Date.now() is not code', () => {
  assert.equal(hasDateNow('var hint = "never Date.now() here";'), false);
  assert.equal(hasDateNow('var hint = `never Date.now() here`;'), false);
  assert.equal(hasDateNow('// Date.now() would be wrong\nvar x = 1;'), false);
  assert.equal(hasDateNow('/* Date.now()\n is wrong */ var x = 1;'), false);
});
await test('division is not mistaken for a regex', () => {
  assert.equal(hasDateNow('var x = a / b; var t = Date.now() / 2;'), true);
});
await test('line numbers survive the blanking', () => {
  const src = '// one\nvar s = "two // not a comment";\n/* three\nfour */\nvar t = Date.now();\n';
  const at = code(src).search(/Date\.now/);
  assert.equal(src.slice(0, at).split('\n').length, 5);
});
await test('--strict errors on a real Date.now() and on connection code, not on comments about them', () => {
  const root = tempDir('validate');
  const dirty = writeBundle(root, 'dirty', "var u = 'http://x'; var t = Date.now();\nTable.onPlayerLeave(function(){});\nTable.send({ t: 'hello' });\n");
  const errs = validateBundle(dirty, { strict: true }).errors.join('\n');
  assert.match(errs, /game\.js:1 uses Date\.now/);
  assert.match(errs, /game\.js:2 registers Table\.onPlayerLeave/);
  assert.match(errs, /game\.js:3 sends a 'hello'/);
  const clean = writeBundle(root, 'clean', "// No Table.onPlayerLeave( here, and no Date.now().\nvar tip = 'Date.now() is banned';\n");
  assert.deepEqual(validateBundle(clean, { strict: true }).errors, []);
});

/* ---------------------------------------------------------------- bumps --- */
section('bumps.mjs — a manifest edit is a change');

await test('changing manifest.json without bumping its version is caught', () => {
  const repo = tempDir('bumps');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  const dir = join(repo, 'playtest/samples/x');
  mkdirSync(dir, { recursive: true });
  const manifest = { id: 'test.x', version: '1.0.0', name: 'X', entry: 'index.html', maxPlayers: 6 };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'game.js'), '// x\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, maxPlayers: 8 }, null, 2));
  let out = checkBumps({ repo, base: 'main' });
  assert.equal(out.problems.length, 1, 'maxPlayers 6 → 8 with no bump must be a problem');
  assert.deepEqual(out.problems[0].files, ['manifest.json']);
  // Bumped: fine. Reordered keys only: not a change at all.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, maxPlayers: 8, version: '1.0.1' }, null, 2));
  out = checkBumps({ repo, base: 'main' });
  assert.equal(out.problems.length, 0);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(reordered, null, 2));
  out = checkBumps({ repo, base: 'main' });
  assert.equal(out.problems.length, 0, 'key order is not a change');
});

/* -------------------------------------------------------------- mutants --- */
section('mutants.mjs — only a real catch counts');

await test('a mutant that stops the bundle booting is INVALID, not caught', async () => {
  const root = tempDir('mutants');
  const dir = writeBundle(root, 'tap', tapGame());
  writeFileSync(join(dir, 'mutants.mjs'), `export default [
    { name: 'syntax error', file: 'game.js', find: 'var GOAL = 60;', replace: 'var GOAL = ;', checks: ['playtest'] },
    { name: 'gone stale',   file: 'game.js', find: 'no such code',   replace: 'x', checks: ['playtest'] },
    { name: 'a typo check', file: 'game.js', find: 'var GOAL = 60;', replace: 'var GOAL = 61;', checks: ['playtst'] }
  ];`);
  const res = Object.fromEntries((await mutate('tap', { games: 4, samples: root })).map(r => [r.name, r.status]));
  assert.equal(res['syntax error'], 'invalid');
  assert.equal(res['gone stale'], 'stale');
  assert.equal(res['a typo check'], 'invalid');
});

await test('the baseline runs as many games as the mutant asks for', async () => {
  const root = tempDir('mutants');
  // The UNMUTATED bundle fails from seed 6 on. A do-nothing mutant asking for 8 games
  // must be reported against an 8-game baseline — never "caught" by seeds 6..8.
  const dir = writeBundle(root, 'late', tapGame({ lateSeed: 5 }));
  writeFileSync(join(dir, 'mutants.mjs'), `export default [
    { name: 'does nothing', file: 'game.js', find: 'var GOAL = 60;', replace: 'var GOAL = 60; ', checks: ['playtest'], games: 8 }
  ];`);
  const [r] = await mutate('late', { games: 4, samples: root });
  assert.equal(r.status, 'baseline', `got ${r.status}: ${r.why}`);
});

/* --------------------------------------------------------------- runner --- */
section('runner.mjs — the shell, modelled exactly');

await test('the table stays paused until EVERY absent phone is back', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'tick', tapGame({ goal: 999, tickMs: 1000 }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  const ticks = () => t.view('p1').s.ticks;
  t.advance(3000);
  const before = t.view('p0') === null ? ticks() : ticks();
  t.disconnect('p1'); t.disconnect('p2');
  t.advance(5000);
  t.reconnect('p1');                 // p2 is still away: HostSession keeps waitingFor = [p2]
  t.advance(5000);
  assert.equal(ticks(), before, 'the host ticked while the table was still waiting for p2');
  t.reconnect('p2');
  t.advance(3000);
  assert.ok(ticks() > before, 'and carries on once everyone is back');
});

await test('a reconnect does not lift a pause the table is holding for another reason', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'tick', tapGame({ goal: 999, tickMs: 1000 }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  t.advance(2000);
  t.setPaused(true);                 // the host stepped away (HostSession.stepAway)
  const before = t.view('p1').s.ticks;
  t.disconnect('p1'); t.advance(1000); t.reconnect('p1', { cold: true });
  t.advance(5000);
  assert.equal(t.view('p1').s.ticks, before, 'p1 coming back unpaused a table the host had paused');
  t.setPaused(false); t.advance(2000);
  assert.ok(t.view('p1').s.ticks > before);
});

await test('a rebuilt page replays its history with haptics and sounds muted', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'buzz', tapGame({ goal: 999, buzz: true }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  for (let i = 0; i < 4; i++) { t.send('p0', { t: 'tap' }); t.advance(250); }
  const buzzes = () => t.feedback().filter(e => e.from === 'p1').length;
  const live = buzzes();
  assert.ok(live >= 4, 'a live state buzzes');
  t.disconnect('p1'); t.advance(1000); t.reconnect('p1', { cold: true });
  assert.equal(buzzes(), live, 'TableBridge mutes a replayed message (window.__frReplaying); the runner must too');
  t.send('p0', { t: 'tap' });
  assert.equal(buzzes(), live + 1, 'and a live message after the rebuild buzzes again');
});

await test('a tap held while a phone was away reaches the host after the table unpauses', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'held', tapGame({ goal: 999, pausedTaps: true }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  t.disconnect('p1');
  t.press('p1', t.clickable('p1').find(h => h.onclick));   // a thumb on the frozen page
  assert.equal(t.view('p2').s.n, 0, 'nothing reaches the host while the link is down');
  t.reconnect('p1');
  assert.equal(t.view('p2').s.n, 1, 'the held tap is applied, once');
  assert.equal(t.view('p2').s.pt, 0, 'HostSession unpauses in resume(); the resend arrives a round trip later');
});

await test('a second endGame replaces the result, as HostSession.endGame does', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'twice', tapGame({ goal: 1, endTwice: true }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  t.send('p0', { t: 'tap' });
  assert.equal(t.wire('endGame').length, 2);
  assert.equal(t.result.winnerId, 'p1', 'the room sees the last result, not the first');
});

await test("a teams game gets the shell's teams: t0/t1, Red Team/Blue Team, dealt round-robin", async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'teams', tapGame(), { teams: 'required' });
  const t = await runGame({ game: dir, players: 4, seed: 1 });
  assert.deepEqual(t.teams.map(x => [x.id, x.name]), [['t0', 'Red Team'], ['t1', 'Blue Team']]);
  assert.deepEqual(t.roster.map(p => p.teamId), ['t0', 't1', 't0', 't1']);
});

await test('delivery is asynchronous: nothing re-enters a page from inside its own call', async () => {
  const root = tempDir('runner');
  const dir = writeBundle(root, 'probe', tapGame({ goal: 999, probe: true }));
  const t = await runGame({ game: dir, players: 3, seed: 1 });
  for (let i = 0; i < 3; i++) {
    t.press('p0', t.clickable('p0').find(h => h.onclick));   // the host taps its own button
    t.press('p1', t.clickable('p1').find(h => h.onclick));
    t.advance(250);
  }
  const s = t.view('p1').s;
  assert.equal(s.n, 6, 'every tap still lands, once');
  assert.equal(s.re, 0, `a client's reply reached the host inside its own broadcast() ${s.re} time(s)`);
  assert.equal(s.sync, 0, `the host's own tap was handled before its click handler's next line ${s.sync} time(s)`);
});

/* ------------------------------------------------------------- playtest --- */
section('playtest.mjs — a mode that never ran is not a pass');

await test('a batch whose pause runs never paused fails', async () => {
  const root = tempDir('playtest');
  // Ends on the first turn: no pause can land in it.
  const dir = writeBundle(root, 'blink', tapGame({ goal: 1 }));
  const out = await playtest(dir, { games: 8, seed: 1 });
  assert.ok(out.failures.some(f => /pause/.test(f.why) && /never/.test(f.why)),
    `expected a "never paused" failure, got: ${out.failures.map(f => f.why).join(' | ') || 'none'}`);
});

await test('a pause twin that fails is a failure, not a skipped comparison', async () => {
  const root = tempDir('playtest');
  // Fine when paused; throws at 20s of game time in a game that never was — so the
  // unpaused twin, and only the twin, fails.
  const dir = writeBundle(root, 'twin', tapGame({ goal: 400, tickMs: 250, noPauseBy: 20000 }));
  const out = await playtest(dir, { games: 1, seed: 1, pause: true, hostile: false, ui: false, reconnect: false, toggleScreen: false });
  assert.ok(out.failures.length > 0, 'the twin threw and the batch still passed');
});

/* --------------------------------------------------------------- screen --- */
section('screen.mjs — the non-interference probe has no blind spot');

await test('a screen that only draws once it has seen a private payload fails', async () => {
  const root = tempDir('screen');
  const dir = writeBundle(root, 'peek', tapGame({ goal: 12, deal: true }), { screen: 'optional' });
  // Draws the public state, and nothing private — but throws until it has been handed
  // something private. The copy fed only public state is the TV a room would see.
  writeFileSync(join(dir, 'screen.js'), `
function createScreen(Table, screen) {
  var s = null, saw = false;
  Table.onMessage(function (from, msg) { if (msg.t === 'state') s = msg.s; else saw = true; });
  screen.onDraw(function (ctx, env) {
    if (!saw) throw new Error('nothing to draw yet');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, env.width, env.height);
    ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif';
    ctx.fillText(s ? 'Taps ' + s.n : 'Waiting', env.width / 2 - 80, env.height / 2);
  });
}`);
  const out = await checkScreen(dir, { games: 2 });
  assert.ok(out.failures.some(f => /threw when it had seen only the public state/.test(f.why)),
    `got: ${out.failures.map(f => f.why).join(' | ') || 'no failures'}`);
});

await test("a screen is started with the roster, as ScreenBridge's Table.onStart does", async () => {
  const root = tempDir('screen');
  const dir = writeBundle(root, 'roll', tapGame({ goal: 12 }), { screen: 'optional' });
  // Sets itself up in onStart from the roster; draws nothing it was not told.
  writeFileSync(join(dir, 'screen.js'), `
function createScreen(Table, screen) {
  var names = null, s = null;
  Table.onStart(function (players) { names = players.map(function (p) { return p.name; }); });
  Table.onMessage(function (from, msg) { if (msg.t === 'state') s = msg.s; });
  screen.onDraw(function (ctx, env) {
    if (!names) throw new Error('never started');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, env.width, env.height);
    ctx.fillStyle = '#fff'; ctx.font = '40px sans-serif';
    ctx.fillText(names.length + ' players · ' + (s ? s.n : 0), env.width / 2 - 120, env.height / 2);
  });
}`);
  const out = await checkScreen(dir, { games: 2 });
  assert.deepEqual(out.failures.map(f => f.why), []);
});

/* ---------------------------------------------------------------- phone --- */
section('phone.mjs — WebKit or nothing');

await test('the layout check never falls back to another engine on its own', () => {
  assert.deepEqual(engineOrder({}), ['webkit']);
  assert.deepEqual(engineOrder({ FR_BROWSER: 'chromium' }), ['chromium'], 'an explicit choice is honoured');
});

/* ------------------------------------------------------------------------- */
for (const d of temps) rmSync(d, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
