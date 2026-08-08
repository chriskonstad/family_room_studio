#!/usr/bin/env node
/*
 * check.mjs — everything, in one command.
 *
 *   node tools/check.mjs
 *
 * This is what an agent runs before it commits, and what CI runs on a push. It needs
 * nothing but node: no browser, no simulator, no Mac. If this is green, the only thing
 * left that a Mac could tell you is how it FEELS — haptics, real WebKit rendering, and
 * whether the round takes too long.
 *
 *   1. conformance   the shared Table SDK still matches the spec both harnesses are held to
 *   2. fr-game       the game-structure library's own suite, including its fuzz soak
 *   3. validate      every bundle would import cleanly into the app
 *   4. playtest      every bundle actually plays to a finish under bot pressure
 *
 * Exit code 0 clean, 1 something failed.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  ['Table SDK conformance', 'tools/conformance/run-studio.mjs', []],
  ['fr-game library',       'tools/sdk/fr-game.test.mjs',       []],
  ['bundle validation',     'tools/validate.mjs',               ['--all']],
  ['headless playtest',     'tools/harness/playtest.mjs',       ['--all', '--games', '10']]
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
