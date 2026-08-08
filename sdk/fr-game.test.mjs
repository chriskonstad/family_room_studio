/*
 * Tests for fr-game.js. Plain node, no dependencies, no browser, no simulator:
 *
 *     node tools/sdk/fr-game.test.mjs
 *
 * Two halves.
 *
 * The unit tests pin each primitive's contract, especially the edges games got
 * wrong by hand: a deck that runs dry, a round where everyone busts, a tie on
 * the scoreboard, an intent arriving out of turn.
 *
 * The fuzz soak is the more interesting half. It builds a small but complete
 * press-your-luck game out of the library, then throws tens of thousands of
 * random intents at it from random players in random order — including illegal
 * ones — and asserts the invariants that must hold no matter what arrives:
 * it never throws, it always terminates, a player who isn't up can never move
 * the deck, and the game ends exactly once. Every run is seeded, so a failure
 * prints a seed that reproduces it exactly. That is the whole reason FR.rng
 * exists.
 */
import assert from 'node:assert/strict';
import FR from './fr-game.js';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
function section(name) { results.push(`\n${name}`); }

/* ---------------------------------------------------------------- rng --- */
section('FR.rng — reproducibility is the point');

test('same seed produces the same sequence', () => {
  const a = FR.rng(12345), b = FR.rng(12345);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('different seeds diverge', () => {
  const a = FR.rng(1), b = FR.rng(2);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test('values stay in [0,1)', () => {
  const r = FR.rng(7);
  for (let i = 0; i < 5000; i++) { const v = r(); assert.ok(v >= 0 && v < 1, `got ${v}`); }
});

test('int(n) stays in range and reaches both ends', () => {
  const r = FR.rng(99), seen = new Set();
  for (let i = 0; i < 2000; i++) { const v = r.int(6); assert.ok(v >= 0 && v < 6); seen.add(v); }
  assert.equal(seen.size, 6, 'every face of a d6 should turn up');
});

test('range(lo,hi) is inclusive at both ends', () => {
  const r = FR.rng(3), seen = new Set();
  for (let i = 0; i < 2000; i++) { const v = r.range(1, 6); assert.ok(v >= 1 && v <= 6); seen.add(v); }
  assert.ok(seen.has(1) && seen.has(6), 'inclusive bounds must be reachable');
});

test('shuffle returns a new array and keeps every element', () => {
  const r = FR.rng(42);
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = r.shuffle(original);
  assert.deepEqual(original, [1, 2, 3, 4, 5, 6, 7, 8], 'must not mutate the input');
  assert.notEqual(shuffled, original);
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), original);
});

test('shuffle actually permutes', () => {
  const r = FR.rng(5);
  const deck = Array.from({ length: 30 }, (_, i) => i);
  let moved = 0;
  for (let trial = 0; trial < 20; trial++) {
    if (r.shuffle(deck).some((v, i) => v !== deck[i])) moved++;
  }
  assert.ok(moved >= 19, 'a 30-card shuffle should essentially never come back in order');
});

test('pick on an empty list is undefined, not a crash', () => {
  assert.equal(FR.rng(1).pick([]), undefined);
});

/* --------------------------------------------------------------- deck --- */
section('FR.deck — the pile that refills itself');

test('draws every card before repeating', () => {
  const d = FR.deck([1, 2, 3, 4, 5], FR.rng(1));
  const seen = [d.draw(), d.draw(), d.draw(), d.draw(), d.draw()];
  assert.deepEqual(seen.slice().sort(), [1, 2, 3, 4, 5]);
  assert.equal(d.left, 0);
});

test('left counts down and is what the player sees', () => {
  const d = FR.deck([1, 2, 3], FR.rng(1));
  assert.equal(d.left, 3); d.draw();
  assert.equal(d.left, 2);
});

test('discards are reshuffled in automatically when the deck runs out', () => {
  const d = FR.deck([1, 2], FR.rng(4));
  const a = d.draw(), b = d.draw();
  assert.equal(d.left, 0);
  d.discard(a); d.discard(b);
  const c = d.draw();
  assert.ok(c === 1 || c === 2, 'a drawn card should come back after a reshuffle');
  assert.equal(d.drawn, 3);
});

test('an exhausted deck returns undefined instead of looping forever', () => {
  const d = FR.deck([1], FR.rng(1));
  assert.equal(d.draw(), 1);
  assert.equal(d.draw(), undefined);
  assert.ok(d.exhausted);
});

test('drawMany returns a short array rather than undefined holes', () => {
  const d = FR.deck([1, 2], FR.rng(1));
  assert.equal(d.drawMany(5).length, 2);
});

test('peek does not consume', () => {
  const d = FR.deck([1, 2, 3], FR.rng(2));
  const top = d.peek();
  assert.equal(d.left, 3);
  assert.equal(d.draw(), top);
});

test('same seed deals the same deck', () => {
  const cards = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = FR.deck(cards, FR.rng(77)), b = FR.deck(cards, FR.rng(77));
  assert.deepEqual(a.drawMany(8), b.drawMany(8));
});

/* -------------------------------------------------------------- seats --- */
section('FR.seats — turn order, status and elimination');

test('turns rotate in seat order', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.startRound();
  assert.equal(s.current, 'a');
  assert.equal(s.next(), 'b');
  assert.equal(s.next(), 'c');
  assert.equal(s.next(), 'a', 'and wraps');
});

test('next() skips a player with a temporary status', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.startRound();
  s.setStatus('b', 'busted');
  assert.equal(s.next(), 'c', 'b is out of the round, not the game');
});

