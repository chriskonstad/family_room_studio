/* Bugs MELTDOWN's tests must catch (node harness/mutants.mjs meltdown). */
export default [
  {
    "name": "the panel stays live after the reactor blows (every tap refused)",
    "file": "game.js",
    "find": "const off = v.phase !== 'running' ? ' disabled' : '';",
    "replace": "const off = '';"
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
