/* Bugs SUMMIT's tests must catch (node harness/mutants.mjs summit). */
export default [
  {
    name: 'a hand heavy in one route runs off the bottom of a small phone',
    file: 'game.js', find: "    fanHand(root.querySelector('.hand'));", replace: '', checks: ['phone']
  },
  {
    name: 'wagers stop multiplying a route',
    file: 'game.js', find: 'let s = (sum - 20) * (1 + wagers);', replace: 'let s = (sum - 20) + wagers;',
    checks: ['playtest']
  },
  {
    name: 'a card lower than the top of its route can still be played on it',
    file: 'game.js', find: 'return card.v > maxNum;', replace: 'return card.v >= 2;',
    checks: ['playtest']
  }
];
