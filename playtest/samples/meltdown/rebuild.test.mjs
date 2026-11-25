/*
 * rebuild.test.mjs — a MELTDOWN phone rebuilt from the history (iOS killed the app;
 * the shell replays `start` and every message) must come back to the panel the host
 * has, not the one it was dealt.
 *
 *   node playtest/samples/meltdown/rebuild.test.mjs
 *
 * The fuzzer's rebuilt-phone comparison sees this only when the drop lands just after
 * a switch flip and the two screens then stay apart for several turns — about one run
 * in fifty — so it is pinned here.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BUNDLE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.FR_REPO || join(BUNDLE, '../../..');
const { runGame } = await import(pathToFileURL(join(REPO, 'harness/runner.mjs')).href);

let pass = 0, fail = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; out.push(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(what, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
const control = (t, id, attr) => t.clickable(id).find(h => h.attrs && h.attrs[attr] !== undefined);

await test('a phone rebuilt after flipping a switch shows it where the host has it', async () => {
  const t = await runGame({ game: BUNDLE, players: 3, seed: 5 });
  t.send('p0', { t: 'begin' }); t.advance(100);
  const sw = control(t, 'p1', 'data-sw');
  eq('the switch is dealt', sw.textContent, 'OFF');
  t.press('p1', sw); t.advance(100);
  eq('flipped on the phone', control(t, 'p1', 'data-sw').textContent, 'ON');

  t.disconnect('p1'); t.advance(1000);
  t.reconnect('p1', { cold: true }); t.advance(100);
  const again = control(t, 'p1', 'data-sw');
  eq('the rebuilt phone shows the switch', again.textContent, 'ON');

  // ...and the next flip turns it OFF, which is what the player sees and means.
  t.press('p1', again); t.advance(100);
  const sent = t.wire('send').filter(e => e.from === 'p1').map(e => e.payload);
  eq('the next flip sends', sent[sent.length - 1].value, false);
});

await test('a phone rebuilt after turning a dial shows the dial where the host has it', async () => {
  const t = await runGame({ game: BUNDLE, players: 2, seed: 9 });
  t.send('p0', { t: 'begin' }); t.advance(100);
  const three = t.clickable('p1').find(h => h.attrs && h.attrs['data-dial'] && h.attrs['data-v'] === '3');
  t.press('p1', three); t.advance(100);
  t.disconnect('p1'); t.advance(500);
  t.reconnect('p1', { cold: true }); t.advance(100);
  const cur = t.clickable('p1').filter(h => h.attrs && h.attrs['data-dial'] && h.classList.contains('cur'));
  eq('the rebuilt dial', cur.map(h => h.attrs['data-v']), ['3']);
});

// Every order is dealt at once when the reactor starts, with the same limit, and nobody
// touches anything — so every phone's order clock reads the same, and the host says
// nothing between the start and the drop but its clock.
await test('a phone rebuilt mid-order shows the time its order really has left', async () => {
  const t = await runGame({ game: BUNDLE, players: 3, seed: 5 });
  t.send('p0', { t: 'begin' }); t.advance(6000);
  t.disconnect('p1'); t.advance(3000);
  t.reconnect('p1', { cold: true }); t.advance(600);
  const clockOf = (id) => {
    const m = t.html(id).match(/class="clock"[^>]*>([\d.]+)</);
    return m ? parseFloat(m[1]) : NaN;
  };
  const rebuilt = clockOf('p1'), never = clockOf('p2');
  if (!(never > 0 && never < 6)) throw new Error(`a phone that never dropped reads ${never}s — the test lost its order`);
  if (!(Math.abs(rebuilt - never) <= 0.6)) throw new Error(`the rebuilt phone reads ${rebuilt}s, one that never dropped ${never}s`);
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
