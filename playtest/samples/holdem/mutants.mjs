/*
 * Bugs HOLD'EM's tests must catch. `node harness/mutants.mjs holdem` breaks a copy of
 * the bundle each of these ways and requires the suite to fail; one that survives is a
 * bug that would ship. Several of these DID ship, or nearly did — see each note.
 */
export default [
  {
    "name": "heads-up blinds are not reversed (the button should post the small blind)",
    "file": "game.js",
    "find": "if (live.length === 2) {",
    "replace": "if (false) {"
  },
  {
    "name": "a host who folded is not offered the Deal button",
    "file": "game.js",
    "find": "} else if (v.phase === 'handEnd') {",
    "replace": "} else if (v.phase === 'handEnd' && !folded) {"
  },
  {
    "name": "the evaluator is handed only the flop, so the wrong hand can win",
    "file": "game.js",
    "find": "scores[id] = R.evaluate(G.hole[id].concat(G.board));",
    "replace": "scores[id] = R.evaluate(G.hole[id].concat(G.board.slice(0, 3)));"
  },
  {
    "name": "every hole card goes out in the public broadcast",
    "file": "game.js",
    "find": "banner: G.banner, reveal: G.reveal,",
    "replace": "banner: G.banner, reveal: G.reveal, holes: G.hole,"
  },
  {
    "name": "the host's phone shows the next player's hole cards instead of its own",
    "file": "game.js",
    "find": "const mine = myHoleHand === v.hand ? myHole : [];",
    "replace": "const mine = (Table.isHost && G && G.hole[v.order[1]]) ? G.hole[v.order[1]] : (myHoleHand === v.hand ? myHole : []);"
  },
  {
    "name": "the TV draws the hole cards it is handed",
    "file": "screen.js",
    "find": "if (msg && msg.t === 'state') view = msg.s;",
    "replace": "if (msg && msg.t === 'state') view = msg.s;\n    if (msg && msg.t === 'hole' && view) view = Object.assign({}, view, { banner: msg.cards.map(function (c) { return c.r + '/' + c.s; }).join(' ') });",
    "checks": [
      "screen"
    ]
  },
  {
    "name": "a won pot is paid out but never leaves the middle",
    "file": "game.js",
    "find": "    G.lastPot = potTotal();\n    G.order.forEach(id => { G.committed[id] = 0; G.bet[id] = 0; });",
    "replace": "    G.lastPot = potTotal();"
  },
  {
    "name": "the raise buttons send a size the host will not take",
    "file": "game.js",
    "find": "if (a === 'raise') send({ t: 'raise', to: Number(b.dataset.to) });",
    "replace": "if (a === 'raise') send({ t: 'raise', to: Number(b.dataset.to) * 100 });"
  },
  {
    // Shipped until 1.1.2: FR.seats steps its dealer INDEX, so after a bust the same
    // live player dealt twice and the two after them paid the blinds twice running.
    "name": "after a bust the button stays put for a hand (FR.seats' index rotation)",
    "file": "game.js",
    "find": "    seats.startRound(false);\n    if (G.hand > 1) G.button = stepFrom(G.button, (id) => st(id) !== 'out');",
    "replace": "    seats.startRound(G.hand > 1);\n    G.button = seats.dealer;",
    "checks": [
      "tests"
    ]
  },
  {
    "name": "after a bust the button stays put — caught by the fuzzer alone",
    "file": "game.js",
    "find": "    seats.startRound(false);\n    if (G.hand > 1) G.button = stepFrom(G.button, (id) => st(id) !== 'out');",
    "replace": "    seats.startRound(G.hand > 1);\n    G.button = seats.dealer;",
    "checks": [
      "playtest"
    ]
  },
  {
    // Shipped until 1.1.2: the sort read `committed`, already zeroed by settle(), so two
    // players busting in one hand were ranked by seat instead of by stack.
    "name": "two players busting in one hand are ranked by seat, not by the stack they started with",
    "file": "game.js",
    "find": "busted.sort((a, b) => (G.handStart[a] || 0) - (G.handStart[b] || 0));",
    "replace": "busted.sort((a, b) => (G.committed[a] || 0) - (G.committed[b] || 0));",
    "checks": [
      "tests"
    ]
  },
  {
    "name": "a TV switched on or off mid-hand is never told to the phones (or to the TV)",
    "file": "game.js",
    "find": "if (Table.onScreensChange) Table.onScreensChange(() => { if (G) publish(); });",
    "replace": "",
    "checks": [
      "tests"
    ]
  },
  {
    "name": "with no TV, the phone still shows only your hand (the table is nowhere)",
    "file": "game.js",
    "find": "    if (!tv) h += seatsHTML(v);",
    "replace": "",
    "checks": [
      "tests"
    ]
  }
];
