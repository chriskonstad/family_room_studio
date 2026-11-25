/*
 * TAPAS's own rules, checked by the fuzzer after every turn and at game end.
 * The draft is simultaneous, so the strong properties are about symmetry and
 * conservation: every player's plate grows in lockstep, and within a round
 * plate + hand always add up to the hand size dealt.
 */
const TYPES = ['croqueta', 'skewer', 'gambas', 'tortilla1', 'tortilla2', 'tortilla3', 'aioli', 'churro'];

/* Every plate's score, worked out here from the dishes on it — croqueta pairs 5, skewer
 * sets of three 10, gambas 1/3/6/10/15/21/28, a tortilla tripled by an earlier aioli —
 * and at the end the churro majority (+6 split among the most, −6 among the fewest).
 * A scoring rule quietly changed conserves every card; only recomputing it shows. */
function plateScore(cards) {
  const count = (k) => cards.filter(c => c === k).length;
  let s = Math.floor(count('croqueta') / 2) * 5 + Math.floor(count('skewer') / 3) * 10;
  s += [0, 1, 3, 6, 10, 15, 21, 28][Math.min(count('gambas'), 7)];
  let aiolis = 0;
  for (const c of cards) {
    if (c === 'aioli') { aiolis++; continue; }
    const v = c === 'tortilla1' ? 1 : c === 'tortilla2' ? 2 : c === 'tortilla3' ? 3 : 0;
    if (v) { s += aiolis > 0 ? v * 3 : v; if (aiolis > 0) aiolis--; }
  }
  return s;
}
function scoring({ table }) {
  const m = table._tapasScored || (table._tapasScored = { i: 0, round: null, sum: null });
  const all = table.wire('broadcast');
  for (; m.i < all.length; m.i++) {
    const s = all[m.i].payload && all[m.i].payload.s;
    if (!s || !s.tableau || !s.lastRound) continue;
    if (s.phase !== 'roundEnd' && s.phase !== 'gameOver') continue;
    if (m.round === s.round) continue;
    m.round = s.round;
    if (!m.sum) m.sum = Object.fromEntries(s.order.map(id => [id, 0]));
    for (const id of s.order) {
      const want = plateScore(s.tableau[id] || []);
      if (s.lastRound[id] !== want) {
        return `round ${s.round}: ${id}'s plate [${(s.tableau[id] || []).join(' ')}] is worth ${want}, but scored ${s.lastRound[id]}`;
      }
      m.sum[id] += want;
    }
    const final = { ...m.sum };
    if (s.phase === 'gameOver') {
      const n = s.order.map(id => s.churros[id] || 0);
      const most = Math.max(...n), least = Math.min(...n);
      if (most > 0 && most !== least) {
        const top = s.order.filter(id => (s.churros[id] || 0) === most);
        const low = s.order.filter(id => (s.churros[id] || 0) === least);
        top.forEach(id => { final[id] += Math.floor(6 / top.length); });
        low.forEach(id => { final[id] -= Math.floor(6 / low.length); });
      }
    }
    for (const id of s.order) {
      if (s.totals[id] !== final[id]) {
        return `after round ${s.round} ${id} has ${s.totals[id]}, but their plates${s.phase === 'gameOver' ? ' and churros' : ''} add up to ${final[id]}`;
      }
    }
  }
  return null;
}

export default function tapasInvariants(args) {
  return scoring(args) || tapasInvariantsBase(args);
}

function tapasInvariantsBase({ table, players, done, result }) {
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
