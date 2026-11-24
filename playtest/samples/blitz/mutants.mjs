/*
 * The harness's own claims, each broken once on the smallest game there is. If one of
 * these survives, a check that CLAUDE.md promises is not actually being made.
 */
export default [
  {
    name: 'endGame fires twice (two winners)',
    file: 'game.js', find: 'winner = ctx.from; finish(); }', replace: 'winner = ctx.from; finish(); finish(); }'
  },
  {
    name: 'the game rolls Math.random() instead of FR.rng(Table.seed) (not replayable)',
    file: 'game.js', find: 'scores[ctx.from] = (scores[ctx.from] || 0) + 1;',
    replace: 'scores[ctx.from] = (scores[ctx.from] || 0) + (Math.random() < 0.5 ? 1 : 2);'
  },
  {
    name: 'a timer is left ticking under the results screen',
    file: 'game.js', find: 'Table.endGame({ winnerId: winner, standings: result.standings });',
    replace: 'Table.endGame({ winnerId: winner, standings: result.standings }); setInterval(function () {}, 1000);'
  },
  {
    name: 'a refused intent changes the published state',
    file: 'game.js', find: 'Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });',
    replace: "Table.onMessage((from, msg) => { if (msg && msg.t === 'nonsense') { scores[from] = (scores[from] || 0) + 1; publish(); } if (table) table.handle(from, msg); });"
  },
  {
    name: 'the only control is dead (the rules allow a tap the screen never offers)',
    file: 'game.js', find: "document.getElementById('tap').disabled = !!winner;", replace: "document.getElementById('tap').disabled = true;"
  },
  {
    name: 'a phone throws when it is told who won',
    file: 'game.js', find: "if (msg.t === 'state') { scores = msg.scores; winner = msg.winner; render(); }",
    replace: "if (msg.t === 'state') { if (msg.winner) throw new Error('boom'); scores = msg.scores; winner = msg.winner; render(); }"
  },
  {
    name: 'game time comes from the wall clock, so a paused table keeps moving',
    file: 'game.js', find: 'function publish() {\n    Table.broadcast({ t: \'state\', scores, winner });',
    replace: 'function publish() {\n    Table.broadcast({ t: \'state\', scores, winner, clock: Math.floor(Date.now() / 1000) });'
  },
  {
    name: 'an unseated id can tap its way onto the scoreboard',
    file: 'game.js', find: 'players: players.map(p => p.id),', replace: ''
  }
];
