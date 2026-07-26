#!/usr/bin/env node
/*
 * Runs the Table conformance suite against the Playtest Studio's SDK — the same
 * spec the iOS unit test uses, so the two harnesses can't drift apart again.
 *
 *   node tools/conformance/run-studio.mjs
 *
 * It extracts the studio's `window.Table = {…}` construction from index.html and
 * evaluates it against stubs, rather than duplicating it here. If the studio's
 * SDK changes shape, this notices.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const studioHTML = readFileSync(join(repo, 'tools/playtest/index.html'), 'utf8');
const suite = readFileSync(join(here, 'table-conformance.js'), 'utf8');

// The studio builds the SDK inside a template literal in a function that returns
// the boot script for each simulated phone. Pull that template out and fill it.
const match = studioHTML.match(/return `\(function\(\)\{\s*\n\s*const PID=[\s\S]*?\n  \}\)\(\);`;/);
if (!match) {
  console.error('✗ Could not find the studio Table bootstrap in tools/playtest/index.html.');
  console.error('  If the studio was restructured, update the pattern in this script.');
  process.exit(2);
}

// Substitute the ${…} interpolations the studio would fill in at runtime.
const boot = match[0]
  .replace(/^return `/, '')
  .replace(/`;$/, '')
  .replace(/\$\{JSON\.stringify\(player\.id\)\}/g, '"p0"')
  .replace(/\$\{JSON\.stringify\(me\)\}/g, '{"id":"p0","name":"Ava","emoji":"🦊","isHost":true}')
  .replace(/\$\{player\.isHost\?'true':'false'\}/g, 'true')
  .replace(/\$\{JSON\.stringify\(players\)\}/g, '[{"id":"p0","name":"Ava","emoji":"🦊"}]')
  .replace(/\$\{JSON\.stringify\(teams\)\}/g, 'null');

if (boot.includes('${')) {
  console.error('✗ Unsubstituted template placeholders remain:',
                [...boot.matchAll(/\$\{[^}]*\}/g)].map(m => m[0]).join(', '));
  process.exit(2);
}

// Stub the studio's parent-window bus. Every call is recorded, none may throw.
const calls = [];
const saved = new Map();
const realBus = {
  saveState: (pid, obj) => { calls.push(['saveState', pid]); saved.set(pid, structuredClone(obj)); },
  loadState: (pid) => (saved.has(pid) ? saved.get(pid) : null)
};
// Anything the studio calls that we haven't stubbed is recorded and ignored —
// but real implementations above must win over the catch-all.
const bus = new Proxy(realBus, {
  get: (target, prop) =>
    prop in target ? target[prop] : (...args) => { calls.push([String(prop), ...args]); }
});

const sandbox = {
  console,
  structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval,
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.parent = { HarnessBus: bus };
sandbox.window.addEventListener = () => {};

vm.createContext(sandbox);
vm.runInContext(boot, sandbox);
vm.runInContext(suite, sandbox);
const report = vm.runInContext('__tableConformance.run(window.Table)', sandbox);

for (const r of report.results) {
  if (!r.ok) console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
const label = `${report.pass}/${report.total} checks passed`;
if (report.fail === 0) {
  console.log(`✓ Studio Table conforms — ${label}`);
  process.exit(0);
}
console.log(`\n✗ Studio Table does NOT conform — ${label}, ${report.fail} failing`);
console.log('  The iOS harness is the source of truth; bring the studio up to it.');
process.exit(1);
