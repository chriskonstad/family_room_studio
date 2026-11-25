#!/usr/bin/env node
/*
 * check.mjs — everything, in one command.
 *
 *   node check.mjs            # the gate: run before every commit; CI runs exactly this
 *   node check.mjs --quick    # while iterating: skips the phone layouts and the mutants
 *
 * Green means a game imports cleanly, plays to a finish under every kind of pressure the
 * harness knows, fits on every phone without scrolling, keeps every secret, and that the
 * suite itself still catches the bugs it claims to. The only thing left a Mac could tell
 * you is how it FEELS — haptics, and whether the round takes too long.
 *
 *   1. conformance   the shared Table SDK still matches the spec both harnesses are held to
 *   2. fr-game       the game-structure library's own suite, including its fuzz soak
 *   3. fr-screen     the shared-screen drawing vocabulary both renderers honour
 *   4. timer shim    the pausable clock: freezes on pause, stale clears kill nothing
 *   4b. tooling      the harness's own tests: the validator, version check, mutant
 *                    runner, the runner's model of the shell, playtest's modes, the
 *                    screen probe — each once wrong in a way that reported green
 *   5. validate      every bundle would import cleanly into the app
 *   6. versions      every game that changed bumped its manifest version
 *   7. playtest      every bundle plays to a finish under bots: hostile input, pauses,
 *                    warm and cold reconnects, real button presses, a TV coming and going
 *   8. screens       every shared screen draws at six shapes, fits, and leaks nothing
 *   9. phones        every phone screen, laid out by WebKit at six device sizes: nothing
 *                    clipped, overlapping, under the home bar, too small to tap, or
 *                    needing a scroll                           (needs: npm ci + webkit)
 *  10. bundle tests  each bundle's own *.test.mjs — worked examples a fuzzer can't judge
 *  11. mutants       each bundle's mutants.mjs: known bugs put back on purpose, every one
 *                    of which the suite above must catch
 *
 * Exit code 0 clean, 1 something failed.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');

/* A bundle may ship tests beside its game: `rules.test.mjs` (HOLD'EM's evaluator against
 * worked examples), `hands.test.mjs` (whole hands through the real reducer). Discovered,
 * not listed, so the next game that needs one is covered by writing the file. */
const samples = join(REPO, 'playtest/samples');
const bundleTests = readdirSync(samples).sort().flatMap(d =>
  existsSync(join(samples, d)) && existsSync(join(samples, d, 'manifest.json'))
    ? readdirSync(join(samples, d)).filter(f => f.endsWith('.test.mjs')).sort()
        .map(f => [`${d} ${f.replace('.test.mjs', '')}`, `playtest/samples/${d}/${f}`, []])
    : []);

/* Every check below walks playtest/samples with --all, and a walk over nothing passes.
 * A gate that ran no game at all must not say green. */
const bundleCount = readdirSync(samples).filter(d => existsSync(join(samples, d, 'manifest.json'))).length;
if (!bundleCount) {
  console.log(`✗ no bundles in ${samples} — every check would pass by checking nothing`);
  process.exit(1);
}

const steps = [
  ['Table SDK conformance', 'conformance/run-studio.mjs', []],
  ['fr-game library',       'sdk/fr-game.test.mjs',       []],
  ['fr-screen library',     'sdk/fr-screen.test.mjs',     []],
  ['timer shim',            'sdk/table-sdk.test.mjs',      []],
  ['tooling self-tests',    'harness/harness.test.mjs',    []],
  ['bundle validation',     'validate.mjs',               ['--all', '--strict']],
  ['version bumps',         'harness/bumps.mjs',          []],
  ['headless playtest',     'harness/playtest.mjs',       ['--all', '--games', quick ? '10' : '24']],
  ['shared screens',        'harness/screen.mjs',         ['--all', '--games', '4']],
  ...(quick ? [] : [['phone layouts', 'harness/phone.mjs', ['--all', '--max', '6']]]),
  ...bundleTests,
  ...(quick ? [] : [['mutants', 'harness/mutants.mjs', []]])
];

let failed = 0;
const t0 = Date.now();
for (const [label, script, extra] of steps) {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 46 - label.length))}\n`);
  const run = spawnSync(process.execPath, [join(REPO, script), ...extra], { cwd: REPO, stdio: 'inherit' });
  if (run.status !== 0) failed++;
}

const secs = Math.round((Date.now() - t0) / 1000);
console.log(failed
  ? `\n✗ ${failed} of ${steps.length} checks failed (${secs}s)`
  : `\n✓ all ${steps.length} checks passed (${secs}s)${quick ? ' — QUICK: phone layouts and mutants were not run' : ''}`);
process.exit(failed ? 1 : 0);
