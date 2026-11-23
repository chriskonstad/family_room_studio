/*
 * rules.test.mjs — the poker, checked.
 *
 *   node playtest/samples/holdem/rules.test.mjs
 *
 * The fuzzer can tell you a hand of Hold'em never crashed and that the chips add
 * up. It cannot tell you a flush beat a straight, because both outcomes conserve
 * chips perfectly. Whether the right hand won is a question only a table of known
 * answers can settle, so that is what this is.
 *
 * Side pots get as much attention as the evaluator. A short all-in winning money
 * it never matched is the bug that ends an evening, and it is pure arithmetic —
 * which means it can be pinned down exactly, here, rather than hoped about.
 */
import R from './rules.js';

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/* Cards written the way a person says them: 'Ah', 'Td', '2c'. */
const S = { s: 0, h: 1, d: 2, c: 3 };
const RK = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const C = (str) => str.trim().split(/\s+/).map(t => ({ r: RK[t[0]], s: S[t[1]] }));

/* ------------------------------------------------------------ categories --- */

const EXAMPLES = [
  ['high card',      'Ah Kd 9c 7s 4h'],
  ['pair',           '9h 9d Kc 7s 4h'],
  ['two pair',       '9h 9d 7c 7s 4h'],
  ['trips',          '9h 9d 9c 7s 4h'],
  ['straight',       '5h 6d 7c 8s 9h'],
  ['flush',          '2h 5h 9h Jh Kh'],
  ['full house',     '9h 9d 9c 7s 7h'],
  ['quads',          '9h 9d 9c 9s 7h'],
  ['straight flush', '5h 6h 7h 8h 9h']
];
// Each category beats every category below it. Asserting the whole ladder rather
// than a few pairs: an evaluator with two categories transposed passes most
// spot-checks and loses exactly one pot a night.
for (let i = 0; i < EXAMPLES.length; i++) {
  for (let j = 0; j < i; j++) {
    const hi = R.evaluate5(C(EXAMPLES[i][1]));
    const lo = R.evaluate5(C(EXAMPLES[j][1]));
    ok(`${EXAMPLES[i][0]} beats ${EXAMPLES[j][0]}`, R.compare(hi, lo) > 0);
  }
}
eq('categories are ordered 0..8', EXAMPLES.map(e => R.evaluate5(C(e[1])).cat),
   [0, 1, 2, 3, 4, 5, 6, 7, 8]);

/* -------------------------------------------------------------- straights --- */

ok('the wheel is a straight', R.evaluate5(C('Ah 2d 3c 4s 5h')).cat === R.CAT.STRAIGHT);
eq('the wheel is five-high', R.evaluate5(C('Ah 2d 3c 4s 5h')).tb, [5]);
ok('six-high beats the wheel',
   R.compare(R.evaluate5(C('2h 3d 4c 5s 6h')), R.evaluate5(C('Ah 2d 3c 4s 5h'))) > 0);
ok('ace-high straight beats king-high',
   R.compare(R.evaluate5(C('Ah Kd Qc Js Th')), R.evaluate5(C('Kh Qd Jc Ts 9h'))) > 0);
ok('a wheel in one suit is a straight flush',
   R.evaluate5(C('Ah 2h 3h 4h 5h')).cat === R.CAT.STRAIGHT_FLUSH);
ok('royal flush is named', R.evaluate(C('Ah Kh Qh Jh Th')).name === 'Royal flush');
ok('A-K-Q-J-9 is not a straight', R.evaluate5(C('Ah Kd Qc Js 9h')).cat === R.CAT.HIGH);
ok('K-Q-J-T-9 with an ace around is still a straight',
   R.evaluate(C('Ah Kd Qc Js Th 9h 2c')).tb[0] === 14);

/* ------------------------------------------------------------- tiebreaks --- */

ok('higher full house trips win',
   R.compare(R.evaluate5(C('Kh Kd Kc 2s 2h')), R.evaluate5(C('Qh Qd Qc As Ah'))) > 0);
ok('equal trips, higher pair wins',
   R.compare(R.evaluate5(C('Kh Kd Kc As Ah')), R.evaluate5(C('Ks Kc Kh 2s 2h'))) > 0);
ok('quads kicker matters',
   R.compare(R.evaluate5(C('9h 9d 9c 9s Kh')), R.evaluate5(C('9h 9d 9c 9s Qh'))) > 0);
ok('two pair kicker matters',
   R.compare(R.evaluate5(C('9h 9d 7c 7s Kh')), R.evaluate5(C('9h 9d 7c 7s Qh'))) > 0);
ok('higher top pair beats higher kicker',
   R.compare(R.evaluate5(C('Th Td 2c 3s 4h')), R.evaluate5(C('9h 9d Ac Ks Qh'))) > 0);
ok('flush compares all five cards',
   R.compare(R.evaluate5(C('Ah Kh Qh Jh 9h')), R.evaluate5(C('Ah Kh Qh Jh 8h'))) > 0);
ok('identical hands in different suits tie',
   R.compare(R.evaluate5(C('Ah Kd Qc Js 9h')), R.evaluate5(C('As Kh Qd Jc 9s'))) === 0);

/* ------------------------------------------------------- best five of N --- */

// The point of brute force: it cannot pick the wrong kicker.
eq('seven cards, best five is the flush',
   R.evaluate(C('2h 5h 9h Jh Kh Ad As')).cat, R.CAT.FLUSH);
eq('seven cards, trips plus two pair is a full house',
   R.evaluate(C('9h 9d 9c 7s 7h 2d 3c')).cat, R.CAT.FULL_HOUSE);
ok('the five returned are the five that made the hand',
   R.evaluate(C('2h 5h 9h Jh Kh Ad As')).cards.every(c => c.s === S.h));
