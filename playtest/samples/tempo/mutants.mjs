/* Bugs TEMPO's tests must catch (node harness/mutants.mjs tempo). */
export default [
  {
    "name": "a reconnect restarts the track at zero and the host takes the lower score",
    "edits": [
      {
        "file": "game.js",
        "find": "G.scores[ctx.from] = Math.max(G.scores[ctx.from] || 0, Number(ctx.msg.score) || 0);\n                   const at",
        "replace": "G.scores[ctx.from] = Number(ctx.msg.score) || 0;\n                   const at"
      },
      {
        "file": "game.js",
        "find": "startRun(s.seed, (s.at && s.at[MY]) || 0, (s.scores && s.scores[MY]) || 0);",
        "replace": "startRun(s.seed, 0, 0);"
      }
    ]
  }
];
