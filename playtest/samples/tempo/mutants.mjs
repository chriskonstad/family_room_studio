/* Bugs TEMPO's tests must catch (node harness/mutants.mjs tempo). */
export default [
  {
    // A phone reloaded mid-track reports a restarted run's lower score; taking the
    // latest instead of the best wiped everything it had earned.
    name: 'the host takes the latest score, so a reloaded phone wipes what it had',
    file: 'game.js',
    find: "G.scores[ctx.from] = Math.max(G.scores[ctx.from] || 0, Number(ctx.msg.score) || 0);\n                   const at",
    replace: "G.scores[ctx.from] = Number(ctx.msg.score) || 0;\n                   const at"
  },
  {
    // Shipped in 1.1.2: the resume read `at` from the FIRST playing state a rebuilt
    // phone was handed — the one from when the track started — so it always restarted
    // the track at zero (rebuild.test.mjs).
    name: 'a phone rebuilt mid-track restarts its track at zero',
    file: 'game.js',
    find: 'if (!run || (!run.over && at > trackTime() + 0.5)) {',
    replace: 'if (!run) {'
  },
  {
    // Shipped in 1.1.2: the track's start was kept in seconds. A rebuilt phone resumes
    // from a fractional `at`, a pause then adds its length, and the sum rounded apart
    // from the unpaused game's — the published `at` read 2.02 where it said 2.00
    // (rebuild.test.mjs: a pause after a reconnect).
    name: "a pause after a reconnect moves where the track's position rounds",
    edits: [
      { file: 'game.js', find: 'function trackTime() { return (performance.now() - run.start) / 1000; }',
        replace: 'function trackTime() { return performance.now()/1000 - run.start; }' },
      { file: 'game.js', find: 'start: performance.now() + 150 - Math.round(at*1000),',
        replace: 'start: performance.now()/1000 + 0.15 - at,' },
      { file: 'game.js', find: 'if (run && pausedAt != null) run.start += performance.now() - pausedAt;',
        replace: 'if (run && pausedAt != null) run.start += (performance.now() - pausedAt)/1000;' }
    ]
  },
  {
    // Same root: whether it had finished was read off that first state too, so a
    // finished player's rebuilt phone played (and streamed) a whole second track.
    name: 'a phone rebuilt after it finished plays the track again',
    file: 'game.js',
    find: 'if (s.finished && s.finished[MY]) {\n      if (run && run.over) return false;',
    replace: 'if (s.finished && s.finished[MY] && !run) {\n      if (run && run.over) return false;'
  }
];
