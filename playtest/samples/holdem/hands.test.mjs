/*
 * hands.test.mjs — whole hands of HOLD'EM, played through the real game, with a stacked deck.
 *
 *   node playtest/samples/holdem/hands.test.mjs
 *
 * rules.test.mjs proves the evaluator and the pot arithmetic in isolation. The fuzzer
 * proves the game never crashes and that the chips always add up. Neither proves that
 * the GAME — the reducer, the blinds, the order of action, who is still in, which cards
 * it hands the evaluator — gets a particular hand right. So: deal known cards, play the
 * hand a person would, and assert exactly where every chip ends up.
 *
 * The deck is stacked by wrapping FR.rng before the bundle loads (the runner's
 * `beforeGame` hook), so this is the shipped game.js, unmodified, end to end.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// The bundle this file sits in — so a mutated copy (harness/mutants.mjs) tests the
// copy, not the original — and the dev kit it belongs to.
const BUNDLE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.FR_REPO || join(BUNDLE, '../../..');
const { runGame } = await import(pathToFileURL(join(REPO, 'harness/runner.mjs')).href);

let pass = 0, fail = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; out.push(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(what, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
function ok(what, cond) { if (!cond) throw new Error(what); }

/* Cards the way people say them: 'Ah', 'Td', '2c'. */
const S = { s: 0, h: 1, d: 2, c: 3 };
const RK = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const C = (str) => str.trim().split(/\s+/).map(t => ({ r: RK[t[0]], s: S[t[1]] }));

/**
 * Stack the deck for successive hands. Each hand is written in DEAL order: two hole
 * cards per seat in seat order, then burn + flop + burn + turn + burn + river.
 */
function stacked(...hands) {
  return (w) => {
    const real = w.FR.rng;
    w.FR.rng = (seed) => {
      const r = real(seed);
      let n = 0;
      r.shuffle = (deck) => {
        const want = C(hands[n++] || '');
        const rest = deck.filter(c => !want.some(x => x.r === c.r && x.s === c.s));
        return rest.concat(want.reverse());          // the game deals with pop()
      };
      return r;
    };
  };
}
const TABLE = { players: 3 };
async function table(opts, ...hands) {
  const t = await runGame({ game: BUNDLE, seed: 1, screens: 0, ...opts, beforeGame: stacked(...hands) });
  t.s = () => t.wire('broadcast').slice(-1)[0].payload.s;
  t.act = (id, msg) => {
    const before = t.refusedTotal();
    t.send(id, typeof msg === 'string' ? { t: msg } : msg);
    if (t.refusedTotal() !== before) {
      const why = t.rejections().slice(-1)[0];
      throw new Error(`${id} ${JSON.stringify(msg)} was refused (${why.why}) — to act: ${t.s().toAct}, phase ${t.s().phase}`);
    }
    return t;
  };
  t.settle = () => { t.advance(6000); return t; };
  return t;
}
const stacks = (t) => t.s().stacks;

/* --------------------------------------------------------------------------- */

await test('heads-up: the button posts the small blind and acts first, then last', async () => {
  const t = await table({ players: 2 }, 'Ah Kd 2c 7d 3s 9h 4h 5c 8d Jh 6s Qc');
  const s = t.s();
  eq('dealer', s.dealer, 'p0');
  eq('blinds', s.blinds, { sb: 'p0', bb: 'p1' });
  eq('first to act preflop', s.toAct, 'p0');
  eq('stacks after the blinds', stacks(t), { p0: 495, p1: 490 });
  t.act('p0', 'call').act('p1', 'check');
  t.advance(900);
  eq('street', t.s().street, 'flop');
  eq('first to act on the flop', t.s().toAct, 'p1');
});

