/*
 * THE DETONATOR's own rules. Five plungers, exactly one live, and the live one
 * is only ever revealed by being pressed — a board showing the bomb before
 * anyone pressed it would leak the answer to every phone in the room.
 */
export default function detonatorInvariants({ table, players, done, result }) {
  const seen = table._detAlive || (table._detAlive = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.plungers) continue;

    if (s.plungers.length !== 5) return `the bank has ${s.plungers.length} plungers, not 5`;
    if (s.plungers.some(p => p !== 0 && p !== 1 && p !== 2)) {
      return `a plunger is in unknown state: [${s.plungers}]`;
    }
    const boomed = s.plungers.filter(p => p === 2).length;
    if (boomed > 1) return `${boomed} plungers exploded on one bank`;
    // `live` is -1 until the bomb goes off; when it IS shown, it must be the one
    // that just exploded. Anything else is the answer leaking early.
    if (s.live !== -1) {
      if (s.live < 0 || s.live > 4) return `live plunger index is ${s.live}`;
      if (s.plungers[s.live] !== 2) {
        return `plunger ${s.live} is flagged live but hasn't exploded — the bomb's position is showing`;
      }
    } else if (boomed > 0) {
      return `a plunger exploded but the live one was never revealed`;
    }

    const aliveNow = s.order.filter(pid => s.alive[pid]);
    if (seen[id]) {
      for (const pid of s.order) {
        if (s.alive[pid] && seen[id][pid] === false) return `${pid} came back from elimination`;
      }
    }
    seen[id] = { ...s.alive };
    if (s.phase === 'playing') {
      if (!aliveNow.length) return `nobody is left but the game is still running`;
      if (s.turn && !s.alive[s.turn]) return `it is ${s.turn}'s turn, but they're out`;
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
