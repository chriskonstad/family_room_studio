/*
 * Tests for the pausable timer shim in table-sdk.js (installTimerShim).
 * Plain node, no dependencies:
 *
 *     node tools/sdk/table-sdk.test.mjs
 *
 * The shim replaces a page's setTimeout/setInterval so the shell can freeze
 * game clocks while the table is paused. It hands out its OWN ids while the
 * native clock hands out its own — two counters sharing one small-number
 * namespace. Clearing a stale shim id used to fall through to the native
 * clear with the same number, which could murder a live, unrelated timer:
 * that is what killed FR.clock's 250ms tick in LOOK AWAY (frozen countdowns,
 * healthy game) and broke its WebKit replay. These pin the fix.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const REPO = dirname(fileURLToPath(import.meta.url));
const sdkSrc = readFileSync(join(REPO, 'table-sdk.js'), 'utf8');

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
function section(name) { results.push(`\n${name}`); }

/* A native clock the test drives by hand. Small-int ids like a browser's,
 * so shim ids and native ids collide exactly as they do in production. */
function fakeNative() {
  let now = 0, seq = 0;
  const jobs = new Map();
  const api = {
    get now() { return now; },
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { at: now + Math.max(0, ms || 0), fn, every: 0 }); return id; },
    setInterval(fn, ms) { const id = ++seq; const d = Math.max(1, ms || 1); jobs.set(id, { at: now + d, fn, every: d }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    clearInterval(id) { jobs.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= target && (!next || j.at < next[1].at)) next = [id, j];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        if (job.every) job.at = now + job.every; else jobs.delete(id);
        job.fn();
      }
      now = target;
    }
  };
  return api;
}

/* The shim installed over the fake natives, in a bare window. */
function shimmedWindow() {
  const native = fakeNative();
  const w = {
    setTimeout: native.setTimeout.bind(native),
    clearTimeout: native.clearTimeout.bind(native),
    setInterval: native.setInterval.bind(native),
    clearInterval: native.clearInterval.bind(native),
  };
  // The shim stamps dues with Date.now(), so the sandbox clock must be the same
  // virtual time the fake natives run on — real time would stand still while it
  // advances, and every remaining-slice computation would come out wrong.
  const VDate = { now: () => native.now };
  const sandbox = { window: w, globalThis: {}, Date: VDate };
  sandbox.window.Date = VDate;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sdkSrc, sandbox);
  const frTable = w.__frTable;   // the SDK installs itself on `window`
  const clock = frTable.installTimerShim(w);
  return { w, native, clock };
}

section('installTimerShim — stale clears must not kill live timers');

test('clearing a stale id twice never touches another live timer', () => {
  const { w, native } = shimmedWindow();
  let ticks = 0;
  w.setInterval(() => ticks++, 250);   // shim id 1; native first slice, then a native interval
  native.advance(300);                 // first slice fires; interval re-arms natively
  const before = ticks;
  assert.ok(before >= 1, 'the interval should have ticked');
  const arm = w.setTimeout(() => {}, 50);   // shim id 2
  w.clearTimeout(arm);                       // live clear: fine
  w.clearTimeout(arm);                       // STALE: must be a no-op, never forwarded
  w.clearInterval(arm);                      // stale under the other clear too
  native.advance(1000);
  assert.ok(ticks > before, `the interval kept ticking (was ${before}, now ${ticks})`);
});

test('a stale clear aimed at a live native id is swallowed, not forwarded', () => {
  const { w, native } = shimmedWindow();
  let ticks = 0;
  w.setInterval(() => ticks++, 100);   // native job takes a small id…
  native.advance(150);                 // …and the interval re-arms natively
  // Burn shim ids until a stale one numerically equals a live native job, then
  // clear it stale twice over. Old code forwarded the second clear and killed it.
  for (let i = 0; i < 12; i++) { const id = w.setTimeout(() => {}, 10); w.clearTimeout(id); w.clearTimeout(id); }
  const before = ticks;
  native.advance(500);
  assert.ok(ticks > before, `interval survived 12 stale clears (was ${before}, now ${ticks})`);
});

test('a genuinely foreign id still forwards to the native clear', () => {
  const { w, native } = shimmedWindow();
  let fired = 0;
  const id = native.setTimeout(() => fired++, 100);   // armed pre-shim: the shim never issued it
  w.clearTimeout(id);
  native.advance(500);
  assert.equal(fired, 0, 'pre-shim native timer must still be clearable');
});

test('live clears still work, and double-clear is harmless', () => {
  const { w, native } = shimmedWindow();
  let n = 0;
  const id = w.setTimeout(() => n++, 100);
  w.clearTimeout(id);
  w.clearTimeout(id);
  native.advance(500);
  assert.equal(n, 0);
});

section('installTimerShim — pause still freezes and resumes');

test('timers freeze while paused and resume with the time remaining', () => {
  const { w, native, clock } = shimmedWindow();
  let n = 0;
  w.setTimeout(() => n++, 1000);
  native.advance(400);
  clock.setPaused(true);
  native.advance(5000);
  assert.equal(n, 0, 'nothing fires while paused');
  clock.setPaused(false);
  native.advance(599);
  assert.equal(n, 0, 'only the remaining 600ms was owed');
  native.advance(2);
  assert.equal(n, 1);
});

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
