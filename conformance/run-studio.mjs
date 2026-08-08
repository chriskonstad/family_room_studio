#!/usr/bin/env node
/*
 * Runs the Table conformance suite against the shared SDK, under node.
 *
 *   node tools/conformance/run-studio.mjs
 *
 * This used to reach the studio's `Table` by REGEX-SCRAPING a template literal out of
 * playtest/index.html, substituting the `${…}` placeholders by hand, and evaluating the
 * result — because the studio and the iOS shell each had their own copy of the SDK and
 * there was no third place to get one from. Restructuring the studio's HTML broke it.
 *
 * There is one implementation now (tools/sdk/table-sdk.js), so this just imports it. The
 * iOS unit test loads the same file into a real WKWebView, which means both harnesses are
 * held to this spec against the same source.
 *
 * Exit code is 0 when every check passes, 1 when the SDK doesn't conform, 2 when the
 * harness itself couldn't run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const read = (rel) => {
  try { return readFileSync(join(repo, rel), 'utf8'); }
  catch (e) { console.error(`✗ Missing ${rel} — ${e.message}`); process.exit(2); }
};

const tableSDK = read('tools/sdk/table-sdk.js');
const feel     = read('tools/sdk/fr-feel.js');
const frGame   = read('tools/sdk/fr-game.js');
const suite    = read('tools/conformance/table-conformance.js');

/* A window-ish sandbox. Nothing here may throw: a game that calls into the SDK on a
 * harness with no transport behind it should degrade to a no-op, not crash. */
const calls = [];
const sandbox = {
  console, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Map, Set, Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }),
  querySelector: () => null,
  head: { appendChild() {} },
  documentElement: { appendChild() {} }
};

vm.createContext(sandbox);
vm.runInContext(tableSDK, sandbox);

// Build a Table exactly the way a harness does: install the timer shim, then create with
// a transport. Ours just records, which is enough to prove the surface and the host-only
// guards without a network.
const saved = new Map();
sandbox.__io = new Proxy({
  saveState: (v) => { calls.push(['saveState', v]); saved.set('me', v); }
}, {
  get: (t, prop) => (prop in t ? t[prop] : (...args) => { calls.push([String(prop), ...args]); })
});
sandbox.__cfg = {
  me: { id: 'p0', name: 'Ava', emoji: '🦊' },
  players: [{ id: 'p0', name: 'Ava', emoji: '🦊' }, { id: 'p9', name: 'Ben', emoji: '🐙' }],
  teams: [],
  isHost: true,
  saved: null
};

vm.runInContext(`
  var clock = __frTable.installTimerShim(window);
  window.__tableSetPaused = clock.setPaused;
  __cfg.clock = clock;
  window.Table = __frTable.create(__cfg, __io, window);
`, sandbox);

// Both runtimes the harnesses inject, so this run sees what a real game sees.
vm.runInContext(feel, sandbox);
vm.runInContext('__frFeel.install(window.Table, document)', sandbox);
vm.runInContext(frGame, sandbox);

vm.runInContext(suite, sandbox);
const report = vm.runInContext('__tableConformance.run(window.Table)', sandbox);

for (const r of report.results) {
  if (!r.ok) console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}

// The library is injected alongside the SDK on both harnesses; if it went missing, games
// would lose FR.deck/seats/host with no other warning.
const frOK = vm.runInContext('!!(window.FR && FR.version && FR.rng && FR.seats && FR.host)', sandbox);
if (!frOK) console.log('  ✗ FR game-structure library missing or incomplete');

const label = `${report.pass}/${report.total} checks passed`;
if (report.fail === 0 && frOK) {
  console.log(`✓ Shared Table SDK conforms — ${label}, FR present`);
  process.exit(0);
}
console.log(`\n✗ Shared Table SDK does NOT conform — ${label}, ${report.fail} failing`);
process.exit(1);
