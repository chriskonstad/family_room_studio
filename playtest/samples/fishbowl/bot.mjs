/*
 * FISHBOWL is driven by a text input, and the generic bot has nothing to type — it can
 * click "Add" forever and the game never leaves the entry phase. This is the whole reason
 * the per-bundle bot hook exists.
 *
 * Only the entry phase needs teaching; everything after it is buttons, so this returns
 * false there and the generic bot takes over.
 */
const WORDS = ['otter', 'trombone', 'lighthouse', 'pickle', 'avalanche', 'wizard',
               'submarine', 'tapioca', 'meteor', 'banjo', 'gondola', 'pancake'];

export default function fishbowlBot({ table, playerId, rng, send }) {
  const view = table.view(playerId);
  const phase = view && view.s && view.s.phase;

  // Before the first broadcast lands, and during entry, everyone stuffs the bowl.
  if (phase === undefined || phase === null || phase === 'entry') {
    const added = table._added || (table._added = {});
    const mine = added[playerId] || 0;
    if (mine < 3) {
      added[playerId] = mine + 1;
      send({ t: 'addPhrase', phrase: rng.pick(WORDS) + '-' + rng.int(9999) });
      return true;
    }
    if (!added[playerId + ':done']) {
      added[playerId + ':done'] = true;
      send({ t: 'doneEntry' });
      return true;
    }
    return true;                 // waiting on the others; don't let the bot flail
  }
  return false;                  // buttons from here on — generic bot drives
}
