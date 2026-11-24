/* Bugs THE DETONATOR's tests must catch (node harness/mutants.mjs detonator). */
export default [
  {
    // The whole game is that nobody knows which plunger is live. Publishing it
    // before the press hands the answer to every phone in the room.
    name: 'the live plunger is broadcast before anyone presses it',
    file: 'game.js', find: 'live:G.reveal?G.live:-1', replace: 'live:G.live'
  },
  {
    name: 'a plunger explodes but the live one is never revealed',
    file: 'game.js', find: 'G.plungers[i]=2; G.reveal=true;', replace: 'G.plungers[i]=2;'
  },
  {
    // No elimination: the bank rearms forever and the game can never settle.
    name: 'hitting the detonator eliminates nobody',
    file: 'game.js', find: 'seats.eliminate(ctx.from);', replace: '/* nobody is eliminated */'
  }
];
