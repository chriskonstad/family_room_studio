/*
 * TEMPO's own rules. Judging is local to each phone and only the score reaches
 * the host, so the properties are about the run finishing cleanly: nobody
 * un-finishes, scores stay sane, and the track ends when everyone is done.
 */
export default function tempoInvariants({ table, players, done, result }) {
  const seen = table._tempoDone || (table._tempoDone = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.scores) continue;

    for (const [pid, n] of Object.entries(s.scores)) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        return `${pid} has a score of ${n}`;
      }
    }
    const mine = seen[id] || (seen[id] = {});
    for (const [pid, isDone] of Object.entries(s.finished)) {
      if (mine[pid] && !isDone) return `${pid} un-finished their run`;
      mine[pid] = isDone;
    }
    // The track is over exactly when every phone has reported in.
    const all = s.order.every(pid => s.finished[pid]);
    if (all && s.phase === 'playing') {
      return `every player finished but the game is still playing`;
    }
    if (s.phase === 'ready' && s.order.some(pid => s.finished[pid])) {
      return `somebody finished before the track started`;
    }
  }
  if (done && result && Array.isArray(result.standings) && result.standings.length) {
    const top = Math.max(...result.standings.map(r => r.score));
    const winner = result.standings.find(r => r.playerId === result.winnerId);
    if (winner && winner.score !== top) {
      return `winner ${result.winnerId} scored ${winner.score} but ${top} was the best`;
    }
  }
  return null;
}
