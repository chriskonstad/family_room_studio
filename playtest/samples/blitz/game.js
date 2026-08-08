/* BLITZ — trivial tap race; the spec's minimal example, playable.
   Same file runs on every device; host is authoritative.

   Also the smallest possible demonstration of FR.host: three declarations and the
   game is fully playable AND fully fuzzable headlessly. */
(function () {
  const Table = window.Table;
  const GOAL = 10;
  let roster = [];
  let scores = {};
  let winner = null;
  let table = null;

  function render() {
    const el = document.getElementById('scores');
    el.innerHTML = roster.map(p =>
      `<div class="row ${p.id === winner ? 'win' : ''}">${p.emoji} ${p.name}` +
      `${p.id === Table.me.id ? ' (you)' : ''}<b>${scores[p.id] || 0}</b></div>`
    ).join('');
    document.getElementById('tap').disabled = !!winner;
  }

  function publish() {
    Table.broadcast({ t: 'state', scores, winner });
    render();
  }

  Table.onStart(players => {
    roster = players;
    players.forEach(p => { scores[p.id] = 0; });
    if (Table.isHost) {
      table = FR.host({
        state: { scores }, hostId: Table.me.id,
        players: players.map(p => p.id),
        publish,
        intents: {
          hello: { hidden: true, run: () => {} },
          // Anyone may tap, any time, until someone wins. `when` says so, and that is
          // all the harness needs to play this game with no screen.
          tap: {
            when: () => !winner,
            run: (ctx) => {
              scores[ctx.from] = (scores[ctx.from] || 0) + 1;
              if (scores[ctx.from] >= GOAL) { winner = ctx.from; finish(); }
            }
          }
        }
      });
    } else {
      Table.send({ t: 'hello' });
    }
    render();
  });

  function finish() {
    const result = FR.standings.byScore(scores, {
      detail: (id) => id === winner ? 'first to ' + GOAL + ' taps' : ''
    });
    Table.endGame({ winnerId: winner, standings: result.standings });
  }

  if (Table.isHost) {
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
  } else {
    Table.onMessage((_from, msg) => {
      if (msg.t === 'state') { scores = msg.scores; winner = msg.winner; render(); }
    });
  }

  document.getElementById('tap').onclick = () => Table.send({ t: 'tap' });
})();
