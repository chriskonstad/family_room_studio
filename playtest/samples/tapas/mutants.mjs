/* Bugs TAPAS's tests must catch (node harness/mutants.mjs tapas). */
export default [
  {
    name: 'the hand goes back to big cards that need scrolling',
    file: 'index.html', find: '.card{width:62px; height:92px;', replace: '.card{width:88px; height:120px;', checks: ['phone']
  },
  {
    name: 'five plates go back to two lines each',
    file: 'game.js', find: 'const dense = v.order.length >= 4;', replace: 'const dense = false;', checks: ['phone']
  },
  {
    // Shipped until 1.3.2: every state broadcast cleared the chosen card, so another
    // player's pick landing while you decided greyed "Take it" out under your thumb.
    name: "somebody else's pick un-chooses the card a guest is holding",
    file: 'game.js',
    find: "if (msg.t === 'state') { view = msg.s; render(); }",
    replace: "if (msg.t === 'state') { view = msg.s; sel = null; render(); }",
    checks: ['tests']
  },
  {
    name: "somebody else's pick un-chooses the card the host is holding",
    file: 'game.js',
    find: '    view = s; render();\n  }',
    replace: '    view = s; sel = null; render();\n  }',
    checks: ['tests']
  },
  {
    name: 'aioli stops tripling the next tortilla',
    file: 'game.js', find: 'if (v) { s += aiolis > 0 ? v*3 : v; if (aiolis > 0) aiolis--; }', replace: 'if (v) { s += v; }',
    checks: ['playtest']
  },
  {
    name: 'the churro majority goes to the fewest instead of the most',
    file: 'game.js', find: 'const winners = G.order.filter(id => G.churros[id] === most);', replace: 'const winners = G.order.filter(id => G.churros[id] === least);',
    checks: ['playtest']
  }
];