test('next() returns null when nobody is active — that is how a round ends', () => {
  const s = FR.seats(['a', 'b']);
  s.startRound();
  s.setStatus('a', 'busted'); s.setStatus('b', 'busted');
  assert.equal(s.next(), null);
});

test('startRound revives temporary statuses but not eliminations', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.startRound();
  s.setStatus('a', 'busted');
  s.eliminate('c');
  s.startRound();
  assert.equal(s.status('a'), 'active', 'busted is a round thing');
  assert.equal(s.status('c'), 'out', 'eliminated is a game thing');
  assert.deepEqual(s.active, ['a', 'b']);
});

test('eliminate is idempotent — game rule and leave-handler can both call it', () => {
  const s = FR.seats(['a', 'b']);
  s.eliminate('a'); s.eliminate('a');
  assert.deepEqual(s.out, ['a'], 'must not be listed twice');
});

test('survivor and settled identify the winner', () => {
  const s = FR.seats(['a', 'b', 'c']);
  assert.equal(s.survivor, null);
  assert.ok(!s.settled);
  s.eliminate('a'); s.eliminate('c');
  assert.ok(s.settled);
  assert.equal(s.survivor, 'b');
});

test('dealer rotates only when asked', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.startRound();
  assert.equal(s.dealer, 'a');
  s.startRound();
  assert.equal(s.dealer, 'a', 'first round must not rotate');
  s.startRound(true);
  assert.equal(s.dealer, 'b');
  assert.equal(s.current, 'b', 'and the new dealer leads');
});

test('an unknown id is never active', () => {
  const s = FR.seats(['a']);
  assert.equal(s.status('ghost'), 'out');
  assert.ok(!s.isActive('ghost'));
  s.setStatus('ghost', 'active');
  assert.ok(!s.isActive('ghost'), 'a stale id must not be able to smuggle itself in');
});

test('moveTo targets a specific seat but refuses an inactive one', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.startRound();
  s.moveTo('c');
  assert.equal(s.current, 'c');
  s.eliminate('a');
  s.moveTo('a');
  assert.equal(s.current, 'c', 'cannot pass play to someone who is out');
});

