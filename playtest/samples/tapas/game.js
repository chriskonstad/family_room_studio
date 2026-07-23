/* TAPAS — a simultaneous pick-and-pass drafting game (Sushi Go-style mechanics;
   original name/theme/cards). Everyone picks a card from their hand at the same
   time, then hands rotate. Digital superpower: no physical passing, picks are
   revealed together, and scoring is automatic. Host authoritative. */

function createGame(Table, root) {
  const MY = Table.me.id;
  const ROUNDS = 3;
  const HAND_SIZE = { 2:10, 3:9, 4:8, 5:7 };

  // Card set (counts tuned to a 58-card deck)
  const TYPES = {
    croqueta: { ic:'🥔', nm:'Croqueta',   sc:'pair = 5',           n:12 },
    skewer:   { ic:'🍢', nm:'Skewer',     sc:'set of 3 = 10',      n:12 },
    gambas:   { ic:'🍤', nm:'Gambas',     sc:'1/3/6/10/15…',       n:10 },
    tortilla1:{ ic:'🍳', nm:'Tortilla ×1', sc:'1 pt',              n:5  },
    tortilla2:{ ic:'🍳', nm:'Tortilla ×2', sc:'2 pts',             n:5  },
    tortilla3:{ ic:'🍳', nm:'Tortilla ×3', sc:'3 pts',             n:4  },
    aioli:    { ic:'🧄', nm:'Aioli',      sc:'×3 next tortilla',   n:5  },
    churro:   { ic:'🥨', nm:'Churro',     sc:'most at end +6 / least −6', n:5 },
  };

  let view = null;
  let myHand = [];
  let sel = null;
  let picked = false;
  let lastHandSig = '';   // pop animation fires only when a NEW hand arrives
  let G = null;

  const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

  // ---------- host ----------
  function buildDeck() {
    const d = [];
    Object.entries(TYPES).forEach(([k,t]) => { for (let i=0;i<t.n;i++) d.push(k); });
    return shuffle(d);
  }
  function initGame(players) {
    G = { order:players.map(p=>p.id), names:{}, emojis:{}, totals:{}, churros:{},
          round:1, phase:'drafting' };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.totals[p.id]=0; G.churros[p.id]=0; });
    startRound();
  }
  function startRound() {
    G.deck = G.deck && G.deck.length > G.order.length*HAND_SIZE[G.order.length] ? G.deck : buildDeck();
    G.hands = {}; G.tableau = {}; G.picks = {};
    const size = HAND_SIZE[G.order.length] || 8;
    G.order.forEach(id => { G.hands[id] = G.deck.splice(0, size); G.tableau[id] = []; G.picks[id] = null; });
    G.phase = 'drafting';
    G.banner = 'Round '+G.round+' — pick a plate!';
  }

  function everyonePicked(){ return G.order.every(id => G.picks[id] != null); }
  function resolvePicks() {
    // reveal all picks, move to tableaus
    G.order.forEach(id => {
      const idx = G.picks[id];
      const card = G.hands[id][idx];
      G.hands[id].splice(idx, 1);
      G.tableau[id].push(card);
      if (card === 'churro') G.churros[id]++;
      G.picks[id] = null;
    });
    // rotate hands (to the next player in seat order)
    const rotated = {};
    G.order.forEach((id, i) => { rotated[G.order[(i+1) % G.order.length]] = G.hands[id]; });
    G.hands = rotated;
    if (G.hands[G.order[0]].length === 0) endRound();
    else G.banner = 'Plates passed — pick again!';
  }

  function scoreTableau(cards) {
    let s = 0;
    const count = k => cards.filter(c => c === k).length;
    s += Math.floor(count('croqueta') / 2) * 5;
    s += Math.floor(count('skewer') / 3) * 10;
    const gambasPts = [0,1,3,6,10,15,21,28];
    s += gambasPts[Math.min(count('gambas'), gambasPts.length-1)];
    // tortillas with aioli multipliers: each aioli boosts one later tortilla ×3
    let aiolis = 0;
    cards.forEach(c => {
      if (c === 'aioli') { aiolis++; return; }
      const v = c === 'tortilla1' ? 1 : c === 'tortilla2' ? 2 : c === 'tortilla3' ? 3 : 0;
      if (v) { s += aiolis > 0 ? v*3 : v; if (aiolis > 0) aiolis--; }
    });
    return s;
  }
  function endRound() {
    G.lastRound = {};
    G.order.forEach(id => { G.lastRound[id] = scoreTableau(G.tableau[id]); G.totals[id] += G.lastRound[id]; });
    if (G.round >= ROUNDS) { finishGame(); return; }
    G.phase = 'roundEnd';
    G.banner = 'Round '+G.round+' scored';
  }
  function finishGame() {
    // churro majority: +6 most, −6 least (ties share nothing, like the classic)
    const counts = G.order.map(id => G.churros[id]);
    const most = Math.max(...counts), least = Math.min(...counts);
    if (most > 0 && most !== least) {
      const winners = G.order.filter(id => G.churros[id] === most);
      const losers  = G.order.filter(id => G.churros[id] === least);
      winners.forEach(id => G.totals[id] += Math.floor(6 / winners.length));
      losers.forEach(id => G.totals[id] -= Math.floor(6 / losers.length));
    }
    const ranked = G.order.slice().sort((a,b)=>G.totals[b]-G.totals[a]);
    G.phase = 'gameOver';
    Table.endGame({
      winnerId: ranked[0],
      standings: ranked.map(id => ({ playerId:id, score:G.totals[id],
        detail:'🥨 ×'+G.churros[id] })),
    });
  }

  function handleIntent(from, msg) {
    if (msg.t === 'hello') return;
    if (G.phase === 'drafting' && msg.t === 'pick' && G.picks[from] == null
        && msg.i >= 0 && msg.i < G.hands[from].length) {
      G.picks[from] = msg.i;
      if (everyonePicked()) resolvePicks();
      return;
    }
    if (G.phase === 'roundEnd' && msg.t === 'next' && from === MY) {
      G.round++; startRound();
    }
  }

  function publicState() {
    return {
      phase:G.phase, round:G.round, banner:G.banner,
      names:G.names, emojis:G.emojis, order:G.order,
      totals:{...G.totals}, lastRound:G.lastRound||null, churros:{...G.churros},
      tableau: JSON.parse(JSON.stringify(G.tableau)),
      pickedFlags: Object.fromEntries(G.order.map(id => [id, G.picks[id] != null])),
      handCount: G.hands[G.order[0]] ? G.hands[G.order[0]].length : 0,
    };
  }
  function syncAll() {
    const s = publicState();
    Table.broadcast({ t:'state', s });
    G.order.forEach(id => {
      if (id === MY) { myHand = G.hands[id].slice(); picked = G.picks[id] != null; }
      else Table.sendTo(id, { t:'hand', hand:G.hands[id], picked:G.picks[id] != null });
    });
    view = s; sel = null; render();
  }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); syncAll(); });
    Table.onMessage((from, msg) => { handleIntent(from, msg); syncAll(); });
    Table.onPlayerLeave(id => {
      if (!G) return;
      // fold the leaver: their unplayed hand vanishes, their picks resolve as no-op
      G.order = G.order.filter(x => x !== id);
      delete G.picks[id];
      if (G.phase === 'drafting' && everyonePicked()) resolvePicks();
      syncAll();
    });
  } else {
    Table.onStart(() => { view=null; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_f, msg) => {
      if (msg.t === 'state') { view = msg.s; sel = null; render(); }
      else if (msg.t === 'hand') { myHand = msg.hand; picked = msg.picked; render(); }
    });
  }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const T = k => TYPES[k];

  function tableauHTML(id) {
    const counts = {};
    view.tableau[id].forEach(c => counts[c] = (counts[c]||0)+1);
    return Object.entries(counts).map(([k,n]) =>
      `<span class="mini">${T(k).ic}${n>1?'×'+n:''}</span>`).join('') || '<span class="mini" style="opacity:.4">empty plate</span>';
  }

  function render() {
    if (!view) { root.innerHTML = '<span class="wait">Setting the table…</span>'; return; }
    const v = view;
    let h = `<div class="hdr"><span class="brand">TAPAS</span>
      <span class="sub">Round ${v.round}/3 · ${v.handCount} cards left</span></div>
      <div class="banner">${esc(v.banner||'')}</div>`;

    h += `<div class="plates">`;
    v.order.forEach(id => {
      h += `<div class="prow ${id===MY?'me':''}">
        <div class="top"><span>${v.emojis[id]}</span><span class="who">${esc(v.names[id])}</span>
          ${v.phase==='drafting' ? (v.pickedFlags[id] ? '<span class="picked">✓ picked</span>' : '<span class="picked" style="opacity:.35">choosing…</span>') : ''}
          <span class="pts">${v.totals[id]}</span></div>
        <div class="tstack">${tableauHTML(id)}</div></div>`;
    });
    h += `</div>`;

    if (v.phase === 'drafting') {
      const handSig = myHand.join(',');
      const fresh = handSig !== lastHandSig;
      lastHandSig = handSig;
      h += `<div class="sec">Your hand — pick one</div><div class="hand">`;
      myHand.forEach((k,i) => {
        h += `<div class="card ${sel===i?'sel':''}${fresh?' pop':''}" data-i="${i}" style="animation-delay:${fresh ? i*40 : 0}ms">
          <span class="ic">${T(k).ic}</span><span class="nm">${esc(T(k).nm)}</span><span class="sc">${esc(T(k).sc)}</span></div>`;
      });
      h += `</div><div class="ctrl">`;
      h += picked
        ? `<span class="wait">Waiting for the other plates…</span>`
        : `<button class="primary" data-act="pick" ${sel==null?'disabled':''}>Take it</button>`;
      h += `</div>`;
    } else if (v.phase === 'roundEnd') {
      let rows = v.order.map(id => `<div class="srow"><span>${v.emojis[id]} ${esc(v.names[id])}</span>
        <span>+${v.lastRound[id]} → <b>${v.totals[id]}</b></span></div>`).join('');
      const cta = Table.isHost ? `<button class="primary cta" data-act="next">Next round</button>`
                               : `<span class="wait">Waiting for the host…</span>`;
      h += `<div class="overlay"><div class="sheet"><h2>Round ${v.round} scored</h2>${rows}${cta}</div></div>`;
    }

    root.innerHTML = h;
    root.querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
      if (picked) return;
      sel = (sel === +el.dataset.i) ? null : +el.dataset.i; render();
    });
    root.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => {
      if (b.dataset.act === 'pick' && sel != null) { picked = true; Table.send({ t:'pick', i:sel }); render(); }
      else if (b.dataset.act === 'next') Table.send({ t:'next' });
    });
  }

  render();
}