await test('everyone folds to the big blind: the pot goes over unseen', async () => {
  const t = await table(TABLE, 'Ah Kd 2c 7d 9s 9h 3s 4h 5c 8d Jh 6s Qc');
  eq('blinds', t.s().blinds, { sb: 'p1', bb: 'p2' });
  eq('first to act preflop', t.s().toAct, 'p0');
  t.act('p0', 'fold').act('p1', 'fold');
  const s = t.s();
  eq('phase', s.phase, 'showdown');
  ok('uncontested', s.reveal.uncontested);
  eq('cards shown', s.reveal.hole, {});
  eq('stacks', s.stacks, { p0: 500, p1: 495, p2: 505 });
  t.settle();
  eq('phase after the beat', t.s().phase, 'handEnd');
});

await test('a showdown pays the best hand and turns over only the hands still in', async () => {
  // p0 aces, p1 kings, p2 junk who folds. Board gives p0 a set.
  const t = await table(TABLE, 'Ah Ad Kh Kd 2c 7d 3s Ac 9s 4h 5d 6c 8h Jd');
  t.act('p0', 'call').act('p1', 'call').act('p2', 'fold');
  for (const street of ['flop', 'turn', 'river']) {
    t.advance(900);
    eq(`${street}: first to act`, t.s().toAct, 'p1');
    t.act('p1', 'check').act('p0', 'check');
  }
  const s = t.s();
  eq('phase', s.phase, 'showdown');
  eq('who was shown', Object.keys(s.reveal.hole).sort(), ['p0', 'p1']);
  eq('paid', s.reveal.won, { p0: 30 });
  eq('hand', s.reveal.hands.p0, 'Three Aces');
  eq('stacks', s.stacks, { p0: 520, p1: 490, p2: 490 });
});

await test('a short all-in wins only the main pot; the side pot goes to the best of the rest', async () => {
  // Hand 1: p0 raises, both blinds fold — p0 515, p1 495, p2 490.
  // Hand 2: p1 (now the button) shoves 495, p2 calls all-in for 490, p0 calls.
  //   Main pot 1470 among all three; side pot 10 between p0 and p1.
  //   p2 has aces, p1 kings, p0 nothing: p2 takes 1470, p1 the 10, p0 keeps 20.
  const t = await table(TABLE,
    'Ah Kd 2c 7d 9s 9h 3s 4h 5c 8d Jh 6s Qc',
    '2c 7d Kh Kd Ah Ad 5s 9s 4h 3c 8s 6d Tc Js');
  t.act('p0', { t: 'raise', to: 20 }).act('p1', 'fold').act('p2', 'fold');
  t.settle();
  eq('after hand 1', stacks(t), { p0: 515, p1: 495, p2: 490 });
  t.act('p0', 'next');
  const s = t.s();
  eq('button moved', s.dealer, 'p1');
  eq('blinds', s.blinds, { sb: 'p2', bb: 'p0' });
  eq('first to act', s.toAct, 'p1');
  t.act('p1', { t: 'raise', to: 495 }).act('p2', 'call').act('p0', 'call');
  t.advance(4000);                          // the board runs out a card at a time
  const r = t.s();
  eq('phase', r.phase, 'showdown');
  eq('pots', r.reveal.pots.map(p => [p.amount, p.eligible.slice().sort()]), [[1470, ['p0', 'p1', 'p2']], [10, ['p0', 'p1']]]);
  eq('paid', r.reveal.won, { p2: 1470, p1: 10 });
  eq('stacks', r.stacks, { p0: 20, p1: 10, p2: 1470 });
});

await test('a split pot gives the odd chip to the first winner left of the button', async () => {
  // A royal flush on the board: everybody still in has it. p1 folds the small blind,
  // so the pot is 25 between p0 (the button) and p2 — and p2 sits first after the button.
  const t = await table(TABLE, '2c 3d 4c 5d 6c 7d 8h As Ks Qs 9h Js 9d Ts');
  t.act('p0', 'call').act('p1', 'fold').act('p2', 'check');
  for (let i = 0; i < 3; i++) { t.advance(900); t.act('p2', 'check').act('p0', 'check'); }
  const s = t.s();
  eq('paid', s.reveal.won, { p2: 13, p0: 12 });
});

