/*
 * BLITZ's own rules. The game is a tap race to 10, so the properties are about
 * the score only ever climbing, one tap at a time, and stopping at the goal.
 */
const GOAL = 10;

export default function blitzInvariants({ table, players, done, result }) {
  const seen = table._blitzScores || (table._blitzScores = {});
  for (const id of players) {
    const v = table.view(id);
    if (!v || !v.scores) continue;

    const mine = seen[id] || (seen[id] = {});
    for (const [pid, n] of Object.entries(v.scores)) {
      if (!Number.isInteger(n) || n < 0) return `${pid} has a score of ${n}`;
      if (n > GOAL) return `${pid} scored ${n}, past the goal of ${GOAL} — taps kept landing after the win`;
      // Only monotonicity is asserted, not the size of the jump: this runs once per
      // turn and several taps legitimately land in between (everyone may tap at once,
      // and hostile runs inject more), so a per-interval delta bound would be false.
      if (mine[pid] !== undefined && n < mine[pid]) {
        return `${pid}'s score fell from ${mine[pid]} to ${n}`;
      }
      mine[pid] = n;
    }
    // A winner is declared exactly when someone reaches the goal — never early,
    // and the race stops there.
    if (v.winner && v.scores[v.winner] !== GOAL) {
      return `${v.winner} won with ${v.scores[v.winner]} taps instead of ${GOAL}`;
    }
    if (!v.winner && Object.values(v.scores).some(n => n >= GOAL)) {
      return `someone reached ${GOAL} taps but no winner was declared`;
    }
  }
  if (done && result && result.winnerId) {
    const winner = (result.standings || []).find(r => r.playerId === result.winnerId);
    if (winner && winner.score !== GOAL) {
      return `winner ${result.winnerId} finished on ${winner.score}, not ${GOAL}`;
    }
  }
  return null;
}
