/*
 * HOLD'EM's own rules, checked after every turn and at game end.
 *
 * CHIPS ARE THIS GAME'S CARD CONSERVATION. Every outcome of a hand — the right
 * player winning, the wrong one winning, a side pot paid to somebody who never
 * matched it — looks identical to a fuzzer that only asks whether the game
 * crashed. What it cannot fake is the total: the table starts with a fixed number
 * of chips and every one of them is always in a stack, in the pot, or in the
 * pocket of somebody who walked out. This found a real bug on its first run — a
 * pot credited to a stack while the same chips were still counted in `committed`,
 * so for the length of every showdown the room owned more money than it had sat
 * down with, and nothing visible went wrong.
 *
 * Which hand actually won is not here, because a property check cannot see it:
 * that lives in `rules.test.mjs`, against worked examples.
 *
 * THE OTHER HALF IS SECRECY. A screen cannot leak a hole card because it is never
 * sent one — but the HOST could, by putting one in a broadcast, and that is a bug
 * no screen check can see because by then the card is on every phone in the room.
 * So this reads the private deals off the wire and insists that no card dealt to
 * anybody appears in public until the showdown reveals it, and then only as that
 * player's own.
 */

const STATUSES = ['active', 'allin', 'folded', 'out'];
const BOARD_FOR = { preflop: 0, flop: 3, turn: 4, river: 5 };
const key = (c) => c.r + ':' + c.s;
const sum = (o) => Object.keys(o || {}).reduce((n, k) => n + (o[k] || 0), 0);

/** Every card-shaped object anywhere in a value, except under the keys we skip. */
function cards(value, skip, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { value.forEach(v => cards(v, skip, out)); return out; }
  if (typeof value.r === 'number' && typeof value.s === 'number' && Object.keys(value).length === 2) {
    out.push(value);
    return out;
  }
  for (const k of Object.keys(value)) {
    if (skip && skip.includes(k)) continue;
    cards(value[k], skip, out);
  }
  return out;
}

