/*
 * rounds.test.mjs — whole rounds of STREAK, played through the real game, with a stacked deck.
 *
 *   node playtest/samples/streak/rounds.test.mjs
 *
 * The fuzzer plays thousands of rounds and proves nothing crashes, stalls or scores a
 * line inconsistently with the cards on it (invariants.mjs). What it cannot see is a
 * RULE quietly changed: Flip Three dealing two cards conserves everything and breaks
 * nothing — a mutant that did exactly that survived every other check. So: deal known
 * cards and assert exactly what the rules say happens.
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

/* Cards in the order they are DRAWN: '5' a number, 'x2', '+4', 'T' Flip Three,
 * 'F' Freeze, 'S' Second Chance. */
const card = (t) => t === 'x2' ? { k: 'mod', mod: 'x2' }
  : t[0] === '+' ? { k: 'mod', mod: 'plus', v: Number(t.slice(1)) }
  : t === 'T' ? { k: 'act', act: 'triple' } : t === 'F' ? { k: 'act', act: 'freeze' }
  : t === 'S' ? { k: 'act', act: 'save' } : { k: 'num', v: Number(t) };
const same = (a, b) => a.k === b.k && a.v === b.v && a.mod === b.mod && a.act === b.act;

function stacked(draws) {
  return (w) => {
    const real = w.FR.rng;
    w.FR.rng = (seed) => {
      const r = real(seed);
      let first = true;
      r.shuffle = (deck) => {
        if (!first) return deck;
        first = false;
        const want = draws.trim().split(/\s+/).map(card);
        const rest = deck.slice();
        for (const c of want) { const i = rest.findIndex(x => same(x, c)); if (i >= 0) rest.splice(i, 1); }
        return rest.concat(want.reverse());          // the game draws with pop()
      };
      return r;
    };
  };
}

async function round(draws) {
  const t = await runGame({ game: BUNDLE, players: 2, seed: 1, beforeGame: stacked(draws) });
  t.s = () => t.wire('broadcast').slice(-1)[0].payload.s;
  t.p = (id) => t.s().players.find(p => p.id === id);
  t.act = (id, msg) => { t.send(id, msg); t.advance(2500); return t; };
  return t;
}

await test('Flip Three makes the target flip exactly three cards', async () => {
  const t = await round('T 3 7 9');
  t.act('p0', { t: 'flip' });                      // p0 draws Flip Three and must choose
  eq('p0 is choosing', t.s().pending && t.s().pending.chooserId, 'p0');
  t.act('p0', { t: 'target', id: 'p1' });
  eq("p1's line", t.p('p1').nums, [3, 7, 9]);
});

await test('×2 doubles the numbers on the line, not the bonuses', async () => {
  const t = await round('5 2 x2 +4');
  t.act('p0', { t: 'flip' }).act('p1', { t: 'flip' }).act('p0', { t: 'flip' }).act('p1', { t: 'flip' });
  t.act('p0', { t: 'bank' }).act('p1', { t: 'bank' });
  const s = t.s();
  eq('phase', s.phase, 'roundEnd');
  eq('p0 scored (5 × 2)', s.players.find(p => p.id === 'p0').lastRound, 10);
  eq('p1 scored (2 + 4)', s.players.find(p => p.id === 'p1').lastRound, 6);
});

await test('a second copy of a number busts the line to zero', async () => {
  const t = await round('5 3 5');
  t.act('p0', { t: 'flip' }).act('p1', { t: 'flip' }).act('p0', { t: 'flip' });
  eq('p0 busted', t.p('p0').status, 'busted');
  t.act('p1', { t: 'bank' });
  eq('p0 scored', t.p('p0').lastRound, 0);
  eq('p1 scored', t.p('p1').lastRound, 3);
});

await test('seven different numbers is a full streak: +15 and the round ends', async () => {
  const t = await round('1 2 3 4 5 6 7 8');
  t.act('p0', { t: 'flip' }).act('p1', { t: 'flip' }).act('p0', { t: 'flip' }).act('p1', { t: 'bank' });
  for (let i = 0; i < 5; i++) t.act('p0', { t: 'flip' });   // p0 alone: 4 5 6 7 8
  const s = t.s();
  eq('phase', s.phase, 'roundEnd');
  eq('p0 scored (1+3+4+5+6+7+8 + 15)', s.players.find(p => p.id === 'p0').lastRound, 49);
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