test('eliminating everyone leaves no current player rather than looping', () => {
  const s = FR.seats(['a', 'b']);
  s.startRound();
  s.eliminate('a'); s.eliminate('b');
  assert.equal(s.next(), null);
  assert.deepEqual(s.remaining, []);
});

/* ---------------------------------------------------------- standings --- */
section('FR.standings — one scoreboard, sorted one way');

test('byScore ranks highest first', () => {
  const { winnerId, standings } = FR.standings.byScore({ a: 10, b: 30, c: 20 });
  assert.equal(winnerId, 'b');
  assert.deepEqual(standings.map(s => s.playerId), ['b', 'c', 'a']);
});

test('byScore ties break stably, never arbitrarily', () => {
  const one = FR.standings.byScore({ a: 5, b: 5, c: 5 });
  const two = FR.standings.byScore({ c: 5, b: 5, a: 5 });
  assert.deepEqual(one.standings.map(s => s.playerId), two.standings.map(s => s.playerId));
});

test('lowestWins flips the sort for golf-style scoring', () => {
  const { winnerId } = FR.standings.byScore({ a: 10, b: 2 }, { lowestWins: true });
  assert.equal(winnerId, 'b');
});

test('byElimination puts the survivor first and the longest-lasting next', () => {
  const s = FR.seats(['a', 'b', 'c', 'd']);
  s.eliminate('c');            // out first — should rank last
  s.eliminate('a');
  s.eliminate('d');
  const { winnerId, standings } = FR.standings.byElimination(s);
  assert.equal(winnerId, 'b');
  assert.deepEqual(standings.map(r => r.playerId), ['b', 'd', 'a', 'c']);
});

test('byElimination reports no winner while the game is still running', () => {
  const s = FR.seats(['a', 'b', 'c']);
  s.eliminate('a');
  assert.equal(FR.standings.byElimination(s).winnerId, null);
});

test('detail is attached when asked for', () => {
  const { standings } = FR.standings.byScore({ a: 3 }, { detail: (id, n) => `${n} pts` });
  assert.equal(standings[0].detail, '3 pts');
});

/* ------------------------------------------------------------- timers --- */