await test('after a bust the button moves on one live seat a hand — nobody deals twice', async () => {
  // Hand 1: p3 shoves, the small blind p1 calls all in with nothing and busts. FR.seats
  // steps its dealer INDEX by one a hand, which landed on p2 for hands 2 AND 3 — p2 dealt
  // twice and p3 and p0 paid the blinds twice running.
  const t = await table({ players: 4 }, 'Kc Qd 7c 2d 9h 8h Ah Ad 3s 4h 5c Js 6d 9c Ts Jd');
  eq('hand 1 button', t.s().dealer, 'p0');
  t.act('p3', { t: 'raise', to: 500 }).act('p0', 'fold').act('p1', 'call').act('p2', 'fold');
  t.settle();
  eq('p1 is out', t.s().status.p1, 'out');
  const seen = [];
  for (let h = 0; h < 4; h++) {
    t.act('p0', 'next');
    const s = t.s();
    seen.push([s.dealer, s.blinds.sb, s.blinds.bb]);
    while (t.s().phase === 'betting' && t.s().toAct !== t.s().blinds.bb) t.act(t.s().toAct, 'fold');
    t.settle();
  }
  eq('button, small blind, big blind for hands 2-5', seen,
     [['p2', 'p3', 'p0'], ['p3', 'p0', 'p2'], ['p0', 'p2', 'p3'], ['p2', 'p3', 'p0']]);
});

await test('two players busting in one hand: the one who started it shorter finishes lower', async () => {
  // Hand 1 leaves p0 515, p1 495, p2 490. Hand 2: p1 shoves, p2 calls all in for less,
  // p0 calls and wins it all with aces. p2 sat down to that hand with less than p1, so
  // p2 is third. It used to be decided by seat order (the sort read chips already swept).
  const t = await table(TABLE,
    'Ah Kd 2c 7d 9s 9h 3s 4h 5c 8d Jh 6s Qc',
    'Ah Ad Kh Qd 7c 2d 5s 9s 4h 3c 8s 6d Tc Js');
  t.act('p0', { t: 'raise', to: 20 }).act('p1', 'fold').act('p2', 'fold');
  t.settle();
  eq('after hand 1', stacks(t), { p0: 515, p1: 495, p2: 490 });
  t.act('p0', 'next');
  t.act('p1', { t: 'raise', to: 495 }).act('p2', 'call').act('p0', 'call');
  t.advance(9000);
  ok('the game is over', t.over);
  eq('finishing order', t.result.standings.map(r => r.playerId), ['p0', 'p1', 'p2']);
});

await test('a phone that drops mid-hand comes back to exactly where it was', async () => {
  const t = await table(TABLE, 'Ah Ad Kh Kd 2c 7d 3s 9c 9s 4h 5d 6c 8h Jd');
  t.act('p0', 'call');
  const before = t.text('p1');
  t.disconnect('p1');
  t.advance(3000);
  t.reconnect('p1');                         // warm: its page never went anywhere
  eq('screen after a warm reconnect', t.text('p1'), before);
});

await test('a phone rebuilt from scratch mid-hand gets its own cards back, and nobody else\'s', async () => {
  // The app was killed: the shell rebuilds the page from the whole game so far. The
  // game has no resync code of its own — no `hello`, nothing — and needs none.
  const t = await table(TABLE, 'Ah Ad Kh Kd 2c 7d 3s 9c 9s 4h 5d 6c 8h Jd');
  t.act('p0', 'call');
  t.disconnect('p1');
  t.advance(3000);
  t.reconnect('p1', { cold: true });
  const text = t.text('p1');
  ok(`p1 sees its kings after a rebuild — screen: "${text.slice(0, 160)}"`, /K ♥/.test(text) && /K ♦/.test(text));
  ok('p1 does not see p0\'s aces', !/A ♥|A♥/.test(text));
  t.act('p1', 'call');                       // and it can carry on playing
  eq('p1 called', t.s().lastAction.p1, 'call');
});

