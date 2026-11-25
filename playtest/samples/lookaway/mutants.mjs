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
  },
  {
    // Shipped in 1.1.1: the countdown moved onto FR.clock but its deadline was never
    // put in the published state, so every phone's pick bar sat empty all round.
    name: 'the pick deadline is never published (the bar sits empty)',
    file: 'game.js', find: 'now:clock.now(), pickEnds:G.pickEnds||null,', replace: 'now:clock.now(),'
  },
  {
    // Shipped in 1.1.1: a phone rebuilt mid-round has lost its own memory of picking, so
    // it offered the arrows again and every press was refused. The host now echoes each
    // pick to the picker (rebuild.test.mjs).
    name: 'a phone rebuilt after picking offers the arrows again',
    file: 'game.js', find: "else if(m.t==='picked'){ myPick = m.dir; render(); }", replace: ''
  },
  {
    // Shipped in 1.1.1: FR.clock extrapolates from the last state a phone saw, and the
    // host said nothing mid-window unless someone picked. A phone rebuilt mid-round was
    // last handed the round's first state, and its bar read full (rebuild.test.mjs).
    name: 'the host stops streaming its clock while the pick window is open',
    file: 'game.js', find: "timer.every('clock', 250, syncAll);", replace: ''
  },
  {
    name: "everyone's pick is broadcast before the reveal",
    file: 'game.js', find: 'picks:G.reveal?{...G.picks}:null', replace: 'picks:{...G.picks}'
  }
];
