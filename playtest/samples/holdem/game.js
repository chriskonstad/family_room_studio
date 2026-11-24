/* HOLD'EM — the board on the television if there is one, your two cards in your hand.
 *
 * Poker is already split exactly the way a Family Room table is: the community
 * cards, the pot, the stacks and who has bet what are all PUBLIC and belong in the
 * middle of the room, and the two cards that decide what any of it means are
 * PRIVATE and belong face-down in front of one person.
 *
 * WITH A TV the screen is the felt — five cards, the pot, every seat with its
 * chips, the button, and whose turn it is — and a phone is just your hand, your
 * chips and your buttons.
 *
 * WITHOUT ONE every phone is the felt as well: the seats, their stacks and bets,
 * the button, whose turn it is, and at a showdown everybody's cards and what they
 * won. `"screen": "optional"`, because a living room without an Apple TV should
 * still be able to play. Only the host's shell knows whether a screen is attached
 * (`Table.screens`), so the host publishes it in the state and every phone lays
 * itself out from that — and a TV switched on or off mid-game re-lays every phone
 * on the next publish. A shell too old to say counts as "no TV": a phone showing
 * the whole table beside a TV is redundant, a phone assuming a TV that isn't there
 * shows nothing at all.
 *
 * WHAT KEEPS THE HOLE CARDS HOLE
 *
 * Not care. Routing. The host deals with `Table.sendTo`, and a screen is never a
 * `sendTo` recipient, so the cards are not in the state `screen.js` can see. The
 * private message is `{t:'hole'}` and the public one is `{t:'state'}` — different
 * types ON PURPOSE: the screen harness probes a screen by handing it the host's
 * private payloads, and a screen that stashed whatever arrived under one shared
 * type would render a player's cards onto the wall of the room it was meant to
 * protect. Two names, and that is unwritable.
 *
 * Cards on the wire are numbers (`{r:2..14, s:0..3}`), never 'Ah' — a private
 * payload with no readable text in it cannot be accidentally drawn as something
 * meaningful. `invariants.mjs` carries the real proof: no broadcast contains a
 * card from anyone's hand until the showdown reveals it.
 *
 * THE RULES LIVE IN rules.js
 *
 * Evaluating seven cards and splitting side pots are in `rules.js`, tested
 * against worked examples in `rules.test.mjs`, and loaded by the host, by your
 * phone (to tell you what you're holding) and by the fuzzer. One implementation:
 * a second opinion about what beats what would agree with itself for a thousand
 * hands and then give the pot to the wrong person in front of everybody.
 *
 * THE GAME ENDS
 *
 * Blinds climb every few hands, which is both how a tournament feels and the
 * reason this terminates: eventually the big blind is bigger than a stack, every
 * hand is all-in, and somebody wins the table. A poker game that can run forever
 * is a poker game the harness cannot prove finishes.
 */

