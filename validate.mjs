#!/usr/bin/env node
/*
 * validate.mjs — check a game bundle before it goes anywhere near a phone.
 *
 *   node tools/validate.mjs tools/playtest/samples/streak
 *   node tools/validate.mjs mygame.zip
 *   node tools/validate.mjs --all
 *
 * This is the gate that makes third-party authoring safe. Anyone can write a bundle and
 * hand over a .zip; the app will import it and run it on every phone in the room. Nobody
 * should need a Mac, Xcode or the app's source to find out whether their bundle is sound —
 * and the failure modes are nasty and quiet: a manifest the Swift decoder rejects means the
 * game simply never appears, and a runtime `fetch()` works perfectly in a browser and
 * returns nothing inside the shell.
 *
 * Everything checked here is a rule that exists elsewhere as prose or as Swift, and was
 * previously enforced by a person remembering it.
 *
 * Exit code 0 clean, 1 errors, 2 the validator itself couldn't run.
 * Warnings never fail the run — they're style, not correctness.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The Swift decoder's contract. `id`, `version`, `name` and `entry` are non-optional in
 * GameManifest, so a bundle missing any of them fails to decode and the game vanishes from
 * the library with no error the author will ever see. */
const REQUIRED = ['id', 'version', 'name', 'entry'];
const KNOWN = new Set([...REQUIRED, 'iconEmoji', 'minPlayers', 'maxPlayers',
                       'author', 'description', 'teams']);

const MAX_BUNDLE_MB = 12;      // bundles transfer phone-to-phone when friends join

export function validateBundle(dir) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  /* ---- manifest ---- */
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { errors: ['manifest.json is missing — the loader finds a bundle by it'], warnings };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { errors: [`manifest.json is not valid JSON — ${e.message}`], warnings };
  }

  for (const key of REQUIRED) {
    if (manifest[key] === undefined || manifest[key] === '') {
      err(`manifest.${key} is required — without it the app can't decode the manifest and the game never appears in the library`);
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!KNOWN.has(key) && !key.startsWith('_')) {
      warn(`manifest.${key} is not a field the shell reads — it will be ignored`);
    }
  }
  if (manifest.id && !/^[a-zA-Z0-9][\w.-]*$/.test(manifest.id)) {
    err(`manifest.id "${manifest.id}" should be reverse-DNS-ish (letters, digits, dot, dash, underscore)`);
  }
  if (manifest.id && !manifest.id.includes('.')) {
    warn(`manifest.id "${manifest.id}" has no dot — reverse-DNS ("com.you.${manifest.id}") avoids collisions with someone else's bundle`);
  }
  if (manifest.version && !/^\d+\.\d+(\.\d+)?$/.test(String(manifest.version))) {
    err(`manifest.version "${manifest.version}" must look like 1.0 or 1.0.0 — the library replaces bundles BY VERSION, so an unparseable one can't be upgraded`);
  }
  const lo = manifest.minPlayers, hi = manifest.maxPlayers;
  if (lo !== undefined && (!Number.isInteger(lo) || lo < 1)) err(`manifest.minPlayers must be a whole number >= 1`);
  if (hi !== undefined && (!Number.isInteger(hi) || hi < 1)) err(`manifest.maxPlayers must be a whole number >= 1`);
  if (Number.isInteger(lo) && Number.isInteger(hi) && lo > hi) {
    err(`manifest.minPlayers (${lo}) is greater than maxPlayers (${hi}) — nobody can ever start this game`);
  }
  if (manifest.teams !== undefined && manifest.teams !== 'required') {
    warn(`manifest.teams is "${manifest.teams}"; only "required" does anything — anything else means no teams`);
  }
  if (manifest.teams === 'required' && Number.isInteger(lo) && lo < 2) {
    err(`a "teams":"required" game needs minPlayers >= 2`);
  }
  if (!manifest.description) {
    warn('no manifest.description — players press and hold a game to see what it is before hosting it');
  }
  if (!manifest.iconEmoji) warn('no manifest.iconEmoji — the library will show a generic die');

  /* ---- files ---- */
  const entry = manifest.entry || 'index.html';
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) {
    err(`manifest.entry points at "${entry}", which isn't in the bundle`);
  }

  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else files.push({ path: p, rel: relative(dir, p), size: st.size });
    }
  })(dir);

  const totalMB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  if (totalMB > MAX_BUNDLE_MB) {
    err(`bundle is ${totalMB.toFixed(1)}MB — it transfers phone-to-phone when someone joins; keep it under ${MAX_BUNDLE_MB}MB`);
  } else if (totalMB > MAX_BUNDLE_MB / 3) {
    warn(`bundle is ${totalMB.toFixed(1)}MB — large for something that transfers over the air on join`);
  }

  /* ---- source rules ---- */
  const sources = files.filter(f => ['.js', '.html'].includes(extname(f.rel)));
  for (const f of sources) {
    const src = readFileSync(f.path, 'utf8');
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;

    // Offline-only. A runtime fetch of a bundle file works in a plain browser and returns
    // nothing in the shell, so it breaks only on real phones — the worst place to find out.
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      err(`${f.rel}:${lineOf(m.index)} calls fetch() — bundles are offline; inline your data instead`);
    }
    for (const m of src.matchAll(/\b(XMLHttpRequest|WebSocket|EventSource)\b/g)) {
      err(`${f.rel}:${lineOf(m.index)} uses ${m[1]} — there is no network inside a bundle`);
    }
    // External hosts: a CDN script or webfont simply doesn't load on a table with no
    // internet, which is the entire point of this app.
    for (const m of src.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/([^"'/]+)/gi)) {
      err(`${f.rel}:${lineOf(m.index)} loads from ${m[1]} — bundles must be self-contained and work with no internet`);
    }
    if (/\bnavigator\.vibrate\b/.test(src)) {
      err(`${f.rel} calls navigator.vibrate — it does not exist in WebKit on iOS; use Table.haptic()`);
    }
    if (/\blocalStorage\b|\bsessionStorage\b/.test(src)) {
      warn(`${f.rel} uses web storage — use Table.saveState()/loadState(), which the shell persists properly`);
    }
    for (const m of src.matchAll(/\bMath\.random\s*\(/g)) {
      warn(`${f.rel}:${lineOf(m.index)} uses Math.random() — FR.rng(seed) makes the game replayable, which is what lets a bug be reproduced and fuzzed`);
    }
    // The SDK is injected; a bundle shipping its own copy would shadow it.
    if (/window\.Table\s*=/.test(src)) {
      err(`${f.rel} assigns window.Table — the shell injects the SDK; a bundle must not define it`);
    }
  }

  /* ---- entry HTML rules (only worth checking if it exists) ---- */
  if (existsSync(entryPath)) {
    const html = readFileSync(entryPath, 'utf8');
    if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
      err(`${entry} has no viewport meta — the game will render at desktop scale on a phone`);
    } else if (!/viewport-fit=cover/i.test(html)) {
      warn(`${entry} viewport lacks viewport-fit=cover — content won't reach under the notch/home indicator`);
    }
    if (!/env\(safe-area-inset/.test(html)) {
      warn(`${entry} never uses env(safe-area-inset-*) — controls can end up under the home indicator`);
    }
    for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) {
      const ref = m[1];
      if (/^https?:/i.test(ref)) continue;                       // already reported above
      if (!existsSync(join(dir, ref))) err(`${entry} loads "${ref}", which isn't in the bundle`);
    }
  }

  return { manifest, errors, warnings, files: files.length, sizeMB: totalMB };
}

