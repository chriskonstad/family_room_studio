/* SUMMIT — a two-player expedition card game (Lost Cities mechanics; original
   name/theme/art). Same bundle on both devices; host authoritative. Hands are
   PRIVATE: the host deals them via Table.sendTo, so opponents never see them. */

function createGame(Table, root) {
  const MY = Table.me.id;
  const ROUTES = [
    { k:'glacier', icon:'❄️', color:'#5aa0e0' },
    { k:'volcano', icon:'🌋', color:'#e0564b' },
    { k:'jungle',  icon:'🦜', color:'#43b06b' },
    { k:'desert',  icon:'🏜️', color:'#d99a2e' },
    { k:'reef',    icon:'🐠', color:'#9b6ee0' },
  ];
  const ROUNDS = 3;
  let view = null;     // public state (both devices render this)
  let myHand = [];     // private hand (sent by host via sendTo)
  let sel = null;      // selected hand index
  let prevHandLen = 0; // pop-in animation: only NEW cards animate
  let seenPlay = '';   // route-glow animation: only on a fresh play
  let seenDeal = null; // round whose hand we've already staggered in
  let seenTurn = '';   // "it's your move" nudge: once per turn, not per render
  let G = null;        // authoritative (host only)

  /// Game-feel shim. Everything below funnels through here so a bundle still
  /// runs on a harness that predates Table.feel (and in a plain browser).
  const feel = (ev, o) => { if (Table.feel) Table.feel(ev, o); };
  const dealIn = (nodes, step) => { if (Table.feel && Table.feel.deal) Table.feel.deal(nodes, step); };

  // ---------- host: rules ----------
  // Seeded from the table: the deal replays exactly under `--seed`, which is what makes
  // a fuzz failure something you can look at rather than a rumour.
  const rng = FR.rng(Table.seed);
  const shuffle = a => rng.shuffle(a);
  function buildDeck() {
    const d = [];
    ROUTES.forEach(r => {
      for (let i=0;i<3;i++) d.push({ c:r.k, v:0 });          // ⭐ wagers
      for (let v=2;v<=10;v++) d.push({ c:r.k, v });
    });
    return d;  // 60 cards
  }

  function initGame(players) {
    G = { order:players.map(p=>p.id), names:{}, emojis:{}, totals:{},
          round:1, phase:'playing' };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.totals[p.id]=0; });
    startRound(0);
  }
  function startRound(startIdx) {
    G.deck = shuffle(buildDeck());
    G.hands = {}; G.routes = {}; G.discards = {};
    ROUTES.forEach(r => G.discards[r.k] = []);
    G.order.forEach(id => {
      G.hands[id] = G.deck.splice(0,8);
      G.routes[id] = {}; ROUTES.forEach(r => G.routes[id][r.k] = []);
    });
    G.turn = G.order[startIdx % 2];
    G.sub = 'play';                       // play|discard first, then draw
    G.lastDiscard = null;                 // {pid, color} — can't re-draw same turn
    G.phase = 'playing';
    G.banner = 'Round '+G.round+' — '+G.names[G.turn]+' starts';
  }

  function canPlay(pid, card) {
    // A malformed card — an unknown colour, a missing value — must be refused, not
    // dereferenced. The host trusts nothing from the wire: a stale or buggy client used
    // to take the whole table down here, and the headless fuzzer found it on its second
    // hostile seed.
    if (!card || typeof card.v !== 'number' || !G.routes[pid] || !G.routes[pid][card.c]) return false;
    const pile = G.routes[pid][card.c];
    if (card.v === 0) return pile.every(x => x.v === 0);            // wagers only before numbers
    const maxNum = Math.max(0, ...pile.map(x => x.v));
    return card.v > maxNum;
  }
  function removeFromHand(pid, card) {
    if (!card || !G.hands[pid]) return false;
    const i = G.hands[pid].findIndex(x => x.c===card.c && x.v===card.v);
    if (i < 0) return false;
    G.hands[pid].splice(i,1);
    return true;
  }
  function routeScore(pile) {
    if (!pile.length) return 0;
    const wagers = pile.filter(x=>x.v===0).length;
    const sum = pile.reduce((a,x)=>a+x.v,0);
    let s = (sum - 20) * (1 + wagers);
    if (pile.length >= 8) s += 20;
    return s;
  }
  function roundScore(pid) {
    return ROUTES.reduce((a,r)=>a+routeScore(G.routes[pid][r.k]), 0);
  }

  // The move space, declared rather than implied.
  //
  // SUMMIT's turn is two steps — play or discard a card, THEN draw one — and that shape
  // is exactly what a DOM-driven bot could not follow: it saw a "Climb" button and no way
  // to know which card it meant. Declaring `options` makes the whole move set explicit, so
  // the headless harness can play (and fuzz) this game with no screen at all.
  //
  // Sub-phases ride in the phase string so FR can gate on them directly.
  const phaseNow = () => G.phase === 'playing' ? ('playing:' + G.sub) : G.phase;
  const myTurn = (ctx) => ctx.from === G.turn;
  const drawableColors = () => ROUTES.map(r => r.k).filter(c =>
    G.discards[c].length && !(G.lastDiscard && G.lastDiscard.pid === G.turn && G.lastDiscard.color === c));

  let table = null;
  function buildTable() {
    return FR.host({
      state: G, timers: FR.timers(), hostId: MY,
      players: G.order,   // so a stale or unseated id can't send anything
      phase: phaseNow,
      publish: syncAll,
      intents: {
        hello: { hidden: true, run: () => {} },
        next:  { host: true, phase: 'roundEnd',
                 run: () => { G.round++; startRound(G.round - 1); } },

        play:  { phase: 'playing:play', when: myTurn,
                 options: (ctx) => G.hands[ctx.from]
                   .filter(c => canPlay(ctx.from, c))
                   .map(c => ({ card: { c: c.c, v: c.v } })),
                 run: (ctx) => {
                   const card = ctx.msg.card;
                   if (!card || !canPlay(ctx.from, card) || !removeFromHand(ctx.from, card)) return;
                   G.routes[ctx.from][card.c].push(card);
                   G.routes[ctx.from][card.c].sort((a,b)=>a.v-b.v);
                   G.banner = G.names[ctx.from]+' played '+cardLabel(card)+' on '+card.c;
                   G.lastPlay = { pid:ctx.from, color:card.c, n:(G.playSeq=(G.playSeq||0)+1) };
                   G.sub = 'draw';
                 } },

        discard: { phase: 'playing:play', when: myTurn,
                 options: (ctx) => G.hands[ctx.from].map(c => ({ card: { c: c.c, v: c.v } })),
                 run: (ctx) => {
                   const card = ctx.msg.card;
                   if (!card || !G.discards[card.c] || !removeFromHand(ctx.from, card)) return;
                   G.discards[card.c].push(card);
                   G.lastDiscard = { pid:ctx.from, color:card.c };
                   G.banner = G.names[ctx.from]+' discarded '+cardLabel(card);
                   G.sub = 'draw';
                 } },

        draw:  { phase: 'playing:draw', when: myTurn,
                 options: () => [{ from: 'deck' }].concat(drawableColors().map(c => ({ from: c }))),
                 run: (ctx) => {
                   const src = ctx.msg.from;
                   let card = null;
                   if (src === 'deck') card = G.deck.pop();
                   else if (G.discards[src] && G.discards[src].length
                            && !(G.lastDiscard && G.lastDiscard.pid===ctx.from && G.lastDiscard.color===src)) {
                     card = G.discards[src].pop();
                   }
                   if (!card) return;
                   G.hands[ctx.from].push(card);
                   G.lastDiscard = null;
                   if (G.deck.length === 0) { endRound(); return; }
                   G.turn = G.order.find(id => id !== ctx.from);
                   G.sub = 'play';
                   G.banner = G.names[G.turn]+"'s turn";
                 } }
      }
    });
  }

  function endRound() {
    const detail = {};
    G.order.forEach(id => { detail[id] = roundScore(id); G.totals[id] += detail[id]; });
    G.lastRound = detail;
    if (G.round >= ROUNDS) {
      const ranked = G.order.slice().sort((a,b)=>G.totals[b]-G.totals[a]);
      G.phase = 'gameOver';
      Table.endGame({
        winnerId: ranked[0],
        standings: ranked.map(id => ({ playerId:id, score:G.totals[id],
          detail: (G.lastRound[id]>=0?'+':'')+G.lastRound[id]+' final round' }))
      });
    } else {
      G.phase = 'roundEnd';
      G.banner = 'Round '+G.round+' complete';
    }
  }

  function publicState() {
    return {
      phase:G.phase, round:G.round, banner:G.banner, turn:G.turn, sub:G.sub,
      deckCount:G.deck.length,
      lastPlay:G.lastPlay||null,
      totals:{...G.totals}, lastRound:G.lastRound||null,
      names:{...G.names}, emojis:{...G.emojis}, order:G.order.slice(),
      routes: JSON.parse(JSON.stringify(G.routes)),
      discards: Object.fromEntries(ROUTES.map(r =>
        [r.k, { top: G.discards[r.k].length ? G.discards[r.k][G.discards[r.k].length-1] : null,
                count: G.discards[r.k].length }])),
      blocked: G.lastDiscard,
      handCounts: Object.fromEntries(G.order.map(id => [id, G.hands[id].length])),
    };
  }
  function syncAll() {
    const s = publicState();
    Table.broadcast({ t:'state', s });
    G.order.forEach(id => {
      if (id === MY) { myHand = G.hands[id].slice(); }
      else Table.sendTo(id, { t:'hand', hand:G.hands[id] });
    });
    view = s; sel = null; render();
  }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); table = buildTable(); syncAll(); });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
    Table.onPlayerLeave(() => { /* 2p game: results screen still reachable via shell Leave */ });
  } else {
    Table.onStart(() => { view = null; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_f, msg) => {
      if (msg.t === 'state') { view = msg.s; sel = null; render(); }
      else if (msg.t === 'hand') { myHand = msg.hand; render(); }
    });
  }

  // ---------- rendering ----------
  const R = k => ROUTES.find(r=>r.k===k);
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function cardLabel(card){ return card.v===0 ? '⭐' : String(card.v); }

  // No animation classes are baked into this string — the route that was just
  // played on is found by [data-owner]/[data-route] after render and popped by
  // feel('gain'), so it can't replay on an unrelated re-render.
  function routesHTML(pid, mine) {
    return `<div class="routes" data-owner="${pid}">` + ROUTES.map(r => {
      const pile = view.routes[pid][r.k];
      const pts = routeScoreView(pile);
      return `<div class="route" data-route="${r.k}" style="border-color:${pile.length?r.color:'var(--line)'}">
        <div class="icon">${r.icon}</div>
        <div class="cards" style="color:${r.color}">${pile.map(cardLabel).join(' ')||'&nbsp;'}</div>
        <div class="pts">${pile.length ? (pts>=0?'+':'')+pts : ''}</div>
      </div>`;
    }).join('') + `</div>`;
  }
  function routeScoreView(pile) {
    if (!pile.length) return 0;
    const wagers = pile.filter(x=>x.v===0).length;
    let s = (pile.reduce((a,x)=>a+x.v,0) - 20) * (1 + wagers);
    if (pile.length >= 8) s += 20;
    return s;
  }

  function render() {
    if (!view) { root.innerHTML = '<span class="wait">Connecting to base camp…</span>'; return; }
    const v = view;
    const opp = v.order.find(id => id !== MY);
    const meTurn = v.turn === MY && v.phase === 'playing';
    const selCard = sel != null ? myHand[sel] : null;

    let h = `<div class="hdr"><span class="brand">SUMMIT</span>
      <span class="sub">Round ${v.round}/3</span>
      <span class="deck">🎴 ${v.deckCount} left</span></div>
      <div class="banner">${esc(v.banner||'')}</div>`;

    h += `<div class="sec">${v.emojis[opp]} ${esc(v.names[opp])} — ${v.totals[opp]} pts · ${v.handCounts[opp]} in hand</div>`;
    h += routesHTML(opp, false);

    h += `<div class="sec">Discards ${meTurn && v.sub==='draw' ? '· tap to take' : ''}</div><div class="discards">`;
    ROUTES.forEach(r => {
      const d = v.discards[r.k];
      const blocked = v.blocked && v.blocked.pid===MY && v.blocked.color===r.k;
      const canTake = meTurn && v.sub==='draw' && d.count>0 && !blocked;
      h += `<div class="dpile ${canTake?'canTake':''}" data-take="${r.k}">
        <div class="top" style="color:${r.color}">${d.top?cardLabel(d.top):r.icon}</div>
        <div class="cnt">${d.count||'empty'}</div></div>`;
    });
    h += `</div>`;

    h += `<div class="sec">Your routes — ${v.totals[MY]} pts total</div>`;
    h += routesHTML(MY, true);

    // hand grouped into per-route columns (aligned under the routes), each sorted
    // low→high with wagers first, so you can skim what you hold at a glance
    const byRoute = {}; ROUTES.forEach(r => byRoute[r.k] = []);
    myHand.forEach((c,i) => byRoute[c.c].push({ c, i }));
    ROUTES.forEach(r => byRoute[r.k].sort((a,b) => a.c.v - b.c.v));
    h += `<div class="sec">Your hand — tap a card, then Climb or Discard</div>`;
    h += `<div class="hand">` + ROUTES.map(r => {
      const col = byRoute[r.k];
      const cards = col.map(({ c, i }) =>
        `<div class="card ${c.v===0?'wager ':''}${sel===i?'sel':''}"
              data-hand="${i}" style="background:${r.color}">${cardLabel(c)}</div>`).join('');
      return `<div class="handcol">
        <div class="colhead ${col.length?'has':''}" style="color:${r.color}; border-bottom-color:${col.length?r.color:'transparent'}">${r.icon}</div>
        ${cards}</div>`;
    }).join('') + `</div>`;

    if (v.phase === 'playing') {
      if (meTurn && v.sub === 'play') {
        const canPlaySel = selCard && canPlayView(selCard);
        h += `<div class="ctrl">
          <button class="primary" data-act="play" ${canPlaySel?'':'disabled'}>Climb ▲</button>
          <button data-act="discard" ${selCard?'':'disabled'}>Discard</button></div>`;
      } else if (meTurn && v.sub === 'draw') {
        h += `<div class="ctrl"><button class="primary" data-act="drawdeck">Draw from deck (${v.deckCount})</button></div>`;
      } else {
        h += `<span class="wait">Waiting for ${v.emojis[v.turn]} ${esc(v.names[v.turn])}…</span>`;
      }
    } else if (v.phase === 'roundEnd') {
      let rows = v.order.map(id => `<div class="srow"><span>${v.emojis[id]} ${esc(v.names[id])}</span>
        <span>${(v.lastRound[id]>=0?'+':'')+v.lastRound[id]} → <b>${v.totals[id]}</b></span></div>`).join('');
      const cta = Table.isHost ? `<button class="primary cta" data-act="next">Next Round</button>`
                               : `<span class="wait">Waiting for the host…</span>`;
      h += `<div class="overlay"><div class="sheet"><h2>Round ${v.round} complete</h2>${rows}${cta}</div></div>`;
    }

    root.innerHTML = h;

    // ---- game feel, on the live nodes we just wrote ----
    // render() also runs on a plain card tap, so every call here is behind a
    // guard that only flips when the underlying EVENT happened.

    // A whole new hand staggers in once per round; a single drawn card arrives.
    const handEls = root.querySelectorAll('.hand [data-hand]');
    if (myHand.length) {
      if (v.round !== seenDeal) { dealIn(handEls, 40); seenDeal = v.round; }
      else handEls.forEach(el => {
        if (+el.dataset.hand >= prevHandLen) feel('arrive', { el, mine:true });
      });
    }

    // The card that just landed on a route. Yours hits harder than theirs.
    const lp = v.lastPlay;
    if (lp && ('p'+lp.n) !== seenPlay) {
      const owner = [...root.querySelectorAll('.routes')].find(n => n.dataset.owner === lp.pid);
      const routeEl = owner && owner.querySelector('[data-route="'+lp.color+'"]');
      feel('gain', { el: routeEl, mine: lp.pid === MY });
    }

    // Standing invitation: your controls glow while it's your move. The class has
    // to be re-applied every render (innerHTML replaced the node), but the haptic
    // is quieted unless the turn itself just changed hands.
    const turnKey = v.phase + ':' + v.turn;
    if (meTurn) feel('turn', { el: root.querySelector('.ctrl'), quiet: turnKey === seenTurn });
    seenTurn = turnKey;

    // animation bookkeeping: pops/glows fire once per event, not on every render
    prevHandLen = myHand.length;
    if (view.lastPlay) seenPlay = 'p'+view.lastPlay.n;

    root.querySelectorAll('[data-hand]').forEach(el => el.onclick = () => {
      sel = (sel === +el.dataset.hand) ? null : +el.dataset.hand; render();
    });
    root.querySelectorAll('[data-take]').forEach(el => el.onclick = () => {
      if (el.classList.contains('canTake')) Table.send({ t:'draw', from:el.dataset.take });
      // Rejected taps used to be silent. Say no: an empty pile, or the pile you
      // just fed and may not immediately take back.
      else if (meTurn && v.sub === 'draw') feel('blocked', { el, mine:true });
    });
    root.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a==='play' && selCard) Table.send({ t:'play', card:selCard });
      else if (a==='discard' && selCard) Table.send({ t:'discard', card:selCard });
      else if (a==='drawdeck') Table.send({ t:'draw', from:'deck' });
      else if (a==='next') Table.send({ t:'next' });
    });
  }
  function canPlayView(card) {
    const pile = view.routes[MY][card.c];
    if (card.v === 0) return pile.every(x => x.v === 0);
    return card.v > Math.max(0, ...pile.map(x => x.v));
  }

  render();
}
