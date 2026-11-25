/*
 * entry.test.mjs — filling the bowl, through the real controls, and a phone rebuilt mid-way.
 *
 *   node playtest/samples/fishbowl/entry.test.mjs
 *
 * The fuzzer's bot types its phrases straight onto the wire (bot.mjs), so it never
 * touches the writing form — and the form is where a page keeps what it did itself:
 * how many phrases it dropped in, and whether it said it was done. A page rebuilt from
 * the history (iOS killed the app) has to get both back from the host.
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

async function table() {
  const t = await runGame({ game: BUNDLE, players: 4, seed: 3 });
  t.control = (id, label, shadow) => t.clickable(id, shadow).find(h => (h.textContent || '').includes(label));
  /* Type into the phrase box and press the button, as a thumb would. */
  t.write = (id, phrase) => {
    const btn = t.control(id, 'Drop it');
    btn._owner.querySelector('#ph').value = phrase;
    t.press(id, btn);
    return t;
  };
  t.rebuild = (id) => { t.disconnect(id); t.advance(3000); t.reconnect(id, { cold: true, shadow: true }); return t; };
  return t;
}

await test('a phone rebuilt after "I\'m done" comes back done, with nothing left to press', async () => {
  const t = await table();
  t.write('p1', 'otter').write('p1', 'banjo');
  t.press('p1', t.control('p1', "I'm done"));
  t.rebuild('p1');
  const text = t.text('p1', true);
  ok(`the rebuilt phone is waiting, not writing — screen: "${text.slice(0, 200)}"`, /You’re done/.test(text));
  ok('the rebuilt phone offers no writing controls (the host would refuse them all)',
     !t.control('p1', 'Drop it', true) && !t.control('p1', "I'm done", true));
  ok('and it agrees with the phone that never dropped', text === t.text('p1'));
});

await test('a phone rebuilt mid-writing can still say it is done', async () => {
  const t = await table();
  t.write('p1', 'otter').write('p1', 'banjo');
  t.rebuild('p1');
  const done = t.control('p1', "I'm done", true);
  ok('"I\'m done writing" is live on the rebuilt phone — it has two phrases in the bowl', !!done);
  ok('the rebuilt phone counts them', /You’ve added 2/.test(t.text('p1', true)));
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
