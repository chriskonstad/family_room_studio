/*
 * SUMMIT's own rules, checked by the fuzzer after every turn and at game end.
 * The strongest one is card conservation: the deck is 60 cards, and every card
 * is always in exactly one place — deck, a hand, a route, or a discard pile.
 * Any dupe or leak (the classic card-game bug) breaks the total immediately.
 */
const DECK_SIZE = 60;
const ROUTES = ['glacier', 'volcano', 'jungle', 'desert', 'reef'];

/* Every round's score, worked out here from the routes left on the table: a route never
 * started is worth nothing; otherwise (its numbers − 20) × (1 + its wagers), and +20 for
 * eight cards or more. A scoring rule quietly changed (wagers that stop multiplying)
 * moves no card a conservation check can see. Judged on every broadcast, once a round. */
function routeScore(pile) {
  if (!pile.length) return 0;
  const wagers = pile.filter(c => c.v === 0).length;
  const sum = pile.reduce((a, c) => a + c.v, 0);
  return (sum - 20) * (1 + wagers) + (pile.length >= 8 ? 20 : 0);
}
function scoring({ table }) {
  const m = table._summitScored || (table._summitScored = { i: 0, round: null, totals: null });
  const all = table.wire('broadcast');
  for (; m.i < all.length; m.i++) {
    const s = all[m.i].payload && all[m.i].payload.s;
    if (!s || !s.routes || !s.totals) continue;
    if (!m.totals) m.totals = Object.fromEntries(s.order.map(id => [id, 0]));
    const over = s.phase === 'roundEnd' || s.phase === 'gameOver';
    if (!over || m.round === s.round) continue;
    m.round = s.round;
    for (const id of s.order) {
      const want = ROUTES.reduce((a, r) => a + routeScore(s.routes[id][r]), 0);
      if (!s.lastRound || s.lastRound[id] !== want) {
        return `round ${s.round}: ${id}'s routes are worth ${want}, but the round scored ${s.lastRound && s.lastRound[id]}`;
      }
      m.totals[id] += want;
      if (s.totals[id] !== m.totals[id]) {
        return `after round ${s.round} ${id} has ${s.totals[id]}, but their rounds add up to ${m.totals[id]}`;
      }
    }
  }
  return null;
}

/* Every card PLAYED onto a route beats what was already there: a wager only before any
 * number, a number only above the highest number. The route is stored sorted, so a
 * bad play doesn't show as a route out of order — it shows as the card that arrived,
 * found by comparing each broadcast's routes with the one before. */
function plays({ table }) {
  const m = table._summitPlays || (table._summitPlays = { i: 0, prev: null });
  const all = table.wire('broadcast');
  for (; m.i < all.length; m.i++) {
    const s = all[m.i].payload && all[m.i].payload.s;
    if (!s || !s.routes) continue;
    const p = m.prev;
    m.prev = s;
    if (!p || p.round !== s.round) continue;
    for (const id of s.order) {
      for (const r of ROUTES) {
        const before = p.routes[id][r], after = s.routes[id][r];
        if (after.length === before.length) continue;
        const left = before.map(c => c.v);
        const added = after.filter(c => { const k = left.indexOf(c.v); if (k === -1) return true; left.splice(k, 1); return false; });
        if (after.length !== before.length + 1 || added.length !== 1) {
          return `${id}'s ${r} route went from [${before.map(c => c.v)}] to [${after.map(c => c.v)}] in one move`;
        }
        const card = added[0], top = Math.max(0, ...before.map(c => c.v));
        if (card.v === 0 ? top > 0 : card.v <= top) {
          return `${id} played ${card.v || 'a wager'} on a ${r} route already showing ${top} — a route only climbs`;
        }
      }
    }
  }
  return null;
}

export default function summitInvariants(args) {
  return scoring(args) || plays(args) || summitInvariantsBase(args);
}

function summitInvariantsBase({ table, players, done, result }) {
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.routes) continue;

    let inPlay = s.deckCount;
    for (const n of Object.values(s.handCounts)) {
      if (n < 0 || n > 8) return `a hand holds ${n} cards on ${id}'s screen`;
      inPlay += n;
    }
    for (const r of ROUTES) {
      const d = s.discards[r];
      if (d.count < 0) return `${r} discard pile counts ${d.count}`;
      inPlay += d.count;
      for (const pid of s.order) {
        const pile = s.routes[pid][r];
        inPlay += pile.length;
        // Route rules: wagers (⭐, v=0) only underneath, then strictly climbing numbers.
        let last = 0, numbersStarted = false;
        for (const card of pile) {
          if (card.c !== r) return `${pid}'s ${r} route holds a ${card.c} card`;
          if (card.v === 0) {
            if (numbersStarted) return `${pid} has a wager on top of numbers on ${r}`;
          } else {
            if (card.v < 2 || card.v > 10) return `impossible card value ${card.v} on ${pid}'s ${r}`;
            if (card.v <= last) return `${pid}'s ${r} route isn't climbing: [${pile.map(c => c.v)}]`;
            last = card.v; numbersStarted = true;
          }
        }
        if (pile.filter(c => c.v === 0).length > 3) {
          return `${pid}'s ${r} route holds more wagers than exist in the deck`;
        }
      }
    }
    if (inPlay !== DECK_SIZE) {
      return `card conservation broke on ${id}'s screen: ${inPlay} cards accounted for, deck is ${DECK_SIZE}`;
    }

    if (s.phase === 'playing') {
      if (!s.order.includes(s.turn)) return `it is "${s.turn}"'s turn, but they aren't seated`;
      if (s.sub !== 'play' && s.sub !== 'draw') return `unknown sub-phase "${s.sub}"`;
    }
  }
  if (done && result && Array.isArray(result.standings) && result.standings.length) {
    const top = Math.max(...result.standings.map(r => r.score));
    const winner = result.standings.find(r => r.playerId === result.winnerId);
    if (winner && winner.score !== top) {
      return `winner ${result.winnerId} has ${winner.score} points but ${top} was the best total`;
    }
  }
  return null;
}
