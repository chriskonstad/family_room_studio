/*
 * rebuild.test.mjs — LOOK AWAY's pick window, as a phone draws it: the countdown bar
 * runs down from full; a phone rebuilt from the history (iOS killed the app; the shell
 * replays `start` and every message) shows the time the window really has left; and
 * one rebuilt after its player picked comes back locked in on the same arrow.
 *
 *   node playtest/samples/lookaway/rebuild.test.mjs
 *
 * The fuzzer cannot reach these: the bar is a width, not text, and its bots all pick in
 * the same turn, so the round resolves before a phone ever drops between picking and
 * the reveal.
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

async function round(players) {
  const docs = {};
  const t = await runGame({ game: BUNDLE, players, seed: 2, beforeGame: (w, id) => { docs[id] = w.document; } });
  t.send('p0', { t: 'go' });
  t.bar = (id) => parseFloat((docs[id].querySelector('.tbar i') || { style: {} }).style.width);
  t.arrow = (id) => t.clickable(id).find(h => h.attrs && h.attrs['data-d']);
  t.looker = () => t.wire('broadcast').slice(-1)[0].payload.s.looker;
  return t;
}

await test('the pick bar starts full and runs down on every phone', async () => {
  const t = await round(3);
  t.advance(1000);
  for (const id of t.players) {
    ok(`${id}'s bar after 1s of 4.2`, t.bar(id) > 60 && t.bar(id) < 90, `${t.bar(id)}%`);
  }
  t.advance(2000);
  ok('p1\'s bar after 3s of 4.2', t.bar('p1') > 10 && t.bar('p1') < 40, `${t.bar('p1')}%`);
});

// Nobody picks, so the host says nothing between the round's start and the drop but
// its clock.
for (const into of [500, 3000]) {
  await test(`a phone rebuilt ${into}ms into the window shows the time it really has left`, async () => {
    const t = await round(3);
    t.advance(into);
    t.disconnect('p1'); t.advance(3000);
    t.reconnect('p1', { cold: true });
    t.advance(300);
    ok('the window is still open', t.bar('p2') > 0, `${t.bar('p2')}%`);
    ok('the rebuilt bar matches a phone that never dropped', Math.abs(t.bar('p1') - t.bar('p2')) < 10,
       `rebuilt ${t.bar('p1').toFixed(1)}%, never dropped ${t.bar('p2').toFixed(1)}%`);
  });
}

for (const who of ['dodger', 'looker']) {
  await test(`a ${who}'s phone rebuilt after picking stays locked in`, async () => {
    const t = await round(4);
    // Round 1's looker is the host, whose page is the table itself; wait out round 1
    // (4.2s, then 2s of reveal) so a phone holds the stare.
    t.advance(who === 'looker' ? 6200 + 500 : 500);
    const looker = t.looker();
    ok('a phone is looking', who !== 'looker' || looker !== t.hostId, `looker ${looker}`);
    const id = who === 'looker' ? looker : t.players.find(p => p !== looker);
    t.press(id, t.arrow(id)); t.advance(100);
    const locked = (t.text(id).match(/Locked \S+/) || [])[0];
    ok('locked in before the drop', !!locked, t.text(id));

    t.disconnect(id); t.advance(500);
    t.reconnect(id, { cold: true }); t.advance(100);
    ok('the rebuilt phone is locked in on the same arrow', t.text(id).includes(locked), `${t.text(id)} — wanted "${locked}"`);
    const sends = t.wire('send').length, refused = t.refusedTotal();
    const arrow = t.arrow(id);
    if (arrow && !arrow.disabled) t.press(id, arrow);
    ok('pressing an arrow again sends nothing the host refuses',
       t.refusedTotal() === refused && t.wire('send').length === sends,
       JSON.stringify(t.rejections().slice(-1)));
  });
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
