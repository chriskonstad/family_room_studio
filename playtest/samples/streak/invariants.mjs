/*
 * STREAK's own rules, checked by the fuzzer after every turn and at game end.
 * Return a string to fail the run (the printed seed replays straight to it).
 */
const STATUSES = ['active', 'busted', 'frozen', 'stayed'];
const DECK_SIZE = 94;

export default function streakInvariants({ table, players, done, result }) {
  const seenTotals = table._streakTotals || (table._streakTotals = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.players) continue;

    if (s.deckLeft < 0 || s.discardLeft < 0 || s.deckLeft + s.discardLeft > DECK_SIZE) {
      return `deck accounting broke on ${id}'s screen: ${s.deckLeft} in deck, ${s.discardLeft} discarded (deck is ${DECK_SIZE})`;
    }
    const seated = s.players.map(p => p.id);
    if (s.phase === 'playing' && s.turn != null && !seated.includes(s.turn)) {
      return `it is "${s.turn}"'s turn, but they aren't seated`;
    }
    if (s.pending) {
      if (!seated.includes(s.pending.chooserId)) {
        return `pending action belongs to "${s.pending.chooserId}", who isn't seated`;
      }
      if (!s.pending.eligible.length || s.pending.eligible.some(t => !seated.includes(t))) {
        return `pending ${s.pending.action} has an invalid target list [${s.pending.eligible}]`;
      }
    }

    const mine = seenTotals[id] || (seenTotals[id] = {});
    for (const p of s.players) {
      // A line can never contain a duplicate — drawing one is exactly what a bust is.
      if (new Set(p.nums).size !== p.nums.length) {
        return `${p.id}'s line holds a duplicate: [${p.nums}]`;
      }
      if (p.nums.length > 7 || p.nums.some(n => n < 0 || n > 12)) {
        return `${p.id}'s line is impossible: [${p.nums}]`;
      }
      if (!STATUSES.includes(p.status)) return `${p.id} has unknown status "${p.status}"`;
      if (p.status === 'busted' && p.roundPts !== 0) {
        return `${p.id} busted but still shows ${p.roundPts} round points`;
      }
      // Banked totals only ever grow — a bust zeroes the ROUND, never the bank.
      if (mine[p.id] !== undefined && p.total < mine[p.id]) {
        return `${p.id}'s banked total fell from ${mine[p.id]} to ${p.total}`;
      }
      mine[p.id] = p.total;
    }
    if (s.phase === 'gameOver' && s.winner) {
      const w = s.players.find(p => p.id === s.winner);
      if (!w || w.total < 200) return `winner ${s.winner} declared below the 200-point goal`;
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