function createGame(Table, root) {
  const MY = Table.me.id;
  const R = HOLDEM_RULES;

  const START_STACK = 500;
  /* Small/big blind by level. The last level is bigger than any possible stack,
   * so the tournament cannot outlive it. */
  const LEVELS = [[5, 10], [10, 20], [20, 40], [40, 80], [75, 150],
                  [150, 300], [300, 600], [600, 1200], [1500, 3000]];
  const HANDS_PER_LEVEL = 5;
  /* A beat with the table frozen, so the room SEES a card land or a pot won
   * before anything else can happen. `table.hold` is what makes these safe:
   * no tap during the pause can land, so a dramatic pause can't be raced. */
  const STREET_MS = 850;
  const SHOWDOWN_MS = 3200;
  const FOLDED_WIN_MS = 1700;

  const SUIT = ['♠', '♥', '♦', '♣'];
  const isRed = (c) => c.s === 1 || c.s === 2;

  let view = null;        // the public state — every phone and the TV render this
  let myHole = [];        // PRIVATE: only ever arrives by sendTo, never broadcast
  let myHoleHand = 0;     // which hand those cards belong to
  let G = null;           // authoritative, host only

  /* Game feel, guarded so the bundle still runs on an older harness. */
  const feel = (ev, o) => { try { if (Table.feel) Table.feel(ev, o); } catch (e) {} };
  const dealIn = (n, s) => { try { if (Table.feel && Table.feel.deal) Table.feel.deal(n, s); } catch (e) {} };

  // Seeded from the table: every shuffle replays under `--seed`.
  const rng = FR.rng(Table.seed);
  // FR.seats is a close fit for poker's THREE kinds of not-playing: 'folded' and
  // 'allin' are temporary and cleared when the next hand starts, while busting out
  // is permanent — and the order players bust IS the finishing order, which is
  // exactly what FR.standings.byElimination wants at the end.
  const seats = FR.seats(Table.players.map(p => p.id));
  const timers = FR.timers();
  let table = null;

  const st = (id) => seats.status(id);
  /** Still in this hand — able to act, or all-in and waiting on the cards. */
  const inHand = () => G.order.filter(id => st(id) === 'active' || st(id) === 'allin');
  /** Able to act: has chips, hasn't folded, isn't all-in. */
  const canAct = () => seats.active;
  const sum = (obj) => Object.keys(obj).reduce((n, k) => n + (obj[k] || 0), 0);
  const potTotal = () => sum(G.committed);

  /** The first seat after `id` (exclusive) that passes `pred`, or null. */
  function stepFrom(id, pred) {
    const n = G.order.length;
    const at = G.order.indexOf(id);
    if (at < 0) return null;
    for (let k = 1; k <= n; k++) {
      const c = G.order[(at + k) % n];
      if (pred(c)) return c;
    }
    return null;
  }
  /** Betting order from the dealer's left — who gets an odd chip in a split. */
  function orderFromDealer() {
    const d = seats.dealer;
    const at = Math.max(0, G.order.indexOf(d));
    const out = [];
    for (let k = 1; k <= G.order.length; k++) out.push(G.order[(at + k) % G.order.length]);
    return out;
  }

  /* -------------------------------------------------------------- a hand --- */

  function initGame(players) {
    G = {
      order: players.map(p => p.id), names: {}, emojis: {},
      stacks: {}, committed: {}, bet: {}, acted: {}, lastAction: {},
      hole: {}, board: [], deck: [],
      hand: 0, level: 0, sb: LEVELS[0][0], bb: LEVELS[0][1],
      betToMatch: 0, minRaise: 0, toAct: null,
      phase: 'handEnd', street: 'preflop', banner: '', reveal: null,
      startChips: 0, lastPot: 0
    };
    players.forEach(p => {
      G.names[p.id] = p.name; G.emojis[p.id] = p.emoji;
      G.stacks[p.id] = START_STACK; G.committed[p.id] = 0; G.bet[p.id] = 0;
    });
    G.startChips = START_STACK * players.length;
  }

  function post(id, amount) {
    const amt = Math.max(0, Math.min(amount, G.stacks[id]));
    G.stacks[id] -= amt;
    G.bet[id] = (G.bet[id] || 0) + amt;
    G.committed[id] = (G.committed[id] || 0) + amt;
    if (G.stacks[id] === 0) seats.setStatus(id, 'allin');
    return amt;
  }

  function startHand() {
    G.hand++;
    G.level = Math.min(LEVELS.length - 1, Math.floor((G.hand - 1) / HANDS_PER_LEVEL));
    G.sb = LEVELS[G.level][0];
    G.bb = LEVELS[G.level][1];

    // Everyone not busted is live again; the button moves from the second hand on.
    seats.startRound(G.hand > 1);
    const live = seats.remaining;

    G.board = []; G.reveal = null; G.hole = {};
    G.acted = {}; G.lastAction = {};
    G.order.forEach(id => { G.committed[id] = 0; G.bet[id] = 0; });
    G.deck = rng.shuffle(R.deck());
    live.forEach(id => { G.hole[id] = [G.deck.pop(), G.deck.pop()]; });

    /* Heads-up reverses the blinds: the button IS the small blind and acts first
     * before the flop, then last after it. Special-casing only who POSTS lets the
     * general "first to act is after the big blind / after the button" rules below
     * produce the right answer for two players without a second code path. */
    const dealerId = seats.dealer;
    let sbId, bbId;
    if (live.length === 2) {
      sbId = dealerId;
      bbId = stepFrom(dealerId, (id) => st(id) !== 'out');
    } else {
      sbId = stepFrom(dealerId, (id) => st(id) !== 'out');
      bbId = stepFrom(sbId, (id) => st(id) !== 'out');
    }
    post(sbId, G.sb);
    post(bbId, G.bb);
    G.blindIds = { sb: sbId, bb: bbId };
    G.betToMatch = Math.max(G.bet[sbId] || 0, G.bet[bbId] || 0);
    G.minRaise = G.bb;
    G.street = 'preflop';
    G.phase = 'betting';
    G.banner = G.names[dealerId] + ' deals';

    dealHoles();

    // The blinds are posted, not acted: the big blind still gets their option.
    const first = stepFrom(bbId, (id) => st(id) === 'active');
    if (!first || canAct().length < 2) {
      // Both blinds all-in, or everyone but one is: there is nothing to bet for.
      G.toAct = null;
      runItOut();
      return;
    }
    setToAct(first);
  }

  function dealHoles() {
    inHand().forEach(id => {
      if (id === MY) { myHole = G.hole[id].slice(); myHoleHand = G.hand; }
      else Table.sendTo(id, { t: 'hole', hand: G.hand, cards: G.hole[id] });
    });
  }

  function setToAct(id) {
    G.toAct = id;
    // FR.host's turn guard reads seats.current, so the two must never disagree —
    // if they did, every intent would be refused and the hand would sit forever.
    seats.moveTo(id);
  }

  /* ------------------------------------------------------------- betting --- */

  const needToCall = (id) => Math.max(0, G.betToMatch - (G.bet[id] || 0));
  const maxTo = (id) => (G.bet[id] || 0) + (G.stacks[id] || 0);
  const canCheck = (id) => needToCall(id) === 0;
  const canCall = (id) => needToCall(id) > 0 && (G.stacks[id] || 0) > 0;
  const canRaise = (id) => maxTo(id) > G.betToMatch && (G.stacks[id] || 0) > 0;
  const minRaiseTo = (id) => Math.min(maxTo(id), G.betToMatch + G.minRaise);

  /**
   * The raise sizes the phone offers and the fuzzer enumerates.
   *
   * A slider cannot be enumerated, and an intent the harness cannot enumerate is
   * an intent nothing ever tests. Four sizes are also simply better on a phone
   * than a slider nobody can place accurately with a thumb: the minimum, half the
   * pot, the pot, and everything.
   */
  function raiseOptions(id) {
    if (!canRaise(id)) return [];
    const lo = minRaiseTo(id), hi = maxTo(id);
    const pot = potTotal();
    const wants = [lo, G.betToMatch + Math.round(pot / 2), G.betToMatch + pot, hi];
    const out = [];
    wants.forEach(v => {
      const to = Math.round(v);
      if (to >= lo && to <= hi && out.indexOf(to) === -1) out.push(to);
    });
    return out.sort((a, b) => a - b);
  }

  function raiseSizeOk(id, rawTo) {
    const to = Math.round(Number(rawTo));
    return isFinite(to) && to >= minRaiseTo(id) && to <= maxTo(id) && to > (G.bet[id] || 0);
  }

  function doCheck(id) { G.acted[id] = true; G.lastAction[id] = 'check'; advance(id); }

  function doCall(id) {
    const need = needToCall(id);
    const paid = post(id, need);
    G.acted[id] = true;
    G.lastAction[id] = paid < need ? 'all in' : 'call';
    advance(id);
  }

  function doFold(id) {
    seats.setStatus(id, 'folded');
    G.acted[id] = true;
    G.lastAction[id] = 'fold';
    advance(id);
  }

  function doRaise(id, rawTo) {
    const to = Math.round(Number(rawTo));
    // Never trust the wire: a raise outside the legal window is ignored rather
    // than clamped, so a malformed message can't move chips to a size nobody
    // chose. Every size the UI offers is inside it.
    if (!isFinite(to) || to < minRaiseTo(id) || to > maxTo(id)) return;
    const add = to - (G.bet[id] || 0);
    if (add <= 0) return;
    const raiseBy = to - G.betToMatch;
    post(id, add);
    if (raiseBy > 0) G.minRaise = Math.max(G.minRaise, raiseBy);
    G.betToMatch = Math.max(G.betToMatch, to);
    // A raise reopens the betting: everyone still in has to answer it.
    G.acted = {};
    G.acted[id] = true;
    G.lastAction[id] = (G.stacks[id] === 0) ? 'all in' : 'raise';
    advance(id);
  }

  /** Has everyone who can still act both acted and matched the bet? */
  function roundDone() {
    const act = canAct();
    if (!act.length) return true;
    for (let i = 0; i < act.length; i++) {
      const id = act[i];
      if (!G.acted[id]) return false;
      if ((G.bet[id] || 0) !== G.betToMatch) return false;
    }
    return true;
  }

  function advance(pivot) {
    const live = inHand();
    if (live.length <= 1) return endHand(live[0]);
    if (roundDone()) return nextStreet();
    const nxt = stepFrom(pivot || G.toAct, (id) => st(id) === 'active');
    if (!nxt) return nextStreet();
    setToAct(nxt);
  }

  const STREETS = ['preflop', 'flop', 'turn', 'river'];

  /** Burn one and turn the next street's cards. */
  function dealStreet(name) {
    G.street = name;
    G.deck.pop();                                  // the burn card, as at a real table
    const n = name === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) G.board.push(G.deck.pop());
    G.banner = name === 'flop' ? 'The flop' : name === 'turn' ? 'The turn' : 'The river';
  }

  function sweep() {
    G.order.forEach(id => { G.bet[id] = 0; });
    G.betToMatch = 0;
    G.minRaise = G.bb;
    G.acted = {};
    G.lastAction = {};
  }

  function nextStreet() {
    sweep();
    if (G.street === 'river') return showdown();
    const next = STREETS[STREETS.indexOf(G.street) + 1];
    G.toAct = null;
    dealStreet(next);
    if (inHand().length <= 1) return endHand(inHand()[0]);
    if (canAct().length < 2) return runItOut();
    // A held beat so the room sees the card land before anyone can act on it.
    table.hold(STREET_MS, function () {
      const first = stepFrom(seats.dealer, (id) => st(id) === 'active');
      if (!first) return nextStreet();
      G.phase = 'betting';
      setToAct(first);
    });
  }

  /**
   * Everyone left is all-in: there is nothing to decide, so deal the rest of the
   * board a beat at a time and show down. A sequence keeps the table frozen
   * throughout, which is what makes the run-out watchable instead of instant.
   */
  function runItOut() {
    const steps = [];
    let s = G.street;
    while (s !== 'river') {
      s = STREETS[STREETS.indexOf(s) + 1];
      steps.push((function (name) { return function () { dealStreet(name); }; })(s));
    }
    G.toAct = null;
    if (!steps.length) return showdown();
    table.sequence(STREET_MS, steps, showdown);
  }

  /* ----------------------------------------------------------- the money --- */

  /**
   * The chips have moved out of the pot and into somebody's stack, so stop
   * counting them in both places.
   *
   * Without this the table's chips were briefly wrong by exactly the size of the
   * pot: the winnings were added to a stack while `committed` still held the same
   * chips, so for the length of a showdown the room owned more money than it had
   * started with. Nothing visible went wrong, which is how it would have shipped.
   * `lastPot` keeps the NUMBER for the screen to show while it is being won.
   */
  function settle() {
    G.lastPot = potTotal();
    G.order.forEach(id => { G.committed[id] = 0; G.bet[id] = 0; });
  }

  /** Who committed what, and whether they can still win it. */
  function potPlayers() {
    return G.order.map(id => ({
      id: id,
      committed: G.committed[id] || 0,
      folded: st(id) !== 'active' && st(id) !== 'allin'
    }));
  }

  function showdown() {
    const live = inHand();
    if (live.length <= 1) return endHand(live[0]);

    const scores = {};
    live.forEach(id => { scores[id] = R.evaluate(G.hole[id].concat(G.board)); });
    const pots = R.buildPots(potPlayers());
    const award = R.awardPots(pots, scores, orderFromDealer());
    Object.keys(award.won).forEach(id => { G.stacks[id] = (G.stacks[id] || 0) + award.won[id]; });
    settle();

    // Cards are SHOWN at a showdown — this is the one moment they become public,
    // and it goes out on the broadcast so the television can turn them over.
    /* Two cards each and the name of the hand. The five cards that MADE each hand
     * are not sent: nothing draws them, and an unused field carrying hole cards is
     * one more place a card can escape from for no benefit at all. */
    const reveal = { hole: {}, hands: {}, won: award.won,
                     pots: pots.map(p => ({ amount: p.amount, eligible: p.eligible.slice() })),
                     detail: award.detail, uncontested: false };
    live.forEach(id => {
      reveal.hole[id] = G.hole[id].slice();
      reveal.hands[id] = scores[id].name;
    });
    G.reveal = reveal;

    const top = award.detail.length ? award.detail[award.detail.length - 1] : null;
    const winners = Object.keys(award.won);
    G.banner = winners.length === 1
      ? G.names[winners[0]] + ' wins ' + award.won[winners[0]] + ' with ' + reveal.hands[winners[0]]
      : winners.map(id => G.names[id]).join(' and ') + ' split the pot';
    if (top && winners.length > 1) G.banner += ' — ' + top.name;

    G.phase = 'showdown';
    table.hold(SHOWDOWN_MS, endOfHand);
  }

  /** Everyone else folded: the pot is taken without showing a card. */
  function endHand(winnerId) {
    const pot = potTotal();
    G.stacks[winnerId] = (G.stacks[winnerId] || 0) + pot;
    settle();
    // No reveal: a hand that wins uncontested is mucked, at a real table and here.
    G.reveal = { hole: {}, hands: {}, won: {}, pots: [], detail: [], uncontested: true };
    G.reveal.won[winnerId] = pot;
    G.banner = G.names[winnerId] + ' wins ' + pot + ' — everyone folded';
    G.phase = 'showdown';
    table.hold(FOLDED_WIN_MS, endOfHand);
  }

  function endOfHand() {
    // Busting out is permanent, and the order of it is the finishing order. The
    // shorter stack busts first when two go down together, which is the rule a
    // real table uses and the only way a tie in elimination ranks consistently.
    const busted = G.order.filter(id => st(id) !== 'out' && (G.stacks[id] || 0) <= 0);
    busted.sort((a, b) => (G.committed[a] || 0) - (G.committed[b] || 0));
    busted.forEach(id => {
      G.lastAction[id] = 'out';
      seats.eliminate(id);
    });
    G.order.forEach(id => { G.committed[id] = 0; G.bet[id] = 0; });

    if (seats.remaining.length <= 1) return finish();
    G.phase = 'handEnd';
    G.toAct = null;
  }

  /** 1st, 2nd, 3rd, 4th — "out 2th" is the sort of thing a results screen shows
   *  to a whole room for a full minute. */
  function ordinal(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }

  function finish() {
    G.phase = 'gameOver';
    timers.cancelAll();
    if (table) table.stop();
    const champ = seats.remaining[0] || null;
    const r = FR.standings.byElimination(seats, {
      detail: (id, place) => place === 1 ? 'took the table' : (ordinal(place) + ' out of ' + seats.all.length)
    });
    Table.endGame({
      title: champ ? (G.names[champ] + ' takes it all') : 'Game over',
      winnerId: r.winnerId,
      standings: r.standings.map(row => ({
        playerId: row.playerId,
        score: G.stacks[row.playerId] || 0,
        detail: row.detail
      }))
    });
  }

  /* ---------------------------------------------------------- the wiring --- */

  function publicState() {
    const status = {};
    G.order.forEach(id => { status[id] = st(id); });
    const bets = {};
    G.order.forEach(id => { bets[id] = G.bet[id] || 0; });
    return {
      phase: G.phase, street: G.street, hand: G.hand,
      sb: G.sb, bb: G.bb, level: G.level + 1, levels: LEVELS.length,
      order: G.order.slice(), names: G.names, emojis: G.emojis,
      stacks: Object.assign({}, G.stacks), bet: bets, status: status,
      committed: Object.assign({}, G.committed),
      board: G.board.slice(),
      /* While a pot is being awarded there is nothing in the middle any more —
       * it is already in somebody's stack — but the room is looking at the number
       * it just won, so show that. */
      pot: (G.phase === 'showdown' || G.phase === 'handEnd') ? (G.lastPot || 0) : potTotal(),
      /* What is already swept in, so the TV can show the pot and the chips still
       * sitting in front of people without counting the same chip twice. */
      collected: potTotal() - sum(bets),
      betToMatch: G.betToMatch, minRaise: G.minRaise,
      toAct: G.toAct, dealer: seats.dealer, blinds: G.blindIds || null,
      lastAction: Object.assign({}, G.lastAction),
      banner: G.banner, reveal: G.reveal,
      startChips: G.startChips,
      screen: screensNow()
    };
  }

  /** Shared screens attached right now, as only the host's shell knows. */
  function screensNow() {
    return typeof Table.screens === 'number' ? Table.screens : 0;
  }

  function publish() {
    const s = publicState();
    Table.broadcast({ t: 'state', s });
    view = s;
    render();
  }

  if (Table.isHost) {
    Table.onStart(players => {
      initGame(players);
      table = buildTable();
      startHand();
      publish();
    });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
    // A TV switched on or off mid-game: every phone re-lays itself on the next state.
    // Publishing is safe at any moment, held frame or not — it changes nothing.
    if (Table.onScreensChange) Table.onScreensChange(() => { if (G) publish(); });
  } else {
    Table.onStart(() => { view = null; render(); });
    Table.onMessage((_from, msg) => {
      if (!msg) return;
      if (msg.t === 'state') { view = msg.s; render(); }
      // The ONLY place a hole card ever arrives. Its own message type, so no
      // public handler can ever be the thing that stores it.
      else if (msg.t === 'hole') { myHole = msg.cards || []; myHoleHand = msg.hand || 0; render(); }
    });
  }

  function buildTable() {
    return FR.host({
      state: G, seats: seats, timers: timers, hostId: MY,
      phase: () => G.phase,
      publish: publish,
      /* Order matters here. `legalMoves` lists these in declaration order, and the
       * screen harness drives a game by taking the FIRST legal move — so with
       * check and call in front, a headless run plays hands to a showdown and the
       * television gets exercised through every street. Put fold first and every
       * hand would end before the flop, from a run that looked perfectly green. */
      intents: {
        check: { phase: 'betting', turn: true,
                 when: (ctx) => canCheck(ctx.from),
                 run: (ctx) => doCheck(ctx.from) },
        call:  { phase: 'betting', turn: true,
                 when: (ctx) => canCall(ctx.from),
                 run: (ctx) => doCall(ctx.from) },
        // The size is part of the guard. A raise outside the legal window used to be
        // ACCEPTED and then quietly ignored inside doRaise — the host took the intent,
        // nothing happened, and no check could tell a button that does nothing from one
        // that works. Refused, it is visible: to the fuzzer, and to FR.host's log.
        raise: { phase: 'betting', turn: true,
                 when: (ctx) => canRaise(ctx.from) && raiseSizeOk(ctx.from, ctx.msg && ctx.msg.to),
                 options: (ctx) => raiseOptions(ctx.from).map(to => ({ to: to })),
                 run: (ctx) => doRaise(ctx.from, ctx.msg.to) },
        fold:  { phase: 'betting', turn: true,
                 run: (ctx) => doFold(ctx.from) },
        next:  { host: true, phase: 'handEnd', run: () => startHand() },
      }
    });
  }

  /* --------------------------------------------------------------- phone --- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let seenHand = 0, seenTurn = '', seenStack = null, seenStreet = '', seenOut = false;

  function cardHTML(c, cls) {
    return '<div class="pc ' + (cls || '') + (isRed(c) ? ' red' : '') + '">' +
      '<span class="r">' + R.RANK_SHORT[c.r] + '</span>' +
      '<span class="s">' + SUIT[c.s] + '</span></div>';
  }

  /** A card as a little inline pill — what a seat row has room for. */
  function miniCard(c) {
    return '<span class="mc' + (isRed(c) ? ' red' : '') + '">' + R.RANK_SHORT[c.r] + SUIT[c.s] + '</span>';
  }

  /**
   * Everybody at the table, for a room with no TV: one chip per seat, in seat order.
   * Two lines each — who and how much, then what they're doing this hand — so eight
   * seats fit on the smallest phone without scrolling. At a showdown the second line
   * is their cards and their hand; for the rest of the hand, their bet and last action.
   */
  function seatsHTML(v) {
    const contested = v.reveal && !v.reveal.uncontested;
    const done = v.phase === 'showdown' || v.phase === 'handEnd' || v.phase === 'gameOver';
    let h = '<div class="seats' + (v.order.length > 4 ? ' many' : '') + '">';
    v.order.forEach(id => {
      const st = v.status[id];
      const won = done && v.reveal && v.reveal.won ? (v.reveal.won[id] || 0) : 0;
      const turn = v.phase === 'betting' && v.toAct === id;
      const cls = ['seat', turn ? 'turn' : '', st === 'folded' ? 'folded' : '', st === 'out' ? 'out' : '',
                   id === MY ? 'me' : '', won ? 'won' : ''].filter(Boolean).join(' ');
      let tags = '';
      if (id === v.dealer && st !== 'out') tags += '<span class="tag d">D</span>';
      if (v.blinds && v.phase === 'betting' && v.street === 'preflop') {
        if (v.blinds.sb === id) tags += '<span class="tag">SB</span>';
        if (v.blinds.bb === id) tags += '<span class="tag">BB</span>';
      }
      let line2 = '';
      if (st === 'out') line2 = '<span class="act">out</span>';
      else if (contested && done && v.reveal.hole[id]) {
        line2 = v.reveal.hole[id].map(miniCard).join('') +
          '<span class="hand">' + esc(v.reveal.hands[id] || '') + '</span>';
      } else if (st === 'folded') line2 = '<span class="act">folded</span>';
      else {
        const bet = v.bet[id] || 0;
        const act = v.lastAction[id] || '';
        if (st === 'allin') line2 = '<span class="act allin">ALL IN</span>';
        else if (act) line2 = '<span class="act">' + esc(act) + '</span>';
        if (bet) line2 += '<span class="bet">' + bet + '</span>';
      }
      if (won) line2 += '<span class="plus">+' + won + '</span>';
      h += '<div class="' + cls + '">' +
        '<div class="sl"><span class="sn">' + esc((v.emojis[id] || '') + ' ' + (v.names[id] || '')) + '</span>' +
        tags + '<span class="ss">' + (v.stacks[id] || 0) + '</span></div>' +
        '<div class="sl2">' + (line2 || '&nbsp;') + '</div></div>';
    });
    return h + '</div>';
  }

  function render() {
    if (!view) {
      root.innerHTML = '<div class="wait">Taking a seat at the table…</div>';
      return;
    }
    const v = view;
    const tv = !!v.screen;
    const me = { stack: v.stacks[MY] || 0, bet: v.bet[MY] || 0, status: v.status[MY] || 'out' };
    const mine = myHoleHand === v.hand ? myHole : [];
    const folded = me.status === 'folded';
    const out = me.status === 'out';
    const myTurn = v.toAct === MY && v.phase === 'betting';
    root.classList.toggle('notv', !tv);

    let h = '<div class="hdr"><span class="brand">HOLD’EM</span>' +
      '<span class="sub">Hand ' + v.hand + ' · blinds ' + v.sb + '/' + v.bb + '</span>' +
      '<span class="chips">' + me.stack + '</span></div>';

    // With a TV this is the glance-down copy of the board, so it is small; without
    // one it IS the board, and gets a little more room.
    const cardCls = tv ? 'sm' : 'md';
    h += '<div class="board">';
    for (let i = 0; i < 5; i++) {
      h += v.board[i] ? cardHTML(v.board[i], cardCls) : '<div class="pc ' + cardCls + ' empty"></div>';
    }
    h += '</div>';
    h += '<div class="potline"><span class="pot">POT ' + v.pot + '</span>' +
      (v.betToMatch > me.bet && !folded && !out
        ? '<span class="tocall">' + (v.betToMatch - me.bet) + ' to call</span>' : '') +
      '</div>';

    h += '<div class="banner">' + esc(v.banner || '') + '</div>';

    if (!tv) h += seatsHTML(v);

    // Your cards, and what only you can know they mean.
    if (out) {
      h += '<div class="mine"><div class="wait">You’re out — ' +
        (tv ? 'watch the rest on the big screen.' : 'the table plays on above.') + '</div></div>';
    } else if (!mine.length) {
      h += '<div class="mine"><div class="wait">Waiting for the deal…</div></div>';
    } else {
      h += '<div class="mine' + (folded ? ' folded' : '') + '">' +
        '<div class="hole">' + mine.map(c => cardHTML(c, tv ? 'big' : 'mid')).join('') + '</div>' +
        '<div class="strength">' + esc(R.describe(mine, v.board)) + '</div></div>';
    }

    h += '<div class="actions">';
    if (v.phase === 'gameOver') {
      h += '<div class="wait">That’s the table.</div>';
    } else if (v.phase === 'handEnd') {
      // Before `folded`, and before `out`: whoever deals has to be offered the button
      // whatever happened to their own hand. This sat below the folded branch, so a
      // host who folded saw "Folded this hand." and NOBODY could deal — the whole
      // table stuck after any hand the host sat out. Only the host may deal.
      h += Table.isHost
        ? '<button class="primary" data-act="next">Deal the next hand</button>'
        : (out ? '' : '<div class="wait">Waiting for ' + esc(v.names[v.order[0]] || 'the host') + ' to deal…</div>');
    } else if (out) {
      h += '';
    } else if (folded) {
      h += '<div class="wait">Folded this hand.</div>';
    } else if (v.phase === 'showdown') {
      h += '<div class="wait">' + (v.reveal && v.reveal.uncontested ? 'Pot’s away…' : 'Cards up…') + '</div>';
    } else if (me.status === 'allin') {
      h += '<div class="wait">All in — nothing left to decide.</div>';
    } else if (myTurn) {
      const need = v.betToMatch - me.bet;
      h += '<div class="btnrow">';
      h += '<button class="danger" data-act="fold">Fold</button>';
      h += need > 0
        ? '<button class="primary" data-act="call">Call ' + Math.min(need, me.stack) + '</button>'
        : '<button class="primary" data-act="check">Check</button>';
      h += '</div>';
      // Raise sizes, not a slider: a thumb cannot place a slider accurately, and
      // a size the harness can enumerate is a size that gets tested.
      const opts = raiseSizes(v, me);
      if (opts.length) {
        h += '<div class="btnrow raises">' + opts.map(o =>
          '<button data-act="raise" data-to="' + o.to + '">' + esc(o.label) + '</button>').join('') + '</div>';
      }
    } else if (!v.toAct) {
      // Between streets the table is frozen and nobody is to act, so naming a
      // player here printed "Waiting for …" at the one moment with no answer.
      h += '<div class="wait">Dealing…</div>';
    } else {
      // Never a silent wait: say whose decision the table is on.
      h += '<div class="wait">Waiting for ' +
        esc((v.emojis[v.toAct] || '') + ' ' + (v.names[v.toAct] || '')) + '</div>';
    }
    h += '</div>';

    root.innerHTML = h;

    /* ---- feel, on the nodes we just wrote, once per event ---- */
    if (mine.length && v.hand !== seenHand) {
      seenHand = v.hand;
      dealIn(root.querySelectorAll('.hole .pc'), 90);
    }
    if (v.street !== seenStreet) {
      seenStreet = v.street;
      if (v.board.length) feel('reveal', { el: root.querySelector('.board') });
    }
    const turnKey = v.phase + ':' + v.toAct + ':' + v.hand;
    if (myTurn && turnKey !== seenTurn) feel('turn', { el: root.querySelector('.actions'), mine: true });
    if (myTurn) seenTurn = turnKey;
    if (seenStack != null && me.stack > seenStack) feel('gain', { mine: true });
    seenStack = me.stack;
    if (out && !seenOut) { seenOut = true; feel('eliminate', { mine: true }); }

    const send = (msg) => Table.send(msg);
    root.querySelectorAll('button[data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'raise') send({ t: 'raise', to: Number(b.dataset.to) });
        else send({ t: a });
      };
    });
  }

  /**
   * The same four sizes the host will accept, computed from the public state so a
   * phone that is not the host can offer them too.
   */
  function raiseSizes(v, me) {
    const max = me.bet + me.stack;
    if (max <= v.betToMatch || me.stack <= 0) return [];
    const lo = Math.min(max, v.betToMatch + v.minRaise);
    const wants = [
      { to: lo, label: 'Raise to ' + lo },
      { to: v.betToMatch + Math.round(v.pot / 2), label: '½ pot' },
      { to: v.betToMatch + v.pot, label: 'Pot' },
      { to: max, label: 'All in ' + max }
    ];
    const out = [];
    wants.forEach(w => {
      const to = Math.round(w.to);
      if (to >= lo && to <= max && !out.some(o => o.to === to)) {
        out.push({ to: to, label: to === max ? 'All in ' + max : w.label });
      }
    });
    return out.sort((a, b) => a.to - b.to);
  }

  render();
}
