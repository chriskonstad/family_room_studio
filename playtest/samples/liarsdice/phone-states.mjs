/*
 * Phone screens a played game doesn't reach, drawn and held to the same layout rules as
 * every played screen (see harness/phone.mjs).
 *
 * A full table with names wider than the harness's long roster, bidding and revealed:
 * the seat columns must ellipsize names rather than widen. The bug this guards was
 * Linux-only — CI's WebKit fonts are wider than macOS's, and a plain `1fr` column ran
 * the right-hand seats off a 375pt screen (macOS truncated in time), so the fix
 * (`minmax(0,1fr)`) is proven by CI's phone check; these states keep both layouts
 * honest on every machine for names longer than any the played games use.
 */
const NAMES = ['Wolfgang-Amadeus', 'Maximilianne W.', 'Bartholomew-Jo', 'Christopher M.',
               'Anastasia W.W.', 'Emmanuelle-Rose', 'Georgina Wray', 'MMMMMMMMMMMM'];
const EMOJIS = ['🦊', '🐙', '🐸', '🦉', '🐝', '🦄', '🐳', '🦁'];
const ids = NAMES.map((_, i) => 'p' + i);
const each = (f) => Object.fromEntries(ids.map((id, i) => [id, f(id, i)]));

const view = (over) => ({
  phase: 'bidding', round: 1, names: each((id, i) => NAMES[i]), emojis: each((id, i) => EMOJIS[i]),
  order: ids.slice(), diceCount: each(() => 5), current: 'p1', lastBid: { qty: 12, face: 5 },
  lastBidder: 'p0', banner: 'Wolfgang-Amadeus bid 12 x 5. Maximilianne W. to bid or call.',
  totalDice: 40, loser: null, eliminated: [], reveal: null,
  ownDice: [1, 3, 5, 5, 6], legalBids: [], ...over
});

export default [
  {
    name: 'eight wide names, bidding, your turn',
    as: 'p1', players: 8,
    messages: [{ t: 'state', s: view({ legalBids: [{ qty: 12, face: 6 }, { qty: 13, face: 2 }] }) }]
  },
  {
    name: 'eight wide names, the dice revealed',
    as: 'p1', players: 8,
    messages: [{ t: 'state', s: view({
      phase: 'revealed', current: null, diceCount: each((id) => id === 'p0' ? 4 : 5),
      banner: 'Maximilianne W. caught the bluff. Wolfgang-Amadeus loses a die.',
      reveal: { challenger: 'p1', bid: { qty: 12, face: 5 }, actual: 9, bidWasTrue: false,
                dice: each(() => [1, 2, 4, 5, 6]) } }) }]
  }
];
