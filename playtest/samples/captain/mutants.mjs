/* Bugs CAPTAIN SAYS's tests must catch (node harness/mutants.mjs captain). */
export default [
  {
    // Shipped until 1.1.1: a phone rebuilt mid-order (the app was killed) has lost its
    // own memory of tapping. 1.1.1 published WHETHER each sailor had tapped, which locked
    // it but showed "Locked in ✓" beside a live phone's "Locked in 🟡"; now the host
    // echoes the tap to the tapper. Without it the rebuilt phone offers the colours again
    // and every press is refused (rebuild.test.mjs).
    name: 'a phone rebuilt mid-order forgets it already tapped',
    file: 'game.js', find: "else if(m.t==='tapped'){ myTap = m.color; render(); }", replace: ''
  },
  {
    // Shipped until 1.1.1: the bar counted down from when the order ARRIVED, so a phone
    // rebuilt from the history restarted it at the full window (rebuild.test.mjs).
    name: 'the order countdown runs from when the message arrived',
    edits: [
      { file: 'game.js', find: 'beeps = [1000, 640, 300];', replace: 'beeps = [1000, 640, 300]; var arrivedEnds = Date.now() + view.prompt.win;' },
      { file: 'game.js', find: 'const remain = clock.left(view.prompt.promptEnds)*1000;', replace: 'const remain = Math.max(0, arrivedEnds - Date.now());' }
    ]
  },
  {
    // Shipped in 1.1.1: FR.clock extrapolates from the last state a phone saw, and the
    // host said nothing between an order and its reveal unless someone tapped. A phone
    // rebuilt mid-order was last handed the order's first state, and its bar showed the
    // whole window with a fraction of it left (rebuild.test.mjs).
    name: 'the host stops streaming its clock while an order is up',
    file: 'game.js', find: "timer.every('clock', 250, syncAll);", replace: ''
  },
  {
    name: 'a second tap overwrites the first',
    file: 'game.js', find: "when:(ctx)=> seats.isActive(ctx.from) && G.taps[ctx.from]==null,", replace: 'when:(ctx)=> seats.isActive(ctx.from),'
  }
];
