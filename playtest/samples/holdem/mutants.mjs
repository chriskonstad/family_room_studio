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
    "name": "with no TV, the phone still shows only your hand (the table is nowhere)",
    "file": "game.js",
    "find": "    if (!tv) h += seatsHTML(v);",
    "replace": "",
    "checks": [
      "tests"
    ]
  }
];
