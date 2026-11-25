/*
 * rebuild.test.mjs — CAPTAIN SAYS's order countdown on a phone rebuilt from the
 * history (iOS killed the app; the shell replays `start` and every message): it must
 * show the time the order really has left, as a phone that never dropped does.
 *
 *   node playtest/samples/captain/rebuild.test.mjs
 *
 * The fuzzer cannot see this: the bar is a width, not text, and the next state from
 * the host puts the rebuilt phone right again — after the order it misread is over.
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
function ok(what, cond, detail) { if (!cond) throw new Error(`${what}${detail ? ': ' + detail : ''}`); }

async function order() {
  const docs = {};
  const t = await runGame({ game: BUNDLE, players: 3, seed: 4, beforeGame: (w, id) => { docs[id] = w.document; } });
  t.send('p0', { t: 'go' });
  t.bar = (id) => parseFloat((docs[id].querySelector('.tbar i') || { style: {} }).style.width);
  return t;
}

await test('the order bar starts full and runs down', async () => {
  const t = await order();          // round 1's window: 3040ms
  t.advance(300);
  ok('after 0.3s', t.bar('p1') > 80 && t.bar('p1') <= 100, `${t.bar('p1')}%`);
  t.advance(1500);
  ok('after 1.8s', t.bar('p1') > 30 && t.bar('p1') < 50, `${t.bar('p1')}%`);
});

// Nobody taps, so the host says nothing between the order and the drop but its clock.
for (const into of [600, 2000]) {
  await test(`a phone rebuilt ${into}ms into an order shows the time it really has left`, async () => {
    const t = await order();
    t.advance(into);
    t.disconnect('p1'); t.advance(3000);
    t.reconnect('p1', { cold: true });
    t.advance(300);
    ok('the order is still up', /CAPTAIN SAYS|tap /.test(t.text('p2')) && t.bar('p2') > 0, `${t.bar('p2')}%`);
    ok('the rebuilt bar matches a phone that never dropped', Math.abs(t.bar('p1') - t.bar('p2')) < 10,
       `rebuilt ${t.bar('p1').toFixed(1)}%, never dropped ${t.bar('p2').toFixed(1)}%`);
  });
}

await test('a phone rebuilt after tapping comes back locked in on the same colour', async () => {
  const t = await order();
  t.advance(300);
  const col = t.clickable('p1').find(h => h.attrs && h.attrs['data-c']);
  t.press('p1', col); t.advance(100);
  const locked = (t.text('p1').match(/Locked in \S+/) || [])[0];
  ok('locked in before the drop', !!locked, t.text('p1'));

  t.disconnect('p1'); t.advance(500);
  t.reconnect('p1', { cold: true }); t.advance(100);
  ok('the rebuilt phone is locked in on the same colour', t.text('p1').includes(locked), `${t.text('p1')} — wanted "${locked}"`);
  const sends = t.wire('send').length, refused = t.refusedTotal();
  const again = t.clickable('p1').find(h => h.attrs && h.attrs['data-c']);
  if (again) t.press('p1', again);
  t.advance(50);
  ok('pressing a colour again sends nothing', t.wire('send').length === sends && t.refusedTotal() === refused,
     JSON.stringify(t.rejections().slice(-1)));
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
