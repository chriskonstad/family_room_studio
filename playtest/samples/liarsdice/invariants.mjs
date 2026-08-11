/*
 * Liar's Dice properties for the fuzzer — the rules only this game knows.
 * Called by the playtest after every turn and once at game end; return a string
 * to fail the run with a replayable seed, or null when all is well.
 *
 * Views are PER-PLAYER here (each phone gets its own hand via sendTo), so every
 * check runs against each phone's own last state, and cross-time checks are kept
 * per-phone — comparing one phone's fresh view against another's stale one would
 * false-positive.
 */
export default function liarsdiceInvariants({ table, players, done, result }) {
  const seen = table._diceSeen || (table._diceSeen = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s) continue;

    let total = 0;
    for (const [pid, n] of Object.entries(s.diceCount)) {
      if (!Number.isInteger(n) || n < 0) return `${pid} has ${n} dice on ${id}'s screen`;
      total += n;
    }
    if (total !== s.totalDice) {
      return `dice counts sum to ${total} but totalDice says ${s.totalDice} on ${id}'s screen`;
    }
    // Dice leave the game one challenge at a time and never come back.
    if (seen[id] !== undefined && total > seen[id]) {
      return `total dice rose from ${seen[id]} to ${total} on ${id}'s screen`;
    }
    seen[id] = total;

    const bid = s.lastBid;
    if (bid && (bid.qty < 1 || bid.face < 1 || bid.face > 6)) {
      return `impossible bid ${bid.qty} x ${bid.face} on ${id}'s screen`;
    }
    // Your own dice are the one hand you can always see, and there must be
    // exactly as many as the public count says you hold.
    if (s.phase === 'bidding' && s.ownDice.length !== (s.diceCount[id] || 0)) {
      return `${id} sees ${s.ownDice.length} of their own dice but is counted at ${s.diceCount[id]}`;
    }
  }
  if (done && result && result.winnerId) {
    const s = table.view(players[0])?.s;
    if (s && (s.diceCount[result.winnerId] || 0) <= 0) {
      return `winner ${result.winnerId} finished with no dice`;
    }
  }
  return null;
}
