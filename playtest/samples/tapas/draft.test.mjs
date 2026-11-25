/*
 * draft.test.mjs — picking a plate through the real controls while the table drafts around you.
 *
 *   node playtest/samples/tapas/draft.test.mjs
 *
 * Everyone picks at once, so other people's picks land while you are still deciding.
 * The fuzzer's phone-driven player taps a card and "Take it" in the same breath, so it
 * never has anyone else's pick arrive in between — which is exactly when a choice that
 * quietly un-chooses itself shows up.
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
function ok(what, cond) { if (!cond) throw new Error(what); }

const card = (t, id, i) => t.clickable(id).find(h => h.attrs && h.attrs['data-i'] === String(i));
const takeIt = (t, id) => t.clickable(id).find(h => h.attrs && h.attrs['data-act'] === 'pick');

for (const who of ['p1', 'p0']) {      // a guest's phone, and the host's own
  const other = who === 'p0' ? 'p1' : 'p0';
  await test(`${who === 'p0' ? 'the host' : 'a guest'}: somebody else picking does not un-choose your card`, async () => {
    const t = await runGame({ game: BUNDLE, players: 4, seed: 5 });
    t.press(who, card(t, who, 2));
    ok('"Take it" is live once a card is chosen', !!takeIt(t, who));
    t.send(other, { t: 'pick', i: 0 });            // their pick lands while you decide
    t.send('p2', { t: 'pick', i: 0 });
    const btn = takeIt(t, who);
    ok('"Take it" is still live after two other players picked', !!btn);
    t.press(who, btn);
    ok('your pick went in', t.wire('broadcast').slice(-1)[0].payload.s.pickedFlags[who]);
    t.send('p3', { t: 'pick', i: 0 });             // everyone has picked: hands pass
    ok('the new hand starts with nothing chosen', !takeIt(t, who) && /Take it/.test(t.text(who)));
  });
}

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
