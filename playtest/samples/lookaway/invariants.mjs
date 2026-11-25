/*
 * LOOK AWAY's own rules. Lives only ever run down, one per caught round, and
 * the player doing the looking must still be in the game.
 */
const DIRS = ['up', 'left', 'ctr', 'right', 'down'];
const START_LIVES = 3;

export default function lookawayInvariants({ table, players, done, result }) {
  const seen = table._lookLives || (table._lookLives = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.lives) continue;

    const mine = seen[id] || (seen[id] = {});
    for (const [pid, n] of Object.entries(s.lives)) {
      if (!Number.isInteger(n) || n < 0 || n > START_LIVES) {
        return `${pid} has ${n} lives, outside 0..${START_LIVES}`;
      }
      // Lives only run down. The size of a drop isn't asserted: this runs once per
      // turn, and several rounds can resolve in between.
      if (mine[pid] !== undefined && n > mine[pid]) {
        return `${pid} gained a life, going from ${mine[pid]} to ${n}`;
      }
      mine[pid] = n;
    }
    if (s.phase === 'pick' || s.phase === 'reveal') {
      if (!s.looker || s.lives[s.looker] === undefined) {
        return `"${s.looker}" is looking, but isn't at this table`;
      }
      if (s.phase === 'pick' && s.lives[s.looker] <= 0) {
        return `${s.looker} is looking with no lives left`;
      }
    }
    // The pick bar is drawn from `pickEnds` on the host's clock. Without it the bar
    // sat empty all round (1.1.1). A tick of slack: the host's clock moves in steps.
    if (s.phase === 'pick') {
      const left = s.pickEnds - s.now;
      if (typeof s.pickEnds !== 'number' || !(left >= -250 && left <= s.win)) {
        return `round ${s.round}: the pick window ends at ${s.pickEnds} with the clock at ${s.now} — no countdown to draw`;
      }
    }
    // Which way anyone looked waits for the reveal — the looker's direction on every
    // phone mid-round hands every dodger the answer.
    if (s.phase === 'pick' && s.picks) return `round ${s.round}: the picks are on every phone before the reveal`;
    if (s.picks) {
      for (const [pid, d] of Object.entries(s.picks)) {
        if (d != null && !DIRS.includes(d)) return `${pid} is shown looking "${d}"`;
      }
    }
  }
  if (done && result && result.winnerId) {
    const s = table.view(players[0])?.s;
    // Last one with a life wins; a winner on zero means the game ended wrong.
    if (s && s.lives && (s.lives[result.winnerId] || 0) <= 0) {
      return `winner ${result.winnerId} finished with no lives`;
    }
  }
  return null;
}
