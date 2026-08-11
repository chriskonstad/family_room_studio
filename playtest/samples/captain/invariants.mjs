/*
 * CAPTAIN SAYS's own rules. Elimination is permanent and a round can never wipe
 * the whole crew — "everyone would be out" is explicitly voided by the game, and
 * that rule existing is exactly why it's worth asserting.
 */
const COLORS = ['red', 'blue', 'green', 'yellow'];

export default function captainInvariants({ table, players, done, result }) {
  const seen = table._captainAlive || (table._captainAlive = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.alive) continue;

    const aliveNow = s.order.filter(pid => s.alive[pid]);
    // The crew never repopulates: once you're out, you're out.
    const mine = seen[id];
    if (mine) {
      for (const pid of s.order) {
        if (s.alive[pid] && mine[pid] === false) return `${pid} came back from elimination`;
      }
    }
    seen[id] = { ...s.alive };

    if (s.phase !== 'over' && aliveNow.length === 0) {
      return `every sailor is out but the game hasn't finished — a round wiped the whole crew`;
    }
    if (s.prompt && !COLORS.includes(s.prompt.color)) {
      return `the order names colour "${s.prompt.color}", which isn't on the deck`;
    }
    if (s.prompt && s.prompt.win <= 0) return `the round window is ${s.prompt.win}ms`;
    if (s.taps) {
      for (const [pid, c] of Object.entries(s.taps)) {
        if (c != null && !COLORS.includes(c)) return `${pid} is shown tapping "${c}"`;
      }
    }
  }
  if (done && result && result.winnerId) {
    const s = table.view(players[0])?.s;
    if (s && s.alive && s.alive[result.winnerId] === false) {
      return `winner ${result.winnerId} is marked out on the final screen`;
    }
  }
  return null;
}
