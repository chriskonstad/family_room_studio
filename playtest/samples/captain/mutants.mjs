/* Bugs CAPTAIN SAYS's tests must catch (node harness/mutants.mjs captain). */
export default [
  {
    // Shipped until this release: a phone rebuilt mid-order (the app was killed) has lost
    // its own memory of tapping; without the public `tapped` flag it offered the colours
    // again and every press was refused.
    name: 'a reconnecting phone forgets it already tapped this order',
    edits: [
      { file: 'game.js', find: 'const lockedIn = myTap || (v.tapped && v.tapped[MY]);', replace: 'const lockedIn = myTap;' },
      { file: 'game.js', find: 'if(myTap || (view && view.tapped && view.tapped[MY])) return;', replace: 'if(myTap) return;' }
    ],
    // Only visible when the reconnect lands inside an order the player already tapped.
    games: 80
  },
  {
    name: 'a second tap overwrites the first',
    file: 'game.js', find: "when:(ctx)=> seats.isActive(ctx.from) && G.taps[ctx.from]==null,", replace: 'when:(ctx)=> seats.isActive(ctx.from),'
  }
];
