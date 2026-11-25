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
function liarsdiceInvariantsBase({ table, players, done, result }) {
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

/* Every bid beats the one before it, within a round. Accept one that doesn't and the
 * game plays on looking perfectly healthy — the dice still add up, somebody still
 * loses one — while the one rule that makes it Liar's Dice is gone. */
function extra({ table }) {
  const m = table._ldBids || (table._ldBids = { i: 0, round: null, last: null, who: null });
  const sends = table.wire('sendTo');
  for (; m.i < sends.length; m.i++) {
    const e = sends[m.i];
    if (!m.who) m.who = e.to;                       // one player's stream is the whole story
    if (e.to !== m.who || !e.payload || !e.payload.s) continue;
    const s = e.payload.s;
    if (s.round !== m.round) { m.round = s.round; m.last = null; }
    const b = s.lastBid;
    // No bid on the table: a new round, which opens fresh.
    if (!b) { m.last = null; continue; }
    if (m.last && (b.qty !== m.last.qty || b.face !== m.last.face)) {
      const beats = b.qty > m.last.qty || (b.qty === m.last.qty && b.face > m.last.face);
      if (!beats) return `round ${s.round}: a bid of ${b.qty} x ${b.face} was accepted after ${m.last.qty} x ${m.last.face}`;
    }
    m.last = { qty: b.qty, face: b.face };
  }
  return null;
}

/* Every challenge is settled by the dice, worked out here from the reveal rather than
 * by asking the game: count the bid's face (ones wild, except on a bid of ones), the
 * bid stood if there are at least that many, and then the challenger — or the bidder —
 * loses exactly one die. A resolution rule quietly changed (ones no longer wild, the
 * wrong player losing) leaves every count consistent; only recomputing it shows. */
function resolution({ table }) {
  const m = table._ldReveal || (table._ldReveal = { i: 0, who: null, before: null, judged: null });
  const sends = table.wire('sendTo');
  for (; m.i < sends.length; m.i++) {
    const e = sends[m.i];
    if (!m.who) m.who = e.to;
    if (e.to !== m.who || !e.payload || !e.payload.s) continue;
    const s = e.payload.s;
    if (s.phase === 'bidding') { m.before = s; continue; }
    const r = s.reveal;
    if (!r || !m.before || m.judged === s.round) continue;
    m.judged = s.round;
    const b = m.before;
    const { qty, face } = r.bid;
    if (!b.lastBid || b.lastBid.qty !== qty || b.lastBid.face !== face) {
      return `round ${s.round}: the challenge settled ${qty} x ${face}, but the bid on the table was `
           + (b.lastBid ? `${b.lastBid.qty} x ${b.lastBid.face}` : 'nothing');
    }
    let actual = 0;
    for (const id of b.order) {
      const dice = (r.dice && r.dice[id]) || [];
      if (dice.length !== (b.diceCount[id] || 0)) {
        return `round ${s.round}: the reveal shows ${dice.length} dice for ${id}, who held ${b.diceCount[id] || 0}`;
      }
      actual += dice.filter(d => face === 1 ? d === 1 : (d === face || d === 1)).length;
    }
    const stood = actual >= qty;
    const loser = stood ? r.challenger : b.lastBidder;
    if (r.actual !== actual || r.bidWasTrue !== stood || s.loser !== loser) {
      return `round ${s.round}: ${qty} x ${face} with ${actual} on the table should ${stood ? 'stand' : 'fall'} and cost `
           + `${loser} a die — the game says ${r.actual}, ${r.bidWasTrue ? 'stood' : 'fell'}, ${s.loser} loses`;
    }
    for (const id of b.order) {
      const want = (b.diceCount[id] || 0) - (id === loser ? 1 : 0);
      if ((s.diceCount[id] || 0) !== want) {
        return `round ${s.round}: ${id} has ${s.diceCount[id]} dice after the challenge, should have ${want}`;
      }
    }
  }
  return null;
}

export default function liarsdiceInvariants(args) {
  return extra(args) || resolution(args) || liarsdiceInvariantsBase(args);
}
