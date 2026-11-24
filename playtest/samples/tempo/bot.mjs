/*
 * TEMPO's bot: play the track instead of skipping it.
 *
 * The generic bot sends whatever is legal, and `done` is always legal — so every
 * player "finished" the 60-second track the instant it started, and nothing that
 * happens DURING a track (a phone reloading mid-song, a player walking out halfway)
 * was ever tested. This one taps the phone's own tap zone now and then and lets each
 * phone's track run out and report `done` by itself, the way a person's does.
 */
export default function tempoBot({ table, playerId, rng }) {
  const legal = table.legalMoves(playerId) || [];
  const go = legal.find(m => m.t === 'go');
  if (go) { table.send(playerId, go); return true; }
  if (!legal.some(m => m.t === 'done')) return false;      // not playing: nothing to do
  if (rng() < 0.3) {
    const zone = table.clickable(playerId).find(h => h.onclick && (h._id === 'tap' || (h.attrs && h.attrs.id === 'tap')));
    if (zone) table.press(playerId, zone);
  }
  return true;                                              // never `done` by hand
}