eq('six cards work too', R.evaluate(C('Ah Kh Qh Jh Th 2c')).name, 'Royal flush');
ok('fewer than five cards is refused', (() => {
  try { R.evaluate(C('Ah Kh')); return false; } catch (e) { return true; }
})());

/* -------------------------------------------------------------- describe --- */

eq('preflop pair', R.describe(C('Kh Kd'), []), 'Pair of Kings');
eq('preflop suited', R.describe(C('Ah Th'), []), 'Ace-Ten suited');
eq('preflop offsuit', R.describe(C('Ah Td'), []), 'Ace-Ten');
eq('describe uses the board once there is one',
   R.describe(C('Ah Kh'), C('Qh Jh Th')), 'Royal flush');
eq('describe says nothing with no hand', R.describe([], []), '');

/* ------------------------------------------------------------ side pots --- */

const pots1 = R.buildPots([
  { id: 'a', committed: 100, folded: false },
  { id: 'b', committed: 100, folded: false }
]);
eq('an even pot is one pot', pots1, [{ amount: 200, eligible: ['a', 'b'] }]);

// The case this function exists for: a short all-in cannot win what it never
// matched. 'a' is in for 50, so the main pot is 50x3 and the rest is b-and-c only.
const pots2 = R.buildPots([
  { id: 'a', committed: 50, folded: false },
  { id: 'b', committed: 200, folded: false },
  { id: 'c', committed: 200, folded: false }
]);
eq('a short all-in makes a side pot', pots2, [
  { amount: 150, eligible: ['a', 'b', 'c'] },
  { amount: 300, eligible: ['b', 'c'] }
]);

const pots3 = R.buildPots([
  { id: 'a', committed: 25, folded: false },
  { id: 'b', committed: 60, folded: false },
  { id: 'c', committed: 100, folded: false },
  { id: 'd', committed: 100, folded: false }
]);
eq('two all-ins make three pots', pots3, [
  { amount: 100, eligible: ['a', 'b', 'c', 'd'] },
  { amount: 105, eligible: ['b', 'c', 'd'] },
  { amount: 80, eligible: ['c', 'd'] }
]);
eq('every chip committed is in some pot',
   pots3.reduce((n, p) => n + p.amount, 0), 285);

// A folded player's chips stay in the pot and are won by someone else. Getting
// this wrong either loses chips from the table or pays the folder.
const pots4 = R.buildPots([
  { id: 'a', committed: 30, folded: true },
  { id: 'b', committed: 100, folded: false },
  { id: 'c', committed: 100, folded: false }
]);
eq('folded chips are in the pot but win nothing', pots4,
   [{ amount: 230, eligible: ['b', 'c'] }]);
const pots5 = R.buildPots([
  { id: 'a', committed: 10, folded: true },
  { id: 'b', committed: 10, folded: true },
  { id: 'c', committed: 10, folded: false }
]);
eq('everyone else folding leaves one pot for the survivor', pots5,
   [{ amount: 30, eligible: ['c'] }]);
eq('nobody committed anything is no pots', R.buildPots([{ id: 'a', committed: 0, folded: false }]), []);

/* ----------------------------------------------------------- the payout --- */

const sc = (str) => R.evaluate(C(str));
const award1 = R.awardPots(
  [{ amount: 200, eligible: ['a', 'b'] }],
  { a: sc('Ah Kh Qh Jh 9h'), b: sc('9s 9d 9c 2s 3d') },
  ['a', 'b']
);
eq('the better hand takes the pot', award1.won, { a: 200 });
const award1b = R.awardPots(
  [{ amount: 200, eligible: ['a', 'b'] }],
  { a: sc('Ah Kd Qc Js Th'), b: sc('9h 9d 9c 9s 2h') },
  ['a', 'b']
);
eq('quads beat a straight, however pretty the straight', award1b.won, { b: 200 });

const award2 = R.awardPots(
  [{ amount: 200, eligible: ['a', 'b'] }],
  { a: sc('Ah Kd Qc Js 9h'), b: sc('As Kh Qd Jc 9s') },
  ['a', 'b']
);
eq('a tie splits the pot', award2.won, { a: 100, b: 100 });

const award3 = R.awardPots(
  [{ amount: 201, eligible: ['a', 'b'] }],
  { a: sc('Ah Kd Qc Js 9h'), b: sc('As Kh Qd Jc 9s') },
  ['b', 'a']      // seat order decides the odd chip, not object order
);
eq('the odd chip goes to the first seat', award3.won, { b: 101, a: 100 });

// The whole reason for side pots: the short stack wins the main pot with the best
// hand, and the side pot it never matched goes to the best of the others.
const award4 = R.awardPots(
  [{ amount: 150, eligible: ['a', 'b', 'c'] }, { amount: 300, eligible: ['b', 'c'] }],
  { a: sc('Ah Ad Ac As 2h'), b: sc('Kh Kd Kc Ks 3h'), c: sc('2h 3d 4c 5s 7h') },
  ['a', 'b', 'c']
);
eq('short all-in wins only the main pot', award4.won, { a: 150, b: 300 });
eq('each pot reports the hand that took it', award4.detail.map(d => d.winners[0]), ['a', 'b']);

/* ------------------------------------------------------------- the deck --- */

const d = R.deck();
eq('fifty-two cards', d.length, 52);
eq('no duplicates', new Set(d.map(c => c.r + ':' + c.s)).size, 52);
eq('four of every rank', new Set(d.filter(c => c.r === 14).map(c => c.s)).size, 4);

/* --------------------------------------------------------------- report --- */

results.forEach(line => console.log(line));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
