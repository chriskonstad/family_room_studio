/* Bugs TAPAS's tests must catch (node harness/mutants.mjs tapas). */
export default [
  {
    name: 'the hand goes back to big cards that need scrolling',
    file: 'index.html', find: '.card{width:62px; height:92px;', replace: '.card{width:88px; height:120px;', checks: ['phone']
  },
  {
    name: 'five plates go back to two lines each',
    file: 'game.js', find: 'const dense = v.order.length >= 4;', replace: 'const dense = false;', checks: ['phone']
  }
];
