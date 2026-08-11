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
      // turn, several rounds can resolve in between, and a player who leaves is sent
      // straight to zero — all legitimate.
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
