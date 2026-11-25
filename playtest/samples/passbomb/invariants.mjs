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
/* Only whoever holds the bomb can throw it. A holder change mid-fuse must be the
 * broadcast that answers the holder's own `pass` to exactly that player — the sends
 * and broadcasts are read off the wire in order, so a bomb that changes hands any
 * other way (a bystander's tap, a guard gone missing) is caught the moment it moves. */
function onlyTheHolderThrows({ table }) {
  const m = table._pbWire || (table._pbWire = { i: 0, phase: null, holder: null, last: null });
  const wire = table.wire();
  for (; m.i < wire.length; m.i++) {
    const e = wire[m.i];
    if (e.kind === 'send') { m.last = e; continue; }
    if (e.kind !== 'broadcast' || !e.payload || !e.payload.s) continue;
    const s = e.payload.s;
    if (s.phase === 'live' && m.phase === 'live' && s.holder !== m.holder) {
      const p = m.last && m.last.payload;
      if (!p || p.t !== 'pass' || m.last.from !== m.holder || p.to !== s.holder) {
        return `the bomb went from ${m.holder} to ${s.holder} without ${m.holder} throwing it`
          + (p ? ` (last intent: ${m.last.from} ${JSON.stringify(p)})` : '');
      }
    }
    m.phase = s.phase; m.holder = s.holder;
  }
  return null;
}

export default function passbombInvariants(args) {
  return onlyTheHolderThrows(args) || basics(args);
}

function basics({ table, players, done, result }) {
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
