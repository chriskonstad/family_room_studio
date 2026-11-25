/* Bugs FISHBOWL's tests must catch (node harness/mutants.mjs fishbowl). */
export default [
  {
    // The phrase is the game's one secret: it goes to the giver's phone only.
    // Broadcasting it puts it on every phone (and, via the broadcast stream,
    // on the shared screen).
    name: 'the current phrase is broadcast to the whole table',
    file: 'game.js',
    find: "Table.sendTo(currentGiver(), { t:'phrase', phrase, secondsLeft: s.secondsLeft, turnEnds: G.turnEnds });",
    replace: "Table.broadcast({ t:'phrase', phrase, secondsLeft: s.secondsLeft, turnEnds: G.turnEnds });"
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
  },
  {
    // Shipped until 1.4.3: a page rebuilt from the history (app killed) never saw its own
    // "I'm done" tap, so it came back to the writing form — every button on it refused.
    name: 'a rebuilt phone forgets it said it was done writing',
    file: 'game.js',
    find: "if (v.dones && v.dones[MY] && !myEntryDone) { myEntryDone = true; lastPhase = null; }",
    replace: '',
    checks: ['tests']
  },
  {
    // ...and greyed out "I'm done writing" until its player dropped in yet another phrase.
    name: 'a rebuilt phone forgets the phrases it already dropped in',
    file: 'game.js',
    find: 'if (v.counts && (v.counts[MY] || 0) > myAdded) myAdded = v.counts[MY];',
    replace: '',
    checks: ['tests']
  },
  {
    // Shipped until 1.4.3: one long word on the giver's card ran off the right edge of
    // an iPhone SE and scrolled the page sideways (phone-states.mjs draws that card).
    name: "a long word runs off the giver's card",
    file: 'index.html',
    find: 'overflow-wrap:anywhere}',
    replace: '}',
    checks: ['phone']
  }
];
