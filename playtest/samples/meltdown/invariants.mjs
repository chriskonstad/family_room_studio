/*
 * MELTDOWN's own rules. Co-op, so there's no turn and no elimination — the
 * properties are about the reactor itself: integrity is capped, levels only
 * climb, and the game must end the moment the reactor is gone.
 */
export default function meltdownInvariants({ table, players, done, result }) {
  const seen = table._meltLevel || (table._meltLevel = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || s.level === undefined) continue;

    if (s.integrity > 100) return `reactor integrity is ${s.integrity}, above the 100 cap`;
    if (s.level < 1) return `reactor is on level ${s.level}`;
    if (seen[id] !== undefined && s.level < seen[id]) {
      return `level fell from ${seen[id]} to ${s.level}`;
    }
    seen[id] = s.level;
    // Progress resets on level-up, so it never reaches the goal and sits there.
    if (s.progress < 0 || s.progress >= s.goal) {
      return `level progress is ${s.progress}/${s.goal} — a level-up was missed`;
    }
    // The reactor blowing is the end of the game, not a state to keep playing in.
    if (s.integrity <= 0 && s.phase !== 'over') {
      return `integrity hit ${s.integrity} but the reactor is still running`;
    }
    if (s.phase !== 'briefing' && s.phase !== 'running' && s.phase !== 'over') {
      return `unknown phase "${s.phase}"`;
    }
  }
  if (done && result && Array.isArray(result.standings)) {
    for (const row of result.standings) {
      if (row.score < 0) return `${row.playerId} completed ${row.score} orders`;
    }
  }
  return null;
}
