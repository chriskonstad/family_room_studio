/* Bugs SUMMIT's tests must catch (node harness/mutants.mjs summit). */
export default [
  {
    name: 'a hand heavy in one route runs off the bottom of a small phone',
    file: 'game.js', find: "    fanHand(root.querySelector('.hand'));", replace: '', checks: ['phone']
  }
];
