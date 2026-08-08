/*
 * fr-game.js — the structure every Family Room game was rebuilding by hand.
 *
 * `fr-feel.js` is how a game FEELS. This is how a game is SHAPED: the deck, the
 * turn order, who's out, whose round it is, what the scoreboard says at the end.
 * None of that is interesting to write. All of it is easy to write subtly wrong.
 *
 * It is a library, not a framework. Take one piece or all of them; nothing here
 * requires anything else here, and nothing requires `Table`. That last part is
 * deliberate — a game built on these primitives can be driven, replayed and
 * fuzzed by a plain node script with no browser, no simulator and no Mac.
 *
 * WHAT WENT WRONG BEFORE, AND WHAT NOW PREVENTS IT
 *
 *   Every game shipped this line, copied verbatim:
 *       const shuffle = a => { for (let i=a.length-1;i>0;i--){ ... Math.random() ... } };
 *   Math.random() cannot be seeded, so no game could be replayed. A bug found in
 *   a playtest could not be reproduced, and fuzzing was pointless because a
 *   failure could never be shown again. `FR.rng(seed)` is the fix, and it is the
 *   reason the rest of this file is testable at all.
 *
 *   Three games hand-rolled `G.alive` + `G.out` + "last one standing", and each
 *   one separately had to remember to check for a winner after a player left
 *   mid-game. `FR.seats` owns that.
 *
 *   STREAK's "Flip 3" dealt 2 cards or 4, never 3, because Flip and Bank stayed
 *   live during the 800ms gaps between forced flips and a stray tap re-entered
 *   the sequence. `FR.host` refuses every intent while a scripted sequence is in
 *   flight (`table.hold`), so that bug cannot be written again.
 *
 * USAGE
 *
 *   Browser (both harnesses inject it, so `FR` is simply there):
 *       var deck = FR.deck(cards, FR.rng(seed));
 *   Node (tests, fuzzing, CI):
 *       import FR from './fr-game.js';
 *
 * Everything is plain ES5 and dependency-free: it has to run inside WKWebView on
 * an old iPhone as happily as it runs under node on a headless Linux box.
 */
