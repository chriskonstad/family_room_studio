/*
 * TAPAS's own rules, checked by the fuzzer after every turn and at game end.
 * The draft is simultaneous, so the strong properties are about symmetry and
 * conservation: every player's plate grows in lockstep, and within a round
 * plate + hand always add up to the hand size dealt.
 */
const TYPES = ['croqueta', 'skewer', 'gambas', 'tortilla1', 'tortilla2', 'tortilla3', 'aioli', 'churro'];

export default function tapasInvariants({ table, players, done, result }) {
  const seen = table._tapas || (table._tapas = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.tableau) continue;

    const mine = seen[id] || (seen[id] = { round: 0, size: 0, churros: {} });
    const lens = s.order.map(pid => (s.tableau[pid] || []).length);
    for (const pid of s.order) {
      for (const card of s.tableau[pid] || []) {
        if (!TYPES.includes(card)) return `${pid}'s plate holds unknown card "${card}"`;
      }
      // Churros are counted for the endgame majority: the running tally can never
      // be less than what's visibly on the plate, and it never goes down.
      const onPlate = (s.tableau[pid] || []).filter(c => c === 'churro').length;
      if ((s.churros[pid] || 0) < onPlate) {
        return `${pid} shows ${onPlate} churros on their plate but is only credited ${s.churros[pid]}`;
      }
      if (mine.churros[pid] !== undefined && (s.churros[pid] || 0) < mine.churros[pid]) {
        return `${pid}'s churro tally fell from ${mine.churros[pid]} to ${s.churros[pid]}`;
      }
      mine.churros[pid] = s.churros[pid] || 0;
    }
    // Simultaneous draft: picks resolve together, so every plate is the same size.
    if (s.phase === 'drafting' && lens.length && new Set(lens).size !== 1) {
      return `plates are uneven mid-draft: [${lens}] — picks are not resolving together`;
    }
    // Within a round, plate + hand is constant (each step moves exactly one card).
    if (s.phase === 'drafting' && lens.length) {
      const total = lens[0] + s.handCount;
      if (s.round !== mine.round) { mine.round = s.round; mine.size = total; }
      else if (total !== mine.size) {
        return `cards leaked mid-round: plate+hand was ${mine.size}, now ${total}`;
      }
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
