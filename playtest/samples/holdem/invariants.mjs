/*
 * HOLD'EM's own rules, checked after every turn and at game end.
 *
 * CHIPS ARE THIS GAME'S CARD CONSERVATION. Every outcome of a hand — the right
 * player winning, the wrong one winning, a side pot paid to somebody who never
 * matched it — looks identical to a fuzzer that only asks whether the game
 * crashed. What it cannot fake is the total: the table starts with a fixed number
 * of chips and every one of them is always in a stack or in the pot. This found a real bug on its first run — a
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

import R from './rules.js';

const STATUSES = ['active', 'allin', 'folded', 'out'];
const SUIT = ['♠', '♥', '♦', '♣'];
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

function blindsAndAction(s, mem) {
  /* The turn passes only when the player it was on acts. Anything else is the table
   * skipping somebody. A player has acted when their last action, their bet, or their
   * status changed. */
  const p = mem.prevB;
  mem.prevB = s;
  if (p && p.hand === s.hand && p.phase === 'betting' && s.phase === 'betting' && p.street === s.street
      && p.toAct && s.toAct && p.toAct !== s.toAct) {
    const id = p.toAct;
    const acted = (s.lastAction || {})[id] !== (p.lastAction || {})[id]
      || (s.bet || {})[id] !== (p.bet || {})[id] || s.status[id] !== p.status[id];
    if (!acted) {
      return `hand ${s.hand}, ${s.street}: the turn moved from ${id} to ${s.toAct}, but ${id} never acted`;
    }
  }
  /* The button moves one seat a hand, to the next player still in the game — whoever
   * busted. A button that stays put after a bust makes the same two players pay the
   * blinds twice running, and every chip still adds up. */
  if (s.hand !== mem.buttonHand) {
    if (mem.buttonHand && s.hand === mem.buttonHand + 1 && s.dealer) {
      const order = s.order, at = order.indexOf(mem.button);
      let want = null;
      for (let k = 1; k <= order.length && at >= 0; k++) {
        const c = order[(at + k) % order.length];
        if (s.status[c] !== 'out') { want = c; break; }
      }
      if (want && s.dealer !== want) {
        return `hand ${s.hand}: the button is on ${s.dealer}, but it was on ${mem.button} last hand `
             + `and the next player still in is ${want}`;
      }
    }
    mem.buttonHand = s.hand;
    mem.button = s.dealer;
  }
  if (s.phase === 'betting' && s.street === 'preflop' && s.blinds && s.hand !== mem.blindHand) {
    mem.blindHand = s.hand;
    const live = s.order.filter(id => s.status[id] !== 'out');
    const next = (from) => { const i = live.indexOf(from); return live[(i + 1) % live.length]; };
    if (live.includes(s.blinds.sb) && live.includes(s.blinds.bb) && live.includes(s.dealer)) {
      const sb = live.length === 2 ? s.dealer : next(s.dealer);
      const bb = next(sb);
      if (s.blinds.sb !== sb || s.blinds.bb !== bb) {
        return `hand ${s.hand}: blinds are ${s.blinds.sb}/${s.blinds.bb} with ${s.dealer} on the button `
             + `and ${live.length} players — they should be ${sb}/${bb}`;
      }
    }
  }
  // Before anybody has acted on a street, the action is where the rules put it.
  if (s.phase === 'betting' && s.toAct && Object.keys(s.lastAction || {}).length === 0) {
    const order = s.order, n = order.length;
    const after = (from, ok) => { const i = order.indexOf(from); for (let k = 1; k <= n; k++) { const c = order[(i + k) % n]; if (ok(c)) return c; } return null; };
    const canAct = (id) => s.status[id] === 'active';
    const want = s.street === 'preflop' ? after(s.blinds && s.blinds.bb, canAct) : after(s.dealer, canAct);
    if (want && s.toAct !== want) {
      return `${s.street} of hand ${s.hand}: ${s.toAct} is first to act but the rules say ${want} `
           + `(button ${s.dealer}, blinds ${s.blinds && s.blinds.sb}/${s.blinds && s.blinds.bb})`;
    }
  }
  return null;
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
  const accounted = stacks + committed;
  if (accounted !== s.startChips) {
    return `the table has ${accounted} chips but sat down with ${s.startChips} `
         + `(${stacks} in stacks, ${committed} in the pot) in phase ${s.phase}`;
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

  /* --------------------------------------------------- whose phone shows --- */

  // Every phone — the host's too, which holds every hole card in memory and so is
  // the one place a render bug could put somebody else's hand — shows only its own
  // cards, the board, and what a showdown has turned over. Cards render as their
  // rank and suit ("K ♠" in your hand, "K♠" in a seat row), so that is what to look
  // for; a card is unique, so seeing one is seeing THAT card.
  for (const viewer of players) {
    const text = table.text(viewer);
    if (!text) continue;
    for (const [owner, cs] of Object.entries(holes)) {
      if (owner === viewer || revealed[owner]) continue;
      for (const c of cs) {
        const face = R.RANK_SHORT[c.r] + SUIT[c.s];
        const spaced = R.RANK_SHORT[c.r] + ' ' + SUIT[c.s];
        if (boardKeys.includes(key(c))) continue;
        if (new RegExp('(^|[^0-9A-Z])(' + face + '|' + spaced + ')').test(text)) {
          return `${viewer}'s phone shows ${face}, which is ${owner}'s hole card (phase ${s.phase})`;
        }
      }
    }
  }

  /* ------------------------------------------- the blinds and who acts first --- */

  // Heads-up the button IS the small blind and acts first before the flop; three or
  // more, the blinds sit to the button's left. Get this wrong and every chip still
  // adds up — which is why nothing checked it.
  //
  // Judged on EVERY broadcast since the last look, not just the latest: the blinds and
  // the button are right or wrong at the moment a hand is dealt, and a check that only
  // saw the newest state would miss a hand that came and went between looks.
  const all = broadcasts;
  for (let i = mem.scanned || 0; i < all.length; i++) {
    const b = all[i].payload && all[i].payload.s;
    if (!b) continue;
    const bad = blindsAndAction(b, mem);
    if (bad) { mem.scanned = all.length; return bad; }
  }
  mem.scanned = all.length;

  /* ------------------------------------------------------------- payouts --- */

  // Every pot went to the best hand among the players who could win it — worked out
  // here from the cards the showdown turned over, not by asking the game. The
  // evaluator itself is proven in rules.test.mjs; this proves the game fed it the
  // right cards, the right players and the right pots, every showdown of every run.
  if (s.phase === 'showdown' && s.reveal && !s.reveal.uncontested && s.reveal.pots && s.reveal.pots.length
      && (s.board || []).length === 5 && s.reveal.hand !== s.hand) {
    const scores = {};
    for (const [id, cs] of Object.entries(revealed)) scores[id] = R.evaluate(cs.concat(s.board));
    const order = s.order, d = order.indexOf(s.dealer);
    const fromDealer = order.slice(d + 1).concat(order.slice(0, d + 1));
    const want = {};
    for (const pot of s.reveal.pots) {
      const live = pot.eligible.filter(id => scores[id]);
      if (!live.length) continue;
      const best = live.reduce((b, id) => (R.compare(scores[id], scores[b]) > 0 ? id : b), live[0]);
      const winners = live.filter(id => R.compare(scores[id], scores[best]) === 0)
        .sort((a, b) => fromDealer.indexOf(a) - fromDealer.indexOf(b));
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach((id, i) => { want[id] = (want[id] || 0) + share + (i < pot.amount - share * winners.length ? 1 : 0); });
    }
    const got = s.reveal.won || {};
    for (const id of new Set(Object.keys(want).concat(Object.keys(got)))) {
      if ((want[id] || 0) !== (got[id] || 0)) {
        return `hand ${s.hand}: ${id} was paid ${got[id] || 0} but the cards say ${want[id] || 0} `
             + `(${Object.entries(scores).map(([k, v]) => k + ': ' + v.name).join(', ')})`;
      }
    }
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
      if ((s.stacks[result.winnerId] || 0) !== s.startChips) {
        return `the winner finished with ${s.stacks[result.winnerId]} of the ${s.startChips} chips on the table`;
      }
    }
  }
  return null;
}
