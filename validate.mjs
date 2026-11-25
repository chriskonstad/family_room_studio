#!/usr/bin/env node
/*
 * validate.mjs — check a game bundle before it goes anywhere near a phone.
 *
 *   node validate.mjs playtest/samples/streak
 *   node validate.mjs mygame.zip
 *   node validate.mjs --all
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
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { discoverIntents } from './harness/intents.mjs';
import { join, basename, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO = dirname(fileURLToPath(import.meta.url));

/* The Swift decoder's contract. `id`, `version`, `name` and `entry` are non-optional in
 * GameManifest, so a bundle missing any of them fails to decode and the game vanishes from
 * the library with no error the author will ever see. */
const REQUIRED = ['id', 'version', 'name', 'entry'];
const KNOWN = new Set([...REQUIRED, 'iconEmoji', 'minPlayers', 'maxPlayers',
                       'author', 'description', 'teams', 'screen']);

const MAX_BUNDLE_MB = 12;      // bundles transfer phone-to-phone when friends join

/* ------------------------------------------------------------ source views --- */

/* Words after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * Two views of a script with what is not code blanked out, character for character —
 * newlines kept, so a match's line number is the line it is on in the file.
 *
 *   noComments  comments blanked; strings, templates and regexes kept
 *   codeOnly    comments AND the contents of strings, templates and regex literals
 *               blanked (a template's `${…}` expressions are code and are kept)
 *
 * A real (small) tokenizer, because the line-by-line comment stripping it replaces was
 * fooled both ways: `var u = 'http://x'; var t = Date.now();` lost everything after the
 * `//` inside the string, so the Date.now() passed; a `'/*'` in a string skipped every
 * line until some later `*\/`; and `"Date.now()"` in a hint string tripped the error.
 */
export function sourceViews(src) {
  const n = src.length;
  const nc = src.split(''), co = src.split('');
  const blank = (arr, from, to) => { for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const stack = [];         // template nesting: brace depth at each `${`
  let depth = 0;
  let prev = '';            // last significant code character, for regex-vs-divide
  let word = '';            // last identifier/keyword
  let i = 0;
  const regexAllowed = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.has(word);
  // Scan a template body from i (just after ` or }) to its end or next `${`.
  const templateBody = () => {
    const start = i;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(co, start, i); i++; prev = '`'; word = ''; return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(co, start, i); i += 2; stack.push(depth); depth++; prev = '{'; word = ''; return; }
      i++;
    }
    blank(co, start, n);
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j === -1) j = n;
      blank(nc, i, j); blank(co, i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2); j = j === -1 ? n : j + 2;
      blank(nc, i, j); blank(co, i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(co, i + 1, Math.min(j, n)); i = Math.min(j + 1, n); prev = c; word = ''; continue;
    }
    if (c === '`') { i++; templateBody(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      blank(co, i + 1, Math.min(j, n)); i = Math.min(j + 1, n);
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = '/'; word = ''; continue;
    }
    if (c === '{') { depth++; prev = c; word = ''; i++; continue; }
    if (c === '}') {
      if (stack.length && stack[stack.length - 1] === depth - 1) { depth--; stack.pop(); i++; templateBody(); continue; }
      depth--; prev = c; word = ''; i++; continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z_$0-9]/.test(src[j])) j++;
      word = src.slice(i, j); prev = 'a'; i = j; continue;
    }
    if (!/\s/.test(c)) { prev = c; word = ''; }
    i++;
  }
  return { noComments: nc.join(''), codeOnly: co.join('') };
}

/** The script a source file runs: all of a .js, the inline <script> bodies of an .html
 *  (offsets kept, so line numbers stay true). */
function scriptViews(src, ext) {
  if (ext !== '.html') return sourceViews(src);
  const nc = src.replace(/[^\n]/g, ' ').split(''), co = nc.slice();
  for (const m of src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const at = m.index + m[1].length;
    const v = sourceViews(m[2]);
    for (let k = 0; k < m[2].length; k++) { nc[at + k] = v.noComments[k]; co[at + k] = v.codeOnly[k]; }
  }
  return { noComments: nc.join(''), codeOnly: co.join('') };
}

