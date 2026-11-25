/* Bugs MELTDOWN's tests must catch (node harness/mutants.mjs meltdown). */
export default [
  {
    "name": "the panel stays live after the reactor blows (every tap refused)",
    "file": "game.js",
    "find": "const off = v.phase !== 'running' ? ' disabled' : '';",
    "replace": "const off = '';"
  },
  {
    // Shipped until the harness dropped phones early enough to see it: the order
    // countdown was anchored to when the message ARRIVED, so a phone rebuilt
    // from the history restarted its order at the full limit while the rest of
    // the table was seconds from expiry.
    name: 'a rebuilt phone restarts its order countdown at the full limit',
    edits: [
      { file: 'game.js', find: "const payload = { t:'order', text:order.text, deadline:order.deadline };",
        replace: "const payload = { t:'order', text:order.text, seconds:orderTimeLimit() };" },
      { file: 'game.js', find: '{ myOrder = { text:msg.text, deadline:msg.deadline };',
        replace: '{ myOrder = { text:msg.text, deadline:Date.now() + msg.seconds*1000 };' },
      { file: 'game.js', find: 'const s = clock.left(myOrder.deadline);',
        replace: 'const s = Math.max(0, (myOrder.deadline - Date.now())/1000);' }
    ],
    games: 32
  },
  {
    // Shipped in 1.2.2, when the `hello` resync went: it was what resent a returning
    // phone its panel as the host had it. Rebuilt from the history, the phone showed the
    // switches as they were dealt, and its next flip of one it had already turned ON
    // sent ON again — a wrong flip for a correct tap. The host now resends the panel
    // whenever a switch or dial moves (rebuild.test.mjs).
    name: 'a phone rebuilt from the history shows the switch positions it was dealt',
    file: 'game.js', find: '{ ctl.value = msg.value; sendPanel(from); }', replace: '{ ctl.value = msg.value; }'
  },
  {
    // Shipped in 1.2.2: FR.clock extrapolates from the last state a phone saw, and the
    // host said nothing while nobody flipped anything. A phone rebuilt from the history
    // was last handed a state from seconds before the drop, and its order clock showed
    // those seconds as still to come (rebuild.test.mjs).
    name: 'the host stops streaming its clock while the reactor runs',
    file: 'game.js', find: "timer.every('clock', 500, syncAll);", replace: ''
  },
  {
    "name": "PUSH buttons shrink back under 44pt",
    "file": "index.html",
    "find": "cursor:pointer; min-height:44px}",
    "replace": "cursor:pointer}",
    "checks": [
      "phone"
    ]
  }
];