/** Unzip to a temp dir and validate that, finding the bundle root the way the app does. */
export function validateZip(zipPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'fr-validate-'));
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmp], { stdio: 'pipe' });
  } catch (e) {
    return { errors: [`could not unzip — ${e.message}`], warnings: [] };
  }
  // Accept files at the zip root OR under a single top-level folder, same as the loader.
  let root = tmp;
  if (!existsSync(join(root, 'manifest.json'))) {
    const dirs = readdirSync(root).filter(d => !d.startsWith('.') && d !== '__MACOSX'
                                            && statSync(join(root, d)).isDirectory());
    if (dirs.length === 1 && existsSync(join(root, dirs[0], 'manifest.json'))) root = join(root, dirs[0]);
  }
  return validateBundle(root);
}

/* ------------------------------------------------------------------ cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let targets = args.filter(a => !a.startsWith('--'));
  if (args.includes('--all') || !targets.length) {
    const samples = join(REPO, 'tools/playtest/samples');
    targets = readdirSync(samples)
      .filter(d => existsSync(join(samples, d, 'manifest.json')))
      .map(d => join(samples, d));
  }

  let failed = 0;
  for (const target of targets) {
    const label = basename(target).padEnd(12);
    let out;
    try {
      out = extname(target) === '.zip' ? validateZip(target) : validateBundle(target);
    } catch (e) {
      console.log(`  ✗ ${label} validator error: ${e.message}`);
      failed++;
      continue;
    }
    if (out.errors.length) {
      failed++;
      console.log(`  ✗ ${label} ${out.errors.length} error(s)`);
      for (const e of out.errors) console.log(`      ${e}`);
    } else {
      const size = out.sizeMB !== undefined ? ` ${out.sizeMB.toFixed(2)}MB` : '';
      console.log(`  ✓ ${label} ${out.manifest?.id}@${out.manifest?.version}${size}`);
    }
    for (const w of out.warnings) console.log(`      ⚠ ${w}`);
  }
  console.log(failed ? `\n${failed} bundle(s) invalid` : `\nAll ${targets.length} bundle(s) valid`);
  process.exit(failed ? 1 : 0);
}
