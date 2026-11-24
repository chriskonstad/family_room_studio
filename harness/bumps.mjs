#!/usr/bin/env node
/*
 * bumps.mjs — a game that changed must say so in its version.
 *
 *   node harness/bumps.mjs            # against the branch this one came from
 *   node harness/bumps.mjs --base main
 *
 * The first rule of a game bundle: bump manifest.json's version on ANY change. The app
 * replaces bundles by version, so a change that keeps its version never reaches a phone
 * that already has the game — and the same id@version must be byte-identical on every
 * device, or the authoritative-host model breaks. It was written down in four places
 * and enforced in none, which is how rules get broken: not on purpose, on a Tuesday.
 *
 * For each bundle, this compares what would ship against the base branch. If anything
 * the app loads changed, the version must be higher than the base's. The `.mjs` files
 * beside a game — bot, invariants, tests, mutants, phone and screen states — are the
 * harness's, never loaded by a phone, and do not count.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './runner.mjs';

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function baseRef(wanted) {
  const tries = wanted ? [wanted] : [process.env.FR_BASE, 'origin/main', 'main'].filter(Boolean);
  for (const ref of tries) {
    try {
      const mb = git('merge-base', 'HEAD', ref);
      if (mb !== git('rev-parse', 'HEAD')) return mb;
      // Sitting ON the base: uncommitted work is judged against it; a clean checkout
      // (CI after a merge to main) is judged against the commit that came before.
      const dirty = git('status', '--porcelain', '--', 'playtest/samples');
      return dirty ? mb : git('rev-parse', 'HEAD^1');
    } catch (e) { /* try the next */ }
  }
  return null;
}

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

export function checkBumps({ base } = {}) {
  const ref = baseRef(base);
  if (!ref) return { skipped: 'no base branch to compare with (not a git checkout, or no main)' };
  const samples = 'playtest/samples';
  const problems = [], checked = [];
  for (const key of readdirSync(join(REPO, samples)).sort()) {
    const dir = `${samples}/${key}`;
    if (!existsSync(join(REPO, dir, 'manifest.json'))) continue;
    let changed;
    try {
      // Committed AND uncommitted changes since the base — a check run before you
      // commit should say what the commit is about to get wrong.
      changed = git('diff', '--name-only', ref, '--', dir).split('\n').filter(Boolean);
      changed = changed.concat(git('ls-files', '--others', '--exclude-standard', '--', dir).split('\n').filter(Boolean));
    } catch (e) { continue; }
    const shipped = [...new Set(changed)].filter(f => !f.endsWith('.mjs') && !f.endsWith('/manifest.json'));
    const mine = JSON.parse(readFileSync(join(REPO, dir, 'manifest.json'), 'utf8')).version;
    let theirs = null;
    try { theirs = JSON.parse(git('show', `${ref}:${dir}/manifest.json`)).version; } catch (e) { /* new bundle */ }
    if (!theirs) continue;
    if (shipped.length && !newer(mine, theirs)) {
      problems.push({ key, mine, theirs, files: shipped.map(f => f.slice(dir.length + 1)) });
    } else if (shipped.length) checked.push({ key, from: theirs, to: mine });
  }
  return { ref: ref.slice(0, 7), problems, checked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--base');
  const out = checkBumps({ base: i === -1 ? null : process.argv[i + 1] });
  if (out.skipped) { console.log(`  ~ version bumps: skipped — ${out.skipped}`); process.exit(0); }
  for (const c of out.checked) console.log(`  ✓ ${c.key.padEnd(12)} ${c.from} → ${c.to}`);
  for (const p of out.problems) {
    console.log(`  ✗ ${p.key.padEnd(12)} changed since ${out.ref} (${p.files.slice(0, 4).join(', ')}${p.files.length > 4 ? ', …' : ''}) `
      + `but its version is still ${p.mine} — bump manifest.json, or phones that have ${p.theirs} never get the change`);
  }
  if (!out.checked.length && !out.problems.length) console.log(`  ✓ no game changed since ${out.ref}`);
  process.exit(out.problems.length ? 1 : 0);
}
