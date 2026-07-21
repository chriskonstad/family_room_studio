/* BLITZ — trivial tap race; the spec's minimal example, playable.
   Same file runs on every device; host is authoritative. */
(function () {
  const Table = window.Table;
  const GOAL = 10;
  let roster = [];
  let scores = {};
  let winner = null;

  function render() {
    const el = document.getElementById('scores');
    el.innerHTML = roster.map(p =>
      `<div class="row ${p.id === winner ? 'win' : ''}">${p.emoji} ${p.name}` +
      `${p.id === Table.me.id ? ' (you)' : ''}<b>${scores[p.id] || 0}</b></div>`
    ).join('');
    document.getElementById('tap').disabled = !!winner;
  }

  Table.onStart(players => {
    roster = players;
    players.forEach(p => { scores[p.id] = 0; });
    if (!Table.isHost) Table.send({ type: 'hello' });
    render();
  });

  if (Table.isHost) {
    Table.onMessage((from, msg) => {
      if (msg.type === 'tap' && !winner) {
        scores[from] = (scores[from] || 0) + 1;
        if (scores[from] >= GOAL) winner = from;
      }
      Table.broadcast({ type: 'state', scores, winner });
      render();
      if (winner) {
        // Hand the terminal result to the shell for a native results screen.
        const ranked = roster.slice().sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0));
        Table.endGame({
          winnerId: winner,
          standings: ranked.map(p => ({ playerId: p.id, score: scores[p.id] || 0,
            detail: p.id === winner ? 'first to ' + GOAL + ' taps' : '' }))
        });
      }
    });
  } else {
    Table.onMessage((_from, msg) => {
      if (msg.type === 'state') { scores = msg.scores; winner = msg.winner; render(); }
    });
  }

  document.getElementById('tap').onclick = () => Table.send({ type: 'tap' });
})();