/** A clock tests drive by hand, so a 60-second game runs instantly. */
function fakeClock() {
  let now = 0, seq = 0;
  const jobs = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, fn, every: 0 }); return id; },
    clearTimeout: id => jobs.delete(id),
    setInterval: (fn, ms) => { const id = ++seq; jobs.set(id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: id => jobs.delete(id),
    /** Move time forward, firing whatever is due. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= target && (!next || j.at < next[1].at)) next = [id, j];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        if (job.every) job.at = now + job.every; else jobs.delete(id);
        job.fn();
      }
      now = target;
    },
    get armed() { return jobs.size; }
  };
}

section('FR.timers — named, cancellable, and virtual-clock friendly');

test('after fires once at the right time', () => {
  const clock = fakeClock(), t = FR.timers(clock);
  let fired = 0;
  t.after('x', 100, () => fired++);
  clock.advance(99); assert.equal(fired, 0);
  clock.advance(2);  assert.equal(fired, 1);
  clock.advance(500); assert.equal(fired, 1, 'must not repeat');
});

test('every repeats until cancelled', () => {
  const clock = fakeClock(), t = FR.timers(clock);
  let n = 0;
  t.every('tick', 10, () => n++);
  clock.advance(35); assert.equal(n, 3);
  t.cancel('tick');
  clock.advance(100); assert.equal(n, 3);
});

test('reusing a name replaces rather than duplicating', () => {
  const clock = fakeClock(), t = FR.timers(clock);
  let n = 0;
  t.after('x', 10, () => n++);
  t.after('x', 10, () => n++);
  clock.advance(50);
  assert.equal(n, 1, 'the first timer must have been cancelled');
});

test('cancelAll stops everything — the leak this exists to prevent', () => {
  const clock = fakeClock(), t = FR.timers(clock);
  let n = 0;
  t.after('a', 10, () => n++); t.every('b', 10, () => n++); t.after('c', 10, () => n++);
  assert.equal(t.pending.length, 3);
  t.cancelAll();
  clock.advance(1000);
  assert.equal(n, 0);
  assert.equal(clock.armed, 0, 'no timer may survive cancelAll');
});

test('a fired one-shot cleans itself out of pending', () => {
  const clock = fakeClock(), t = FR.timers(clock);
  t.after('x', 10, () => {});
  clock.advance(20);
  assert.deepEqual(t.pending, []);
});

test('cancelling an unarmed name is harmless', () => {
  FR.timers(fakeClock()).cancel('nope');
});

/* --------------------------------------------------------------- host --- */
section('FR.host — the four checks every game forgot at least once');

function tinyTable(clock) {
  const seats = FR.seats(['a', 'b']);
  seats.startRound();
  const state = { phase: 'playing', flips: 0 };
  let published = 0;
  const table = FR.host({
    state, seats,
    timers: FR.timers(clock),
    phase: () => state.phase,
    publish: () => { published++; },
    intents: {
      flip: { turn: true, run: ctx => { ctx.state.flips++; } },
      shout: ctx => { ctx.state.shouted = ctx.from; },
      next: { phase: 'roundEnd', run: ctx => { ctx.state.phase = 'playing'; } }
    }
  });
  return { table, seats, state, published: () => published };
}

test('accepts a legal intent from the current player', () => {
  const { table, state } = tinyTable(fakeClock());
  assert.equal(table.handle('a', { t: 'flip' }), true);
  assert.equal(state.flips, 1);
});

test('rejects an unknown intent', () => {
  const { table } = tinyTable(fakeClock());
  assert.equal(table.handle('a', { t: 'nonsense' }), false);
  assert.equal(table.rejected.pop().why, 'unknown');
});

test('rejects an out-of-turn intent — and state is untouched', () => {
  const { table, state } = tinyTable(fakeClock());
  assert.equal(table.handle('b', { t: 'flip' }), false);
  assert.equal(state.flips, 0);
  assert.equal(table.rejected.pop().why, 'turn');
});

test('an intent without turn:true is open to anyone', () => {
  const { table, state } = tinyTable(fakeClock());
  assert.equal(table.handle('b', { t: 'shout' }), true);
  assert.equal(state.shouted, 'b');
});

test('rejects an intent in the wrong phase', () => {
  const { table } = tinyTable(fakeClock());
  assert.equal(table.handle('a', { t: 'next' }), false);
  assert.equal(table.rejected.pop().why, 'phase');
});

test('publishes after every accepted intent, and never after a rejected one', () => {
  const { table, published } = tinyTable(fakeClock());
  table.handle('a', { t: 'flip' });
  assert.equal(published(), 1);
  table.handle('b', { t: 'flip' });
  assert.equal(published(), 1);
});

test('hold freezes the table — the Flip 3 bug, made unwritable', () => {
  const clock = fakeClock();
  const { table, state } = tinyTable(clock);
  table.hold(500, () => { state.phase = 'roundEnd'; });
  assert.ok(table.busy);
  assert.equal(table.handle('a', { t: 'flip' }), false, 'a tap during the pause must not land');
  assert.equal(table.rejected.pop().why, 'busy');
  clock.advance(600);
  assert.ok(!table.busy);
  assert.equal(state.phase, 'roundEnd');
  assert.equal(state.flips, 0, 'nothing landed while frozen');
  assert.equal(table.handle('a', { t: 'flip' }), true, 'and input works again afterwards');
});

test('host:true rejects a non-host, accepts the host', () => {
  const seats = FR.seats(['a', 'b']);
  seats.startRound();
  const state = { started: 0 };
  const table = FR.host({
    state, seats, hostId: 'a', timers: FR.timers(fakeClock()), publish: () => {},
    intents: { begin: { host: true, run: () => { state.started++; } } }
  });
  assert.equal(table.handle('b', { t: 'begin' }), false, 'a joiner must not pace the table');
  assert.equal(table.rejected.pop().why, 'not-host');
  assert.equal(state.started, 0);
  assert.equal(table.handle('a', { t: 'begin' }), true);
  assert.equal(state.started, 1);
});

test('rejects an intent from an id that is not seated', () => {
  const { table, state } = tinyTable(fakeClock());
  assert.equal(table.handle('ghost', { t: 'shout' }), false);
  assert.equal(state.shouted, undefined);
  assert.equal(table.rejected.pop().why, 'not-seated');
});

test('a held frame is published immediately so players see what happened', () => {
  const clock = fakeClock();
  const { table, published } = tinyTable(clock);
  const before = published();
  table.hold(500, () => {});
  assert.equal(published(), before + 1, 'the triggering frame must show during the pause');
  clock.advance(600);
  assert.equal(published(), before + 2, 'and again once the hold lifts');
});

test('sequence runs every step, exactly once, with input frozen throughout', () => {
  const clock = fakeClock();
  const { table, state } = tinyTable(clock);
  let done = false;
  table.sequence(100, [
    () => state.flips++,
    () => state.flips++,
    () => state.flips++
  ], () => { done = true; });

  // This is precisely the Flip 3 failure: hammering the button mid-sequence.
  for (let i = 0; i < 20; i++) {
    clock.advance(10);
    table.handle('a', { t: 'flip' });
  }
  clock.advance(1000);
  assert.equal(state.flips, 3, 'exactly three — not two, not four');
  assert.ok(done);
  assert.ok(!table.busy);
});

test('stop cancels the timers a finished game left behind', () => {
  const clock = fakeClock();
  const { table } = tinyTable(clock);
  table.hold(1000, () => {});
  table.stop();
  clock.advance(5000);
  assert.equal(clock.armed, 0);
  assert.ok(!table.busy);
});

section('FR.host.legalMoves — the move space, without a DOM');

test('enumerates a bare verb and an intent with options', () => {
  const seats = FR.seats(['a', 'b']);
  seats.startRound();
  const state = { phase: 'playing', hand: { a: ['x', 'y'], b: ['z'] } };
  const table = FR.host({
    state, seats, hostId: 'a', timers: FR.timers(fakeClock()), publish: () => {},
    phase: () => state.phase,
    intents: {
      hello: { hidden: true, run: () => {} },
      pass:  { turn: true, run: () => {} },
      play:  { turn: true,
               options: (ctx) => state.hand[ctx.from].map(c => ({ card: c })),
               run: () => {} }
    }
  });
  const moves = table.legalMoves('a');
  assert.deepEqual(moves, [
    { t: 'pass' },
    { t: 'play', card: 'x' },
    { t: 'play', card: 'y' }
  ]);
  assert.deepEqual(table.legalMoves('b'), [], "not b's turn, so nothing is legal");
});

test('every enumerated move is actually accepted', () => {
  const seats = FR.seats(['a', 'b']);
  seats.startRound();
  const state = { phase: 'playing', played: [] };
  const table = FR.host({
    state, seats, hostId: 'a', timers: FR.timers(fakeClock()), publish: () => {},
    phase: () => state.phase,
    intents: {
      play: { turn: true, options: () => [{ i: 0 }, { i: 1 }, { i: 2 }],
              run: (ctx) => { state.played.push(ctx.msg.i); } }
    }
  });
  // The contract that makes fuzzing meaningful: if legalMoves offers it, handle takes it.
  for (const m of table.legalMoves('a')) {
    assert.equal(table.handle('a', m), true, `legalMoves offered ${JSON.stringify(m)} but handle refused it`);
  }
  assert.deepEqual(state.played, [0, 1, 2]);
});

test('a `when` guard is honoured by handle and legalMoves alike', () => {
  const state = { open: false };
  const table = FR.host({
    state, timers: FR.timers(fakeClock()), publish: () => {},
    intents: { enter: { when: (ctx) => ctx.state.open, run: () => { state.entered = true; } } }
  });
  assert.deepEqual(table.legalMoves('a'), [], 'closed: not offered');
  assert.equal(table.handle('a', { t: 'enter' }), false, 'closed: not accepted');
  assert.equal(table.rejected.pop().why, 'when');
  state.open = true;
  assert.deepEqual(table.legalMoves('a'), [{ t: 'enter' }], 'open: offered');
  assert.equal(table.handle('a', { t: 'enter' }), true, 'open: accepted');
});

test('hidden intents stay out of the move space', () => {
  const table = FR.host({
    state: {}, timers: FR.timers(fakeClock()), publish: () => {},
    intents: { hello: { hidden: true, run: () => {} }, go: () => {} }
  });
  assert.deepEqual(table.legalMoves('a').map(m => m.t), ['go']);
});

test('a frozen table offers no moves at all', () => {
  const clock = fakeClock();
  const table = FR.host({
    state: {}, timers: FR.timers(clock), publish: () => {},
    intents: { go: () => {} }
  });
  table.hold(500, () => {});
  assert.deepEqual(table.legalMoves('a'), [], 'nothing is legal mid-hold');
  clock.advance(600);
  assert.deepEqual(table.legalMoves('a').map(m => m.t), ['go']);
});

test('host-only and phase-gated moves are filtered per player', () => {
  const seats = FR.seats(['a', 'b']);
  const state = { phase: 'roundEnd' };
  const table = FR.host({
    state, seats, hostId: 'a', timers: FR.timers(fakeClock()), publish: () => {},
    phase: () => state.phase,
    intents: {
      next: { host: true, phase: 'roundEnd', run: () => {} },
      quit: { run: () => {} }
    }
  });
  assert.deepEqual(table.legalMoves('a').map(m => m.t), ['next', 'quit']);
  assert.deepEqual(table.legalMoves('b').map(m => m.t), ['quit']);
  state.phase = 'playing';
  assert.deepEqual(table.legalMoves('a').map(m => m.t), ['quit']);
});

/* --------------------------------------------------------------- fuzz --- */
section('Fuzz soak — a whole game under random abuse');

/**
 * A complete press-your-luck game in ~40 lines, built only from the library.
 * It is the fuzz target, and doubles as the shape a new game should copy.
 */
function pressYourLuck(seed, playerIds, clock) {
  const rng = FR.rng(seed);
  const seats = FR.seats(playerIds);
  const deck = FR.deck(
    Array.from({ length: 60 }, (_, i) => (i % 12) + 1), rng);
  const state = { phase: 'playing', seen: {}, score: {}, round: 1, ended: null };
  playerIds.forEach(id => { state.score[id] = 0; state.seen[id] = []; });
  seats.startRound();

  let publishes = 0;
  const table = FR.host({
    state, seats,
    timers: FR.timers(clock),
    phase: () => state.phase,
    publish: () => { publishes++; },
    intents: {
      flip: { turn: true, phase: 'playing', run: () => {
        const card = deck.draw();
        if (card === undefined) return endRound();
        const hand = state.seen[seats.current];
        if (hand.indexOf(card) !== -1) {
          seats.setStatus(seats.current, 'busted');       // lose the lot
          state.seen[seats.current] = [];
        } else {
          hand.push(card);
          if (hand.length >= 7) { bank(); return; }        // an auto-bank
        }
        if (!seats.next()) endRound();
      } },
      bank: { turn: true, phase: 'playing', run: () => bank() },
      next: { phase: 'roundEnd', run: () => {
        state.round++; state.phase = 'playing'; seats.startRound(true);
      } }
    }
  });

  function bank() {
    const id = seats.current;
    state.score[id] += state.seen[id].reduce((a, b) => a + b, 0);
    state.seen[id] = [];
    seats.setStatus(id, 'stayed');
    if (!seats.next()) endRound();
  }

  function endRound() {
    if (state.phase !== 'playing') return;
    state.phase = 'roundEnd';
    const leader = Object.keys(state.score).sort((a, b) => state.score[b] - state.score[a])[0];
    if (state.score[leader] >= 100 || state.round >= 25) {
      state.phase = 'gameOver';
      if (state.ended) throw new Error('endGame fired twice');
      state.ended = FR.standings.byScore(state.score);
      table.stop();
    }
  }

  return { table, seats, state, deck, publishes: () => publishes };
}

test('fuzz: 400 seeded games survive random legal-and-illegal input', () => {
  const INTENTS = ['flip', 'bank', 'next', 'garbage', ''];
  let gamesFinished = 0, totalIntents = 0;

  for (let seed = 1; seed <= 400; seed++) {
    const r = FR.rng(seed);
    const players = ['p0', 'p1', 'p2'].slice(0, r.range(2, 3));
    const clock = fakeClock();
    const game = pressYourLuck(seed, players, clock);

    try {
      for (let step = 0; step < 3000 && !game.state.ended; step++) {
        // Anyone may send anything at any time — that is what a hostile
        // client, a double-tap, or a laggy reconnect actually looks like.
        const from = r.pick(players.concat(['ghost']));
        const before = game.deck.drawn;
        const accepted = game.table.handle(from, { t: r.pick(INTENTS) });
        totalIntents++;

        if (!accepted) {
          assert.equal(game.deck.drawn, before,
            `seed ${seed}: a rejected intent moved the deck`);
        }
        if (from === 'ghost') {
          assert.ok(!accepted, `seed ${seed}: a player who isn't seated was allowed to act`);
        }
        clock.advance(r.range(0, 50));
      }
    } catch (e) {
      assert.fail(`seed ${seed} threw: ${e.message}`);
    }

    assert.ok(game.state.ended, `seed ${seed}: game never terminated`);
    assert.ok(game.state.ended.winnerId, `seed ${seed}: finished with no winner`);
    assert.equal(game.state.ended.standings.length, players.length,
      `seed ${seed}: standings lost a player`);
    assert.equal(clock.armed, 0, `seed ${seed}: finished game left timers running`);
    gamesFinished++;
  }

  assert.equal(gamesFinished, 400);
  assert.ok(totalIntents > 5000, `only ${totalIntents} intents — the soak was too shallow`);
});

test('fuzz: a failing seed replays identically', () => {
  const run = () => {
    const clock = fakeClock();
    const g = pressYourLuck(31337, ['p0', 'p1'], clock);
    const r = FR.rng(31337);
    while (!g.state.ended) {
      g.table.handle(r.pick(['p0', 'p1']), { t: r.pick(['flip', 'bank', 'next']) });
      clock.advance(10);
    }
    return JSON.stringify(g.state.ended);
  };
  assert.equal(run(), run(), 'the same seed must produce the same game, or no bug is reproducible');
});

test('fuzz: input during a hold never lands, across many random timings', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = FR.rng(seed);
    const clock = fakeClock();
    const state = { n: 0 };
    const table = FR.host({
      state, timers: FR.timers(clock), publish: () => {},
      intents: { go: ctx => { ctx.state.n++; } }
    });
    const holdFor = r.range(50, 500);
    table.hold(holdFor, () => {});
    let sent = 0;
    for (let t = 0; t < holdFor; t += r.range(1, 20)) {
      clock.advance(r.range(1, 20));
      if (table.busy) { table.handle('p0', { t: 'go' }); sent++; }
    }
    assert.equal(state.n, 0, `seed ${seed}: ${sent} taps landed during a hold`);
  }
});

/* -------------------------------------------------------------------- */
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
