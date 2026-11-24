/* Bugs FISHBOWL's tests must catch (node harness/mutants.mjs fishbowl). */
export default [
  {
    // The phrase is the game's one secret: it goes to the giver's phone only.
    // Broadcasting it puts it on every phone (and, via the broadcast stream,
    // on the shared screen).
    name: 'the current phrase is broadcast to the whole table',
    file: 'game.js',
    find: "Table.sendTo(currentGiver(), { t:'phrase', phrase, secondsLeft: s.secondsLeft });",
    replace: "Table.broadcast({ t:'phrase', phrase, secondsLeft: s.secondsLeft });"
  },
  {
    // Every phrase in the bowl was written by someone; if adds stop being
    // counted, the bowl and the per-player counts no longer reconcile.
    name: 'a dropped-in phrase is not counted for its author',
    file: 'game.js', find: 'G.counts[ctx.from]++;', replace: '/* not counted */'
  },
  {
    // A point is a phrase leaving the bowl. Scoring without removing it lets
    // a team score more phrases than the bowl ever held.
    name: 'a guessed phrase stays in the bowl',
    file: 'game.js', find: 'G.bowl.shift();', replace: '/* phrase stays in the bowl */'
  }
];
