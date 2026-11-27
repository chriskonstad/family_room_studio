/* Bugs SCRAMBLE's tests must catch (node harness/mutants.mjs scramble). */
export default [
  {
    name: 'a long word list scrolls instead of folding its oldest words away',
    file: 'game.js', find: "      fitChips(root.querySelector('#chips'));", replace: '', checks: ['phone']
  },
  {
    name: 'a word nobody else found is read out at face value, not double',
    file: 'game.js', find: 'G.points[id] += row.value;', replace: 'G.points[id] += row.pts;',
    checks: ['playtest']
  },
  {
    name: 'any phone can skip the readout mid-word and start the next round',
    file: 'game.js', find: 'when: () => G.revealed >= G.totalRows,', replace: '',
    checks: ['playtest']
  }
];
