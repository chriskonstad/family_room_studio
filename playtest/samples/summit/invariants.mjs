/*
 * SUMMIT's own rules, checked by the fuzzer after every turn and at game end.
 * The strongest one is card conservation: the deck is 60 cards, and every card
 * is always in exactly one place — deck, a hand, a route, or a discard pile.
 * Any dupe or leak (the classic card-game bug) breaks the total immediately.
 */
const DECK_SIZE = 60;
const ROUTES = ['glacier', 'volcano', 'jungle', 'desert', 'reef'];

export default function summitInvariants({ table, players, done, result }) {
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
