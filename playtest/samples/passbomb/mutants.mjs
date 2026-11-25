/* Bugs PASS THE BOMB's tests must catch (node harness/mutants.mjs passbomb). */
export default [
  {
    // The explosion is the only way anyone leaves; without it the bomb relights
    // forever among the same players and the game can never settle.
    name: 'the player holding the bomb when it blows is not eliminated',
    file: 'game.js', find: 'seats.eliminate(dead);', replace: '/* nobody is eliminated */'
  },
  {
    // The next holder must come from the players still in. Picking from the
    // whole roster hands the bomb to someone who is already out.
    name: 'a fresh bomb can be handed to a player who is already out',
    file: 'game.js', find: 'G.holder = rng.pick(aliveIds());', replace: 'G.holder = rng.pick(G.order);',
    games: 48
  },
  {
    // The guard moved from inside run() (where a refused throw was silently accepted)
    // into `when`. Without it a bystander's tap steals the bomb out of the holder's hands.
    name: 'anyone can throw the bomb, not just whoever holds it',
    file: 'game.js', find: 'when:(ctx)=> ctx.from === G.holder && ', replace: 'when:(ctx)=> '
  }
];
