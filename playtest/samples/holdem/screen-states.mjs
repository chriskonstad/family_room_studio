/*
 * Frames a played game will not reach, drawn and held to the same layout rules.
 *
 * The screen harness plays a real game for 160 ticks, which is several hands of
 * HOLD'EM and nowhere near a whole tournament — so the frame with the confetti on
 * it, the one that only exists at the moment somebody wins the table, was never
 * once drawn. That is the frame fr-screen specifically warns about.
 *
 * The rest are the shapes a real table gets to eventually and a bot rarely does:
 * eight seats at once, a three-way all-in with side pots, hand names as long as
 * the game can produce, and the names people actually type into a party game.
 */

const NAMES = {
  p0: 'Alexandra', p1: 'Bo', p2: 'Christopher', p3: 'Dee',
  p4: 'Emmanuelle', p5: 'Fitz', p6: 'Georgina', p7: 'Hal'
};
const EMOJI = { p0:'🦊', p1:'🐙', p2:'🐸', p3:'🦉', p4:'🐝', p5:'🦄', p6:'🐳', p7:'🦁' };
const card = (r, s) => ({ r, s });

function base(ids, over) {
  const pick = (fn) => ids.reduce((o, id) => (o[id] = fn(id), o), {});
  return Object.assign({
    phase: 'betting', street: 'river', hand: 42, sb: 300, bb: 600,
    level: 7, levels: 9,
    order: ids.slice(),
    names: pick(id => NAMES[id]), emojis: pick(id => EMOJI[id]),
    stacks: pick(() => 1200), bet: pick(() => 0), committed: pick(() => 0),
    status: pick(() => 'active'),
    board: [card(14, 0), card(13, 0), card(7, 2), card(7, 1), card(2, 3)],
    pot: 0, collected: 0, betToMatch: 0, minRaise: 600,
    toAct: null, dealer: ids[0], blinds: { sb: ids[1], bb: ids[2] },
    lastAction: {}, banner: '', reveal: null,
    startChips: 500 * ids.length, removed: 0
  }, over || {});
}

const EIGHT = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
const HEADS_UP = ['p0', 'p1'];

export default [
  {
    // The whole reason this file exists: confetti, bounded, at every shape.
    name: 'game over, confetti flying',
    payload: { t: 'state', s: base(EIGHT, {
      phase: 'gameOver', street: 'river',
      stacks: { p0: 4000, p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 0 },
      status: { p0: 'active', p1: 'out', p2: 'out', p3: 'out', p4: 'out', p5: 'out', p6: 'out', p7: 'out' },
      banner: 'Alexandra wins 2400 with Full house, Sevens over Aces'
    }) }
  },
  {
    // Eight seats, three of them all-in, long names and five-figure numbers:
    // the busiest board the game can produce.
    name: 'eight seats mid-hand, three all-in',
    payload: { t: 'state', s: base(EIGHT, {
      phase: 'betting', street: 'turn',
      board: [card(14, 0), card(13, 0), card(7, 2), card(10, 1)],
      stacks: { p0: 0, p1: 14250, p2: 0, p3: 980, p4: 0, p5: 2400, p6: 600, p7: 120 },
      bet: { p0: 1200, p1: 1200, p2: 450, p3: 1200, p4: 75, p5: 0, p6: 0, p7: 0 },
      committed: { p0: 3600, p1: 3600, p2: 1050, p3: 3600, p4: 300, p5: 600, p6: 600, p7: 0 },
      status: { p0: 'allin', p1: 'active', p2: 'allin', p3: 'active', p4: 'allin',
                p5: 'folded', p6: 'folded', p7: 'folded' },
      lastAction: { p1: 'raise', p3: 'call', p5: 'fold', p6: 'fold', p7: 'fold' },
      pot: 13350, collected: 9225, betToMatch: 1200, minRaise: 600,
      toAct: 'p3', banner: 'Bo raises to 1200'
    }) }
  },
  {
    // A showdown with side pots and the longest hand names in the game.
    name: 'four-way showdown with a side pot',
    payload: { t: 'state', s: base(EIGHT.slice(0, 4), {
      phase: 'showdown', street: 'river',
      board: [card(7, 0), card(7, 1), card(7, 2), card(13, 3), card(13, 0)],
      stacks: { p0: 0, p1: 3200, p2: 0, p3: 450 },
      committed: { p0: 600, p1: 2400, p2: 2400, p3: 2400 },
      status: { p0: 'allin', p1: 'allin', p2: 'allin', p3: 'folded' },
      pot: 7800, collected: 7800,
      banner: 'Christopher wins 5400 with Full house, Sevens over Kings',
      reveal: {
        uncontested: false,
        hole: { p0: [card(14, 0), card(14, 1)], p1: [card(13, 1), card(12, 2)],
                p2: [card(7, 3), card(2, 1)] },
        hands: { p0: 'Two pair, Aces and Sevens', p1: 'Full house, Kings over Sevens',
                 p2: 'Four Sevens' },
        won: { p2: 5400, p0: 1800 },
        pots: [{ amount: 1800, eligible: ['p0', 'p1', 'p2'] },
               { amount: 6000, eligible: ['p1', 'p2'] }],
        detail: [{ pot: 0, amount: 1800, winners: ['p0'], name: 'Two pair, Aces and Sevens' },
                 { pot: 1, amount: 6000, winners: ['p2'], name: 'Four Sevens' }]
      }
    }) }
  },
  {
    // Heads-up, split pot, waiting on the host — the quietest frame, which is
    // also where a two-seat layout is most likely to look wrong.
    name: 'heads-up split pot, hand over',
    payload: { t: 'state', s: base(HEADS_UP, {
      phase: 'handEnd', street: 'river',
      stacks: { p0: 2000, p1: 2000 },
      committed: { p0: 0, p1: 0 },
      status: { p0: 'active', p1: 'active' },
      pot: 0, collected: 0,
      banner: 'Alexandra and Bo split the pot — Straight, Ace high',
      reveal: {
        uncontested: false,
        hole: { p0: [card(12, 0), card(11, 1)], p1: [card(12, 2), card(11, 3)] },
        hands: { p0: 'Straight, Ace high', p1: 'Straight, Ace high' },
        won: { p0: 1200, p1: 1200 },
        pots: [{ amount: 2400, eligible: ['p0', 'p1'] }],
        detail: [{ pot: 0, amount: 2400, winners: ['p0', 'p1'], name: 'Straight, Ace high' }]
      }
    }) }
  },
  {
    // One player takes it without showing a card. Nothing to reveal, and the
    // panel still has to look like something.
    name: 'uncontested win, nothing shown',
    payload: { t: 'state', s: base(EIGHT.slice(0, 5), {
      phase: 'showdown', street: 'preflop', board: [],
      banner: 'Dee wins 900 — everyone folded',
      status: { p0: 'folded', p1: 'folded', p2: 'folded', p3: 'active', p4: 'folded' },
      pot: 900, collected: 900,
      reveal: { uncontested: true, hole: {}, best: {}, hands: {},
                won: { p3: 900 }, pots: [], detail: [] }
    }) }
  }
];
