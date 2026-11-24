#!/usr/bin/env node
/*
 * mutants.mjs — does the suite catch the bugs it says it catches?
 *
 *   node harness/mutants.mjs                 # every bundle that ships a mutants.mjs
 *   node harness/mutants.mjs holdem streak   # just these
 *   node harness/mutants.mjs --list          # what each mutant is, without running it
 *
 * A green test suite proves nothing on its own: a fuzzer that never runs the leave path,
 * a leak probe that only looks for strings, a "never sent" report that reads one intent
 * out of the source — every one of those was green, and every one was blind. This file
 * is how that gets found out on purpose instead of by accident.
 *
 * A bundle may ship `mutants.mjs` beside its game: a list of small, deliberate breakages,
 * each one a real bug class — most of them bugs that actually shipped:
 *
 *   export default [{
 *     name: 'heads-up blinds are not reversed',
 *     file: 'game.js', find: 'if (live.length === 2) {', replace: 'if (false) {',
 *     checks: ['playtest']            // optional; default playtest + the bundle's tests
 *   }];
 *
 * (or `edits: [{file, find, replace}, …]` for a bug that takes more than one change).
 * Each mutant is applied to a COPY of the bundle and the named checks are run against
 * it. The suite must fail. A mutant that survives is a hole in the tests, reported as a
 * failure — the bug it describes would ship.
 *
 * `find` must appear in the file exactly once. When the code it targets is rewritten the
 * mutant goes stale and says so, rather than silently mutating nothing and "surviving".
 *
 * Before any mutant runs, the UNMUTATED copy must pass the same checks. A mutant can
 * only be caught by a suite that was passing to begin with.
 */
import { readdirSync, existsSync, mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REPO } from './runner.mjs';
import { playtest } from './playtest.mjs';
import { checkScreen } from './screen.mjs';

const SAMPLES = join(REPO, 'playtest/samples');
const DEFAULT_CHECKS = ['playtest', 'tests'];

/** Run the named checks on a bundle directory. The first failure is the catch. */
async function runChecks(dir, checks, { games }) {
  if (checks.includes('playtest')) {
    const out = await playtest(dir, { games, seed: 1 });
    if (out.failures.length) return { failed: true, by: 'playtest', why: out.failures[0].why };
  }
  if (checks.includes('tests')) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort()) {
      const r = spawnSync(process.execPath, [join(dir, f)], { env: { ...process.env, FR_REPO: REPO }, encoding: 'utf8' });
      if (r.status !== 0) {
        const line = (r.stdout + '\n' + r.stderr).split('\n').map(l => l.trim()).find(l => /^✗|Error/.test(l));
        return { failed: true, by: f, why: line || `exited ${r.status}` };
      }
    }
  }
  if (checks.includes('screen') && existsSync(join(dir, 'screen.js'))) {
    const out = await checkScreen(dir, { games: 4 });
    if (out.failures && out.failures.length) return { failed: true, by: 'screen', why: out.failures[0].why };
  }
  if (checks.includes('phone')) {
    const { checkPhones } = await import('./phone.mjs');
    const out = await checkPhones(dir, {});
    if (out.failures.length) return { failed: true, by: 'phone', why: out.failures[0].why };
  }
  return { failed: false };
}

/** A fresh copy of a bundle, somewhere it cannot ship from. */
function copyOf(key) {
  const dir = mkdtempSync(join(tmpdir(), `fr-mutant-${key}-`));
  cpSync(join(SAMPLES, key), dir, { recursive: true });
  return dir;
}

function apply(dir, mutant) {
  const edits = mutant.edits || [{ file: mutant.file, find: mutant.find, replace: mutant.replace }];
  for (const e of edits) {
    const path = join(dir, e.file);
    const src = readFileSync(path, 'utf8');
    const n = src.split(e.find).length - 1;
    if (n !== 1) {
      throw new Error(`stale mutant: "${e.find.slice(0, 60)}" appears ${n} times in ${e.file} (must be exactly once) — `
        + `the code it breaks has changed; update the mutant`);
    }
    writeFileSync(path, src.replace(e.find, e.replace));
  }
}

export async function mutate(key, { games = 16, only = null } = {}) {
  const spec = join(SAMPLES, key, 'mutants.mjs');
  if (!existsSync(spec)) return null;
  const mutants = ((await import(pathToFileURL(spec).href)).default || [])
    .filter(m => !only || only.some(o => m.name.includes(o)));
  const results = [];
  const baselines = new Map();
  for (const m of mutants) {
    const checks = m.checks || DEFAULT_CHECKS;
    const ck = checks.join(',');
    if (!baselines.has(ck)) {
      const dir = copyOf(key);
      try { baselines.set(ck, await runChecks(dir, checks, { games })); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    }
    const base = baselines.get(ck);
    if (base.failed) {
      results.push({ name: m.name, status: 'baseline', why: `the unmutated bundle already fails ${base.by}: ${base.why}` });
      continue;
    }
    const dir = copyOf(key);
    try {
      apply(dir, m);
      const t0 = Date.now();
      const r = await runChecks(dir, checks, { games: m.games || games });
      results.push({ name: m.name, status: r.failed ? 'caught' : 'survived', by: r.by, why: r.why, ms: Date.now() - t0, checks });
    } catch (e) {
      results.push({ name: m.name, status: 'stale', why: e.message });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}

/* ---------------------------------------------------------------------- cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
  let keys = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--games', '--only'].includes(args[i - 1])));
  if (!keys.length) keys = readdirSync(SAMPLES).filter(d => existsSync(join(SAMPLES, d, 'mutants.mjs'))).sort();
  const games = Number(flag('games', 16));
  const only = flag('only', null) ? String(flag('only')).split(',') : null;

  if (args.includes('--list')) {
    for (const key of keys) {
      const ms = (await import(pathToFileURL(join(SAMPLES, key, 'mutants.mjs')).href)).default || [];
      console.log(`  ${key}`);
      for (const m of ms) console.log(`    · ${m.name}${m.checks ? `  [${m.checks.join(', ')}]` : ''}`);
    }
    process.exit(0);
  }

  let killed = 0, total = 0, bad = 0;
  for (const key of keys) {
    const t0 = Date.now();
    const res = await mutate(key, { games, only });
    if (!res) { console.log(`  ~ ${key.padEnd(12)} no mutants.mjs`); continue; }
    const caught = res.filter(r => r.status === 'caught').length;
    killed += caught; total += res.length;
    const ok = caught === res.length;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${key.padEnd(12)} ${caught}/${res.length} mutants caught · ${Date.now() - t0}ms`);
    for (const r of res) {
      if (r.status === 'caught') {
        if (flag('verbose', false)) console.log(`      ✓ ${r.name} — ${r.by}: ${String(r.why).split('\n')[0].slice(0, 150)}`);
      } else {
        console.log(`      ✗ ${r.status.toUpperCase()}: ${r.name}`);
        console.log(`        ${String(r.why || 'every check passed with this bug in place').split('\n')[0]}`);
      }
    }
  }
  console.log(bad
    ? `\n${total - killed} of ${total} mutants survived — those bugs would ship`
    : `\nAll ${total} mutants caught`);
  process.exit(bad ? 1 : 0);
}
