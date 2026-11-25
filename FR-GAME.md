# `FR` — the game-structure library

`FR` is already there. Both harnesses inject `tools/sdk/fr-game.js` before your game runs,
so you never import or bundle it. It has no dependencies and never touches the DOM.

It is a **library, not a framework**. Take one piece or all of them. `FR.deck` doesn't know
`FR.seats` exists.

> `fr-feel.js` is how a game *feels* — animations, haptics, sound.
> `fr-game.js` is how a game is *shaped* — decks, turns, elimination, scoring.

---

## Cheat sheet

```js
// Randomness you can replay. Use this INSTEAD OF Math.random(), always.
var r = FR.rng(seed);        r(); r.int(6); r.range(1,6); r.pick(list); r.shuffle(list)

// A deck that reshuffles its own discards.
var deck = FR.deck(cards, r);
deck.draw(); deck.drawMany(3); deck.peek(); deck.discard(card);
deck.left; deck.discarded; deck.exhausted; deck.drawn

// Turn order, statuses, elimination, and who won.
var seats = FR.seats(['p0','p1','p2']);
seats.startRound(rotateDealer); seats.next(); seats.moveTo(id);
seats.setStatus(id,'busted');   // temporary — cleared next round
seats.eliminate(id);            // permanent — order becomes the ranking
seats.current; seats.active; seats.remaining; seats.out; seats.survivor; seats.settled;
seats.status(id); seats.isActive(id); seats.dealer

// The scoreboard Table.endGame wants.
FR.standings.byScore({p0:12, p1:30})            // -> {winnerId, standings}
FR.standings.byElimination(seats)               // last one standing
                                                // opts: {lowestWins, detail:(id,n)=>string}

// Named timers you can kill all at once.
var timers = FR.timers();
timers.after('boom', 3000, fn); timers.every('tick', 1000, fn);
timers.cancel('boom'); timers.cancelAll(); timers.pending

// One game-time clock every phone counts down from (NOT Date.now()).
var clock = FR.clock(timers); clock.start();          // host
clock.now(); clock.deadlineIn(11);                    // put now in state; re-send it
                                                      // on a timer while a countdown runs
var phoneClock = FR.clock();                          // phone
phoneClock.see(state); phoneClock.left(deadline);     // seconds left

// The host-authoritative reducer.
var table = FR.host({ state, seats, publish, phase, timers, intents });
table.handle(from, msg); table.hold(ms, fn); table.sequence(ms, steps, done);
table.busy; table.rejected; table.stop()
```

---

## `FR.rng` — use it instead of `Math.random()`

This is the rule that matters most, and the one every existing game broke.

A game on `Math.random()` cannot be replayed. A bug someone hits in a playtest can never be
shown again, and fuzzing it is pointless because a failure can't be reproduced. Seed once,
store the seed in state, and the entire game becomes a function of `(seed, intents)`.

```js
var r = FR.rng(Table.seed);             // everything random comes from here
```

The seed comes from the table, never from the wall clock: a game that seeds
itself with `Date.now()` is reproducible in principle and never in practice.

`r.shuffle()` returns a **new** array — shuffling a caller's deck in place is how you
accidentally shuffle the discard pile too.

## `FR.deck` — the pile that refills itself

```js
var cards = [];
for (var n = 1; n <= 12; n++) for (var i = 0; i < n; i++) cards.push(n);
var deck = FR.deck(cards, r);

var card = deck.draw();          // reshuffles discards automatically when empty
deck.discard(card);
publish({ deckLeft: deck.left }); // players want to see this
```

`draw()` returns `undefined` only when the draw pile *and* the discards are empty. Handle
it — that's the end of the deck, and it's a legitimate way to end a round.

## `FR.seats` — turns, statuses, elimination

Two kinds of not-playing, and confusing them is a real bug:

| | Call | Cleared by | Use for |
|---|---|---|---|
| **Temporary** | `setStatus(id, 'busted')` | `startRound()` | busted, frozen, banked, ready |
| **Permanent** | `eliminate(id)` | never | knocked out of the game |

```js
var seats = FR.seats(Table.players.map(function (p) { return p.id; }));
seats.startRound();               // first round — don't rotate the dealer yet

// ...someone busts this round but is back next round:
seats.setStatus(seats.current, 'busted');

// ...someone is out of the game entirely:
seats.eliminate(victim);
if (seats.settled) finish();      // exactly one player left

// Passing play. next() returns null when NOBODY is active — that's the round ending.
if (!seats.next()) endRound();
```

`eliminate()` is idempotent. It is for your game's own rules — a player busting
out — and never for connections: a phone that drops pauses the table and is caught
up when it returns, so no player ever vanishes from a game (no `onPlayerLeave`).

## `FR.standings` — one scoreboard, sorted one way

```js
// Points game:
var result = FR.standings.byScore(G.totals, { detail: function (id, n) { return n + ' pts'; } });
Table.endGame({ title: G.names[result.winnerId] + ' wins!', winnerId: result.winnerId,
                standings: result.standings });

// Last-one-standing game — survivor first, then whoever lasted longest:
var result = FR.standings.byElimination(seats);
```

