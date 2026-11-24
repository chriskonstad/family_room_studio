/* Bugs LOOK AWAY's tests must catch (node harness/mutants.mjs lookaway). */
export default [
  {
    // Being caught is the only way a life is ever lost; without the deduction
    // nobody is ever eliminated and the rounds never end.
    name: 'a caught player keeps their life',
    file: 'game.js', find: 'G.lives[id]--; caught.push(id);', replace: 'caught.push(id);'
  },
  {
    // The looker rotates through the roster; the skip over players who are
    // out is what keeps a dead player from being handed the stare.
    name: 'a player with no lives left can be made the looker',
    file: 'game.js',
    find: 'while(G.lives[G.order[G.lookerIdx]]<=0);',
    replace: 'while(false);',
    games: 48
  }
];
