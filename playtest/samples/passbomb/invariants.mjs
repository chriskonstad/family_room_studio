/*
 * Game-specific properties the generic harness can't know. The playtest calls this
 * after every turn and once at game end; return a string to fail the run (the seed
 * replays straight to the violation), or null/undefined when all is well.
 *
 *   export default function ({ table, players, done, result }) { ... }
 *
 *   table    the runner handle — table.view(id) is what that phone last received
 *   players  ids still at the table (dropped phones excluded; their views are stale)
 *   done     true for the final call, after endGame
 *   result   the endGame payload (final call only)
 *
 * Per-run scratch state goes on `table` (it's fresh for every game) — see how
 * bot.mjs uses table._added.
 */
export default function passbombInvariants({ table, players, done, result }) {
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s) continue;                       // nothing received yet
    if (s.heat < 0 || s.heat > 1) {
      return `heat is ${s.heat}, outside [0,1], on ${id}'s screen`;
    }
    if (s.phase === 'live') {
      if (!s.order.includes(s.holder)) {
        return `the bomb is held by "${s.holder}", who isn't at this table`;
      }
      if (!s.alive[s.holder]) {
        return `the bomb is held by ${s.holder}, who is already out`;
      }
    }
  }
  if (done && result) {
    // Last one standing: the winner must still be alive on the final state.
    const s = table.view(players[0])?.s;
    if (s && result.winnerId && s.alive[result.winnerId] === false) {
      return `winner ${result.winnerId} is marked dead on the final screen`;
    }
  }
  return null;
}