await test('no TV: every phone is the table; a TV switched on mid-game hands it back', async () => {
  const t = await table(TABLE, 'Ah Kd 2c 7d 9s 9h 3s 4h 5c 8d Jh 6s Qc');
  ok('no TV: seats on the phone', /class="seats/.test(t.html('p1')));
  t.setScreens(1);
  eq('the host told everyone', t.view('p1').s.screen, 1);
  ok('TV on: no seats on the phone', !/class="seats/.test(t.html('p1')));
  t.setScreens(0);
  ok('TV off again: seats are back', /class="seats/.test(t.html('p1')));
});

await test('a TV switched on mid-hand: the felt moves to it, your cards and buttons stay, the hand plays on', async () => {
  const t = await table(TABLE, 'Ah Ad Kh Kd 2c 7d 3s 9c 9s 4h 5d 6c 8h Jd');
  t.act('p0', 'call').act('p1', 'call').act('p2', 'check');
  t.advance(900);
  eq('the flop, p1 to act', [t.s().street, t.s().toAct], ['flop', 'p1']);
  const said = t.wire('broadcast').length;
  t.setScreens(1);
  eq('the host told the room at once (and the TV, which only hears broadcasts)', t.wire('broadcast').length, said + 1);
  eq('the state says a TV is on', t.s().screen, 1);
  eq('nothing else about the hand moved', { ...t.s(), screen: 0 }, { ...t.wire('broadcast')[said - 1].payload.s, screen: 0 });
  ok('p1: no seats now — they are on the TV', !/class="seats/.test(t.html('p1')));
  ok('p1 still holds its kings', /K ♥/.test(t.text('p1')) && /K ♦/.test(t.text('p1')));
  ok('p1 still has its buttons', t.actions('p1').some(a => a.act === 'check'));
  t.act('p1', 'check').act('p2', 'check').act('p0', 'check');
  t.advance(900);
  eq('on to the turn', t.s().street, 'turn');
});

await test('a TV switched off mid-hand, while the table is frozen: every phone is the felt again, nothing stalls', async () => {
  const t = await table({ ...TABLE, screens: 1 }, 'Ah Ad Kh Kd 2c 7d 3s 9c 9s 4h 5d 6c 8h Jd');
  eq('with a TV from the start', t.s().screen, 1);
  ok('the phone is only your hand', !/class="seats/.test(t.html('p1')));
  t.act('p0', 'call').act('p1', 'call').act('p2', 'check');   // the flop lands on a held beat
  ok('the table is frozen for the flop', t.busy());
  t.setScreens(0);
  ok('every phone has the seats back at once', ['p0', 'p1', 'p2'].every(id => /class="seats/.test(t.html(id))));
  t.advance(900);
  eq('the held beat still ended: the flop, p1 to act', [t.s().street, t.s().phase, t.s().toAct], ['flop', 'betting', 'p1']);
  for (let i = 0; i < 3; i++) {                              // check it down, then the showdown
    const id = t.s().toAct;
    t.act(id, 'check').act(t.s().toAct, 'check').act(t.s().toAct, 'check');
    t.advance(900);
  }
  eq('a showdown', t.s().phase, 'showdown');
  t.setScreens(1);                                            // and back on, mid-showdown hold
  t.settle();
  eq('the hand ended normally', t.s().phase, 'handEnd');
  ok('the host can deal', t.actions('p0').some(a => a.act === 'next'));
});

await test('a host who folded is still offered the Deal button', async () => {
  // The bug this pins: "Folded this hand." was rendered INSTEAD of the Deal button,
  // and only the host can deal — the table sat there for good.
  const t = await table(TABLE, 'Ah Kd 2c 7d 9s 9h 3s 4h 5c 8d Jh 6s Qc');
  t.act('p0', 'fold').act('p1', 'fold');
  t.settle();
  eq('phase', t.s().phase, 'handEnd');
  ok('the host can deal', t.actions('p0').some(a => a.act === 'next'));
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