Ties break stably (by id), so two players on the same score always rank in the same order
rather than flipping between renders.

## `FR.timers` — name them, then you can kill them

```js
var timers = FR.timers();
timers.every('heat', 250, tickHeat);
timers.after('boom', r.range(8000, 20000), explode);
// ...later, wherever the round ends — one call, nothing leaks:
timers.cancelAll();
```

Reusing a name replaces the old timer rather than running both. When a game ends, call
`cancelAll()` (or `table.stop()`) — a finished game that keeps ticking under the results
screen is a bug that has shipped here before.

## `FR.clock` — countdowns that survive a rebuild

Anything a player counts down — an order expiring, a pick window, a turn timer — must
be measured against the HOST's clock, never against when a message happened to arrive
on one phone. The arrival-anchored version (`deadline = Date.now() + limit`) is wrong
in exactly the situation the shell creates on purpose: a rebuilt phone receives the
order late and restarts it at the full limit while the table is seconds from expiry.
MELTDOWN shipped that; LOOKAWAY and FISHBOWL had their own versions.

```js
// host
var clock = FR.clock(timers); clock.start();
state = { ..., now: clock.now() };
var due = clock.deadlineIn(11);              // send `due` with the order
// phone
var clock = FR.clock();
onState: clock.see(state);
clock.left(due);                             // seconds left — same on every phone
```

A phone counts on between states on GAME time — the shell's timer shim keeps it, and
it stops while the table is paused — so a countdown holds still through a pause, as
the host's does, instead of reading 0 the moment play resumes.

**While a countdown runs, the host re-sends its state on a timer.** `see(state)`
takes the state's `now` as the host's time *at the moment the phone sees it*, and the
phone counts on from there. A phone rebuilt from the history replays every old state
in one burst, so the reading it keeps is the last one in its history — sent whenever
the host last had something to say, which can be seconds before the drop. Counting on
from that, it shows seconds the table no longer has. Republishing on a timer bounds
how old that last reading can be, and the next tick corrects it:

```js
// host: when the countdown starts — cancel it when the countdown ends
timers.every('clock', 250, publish);
// phone: a tick moves nothing but `now`, so don't redraw for one
function sameButNow(a, b) {
  return JSON.stringify(Object.assign({}, a, { now: 0 })) ===
         JSON.stringify(Object.assign({}, b, { now: 0 }));
}
onState: var tick = view && sameButNow(view, state);
         view = state; clock.see(state); if (!tick) render();
```

CAPTAIN and LOOKAWAY re-send every 250ms while an order or pick window is open,
MELTDOWN every 500ms while the reactor runs. Their phones skip the redraw when only
`now` changed: the bar reads the clock by itself, and a redraw would swap the buttons
out from under a thumb.

Name clock fields `now`, `deadline` or `*Ends`: the harness's pause/reconnect
comparisons treat those as clock readings (they may differ by a tick across a pause)
and require everything else in the state to match exactly. CAPTAIN, LOOKAWAY,
MELTDOWN and FISHBOWL run on this; TEMPO and PASSBOMB stream the same idea by hand.

## `FR.host` — the four checks games kept forgetting

```js
var table = FR.host({
  state:   G,
  seats:   seats,
  timers:  timers,
  phase:   function () { return G.phase; },
  publish: publish,                       // called after every accepted intent
  intents: {
    flip: { turn: true, phase: 'playing', run: function (ctx) { drawFor(ctx.from); } },
    bank: { turn: true, phase: 'playing', run: function (ctx) { bank(ctx.from); } },
    next: { phase: 'roundEnd',            run: function ()    { startRound(); } },
    vote: function (ctx) { G.votes[ctx.from] = ctx.msg.choice; }   // open to anyone
  }
});

Table.onMessage(function (from, msg) { table.handle(from, msg); });
```

Every intent is refused unless it passes all of:

1. **known** — declared in `intents`
2. **not frozen** — no `hold()`/`sequence()` in flight
3. **seated** — `from` is a real player at this table
4. **right phase** — if you declared one
5. **their turn** — if you set `turn: true`

`ctx` is `{ from, msg, state, table }`. `table.rejected` lists recent refusals with a reason,
which is what you read when an intent mysteriously does nothing.

### `options` — declare the move space, get fuzzing for free

This is the single highest-value thing you can add to a game.

A bot driving through the DOM has to reverse-engineer what's playable from rendered HTML.
That works until a move is two taps ("pick a card", then "Climb") or typed text — and then
the bot stalls and your game looks broken when it isn't. SUMMIT, TAPAS and FISHBOWL were all
untestable headlessly for exactly this reason.

Declare what an intent would accept, and the harness can play the game with **no screen at
all**:

```js
play: {
  phase: 'playing:play',
  when:    (ctx) => ctx.from === G.turn,
  options: (ctx) => G.hands[ctx.from].filter(c => canPlay(ctx.from, c))
                                     .map(c => ({ card: { c: c.c, v: c.v } })),
  run:     (ctx) => { … }
}
```

`table.legalMoves(playerId)` now returns concrete messages — `{t:'play', card:{c:'jungle',v:7}}`
— filtered by the same turn / host / phase / busy checks `handle()` applies.

