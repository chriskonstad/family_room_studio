#!/usr/bin/env node
/*
 * check.mjs — everything, in one command.
 *
 *   node check.mjs
 *
 * This is what an agent runs before it commits, and what CI runs on a push. It needs
 * nothing but node: no browser, no simulator, no Mac. If this is green, the only thing
 * left that a Mac could tell you is how it FEELS — haptics, real WebKit rendering, and
 * whether the round takes too long.
 *
 *   1. conformance   the shared Table SDK still matches the spec both harnesses are held to
 *   2. fr-game       the game-structure library's own suite, including its fuzz soak
 *   2b. fr-screen    the shared-screen drawing vocabulary both renderers honour
 *   3. validate      every bundle would import cleanly into the app
 *   4. playtest      every bundle actually plays to a finish under bot pressure
 *   5. screens       every shared screen draws, at three shapes, and leaks nothing
 *
 * Exit code 0 clean, 1 something failed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(fileURLToPath(import.meta.url));

/* A bundle may ship `rules.test.mjs` beside its `rules.js`: a table of known
 * answers for rules the fuzzer cannot judge. HOLDEM is the case that forced it —
 * every outcome of a hand conserves chips perfectly, so "did the right hand win"
 * is invisible to a property check and needs worked examples instead. Discovered,
 * not listed, so the next game that needs one is covered by writing the file. */
const samples = join(REPO, 'playtest/samples');
const ruleSuites = readdirSync(samples)
  .filter(d => existsSync(join(samples, d, 'rules.test.mjs')))
  .sort()
  .map(d => [`${d} rules`, `playtest/samples/${d}/rules.test.mjs`, []]);

const steps = [
  ['Table SDK conformance', 'conformance/run-studio.mjs', []],
  ['fr-game library',       'sdk/fr-game.test.mjs',       []],
  ['fr-screen library',     'sdk/fr-screen.test.mjs',     []],
  ['bundle validation',     'validate.mjs',               ['--all']],
  ['headless playtest',     'harness/playtest.mjs',       ['--all', '--games', '10']],
  ['shared screens',        'harness/screen.mjs',         ['--all', '--games', '4']],
  ...ruleSuites
];

let failed = 0;
for (const [label, script, args] of steps) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}\n`);
  const run = spawnSync(process.execPath, [join(REPO, script), ...args],
                        { cwd: REPO, stdio: 'inherit' });
  if (run.status !== 0) failed++;
}

console.log(failed
  ? `\n✗ ${failed} of ${steps.length} checks failed`
  : `\n✓ all ${steps.length} checks passed`);
process.exit(failed ? 1 : 0);