export default function holdemInvariants({ table, players, done, result }) {
  const broadcasts = table.wire('broadcast');
  const last = broadcasts[broadcasts.length - 1];
  if (!last || !last.payload || !last.payload.s) return null;
  const s = last.payload.s;
  const mem = table._holdem || (table._holdem = { hand: 0, startChips: s.startChips, level: 0 });

  /* ---------------------------------------------------------- the chips --- */

  const stacks = sum(s.stacks);
  const committed = sum(s.committed);
  const accounted = stacks + committed + (s.removed || 0);
  if (accounted !== s.startChips) {
    return `the table has ${accounted} chips but sat down with ${s.startChips} `
         + `(${stacks} in stacks, ${committed} in the pot, ${s.removed} walked out) in phase ${s.phase}`;
  }
  if (s.startChips !== mem.startChips) {
    return `the table's starting chips changed from ${mem.startChips} to ${s.startChips}`;
  }
  for (const id of s.order) {
    if ((s.stacks[id] || 0) < 0) return `${id} has a stack of ${s.stacks[id]}`;
    if ((s.bet[id] || 0) < 0) return `${id} has a bet of ${s.bet[id]}`;
    if ((s.committed[id] || 0) < (s.bet[id] || 0)) {
      return `${id} has ${s.bet[id]} in front of them but only ${s.committed[id]} committed all hand`;
    }
    if (!STATUSES.includes(s.status[id])) return `${id} has unknown status "${s.status[id]}"`;
    /* Being all-in means exactly one thing: no chips left — but only while there
     * is still betting to do. An all-in player who WINS has chips again the
     * moment the pot is pushed, and keeps the status until the next hand resets
     * it, so this is a rule about the betting round and not about the hand. */
    if (s.phase === 'betting' && s.status[id] === 'allin' && (s.stacks[id] || 0) !== 0) {
      return `${id} is all in with ${s.stacks[id]} still in front of them`;
    }
    if (s.status[id] === 'active' && (s.stacks[id] || 0) === 0 && s.phase === 'betting') {
      return `${id} is still live with no chips — they should be all in`;
    }
  }
  if (s.phase === 'betting' && s.pot !== committed) {
    return `the pot reads ${s.pot} but ${committed} has been committed`;
  }

  /* --------------------------------------------------------- the table --- */

  if (s.hand < mem.hand) return `the hand number went backwards, ${mem.hand} to ${s.hand}`;
  mem.hand = s.hand;
  if (s.level < mem.level) return `the blind level went down, ${mem.level} to ${s.level}`;
  mem.level = s.level;
  if (s.bb <= s.sb) return `the big blind (${s.bb}) is not bigger than the small blind (${s.sb})`;

  const expected = BOARD_FOR[s.street];
  if (expected === undefined) return `unknown street "${s.street}"`;
  if ((s.board || []).length !== expected) {
    return `${(s.board || []).length} cards on the board at ${s.street}, expected ${expected}`;
  }

  // Whoever the room is waiting on must actually be able to act. If this ever
  // disagrees with FR.host's own idea of the turn, every intent is refused and
  // the hand sits there forever — the exact shape of a game-night freeze.
  if (s.phase === 'betting' && s.toAct) {
    if (s.status[s.toAct] !== 'active') {
      return `the table is waiting on ${s.toAct}, whose status is "${s.status[s.toAct]}"`;
    }
    const legal = table.legalMoves(s.toAct) || [];
    if (!legal.length) {
      return `${s.toAct} is to act but the host offers them no legal move`;
    }
  }
  // Nobody can be left owing less than nothing, and the bet to match must be
  // something at least one live player has actually put up.
  if (s.phase === 'betting' && s.betToMatch > 0) {
    const matched = s.order.some(id => (s.bet[id] || 0) === s.betToMatch);
    if (!matched) return `the bet to match is ${s.betToMatch} but nobody has that much in front of them`;
  }

  /* ------------------------------------------------------------ secrecy --- */

  // What the host dealt privately, for the hand being played right now.
  const holes = {};
  for (const e of table.wire('sendTo')) {
    const p = e.payload;
    if (p && p.t === 'hole' && p.hand === s.hand && Array.isArray(p.cards)) holes[e.to] = p.cards;
  }
  const owner = {};
  for (const id of Object.keys(holes)) {
    for (const c of holes[id]) {
      if (owner[key(c)] && owner[key(c)] !== id) {
        return `the ${key(c)} was dealt to both ${owner[key(c)]} and ${id}`;
      }
      owner[key(c)] = id;
    }
  }
  // A card cannot be in a hand and on the board at once — there is one deck.
  for (const c of s.board || []) {
    if (owner[key(c)]) return `a card on the board was also dealt to ${owner[key(c)]}`;
  }
  const boardKeys = (s.board || []).map(key);
  if (new Set(boardKeys).size !== boardKeys.length) return `the board holds the same card twice`;

  // Nothing private may appear in the broadcast, except a player's own cards
  // inside the showdown reveal — which is what a showdown IS.
  const publicCards = cards(s, ['hole']);
  for (const c of publicCards) {
    if (owner[key(c)]) {
      return `${owner[key(c)]}'s hole card is in the public state outside the reveal (phase ${s.phase})`;
    }
  }
  const revealed = (s.reveal && s.reveal.hole) || {};
  for (const id of Object.keys(revealed)) {
    const shown = revealed[id].map(key).sort().join(',');
    const dealt = (holes[id] || []).map(key).sort().join(',');
    if (dealt && shown !== dealt) {
      return `the showdown shows ${id} holding ${shown}, but they were dealt ${dealt}`;
    }
    if (s.status[id] === 'folded') return `${id} folded but their cards were turned over`;
  }
  if (s.reveal && s.reveal.uncontested && Object.keys(revealed).length) {
    return `a hand won uncontested still showed cards`;
  }

  /* ------------------------------------------------------------- payouts --- */

  if (s.reveal && Array.isArray(s.reveal.pots)) {
    for (const pot of s.reveal.pots) {
      if (pot.amount <= 0) return `a pot of ${pot.amount} was created`;
      if (!pot.eligible.length) return `a pot of ${pot.amount} has nobody who can win it`;
      for (const id of pot.eligible) {
        if (!s.order.includes(id)) return `a pot is playable by "${id}", who is not at this table`;
      }
    }
    const paid = sum(s.reveal.won);
    const inPots = s.reveal.pots.reduce((n, p) => n + p.amount, 0);
    if (inPots && paid !== inPots) {
      return `${inPots} was in the pots but ${paid} was paid out`;
    }
  }

  /* ----------------------------------------------------------- the ending --- */

  if (done && result) {
    const left = s.order.filter(id => s.status[id] !== 'out');
    if (left.length > 1) {
      return `the game ended with ${left.length} players still holding chips`;
    }
    if (result.winnerId) {
      const inPlay = s.startChips - (s.removed || 0);
      if ((s.stacks[result.winnerId] || 0) !== inPlay) {
        return `the winner finished with ${s.stacks[result.winnerId]} of the ${inPlay} chips still on the table`;
      }
    }
  }
  return null;
}