| Option | Use it for |
|---|---|
| `options(ctx)` | the argument sets this intent accepts right now |
| `when(ctx)` | any guard `turn`/`host`/`phase` can't express — checked by `handle` **and** `legalMoves` (against each concrete option, so `ctx.msg` is always the message), so they can never disagree. Validate argument values HERE, not inside `run`: a `run` that silently ignores a bad value is an accepted intent that does nothing |
| `hidden: true` | keep it out of the move space (free text nothing can enumerate — pair it with a `bot.mjs`) |

The UI becomes one view of this list rather than the only place it exists. You don't have to
restructure your game to get it: SUMMIT kept its own deck and scoring and only moved its
intent handling across.

*Free text* (a typed phrase, a drawn gesture) genuinely can't be enumerated — mark it
`hidden` and let the bundle's `bot.mjs` supply it. FISHBOWL does exactly that.

### `hold` and `sequence` — the Flip 3 bug, made unwritable

STREAK's "Flip 3" dealt 2 cards or 4, never 3. The forced flips were 800ms apart, Flip and
Bank stayed live in the gaps, and a stray tap re-entered the sequence.

```js
// A dramatic pause with the table frozen. Players get to SEE what just happened
// before the modal covers it, and no tap during the pause can land.
table.hold(1700, function () { G.phase = 'roundEnd'; });

// A scripted multi-step sequence — forced flips, a cascade, a countdown.
table.sequence(800, [
  function () { dealOne(); },
  function () { dealOne(); },
  function () { dealOne(); }
], function () { if (!seats.next()) endRound(); });
```

Both publish each frame as they go, so the animation is visible, and both refuse all input
until they finish. `table.busy` is true throughout.

---

## A complete game

A working press-your-luck host in ~40 lines, using nothing but the library. This is the
shape to copy.

```js
var r     = FR.rng(G.seed);
var seats = FR.seats(Table.players.map(function (p) { return p.id; }));
var deck  = FR.deck(buildCards(), r);
var timers = FR.timers();
var G = { phase: 'playing', round: 1, score: {}, hand: {} };

seats.startRound();

var table = FR.host({
  state: G, seats: seats, timers: timers,
  phase: function () { return G.phase; },
  publish: publish,
  intents: {
    flip: { turn: true, phase: 'playing', run: function () {
      var card = deck.draw();
      if (card === undefined) return endRound();
      var hand = G.hand[seats.current] || (G.hand[seats.current] = []);
      if (hand.indexOf(card) !== -1) {
        Table.feel('bust', { mine: seats.current === Table.me.id });
        seats.setStatus(seats.current, 'busted');
        G.hand[seats.current] = [];
      } else {
        hand.push(card);
        Table.feel('gain', { mine: seats.current === Table.me.id });
      }
      if (!seats.next()) endRound();
    } },
    bank: { turn: true, phase: 'playing', run: function () {
      var id = seats.current;
      G.score[id] = (G.score[id] || 0) + sum(G.hand[id]);
      G.hand[id] = [];
      seats.setStatus(id, 'stayed');
      if (!seats.next()) endRound();
    } },
    next: { phase: 'roundEnd', run: function () {
      G.round++; G.phase = 'playing'; seats.startRound(true); 
    } }
  }
});

function endRound() {
  G.phase = 'roundEnd';
  table.hold(1700, function () {          // let players see what ended it
    var top = FR.standings.byScore(G.score);
    if (G.score[top.winnerId] >= 200) {
      G.phase = 'gameOver';
      timers.cancelAll();
      Table.endGame({ title: 'Winner!', winnerId: top.winnerId, standings: top.standings });
    }
  });
}

function publish() { Table.broadcast({ view: G, deckLeft: deck.left, turn: seats.current }); }
Table.onMessage(function (from, msg) { table.handle(from, msg); });
```

---

## Testing your game

The gate is one command — run it before every commit, and CI runs exactly it:

```sh
node check.mjs            # everything: conformance, validation, playtests,
                          # screens, phone layouts, bundle tests, mutants
node check.mjs --quick    # while iterating: skips phone layouts and mutants
```

Setup once: `npm ci && npx playwright-core install webkit`.

`FR` has no DOM and no `Table` dependency, so host logic built on it runs under plain node:

```sh
node sdk/fr-game.test.mjs      # the library's own suite, incl. a fuzz soak
```

The suite's `fakeClock` is worth copying: it makes a 60-second game run in a millisecond, so
you can fuzz thousands of games in seconds. Pair it with `FR.rng(seed)` and any failure comes
with a seed that reproduces it exactly.

The invariants worth asserting for any game — the headless playtest
(`node harness/playtest.mjs <game>`) now checks every one of these automatically,
across table sizes, hostile input, mid-game disconnects and mid-game pauses:

- it never throws, whatever arrives
- it always terminates
- a rejected intent changes nothing
- `endGame` fires exactly once
- a finished game leaves no timers armed
- the same seed replays the same game, move for move
- nothing moves while the table is paused

That last set found a real hole on its first run: `FR.host` used to accept intents from an id
that wasn't seated at all.