(function (global) {
  'use strict';

  var FR = { version: '1.0.0' };

  /* ------------------------------------------------------------------ *
   * FR.rng — seeded randomness
   *
   * The single most important thing in this file. A game that draws from
   * `FR.rng(seed)` instead of Math.random() is REPRODUCIBLE: same seed, same
   * game, every time. That turns "it broke once during a playtest" into a
   * failing test, and makes fuzzing meaningful instead of noise.
   *
   * The host should pick the seed once and put it in state, so a replay only
   * needs the seed and the list of intents.
   * ------------------------------------------------------------------ */

  /**
   * @param {number} [seed] any integer; omit for a random (non-reproducible) one.
   * @returns {function} r() -> float in [0,1), with .int/.range/.pick/.shuffle.
   */
  FR.rng = function (seed) {
    // mulberry32: tiny, fast, and good enough that shuffles look shuffled.
    var s = (seed === undefined ? (Math.random() * 4294967296) : seed) >>> 0;
    var r = function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    /** Integer in [0, n). */
    r.int = function (n) { return Math.floor(r() * n); };

    /** Integer in [lo, hi] inclusive, the way dice are described. */
    r.range = function (lo, hi) { return lo + r.int(hi - lo + 1); };

    /** One element. Returns undefined for an empty list rather than throwing. */
    r.pick = function (list) { return list.length ? list[r.int(list.length)] : undefined; };

    /** Fisher-Yates. Returns a NEW array — shuffling a caller's deck in place
     *  is how you accidentally shuffle the discard pile too. */
    r.shuffle = function (list) {
      var a = list.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = r.int(i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    };

    /** The seed this generator started from, so a game can publish it. */
    r.seed = s;
    return r;
  };

  /* ------------------------------------------------------------------ *
   * FR.deck — a real deck of cards
   *
   * Draw from the top, discard to a pile, and when the deck runs out the
   * discards are reshuffled back in. `left` is the count players want on
   * screen, which is the whole reason STREAK grew a deck counter.
   *
   * "Reshuffle the discards" is the part games get wrong: without it a long
   * game silently starts drawing `undefined`.
   * ------------------------------------------------------------------ */

  /**
   * @param {Array} cards the full deck, any element type.
   * @param {function} [random] an FR.rng; one is created if omitted.
   */
  FR.deck = function (cards, random) {
    var r = random || FR.rng();
    var draw = r.shuffle(cards || []);
    var discard = [];
    var spent = 0;

    var api = {
      /** Cards remaining before a reshuffle is needed. Show this to players. */
      get left() { return draw.length; },
      /** Cards in the discard pile — what a reshuffle would bring back. */
      get discarded() { return discard.length; },
      /** True when both piles are empty and no further draw can succeed. */
      get exhausted() { return draw.length === 0 && discard.length === 0; },
      /** How many cards have been drawn in total, across reshuffles. */
      get drawn() { return spent; },

      /**
       * Take the top card, reshuffling the discards in first if needed.
       * @returns {*} the card, or undefined if both piles are empty.
       */
      draw: function () {
        if (!draw.length) api.reshuffle();
        if (!draw.length) return undefined;
        spent++;
        return draw.pop();
      },

      /** Take up to n cards. Short array if the deck ran dry — never undefined holes. */
      drawMany: function (n) {
        var out = [];
        for (var i = 0; i < n; i++) {
          var c = api.draw();
          if (c === undefined) break;
          out.push(c);
        }
        return out;
      },

      /** Look at the top card without taking it. */
      peek: function () { return draw.length ? draw[draw.length - 1] : undefined; },

      /** Put a card on the discard pile. */
      discard: function (card) { discard.push(card); return api; },

      /** Shuffle the discards back under the draw pile. Called automatically. */
      reshuffle: function () {
        if (!discard.length) return api;
        draw = r.shuffle(discard).concat(draw);
        discard = [];
        return api;
      },

      /** Add cards to the draw pile and shuffle them in (a mid-game injection). */
      add: function (more) {
        draw = r.shuffle(draw.concat(more));
        return api;
      }
    };
    return api;
  };

  /* ------------------------------------------------------------------ *
   * FR.seats — turn order, player status, and elimination
   *
   * The busiest primitive, because it replaces three separate hand-rolled
   * things that every game had: `nextActiveFrom`, `G.alive`/`G.out`, and the
   * "did that departure end the game?" check.
   *
   * TWO KINDS OF NOT-PLAYING, and the difference matters:
   *   setStatus(id, 'busted')  temporary. Cleared by startRound().
   *   eliminate(id)            permanent. Survives startRound(), and the ORDER
   *                            of eliminations is the final ranking.
   * Getting these confused is how a busted player never comes back next round.
   * ------------------------------------------------------------------ */

  /**
   * @param {Array<string>} ids player ids in seat order (== turn order).
   */
  FR.seats = function (ids) {
    var order = (ids || []).slice();
    var status = {};                  // id -> 'active' | 'out' | anything a game likes
    var out = [];                     // elimination order, earliest first
    var idx = 0;                      // index into `order` of whoever is up
    var dealer = 0;

    order.forEach(function (id) { status[id] = 'active'; });

    function activeIndexFrom(start, inclusive) {
      var n = order.length;
      if (!n) return -1;
      for (var step = inclusive ? 0 : 1; step <= n; step++) {
        var i = ((start + step) % n + n) % n;
        if (status[order[i]] === 'active') return i;
      }
      return -1;
    }

    var api = {
      /** Every seat, in turn order, however they're doing. */
      get all() { return order.slice(); },
      /** Ids still able to take a turn. */
      get active() { return order.filter(function (id) { return status[id] === 'active'; }); },
      /** Eliminated ids, earliest knocked out first. */
      get out() { return out.slice(); },
      /** Whose turn it is, or null if nobody can play. */
      get current() { return idx >= 0 && order[idx] ? order[idx] : null; },
      /** Id of the current dealer/starter, for games that rotate who leads. */
      get dealer() { return order[dealer] || null; },
      /** True when exactly one player has not been eliminated — a winner. */
      get settled() { return api.remaining.length <= 1; },
      /** Ids that have NOT been eliminated (may be busted, frozen, etc). */
      get remaining() {
        return order.filter(function (id) { return status[id] !== 'out'; });
      },
      /** The last player standing, or null while the game is still going. */
      get survivor() {
        var left = api.remaining;
        return left.length === 1 ? left[0] : null;
      },

      /** Read a seat's status. Unknown ids read as 'out' so a stale id can't play. */
      status: function (id) { return status[id] || 'out'; },
      /** True only for 'active'. */
      isActive: function (id) { return status[id] === 'active'; },

      /**
       * Set a TEMPORARY status ('busted', 'frozen', 'stayed', 'ready'…).
       * Cleared by startRound(). Use eliminate() for permanent removal.
       */
      setStatus: function (id, s) {
        if (status[id] !== undefined && status[id] !== 'out') status[id] = s;
        return api;
      },

      /**
       * Knock a player out for the rest of the GAME. Idempotent, so calling it
       * from both a game rule and a player-left handler is safe.
       */
      eliminate: function (id) {
        if (status[id] === undefined || status[id] === 'out') return api;
        status[id] = 'out';
        out.push(id);
        return api;
      },

      /**
       * Begin a round: everyone not eliminated becomes active again, and the
       * turn passes to the first active player at or after the dealer.
       * @param {boolean} [rotateDealer] pass true from the SECOND round on.
       */
      startRound: function (rotateDealer) {
        if (rotateDealer && order.length) dealer = (dealer + 1) % order.length;
        order.forEach(function (id) { if (status[id] !== 'out') status[id] = 'active'; });
        idx = activeIndexFrom(dealer, true);
        return api.current;
      },

      /**
       * Pass play to the next active seat.
       * @returns {?string} the new current id, or null when nobody is active —
       *          which is how a round ends, so check for it.
       */
      next: function () {
        idx = activeIndexFrom(idx, false);
        return api.current;
      },

      /** Force play to a specific seat (a targeted attack, a chosen starter). */
      moveTo: function (id) {
        var at = order.indexOf(id);
        if (at >= 0 && status[id] === 'active') idx = at;
        return api.current;
      }
    };
    return api;
  };

  /* ------------------------------------------------------------------ *
   * FR.standings — the scoreboard the shell expects
   *
   * `Table.endGame` wants { winnerId, standings:[{playerId, score, detail}] },
   * and every game built that by hand with a slightly different sort. Ties were
   * handled differently in each one, and one game ranked ascending by mistake.
   * ------------------------------------------------------------------ */

  FR.standings = {
    /**
     * Rank by points, highest first.
     * @param {Object} scores id -> number
     * @param {Object} [opts] { lowestWins:true, detail:fn(id,score)->string }
     * @returns {{winnerId:?string, standings:Array}} ready for Table.endGame.
     */
    byScore: function (scores, opts) {
      opts = opts || {};
      var ids = Object.keys(scores || {});
      var sign = opts.lowestWins ? -1 : 1;
      var ranked = ids.slice().sort(function (a, b) {
        var d = sign * ((scores[b] || 0) - (scores[a] || 0));
        return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);   // stable, never arbitrary
      });
      return {
        winnerId: ranked.length ? ranked[0] : null,
        standings: ranked.map(function (id) {
          var row = { playerId: id, score: scores[id] || 0 };
          if (opts.detail) row.detail = opts.detail(id, scores[id] || 0);
          return row;
        })
      };
    },

    /**
     * Rank a last-one-standing game: the survivor first, then the eliminated in
     * reverse order of going out (whoever lasted longest ranks higher).
     * @param {Object} seats an FR.seats
     * @param {Object} [opts] { detail:fn(id,place)->string }
     */
    byElimination: function (seats, opts) {
      opts = opts || {};
      var survivors = seats.remaining;
      var ranked = survivors.concat(seats.out.slice().reverse());
      return {
        winnerId: survivors.length === 1 ? survivors[0] : null,
        standings: ranked.map(function (id, i) {
          var row = { playerId: id, score: ranked.length - i };
          if (opts.detail) row.detail = opts.detail(id, i + 1);
          return row;
        })
      };
    }
  };

  /* ------------------------------------------------------------------ *
   * FR.timers — named timers that can all be cancelled at once
   *
   * Games leaked timers: a bomb fuse and a heat tick stored in two ad-hoc
   * fields, cleared by hand at four different call sites, and missed at the
   * fifth — so a finished game kept ticking under the results screen.
   *
   * Naming them means "cancel that one" and "cancel everything" are both one
   * call. The injectable clock is what lets a headless test run a 60-second
   * game in a millisecond.
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} [clock] { setTimeout, clearTimeout, setInterval, clearInterval }.
   *        Defaults to the host environment's. Tests pass a virtual clock.
   */
  FR.timers = function (clock) {
    var c = clock || global;
    var live = {};      // name -> { id, repeating }

    var api = {
      /** Names of every timer currently armed. */
      get pending() { return Object.keys(live); },

      /** Run fn once after ms. Re-using a name replaces the old timer. */
      after: function (name, ms, fn) {
        api.cancel(name);
        live[name] = {
          repeating: false,
          id: c.setTimeout(function () { delete live[name]; fn(); }, ms)
        };
        return api;
      },

      /** Run fn every ms until cancelled. Re-using a name replaces the old timer. */
      every: function (name, ms, fn) {
        api.cancel(name);
        live[name] = { repeating: true, id: c.setInterval(fn, ms) };
        return api;
      },

      /** Stop one timer. Safe to call for a name that isn't armed. */
      cancel: function (name) {
        var t = live[name];
        if (!t) return api;
        if (t.repeating) c.clearInterval(t.id); else c.clearTimeout(t.id);
        delete live[name];
        return api;
      },

      /** Stop everything. Call this when the game ends — always. */
      cancelAll: function () {
        Object.keys(live).forEach(api.cancel);
        return api;
      }
    };
    return api;
  };

  /* ------------------------------------------------------------------ *
   * FR.host — the host-authoritative intent reducer
   *
   * Clients send intents; the host decides. Every game wrote that switch by
   * hand, and every game had to remember the same four checks. Missing any one
   * of them is a real bug that shipped at least once:
   *
   *   1. Is this a known intent?          (unknown -> silently ignore)
   *   2. Is the game in a phase for it?   (a tap on the results screen)
   *   3. Is it this player's turn?        (out-of-turn taps mutating state)
   *   4. Is a scripted sequence running?  (STREAK's Flip 3 dealing 2 or 4)
   *
   * Check 4 is the one nobody thinks of until it bites. `hold()` is how a game
   * runs a timed sequence — a forced flip, a dramatic pause before the round-end
   * banner — with the table's inputs frozen for the duration.
   * ------------------------------------------------------------------ */

  /**
   * @param {Object} cfg
   * @param {Object} cfg.state       your game state; handed to every intent.
   * @param {function} cfg.publish   called after any accepted intent, and after
   *                                 a hold ends. Broadcast your view here.
   * @param {Object} cfg.intents     name -> handler or { turn, phase, run }.
   *        handler(ctx) where ctx = { from, msg, state, table }.
   *        Options: turn:true   only the current seat may send it
   *                 host:true   only the host may send it (needs cfg.hostId)
   *                 phase:'x'   only in that phase (string or array)
   *                 when:fn     (ctx) -> bool, any guard turn/host/phase can't express.
   *                             Checked by BOTH handle() and legalMoves(), so they can't
   *                             disagree about what's legal.
   *                 options:fn  (ctx) -> [{...args}] this intent would accept right now.
   *                             Declaring it is what lets legalMoves() enumerate the move
   *                             space, so the game can be fuzzed without a DOM.
   *                 hidden:true keep it out of legalMoves ('hello' and friends)
   *                 run:fn      the handler itself
   * @param {Object} [cfg.seats]     an FR.seats; required for turn:true.
   * @param {function} [cfg.phase]   () -> current phase string.
   * @param {Object} [cfg.timers]    an FR.timers; a private one is made if absent.
   */
  FR.host = function (cfg) {
    cfg = cfg || {};
    var intents = cfg.intents || {};
    var timers = cfg.timers || FR.timers();
    var busy = false;
    var rejected = [];        // names of intents refused, newest last — for tests

    function phaseNow() { return cfg.phase ? cfg.phase() : null; }

    function refuse(name, why) {
      rejected.push({ intent: name, why: why });
      if (rejected.length > 50) rejected.shift();
    }

    var api = {
      /** True while a hold() sequence is running and input is frozen. */
      get busy() { return busy; },
      /** Why recent intents were refused. Diagnostics for tests and fuzzing. */
      get rejected() { return rejected.slice(); },
      timers: timers,

      /**
       * Feed one client intent in. Wire it up as:
       *     Table.onMessage(function (from, msg) { table.handle(from, msg); });
       * @returns {boolean} true if the intent was accepted and ran.
       */
      handle: function (from, msg) {
        var name = msg && msg.t;
        var spec = name && intents[name];
        if (!spec) { refuse(name, 'unknown'); return false; }
        if (typeof spec === 'function') spec = { run: spec };

        // Frozen first: during a hold NOTHING gets through, whatever it is.
        if (busy) { refuse(name, 'busy'); return false; }

        // Is the sender even at this table? Found by the fuzzer, which handed a
        // seatless id to a game whose "next round" intent was open to everyone —
        // and it was allowed to advance the round. The shell only delivers
        // messages from seated players today, so this is defence in depth, but a
        // departed or stale id reaching a game must never move it.
        if (cfg.seats && cfg.seats.all.indexOf(from) === -1) {
          refuse(name, 'not-seated'); return false;
        }

        // Host-only verbs — "start the round", "deal the next hand", "light the fuse".
        // Every game hand-wrote `from === Table.me.id` for these and it is easy to leave
        // out, at which point any player can drive the table's pacing.
        if (spec.host && from !== cfg.hostId) { refuse(name, 'not-host'); return false; }

        if (spec.phase) {
          var want = [].concat(spec.phase);
          if (want.indexOf(phaseNow()) === -1) { refuse(name, 'phase'); return false; }
        }
        if (spec.turn) {
          if (!cfg.seats) { refuse(name, 'no-seats'); return false; }
          if (cfg.seats.current !== from) { refuse(name, 'turn'); return false; }
        }
        // Any guard the built-in ones can't express. It is checked HERE and in
        // legalMoves(), which is the point: a guard written inside run() would let
        // legalMoves offer a move the host then refuses, and the two must not disagree
        // or the fuzzer spends its time on moves that do nothing.
        if (spec.when && !spec.when({ from: from, msg: msg, state: cfg.state, table: api })) {
          refuse(name, 'when'); return false;
        }

        spec.run({ from: from, msg: msg, state: cfg.state, table: api });
        if (cfg.publish) cfg.publish();
        return true;
      },

      /**
       * Every move `playerId` could legally make right now, as concrete messages.
       *
       * This is the answer to "how do you fuzz a game you can't click". A bot driving
       * through the DOM has to reverse-engineer the move set from rendered HTML, which
       * works until a game expresses a move as two taps (select a card, then play it) or
       * as typed text — and then the bot stalls and the game looks broken when it isn't.
       *
       * The host already knows the answer: it has the intent table and the state. An
       * intent declares `options(ctx)` returning the argument sets it would accept, and
       * this enumerates them, applying the same turn / host / phase / busy checks that
       * `handle` would. An intent with no `options` contributes its bare verb.
       *
       * The UI becomes one view of this list rather than the only place it exists.
       *
       * @returns {Array<Object>} messages you can pass straight to handle().
       */
      legalMoves: function (playerId) {
        if (busy) return [];                       // frozen: nothing is legal
        var out = [];
        Object.keys(intents).forEach(function (name) {
          var spec = intents[name];
          if (typeof spec === 'function') spec = { run: spec };
          if (spec.hidden) return;                 // resync verbs like `hello`
          if (spec.host && playerId !== cfg.hostId) return;
          if (spec.turn && (!cfg.seats || cfg.seats.current !== playerId)) return;
          if (spec.phase && [].concat(spec.phase).indexOf(phaseNow()) === -1) return;
          if (cfg.seats && cfg.seats.all.indexOf(playerId) === -1) return;

          var ctx = { from: playerId, state: cfg.state, table: api };
          if (spec.when && !spec.when(ctx)) return;
          var args = spec.options ? spec.options(ctx) : null;
          if (!args) { out.push({ t: name }); return; }
          args.forEach(function (a) {
            out.push(Object.assign({ t: name }, a));
          });
        });
        return out;
      },

      /**
       * Freeze the table for `ms`, then run fn and publish.
       *
       * This is what a dramatic pause is FOR: players need a moment to see the
       * bust that ended the round before the modal covers it. Freezing input is
       * not a side effect of that pause, it IS the point — an accepted tap
       * during the gap is how a forced sequence loses count of itself.
       *
       * Nesting is allowed; the table stays frozen until the last one finishes.
       */
      hold: function (ms, fn) {
        busy = true;
        var name = 'fr:hold:' + (api._holds = (api._holds || 0) + 1);
        timers.after(name, ms, function () {
          busy = false;
          if (fn) fn();
          if (cfg.publish) cfg.publish();
        });
        if (cfg.publish) cfg.publish();     // show the held frame immediately
        return api;
      },

      /**
       * Run a sequence of steps `ms` apart with the table frozen throughout —
       * a forced multi-card flip, a countdown, a cascade of reveals.
       * @param {number} ms gap between steps
       * @param {Array<function>} steps
       * @param {function} [done] after the last step
       */
      sequence: function (ms, steps, done) {
        var i = 0;
        busy = true;
        function step() {
          if (i >= steps.length) {
            busy = false;
            if (done) done();
            if (cfg.publish) cfg.publish();
            return;
          }
          steps[i++]();
          if (cfg.publish) cfg.publish();
          timers.after('fr:seq', ms, step);
        }
        step();
        return api;
      },

      /**
       * Freeze or thaw input by hand, for a game whose timed sequence is its own.
       *
       * `hold` and `sequence` cover the common shapes, but some sequences are variable
       * length and interruptible — STREAK's forced flips can pause mid-run to ask the
       * player who to target. Those games still need the guard, and writing it as
       * `if (myQueue.length || myFlag) return;` at the top of every intent is exactly
       * the check that gets forgotten, which is how Flip 3 dealt two cards or four.
       *
       * While frozen, handle() refuses everything and legalMoves() is empty.
       */
      freeze: function (on) {
        busy = !!on;
        return api;
      },

      /** Stop every timer this table owns. Call when the game ends. */
      stop: function () { busy = false; timers.cancelAll(); return api; }
    };

    // Publish the live table on the window. The headless harness looks for this to ask
    // the game what's legal instead of guessing from rendered HTML; nothing else reads
    // it, and a game never has to wire anything up to be fuzzable.
    try { global.__frHostTable = api; } catch (e) {}
    return api;
  };

  /* ------------------------------------------------------------------ */

  global.FR = FR;
  if (typeof module !== 'undefined' && module.exports) module.exports = FR;
})(typeof window !== 'undefined' ? window : globalThis);
