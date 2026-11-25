/*
 * TEMPO's own rules. Judging is local to each phone and only the score reaches
 * the host, so the properties are about the run finishing cleanly: nobody
 * un-finishes, scores stay sane, and the track ends when everyone is done.
 */
function tempoBase({ table, players, done, result }) {
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

/* The one thing a reloaded TEMPO phone is allowed to show differently: its own
 * running score and combo. Judging happens on the phone, and a phone back from the
 * lock screen resumes the track from the last score and position it streamed to the
 * host — at most a second behind the phone that never left. The scoreboard, which
 * comes from the host, must still match exactly. */
export const reconnectIgnore = [/score \d+ · combo \d+/];

/* A score only ever goes up: a TEMPO track has no penalties, so a score that falls is a
 * score that was lost — which is exactly what a phone reloading mid-track did, its
 * restarted run reporting zero over everything it had earned. Read every broadcast. */
function scoresOnlyRise({ table }) {
  const m = table._tempoBest || (table._tempoBest = { i: 0, best: {} });
  const all = table.wire('broadcast');
  for (; m.i < all.length; m.i++) {
    const s = all[m.i].payload && all[m.i].payload.s;
    if (!s || !s.scores) continue;
    for (const [id, v] of Object.entries(s.scores)) {
      if (v < (m.best[id] || 0)) return `${id}'s score fell from ${m.best[id]} to ${v}`;
      m.best[id] = Math.max(m.best[id] || 0, v);
    }
  }
  return null;
}

export default function tempoInvariants(args) {
  return scoresOnlyRise(args) || tempoBase(args);
}