export function validateBundle(dir, { strict = false } = {}) {
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
  // A bundle that claims a shared screen has to ship one, or the TV sits blank.
  if (manifest.screen && manifest.screen !== 'none') {
    if (!['optional', 'required'].includes(manifest.screen)) {
      err(`manifest.screen is "${manifest.screen}"; use "none", "optional" or "required"`);
    }
    if (!existsSync(join(dir, 'screen.js'))) {
      err(`manifest.screen is "${manifest.screen}" but there is no screen.js — tvOS has no DOM, so a screen view is a .js file that draws, never HTML`);
    }
  }
  if (existsSync(join(dir, 'screen.js')) && !manifest.screen) {
    warn('screen.js is present but manifest.screen is not set — the shell will never attach a screen to this game');
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
    // Wall-clock time breaks across a pause: the shell freezes a paused game's timers
    // but Date.now() keeps moving, so a heat bar or countdown derived from it leaps
    // forward the moment play resumes. Every phone in the room pauses when one app
    // backgrounds, so this bites exactly on game night. Client-side DISPLAY math is
    // the one acceptable use — hence a warning, not an error.
    // Code only: a comment explaining WHY the code avoids Date.now() must not itself
    // trip the check, nor a string that mentions it — and a `//` inside a string must
    // not hide a real call later on the line (see sourceViews).
    const views = scriptViews(src, extname(f.rel));
    const dateAt = views.codeOnly.search(/\bDate\s*\.\s*now\s*\(/);
    const dateLine = dateAt === -1 ? 0 : lineOf(dateAt);
    if (dateLine) {
      // An error under --strict, like connection code: the arrival-anchored
      // countdown (deadline = Date.now() + limit) restarts on a rebuilt phone,
      // and FR.clock exists so no game needs to write one. Zero-noise today —
      // no built-in game has a code-position Date.now() left.
      (strict ? err : warn)(`${f.rel}:${dateLine} uses Date.now() — host game state must never be derived from wall-clock deltas (timers freeze across a pause, the wall clock doesn't); drive host timing from FR.timers, countdowns from FR.clock, and keep Date.now() to client display only`);
    }
    // An intent that carries arguments but declares no `options` can't be enumerated
    // by legalMoves, so the headless harness can't fuzz it — it can only mash the DOM
    // and hope. `hidden` is the honest opt-out for free text (pair it with a bot.mjs).
    if (/FR\.host\s*\(/.test(src)) {
      for (const intent of discoverIntents(src)) {
        const name = intent.fixed.t || intent.fixed.type;
        if (!name || name === 'hello') continue;
        const argful = intent.dynamic.length > 0
          || Object.keys(intent.fixed).filter(k => k !== 't' && k !== 'type').length > 0;
        if (!argful) continue;
        const spec = new RegExp(name + '\\s*:\\s*\\{[\\s\\S]{0,300}?\\b(options|hidden)\\b');
        if (!spec.test(src)) {
          warn(`${f.rel}: intent '${name}' carries arguments but its FR.host spec declares no options — legalMoves can't enumerate it, so it can't be fuzzed headlessly (declare options, or hidden plus a bot.mjs)`);
        }
      }
    }
    // Connections are the shell's job, not the game's. A dropped phone pauses the table
    // and comes back caught up — every message, in order, exactly once — so a game has
    // no departure to handle and nothing to resync. Code that tries is code that can
    // only be wrong: almost every real bug the harness ever found lived in it. A
    // built-in game must not carry any (check.mjs runs this with --strict).
    for (const [re, what] of [
      [/Table\.onPlayerLeave\s*\(/g, 'registers Table.onPlayerLeave'],
      [/Table\.onPlayerJoin\s*\(/g, 'registers Table.onPlayerJoin'],
      [/Table\.send\(\s*\{\s*(?:t|type)\s*:\s*['"]hello['"]/g, "sends a 'hello' resync"],
      [/Table\.sendTo\((?:[^,]+),\s*\{\s*(?:t|type)\s*:\s*['"]hello['"]/g, "sends a 'hello' resync"]
    ]) {
      // Every occurrence, not just the first: one handler is already one too many.
      // Comments are exempt (one explaining why the handler is gone is not a handler);
      // strings are not, so the `hello` literal is still seen.
      for (const m of views.noComments.matchAll(re)) {
        (strict ? err : warn)(`${f.rel}:${lineOf(m.index)} ${what} — the shell owns connections: a dropped phone pauses the table and is caught up when it returns (every message, in order, exactly once), and games never see anyone leave or come back. Delete it`);
      }
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
export function validateZip(zipPath, { strict = false } = {}) {
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
  return validateBundle(root, { strict });
}

/* --------------------------------------------- the Studio's sample index --- */

/**
 * `playtest/samples/index.json` tells the browser Studio which files to fetch
 * for each sample. A browser cannot list a directory, so this list has to exist
 * — but it was hand-kept, and a hand-kept list of files is a drift trap.
 *
 * SUMMIT shipped a `screen.js` that the Studio never fetched because nobody
 * added it here, so the game declared a shared screen and the Studio showed no
 * TV panel, silently. Everything else about it worked. That is the exact shape
 * of failure this repo keeps having: two descriptions of the same thing, only
 * one of them checked.
 *
 * So it is derived now. Everything in the index comes from the bundle itself —
 * the label from the manifest's name and emoji, the files from the directory —
 * and `node validate.mjs --write` rewrites it. Nothing here is a judgement
 * call, which is why nothing here should be typed by hand.
 */
/* A bundle's browser code is always a plain script — games are injected into a
 * WKWebView and cannot use imports — so `.mjs` in a sample directory is always
 * authoring-side: the fuzzer's bot, its invariants, SCRAMBLE's dictionary
 * builder. `.swift` likewise (SCRAMBLE reads the Mac's spelling dictionary to
 * build that list). The Studio must not fetch either, and listing them by name
 * meant every new one was a silent 404 waiting to happen. */
const AUTHORING_ONLY = ['.mjs', '.swift'];
const nodeOnly = (f) => AUTHORING_ONLY.some(ext => f.endsWith(ext));

export function buildSampleIndex() {
  const samples = join(REPO, 'playtest/samples');
  const ids = readdirSync(samples)
    .filter(d => existsSync(join(samples, d, 'manifest.json')))
    .sort();

  // Keep the dropdown in the order it is in today; new games go on the end.
  const indexPath = join(samples, 'index.json');
  let order = [];
  if (existsSync(indexPath)) {
    try { order = JSON.parse(readFileSync(indexPath, 'utf8')).map(e => e.id); } catch { /* rebuild */ }
  }
  ids.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b);
  });

  return ids.map(id => {
    const dir = join(samples, id);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const entry = manifest.entry || 'index.html';
    // Everything a browser needs: the bundle minus the node-only test hooks.
    const files = readdirSync(dir)
      .filter(f => !f.startsWith('.') && !nodeOnly(f)
                && statSync(join(dir, f)).isFile())
      .sort((a, b) => {
        const rank = f => f === 'manifest.json' ? 0 : f === entry ? 1 : f === 'game.js' ? 2 : 3;
        return rank(a) - rank(b) || a.localeCompare(b);
      });
    return { id, label: `${manifest.name} ${manifest.iconEmoji || '🎲'}`, files };
  });
}

export function checkSampleIndex({ write = false } = {}) {
  const indexPath = join(REPO, 'playtest/samples/index.json');
  const wanted = JSON.stringify(buildSampleIndex(), null, 2) + '\n';
  const have = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  if (have === wanted) return { ok: true };
  if (write) {
    writeFileSync(indexPath, wanted);
    return { ok: true, written: true };
  }
  return { ok: false, detail: 'playtest/samples/index.json is out of date with the samples '
                            + 'directory — the Studio would fetch the wrong files. '
                            + 'Run: node validate.mjs --write' };
}

/* ------------------------------------------------------------------ cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let targets = args.filter(a => !a.startsWith('--'));
  if (args.includes('--all') || !targets.length) {
    const samples = join(REPO, 'playtest/samples');
    targets = readdirSync(samples)
      .filter(d => existsSync(join(samples, d, 'manifest.json')))
      .map(d => join(samples, d));
  }

  let failed = 0;
  for (const target of targets) {
    const label = basename(target).padEnd(12);
    let out;
    try {
      // --strict: the built-in games are held to the rules a third-party zip is only
      // warned about.
      out = extname(target) === '.zip' ? validateZip(target, { strict: args.includes('--strict') }) : validateBundle(target, { strict: args.includes('--strict') });
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
  // The Studio's file list is part of the bundles being valid: a game whose
  // files the Studio cannot fetch is not playable, however good the bundle is.
  const index = checkSampleIndex({ write: args.includes('--write') });
  if (index.written) console.log('  ↻ playtest/samples/index.json rewritten from the samples directory');
  if (!index.ok) { failed++; console.log(`  ✗ samples index  ${index.detail}`); }

  console.log(failed ? `\n${failed} bundle(s) invalid` : `\nAll ${targets.length} bundle(s) valid`);
  process.exit(failed ? 1 : 0);
}
