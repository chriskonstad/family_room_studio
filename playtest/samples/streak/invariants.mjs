/*
 * STREAK's own rules, checked by the fuzzer after every turn and at game end.
 * Return a string to fail the run (the printed seed replays straight to it).
 */
const STATUSES = ['active', 'busted', 'frozen', 'stayed'];
const DECK_SIZE = 94;

function streakInvariantsBase({ table, players, done, result }) {
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

/* A round is scored once. Scoring it twice adds everybody's line to their total again: every total
 * still only ever goes up, so nothing else here would notice. Read every broadcast,
 * in order, and allow the totals to move once per round. */
function extra({ table }) {
  const m = table._streakScored || (table._streakScored = { i: 0, sig: null, scored: null });
  const all = table.wire('broadcast');
  for (; m.i < all.length; m.i++) {
    const s = all[m.i].payload && all[m.i].payload.s;
    if (!s || !s.players) continue;
    const sig = JSON.stringify(s.players.map(p => p.total));
    if (m.sig !== null && sig !== m.sig) {
      if (m.scored === s.round) return `round ${s.round} was scored twice — totals moved again after it ended`;
      m.scored = s.round;
    }
    m.sig = sig;
  }
  return null;
}

/* Every line's points, worked out here from the cards on it — numbers summed, doubled
 * by a ×2, plus the bonus cards, +15 for seven different numbers, nothing at all once
 * busted. A scoring rule quietly changed (a ×2 that stopped doubling) moves no chip a
 * generic check can see; recomputing the score from the visible line does. */
function scores({ table }) {
  const b = table.wire('broadcast').slice(-1)[0];
  const s = b && b.payload && b.payload.s;
  if (!s || !s.players) return null;
  for (const p of s.players) {
    const nums = p.nums || [], mods = p.mods || [];
    let want = nums.reduce((a, v) => a + v, 0);
    if (mods.some(m => m.mod === 'x2')) want *= 2;
    want += mods.filter(m => m.mod === 'plus').reduce((a, m) => a + m.v, 0);
    if (nums.length === 7) want += 15;
    if (p.status === 'busted') want = 0;
    if (p.roundPts !== want) {
      return `${p.id}'s line [${nums.join(' ')}${mods.length ? ' | ' + mods.map(m => m.mod === 'x2' ? '×2' : '+' + m.v).join(' ') : ''}] `
           + `shows ${p.roundPts} points; the cards say ${want}`;
    }
  }
  return null;
}

export default function streakInvariants(args) {
  return extra(args) || scores(args) || streakInvariantsBase(args);
}
