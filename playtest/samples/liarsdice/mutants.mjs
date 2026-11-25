/* Bugs LIAR'S DICE's tests must catch (node harness/mutants.mjs liarsdice). */
export default [
  {
    // Shipped until this release: at eight players on an iPhone SE, the bid controls
    // were below the bottom of the screen.
    name: 'a full table gets the roomy seats and pushes the bid controls off screen',
    file: 'game.js', find: "'<div class=\"table' + (view.order.length > 6 ? ' many' : '') + '\">'", replace: "'<div class=\"table\">'",
    checks: ['phone']
  },
  {
    name: 'the bid steppers shrink back to 38pt',
    file: 'index.html', find: 'grid-template-columns:44px 1fr 44px', replace: 'grid-template-columns:38px 1fr 38px', checks: ['phone']
  },
  {
    name: 'a bid that does not beat the last one is accepted',
    file: 'game.js', find: 'return qty > G.lastBid.qty || (qty === G.lastBid.qty && face > G.lastBid.face);', replace: 'return true;'
  },
  {
    name: 'ones stop being wild when a challenge is counted',
    file: 'game.js', find: 'if (face === 1 ? d === 1 : (d === face || d === 1)) n++;', replace: 'if (d === face) n++;',
    checks: ['playtest']
  },
  {
    name: 'whoever calls the bluff loses the die, right or wrong',
    file: 'game.js', find: 'const loser = bidWasTrue ? from : G.lastBidder;', replace: 'const loser = from;',
    checks: ['playtest']
  }
];
