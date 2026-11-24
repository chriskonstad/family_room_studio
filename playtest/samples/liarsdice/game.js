/* LIAR'S DICE — private dice, public bids, host-authoritative challenges.
   Ones are wild for bids on faces 2-6. Bids on ones count only ones. */

function createGame(Table, root) {
  const MY = Table.me.id;
  const START_DICE = 5;
  const rng = FR.rng(Table.seed);
  let G = null;
  let view = null;
  let table = null;

  function initGame(players) {
    G = {
      phase:'bidding', round:1, order:players.map(p => p.id), names:{}, emojis:{},
      diceCount:{}, dice:{}, current:null, starter:null, lastBid:null, lastBidder:null,
      reveal:null, loser:null, eliminated:[], banner:''
    };
    players.forEach(p => {
      G.names[p.id] = p.name;
      G.emojis[p.id] = p.emoji;
      G.diceCount[p.id] = START_DICE;
    });
    G.starter = G.order[0];
    startRound(G.starter);
  }

  function aliveIds() {
    return G.order.filter(id => (G.diceCount[id] || 0) > 0);
  }

  function nextAliveAfter(id, inclusive) {
    const alive = aliveIds();
    if (!alive.length) return null;
    let idx = G.order.indexOf(id);
    if (idx < 0) idx = 0;
    for (let step = inclusive ? 0 : 1; step <= G.order.length; step++) {
      const candidate = G.order[(idx + step) % G.order.length];
      if (alive.indexOf(candidate) !== -1) return candidate;
    }
    return alive[0];
  }

  function rollDice(count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(rng.range(1, 6));
    return out.sort((a, b) => a - b);
  }

  function startRound(starter) {
    const alive = aliveIds();
    G.order.forEach(id => { G.dice[id] = []; });
    alive.forEach(id => { G.dice[id] = rollDice(G.diceCount[id]); });
    G.phase = 'bidding';
    G.lastBid = null;
    G.lastBidder = null;
    G.reveal = null;
    G.loser = null;
    G.starter = nextAliveAfter(starter || alive[0], true);
    G.current = G.starter;
    G.banner = 'Round ' + G.round + ': ' + G.names[G.current] + ' opens the bidding';
  }

  function totalDice() {
    return aliveIds().reduce((sum, id) => sum + (G.diceCount[id] || 0), 0);
  }

  function countFace(face) {
    let n = 0;
    aliveIds().forEach(id => {
      (G.dice[id] || []).forEach(d => {
        if (face === 1 ? d === 1 : (d === face || d === 1)) n++;
      });
    });
    return n;
  }

  function validBid(qty, face) {
    qty = Number(qty);
    face = Number(face);
    if (!Number.isInteger(qty) || !Number.isInteger(face)) return false;
    if (qty < 1 || qty > totalDice() || face < 1 || face > 6) return false;
    if (!G.lastBid) return true;
    return qty > G.lastBid.qty || (qty === G.lastBid.qty && face > G.lastBid.face);
  }

  function bidOptions() {
    const out = [];
    for (let qty = 1; qty <= totalDice(); qty++) {
      for (let face = 1; face <= 6; face++) {
        if (validBid(qty, face)) out.push({ qty, face });
      }
    }
    return out;
  }

  function makeBid(from, qty, face) {
    G.lastBid = { qty:Number(qty), face:Number(face) };
    G.lastBidder = from;
    G.current = nextAliveAfter(from, false);
    G.banner = G.names[from] + ' bids ' + bidText(G.lastBid) + '. ' + G.names[G.current] + ' is up.';
  }

  function challenge(from) {
    if (!G.lastBid || from !== G.current) return;
    const actual = countFace(G.lastBid.face);
    const bidWasTrue = actual >= G.lastBid.qty;
    const loser = bidWasTrue ? from : G.lastBidder;
    G.diceCount[loser] = Math.max(0, (G.diceCount[loser] || 0) - 1);
    if (G.diceCount[loser] === 0 && G.eliminated.indexOf(loser) === -1) G.eliminated.push(loser);
    G.phase = 'revealed';
    G.loser = loser;
    G.reveal = {
      challenger:from,
      bid:{ qty:G.lastBid.qty, face:G.lastBid.face },
      actual,
      bidWasTrue,
      dice:copyDice()
    };
    G.banner = bidWasTrue
      ? G.names[from] + ' called, but the bid was true. ' + G.names[from] + ' loses a die.'
      : G.names[from] + ' caught the bluff. ' + G.names[G.lastBidder] + ' loses a die.';
    maybeFinish();
  }

  function maybeFinish() {
    const alive = aliveIds();
    if (alive.length === 1) {
      G.phase = 'gameOver';
      if (table) table.stop();
      Table.endGame({
        winnerId:alive[0],
        standings:standings().map(item => ({
          playerId:item.id,
          score:item.score,
          detail:item.score + ' ' + (item.score === 1 ? 'die' : 'dice') + ' left'
        }))
      });
      return true;
    }
    return false;
  }

  function nextRound() {
    if (G.phase !== 'revealed') return;
    G.round++;
    startRound(G.loser);
  }

  function standings() {
    return G.order.slice().sort((a, b) => {
      const byDice = (G.diceCount[b] || 0) - (G.diceCount[a] || 0);
      if (byDice) return byDice;
      return G.order.indexOf(a) - G.order.indexOf(b);
    }).map(id => ({ id, score:G.diceCount[id] || 0 }));
  }

  function copyDice() {
    const out = {};
    G.order.forEach(id => { out[id] = (G.dice[id] || []).slice(); });
    return out;
  }

  const seatsView = {
    get all() { return G ? G.order : []; },
    get current() { return G ? G.current : null; }
  };

  function buildTable() {
    return FR.host({
      state:G, seats:seatsView, hostId:MY, phase:() => G.phase, publish:syncAll,
      intents:{
        bid:{ phase:'bidding', turn:true,
          options:bidOptions,
          when:ctx => validBid(ctx.msg.qty, ctx.msg.face),
          run:ctx => makeBid(ctx.from, ctx.msg.qty, ctx.msg.face) },
        challenge:{ phase:'bidding', turn:true,
          when:() => !!G.lastBid,
          run:ctx => challenge(ctx.from) },
        next:{ host:true, phase:'revealed', run:nextRound }
      }
    });
  }

  function publicFor(id) {
    const revealed = G.reveal ? G.reveal.dice : null;
    return {
      phase:G.phase, round:G.round, names:G.names, emojis:G.emojis, order:G.order.slice(),
      diceCount:{...G.diceCount}, current:G.current, lastBid:G.lastBid,
      lastBidder:G.lastBidder, banner:G.banner, totalDice:totalDice(), loser:G.loser,
      eliminated:G.eliminated.slice(), reveal:G.reveal ? {
        challenger:G.reveal.challenger,
        bid:{ qty:G.reveal.bid.qty, face:G.reveal.bid.face },
        actual:G.reveal.actual,
        bidWasTrue:G.reveal.bidWasTrue,
        dice:revealed
      } : null,
      ownDice:(G.dice[id] || []).slice(),
      legalBids:id === G.current && G.phase === 'bidding' ? bidOptions() : []
    };
  }

  function syncAll() {
    if (!G) return;
    // Never sendTo yourself: the host renders its own copy directly below, and a
    // self-send loops back into onMessage as a bogus 'state' intent for the reducer
    // to refuse — noise on the wire and in the rejection log, found by the fuzzer.
    G.order.forEach(id => { if (id !== MY) Table.sendTo(id, { t:'state', s:publicFor(id) }); });
    view = publicFor(MY);
    render();
  }

  if (Table.isHost) {
    Table.onStart(players => { initGame(players); table = buildTable(); syncAll(); });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
  } else {
    Table.onStart(() => { view = null; render(); });
    Table.onMessage((_from, msg) => {
      if (msg.t === 'state') { view = msg.s; render(); }
    });
  }

  let pickQty = 1;
  let pickFace = 2;
  /* The bid the stepper was last set against. When it changes — somebody raised, or a
   * new round opened — the stepper goes back to the smallest legal bid. Keeping the old
   * numbers whenever they were still legal carried last round's 4 x 4 into the next
   * round's OPENING bid, one thumb-tap from opening far higher than you meant to. */
  let pickBase = null;

  function render() {
    if (!view) {
      root.innerHTML = '<div class="wait">Waiting for the host...</div>';
      return;
    }
    clampPick();
    root.innerHTML =
      '<div class="top">' +
        '<div><div class="brand">Liar\'s Dice</div><div class="sub">Ones are wild for bids on 2-6</div></div>' +
        '<div class="count"><b>' + view.totalDice + '</b>dice in play</div>' +
      '</div>' +
      '<div class="banner">' + esc(view.banner) + '</div>' +
      renderBidBox() +
      '<div class="table' + (view.order.length > 6 ? ' many' : '') + '">' + view.order.map(renderSeat).join('') + '</div>' +
      '<div class="controls">' + renderControls() + '</div>';
    wireControls();
  }

  function renderBidBox() {
    const bid = view.lastBid;
    const bidder = view.lastBidder ? playerName(view.lastBidder) : '';
    let truth = '';
    if (view.reveal) {
      truth = '<div class="truth">' + esc(bidText(view.reveal.bid)) + ' needed ' +
        view.reveal.bid.qty + '; there were ' + view.reveal.actual + '.</div>';
    }
    return '<div class="bidbox"><div class="bidline">' +
      '<div><div class="bidlabel">Current bid</div><div class="bidvalue">' +
      (bid ? esc(bidText(bid)) : 'No bid') + '</div></div>' +
      '<div class="bidby">' + (bid ? 'by<br><b>' + esc(bidder) + '</b>' : 'opening<br>bid') + '</div>' +
      '</div>' + truth + '</div>';
  }

  function renderSeat(id) {
    const out = (view.diceCount[id] || 0) <= 0;
    const classes = ['seat'];
    if (id === MY) classes.push('me');
    if (id === view.current && view.phase === 'bidding') classes.push('turn');
    if (out) classes.push('out');
    return '<div class="' + classes.join(' ') + '">' +
      '<div class="who"><span>' + esc(view.emojis[id] || '') + '</span><span class="name">' + esc(view.names[id] || id) +
      '</span><span class="dice-left">' + (view.diceCount[id] || 0) + ' dice</span></div>' +
      '<div class="pips">' + renderDice(id) + '</div>' +
    '</div>';
  }

  function renderDice(id) {
    const dice = view.reveal ? (view.reveal.dice[id] || []) : (id === MY ? view.ownDice : hiddenDice(view.diceCount[id] || 0));
    if (!dice.length) return '<span class="sub">out</span>';
    return dice.map(d => {
      if (d === '?') return '<span class="die hidden">?</span>';
      return '<span class="die ' + (d === 1 ? 'wild' : '') + '">' + d + '</span>';
    }).join('');
  }

  function hiddenDice(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('?');
    return out;
  }

  function renderControls() {
    if (view.phase === 'revealed') {
      if (Table.isHost) return '<button class="primary" id="next">Next round</button>';
      return '<div class="wait">Waiting for the host to roll the next round.</div>';
    }
    if (view.phase === 'gameOver') return '<div class="wait">Game over.</div>';
    if (view.current !== MY) return '<div class="wait">' + esc(playerName(view.current)) + ' is choosing.</div>';
    return '<div class="pickers">' +
      '<div class="picker"><label>Quantity</label><div class="step"><button id="qtyDown">-</button><div class="num">' + pickQty + '</div><button id="qtyUp">+</button></div></div>' +
      '<div class="picker"><label>Face</label><div class="step"><button id="faceDown">-</button><div class="num">' + pickFace + '</div><button id="faceUp">+</button></div></div>' +
      '</div><div class="btnrow"><button class="primary" id="bid" ' + (canPickBid() ? '' : 'disabled') + '>Bid ' + esc(bidText({ qty:pickQty, face:pickFace })) +
      '</button><button class="danger" id="challenge" ' + (view.lastBid ? '' : 'disabled') + '>Call bluff</button></div>';
  }

  function wireControls() {
    const byId = id => root.querySelector('#' + id);
    const on = (id, fn) => { const el = byId(id); if (el) el.onclick = fn; };
    on('next', () => Table.send({ t:'next' }));
    on('qtyDown', () => { pickQty--; clampPick(); render(); });
    on('qtyUp', () => { pickQty++; clampPick(); render(); });
    on('faceDown', () => { pickFace--; clampPick(); render(); });
    on('faceUp', () => { pickFace++; clampPick(); render(); });
    on('bid', () => { if (canPickBid()) Table.send({ t:'bid', qty:pickQty, face:pickFace }); });
    on('challenge', () => Table.send({ t:'challenge' }));
  }

  function clampPick() {
    pickQty = Math.max(1, Math.min(view ? view.totalDice : START_DICE, pickQty));
    pickFace = Math.max(1, Math.min(6, pickFace));
    const legal = view && view.legalBids ? view.legalBids : [];
    const base = view ? view.round + ':' + (view.lastBid ? view.lastBid.qty + 'x' + view.lastBid.face : 'open') : null;
    if (legal.length && (!canPickBid() || base !== pickBase)) {
      pickBase = base;
      pickQty = legal[0].qty;
      pickFace = legal[0].face;
    }
  }

  function canPickBid() {
    return !!(view && view.legalBids || []).some(b => b.qty === pickQty && b.face === pickFace);
  }

  function bidText(bid) {
    if (!bid) return 'No bid';
    return bid.qty + ' x ' + bid.face;
  }

  function playerName(id) {
    return (view && view.names && view.names[id]) || id || '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[c]));
  }

  render();
}
