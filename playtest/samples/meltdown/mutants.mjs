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
      { file: 'game.js', find: 'deadline: msg.deadline != null ? msg.deadline : clock.now() + (msg.seconds || 0) * 1000',
        replace: 'deadline: Date.now() + msg.seconds*1000' },
      { file: 'game.js', find: 'const s = clock.left(myOrder.deadline);',
        replace: 'const s = Math.max(0, (myOrder.deadline - Date.now())/1000);' }
    ],
    games: 32
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
