/*
 * table-sdk.js — the ONE implementation of the `Table` global games are written against.
 *
 * It used to be written twice: once as a Swift string inside TableBridge.swift, once as a
 * template literal inside the Playtest Studio's index.html. Two implementations of the same
 * contract drift, and this pair did — `onPlayerJoin` and `saveState`/`loadState` existed in
 * the studio months before they existed on device, so a game authored in the studio broke on
 * real phones with no error. The conformance suite was written to catch that, and it had to
 * reach the studio's copy by REGEX-SCRAPING the HTML for a template literal.
 *
 * Now both harnesses call `__frTable.create()` and there is nothing to drift.
 *
 * What differs between harnesses is only the TRANSPORT — how a message leaves the page:
 *
 *     native   window.webkit.messageHandlers.table.postMessage({...})   (JSON strings)
 *     studio   window.parent.HarnessBus.send(...)                       (live objects)
 *     tests    a plain array of recorded calls
 *
 * so that is the one thing `create` takes as a parameter. Everything a game can see is
 * defined here, once.
 *
 * Plain ES5, no dependencies: this runs inside WKWebView on an old iPhone, inside a
 * same-origin iframe in the studio, and under node in the conformance runner.
 */
(function (global) {
  'use strict';

  /**
   * Replace setTimeout/setInterval with pausable equivalents.
   *
   * This is what makes "pause the game when someone drops" free for game authors. Every
   * game's fuses, round timers and countdowns freeze and resume where they left off, with
   * no pause code of their own — and elapsed-time math inside a paused game can't advance
   * either, because its timers simply never fire.
   *
   * It has to be installed BEFORE any game code runs, which is why the native shell injects
   * this file at documentStart.
   *
   * Living only in the native shell was itself a drift: a game that leaned on timers
   * freezing behaved differently in the studio, where they kept running. Now both get it.
   *
   * @param {Object} w the window to patch.
   * @param {function} onError called with a message if a timer callback throws.
   * @returns {{setPaused:function, isPaused:function}}
   */
  function installTimerShim(w, onError) {
    var nSetTimeout = w.setTimeout.bind(w);
    var nClearTimeout = w.clearTimeout.bind(w);
    var nSetInterval = w.setInterval.bind(w);
    var nClearInterval = w.clearInterval.bind(w);
    var timers = new Map();
    var nextTimerId = 1, paused = false;
    var onPauseChange = null;

    function armTimeout(rec) {
      rec.native = nSetTimeout(function () { timers.delete(rec.id); rec.cb(); },
                               Math.max(0, rec.due - Date.now()));
      rec.repeating = false;
    }
    function armInterval(rec) {
      // Honour the remaining slice of the current period, then settle into a plain interval.
      rec.native = nSetTimeout(function () {
        rec.due = Date.now() + rec.delay;
        rec.cb();
        if (!timers.has(rec.id)) return;
        rec.native = nSetInterval(function () { rec.due = Date.now() + rec.delay; rec.cb(); }, rec.delay);
        rec.repeating = true;
      }, Math.max(0, rec.due - Date.now()));
      rec.repeating = false;
    }
    function disarm(rec) {
      if (rec.native == null) return;
      if (rec.repeating) nClearInterval(rec.native); else nClearTimeout(rec.native);
      rec.native = null;
    }

    w.setTimeout = function (fn, delay) {
      if (typeof fn !== 'function') return nSetTimeout(fn, delay);
      var args = Array.prototype.slice.call(arguments, 2);
      var id = nextTimerId++, d = Math.max(0, delay || 0);
      var rec = { id: id, cb: function () { fn.apply(null, args); }, delay: d,
                  due: Date.now() + d, repeat: false, native: null };
      timers.set(id, rec);
      if (!paused) armTimeout(rec);
      return id;
    };
    w.setInterval = function (fn, delay) {
      if (typeof fn !== 'function') return nSetInterval(fn, delay);
      var args = Array.prototype.slice.call(arguments, 2);
      var id = nextTimerId++, d = Math.max(1, delay || 1);
      var rec = { id: id, cb: function () { fn.apply(null, args); }, delay: d,
                  due: Date.now() + d, repeat: true, native: null };
      timers.set(id, rec);
      if (!paused) armInterval(rec);
      return id;
    };
    w.clearTimeout = function (id) {
      var rec = timers.get(id);
      if (rec) { disarm(rec); timers.delete(id); } else { nClearTimeout(id); }
    };
    w.clearInterval = function (id) {
      var rec = timers.get(id);
      if (rec) { disarm(rec); timers.delete(id); } else { nClearInterval(id); }
    };

    return {
      isPaused: function () { return paused; },
      /** Called by the harness when the session pauses/resumes. */
      setPaused: function (next) {
        next = !!next;
        if (next === paused) return;
        paused = next;
        if (paused) {
          timers.forEach(function (rec) {
            rec.remaining = Math.max(0, rec.due - Date.now());
            disarm(rec);
          });
        } else {
          timers.forEach(function (rec) {
            rec.due = Date.now() + (rec.remaining != null ? rec.remaining : rec.delay);
            rec.remaining = null;
            if (rec.repeat) armInterval(rec); else armTimeout(rec);
          });
        }
        if (onPauseChange) onPauseChange(paused);
      },
      /** The Table wires its onPause/onResume callbacks in through this. */
      _notify: function (fn) { onPauseChange = fn; }
    };
  }

  /**
   * Build the `Table` global.
   *
   * @param {Object} cfg
   *   me        {id,name,emoji,teamId?}  this device's player
   *   players   [{id,name,emoji,teamId?}] the roster, IN SEAT ORDER
   *   teams     [{id,name,color}] or null; playerIds are derived from `players`
   *   isHost    boolean
   *   saved     the persisted state to hand back from loadState() (already parsed)
   *   clock     the object returned by installTimerShim, or omitted for no pausing
   *   screens   HOST ONLY: how many shared screens (an Apple TV, an iPad) are showing
   *             the table right now. Omitted on a client, and by a shell too old to know.
   * @param {Object} io the transport. Every method is optional; a missing one is a no-op,
   *   which is what lets the conformance runner instantiate a Table with nothing behind it.
   *   send(payload) broadcast(payload) sendTo(id,payload) endGame(result)
   *   haptic(style) sound(name) saveState(value) error(message)
   * @returns {Object} the Table. Also installs `__tableFire` on the target window.
   */
  function createTable(cfg, io, w) {
    cfg = cfg || {}; io = io || {}; w = w || global;
    var handlers = {};
    var saved = cfg.saved === undefined ? null : cfg.saved;
    var clock = cfg.clock;

    function call(name, a, b) {
      var fn = io[name];
      if (fn) return fn(a, b);
      return undefined;
    }
    function report(e) {
      var msg = String((e && e.stack) || e);
      if (io.error) io.error(msg);
    }

    var roster = cfg.players || [];
    /* How many shared screens are attached — known only to the HOST, because only
     * the host's shell has the connections. `null` means "not known here": every
     * client, and a host on a shell too old to say. A game whose phones should
     * look different with a TV in the room reads this on the host and publishes
     * it in its own state, the same way it publishes everything else. */
    var screens = (cfg.isHost && typeof cfg.screens === 'number') ? cfg.screens : null;
    var rawTeams = cfg.teams || [];
    var isHost = !!cfg.isHost;

    var Table = {
      me: Object.assign({}, cfg.me || {}, { isHost: isHost }),
      /* A seed the whole table agrees on, supplied by the harness.
       *
       * A game that seeds itself from Date.now() is reproducible in principle and never
       * in practice: the test harness can't reproduce a failure it didn't choose the seed
       * for. With the seed coming from here, `node playtest.mjs streak --seed 137` replays
       * the exact game, which is the difference between fuzzing that finds bugs and
       * fuzzing that just reports that something, once, went wrong.
       *
       * Use it: `var r = FR.rng(Table.seed);` */
      seed: (cfg.seed === undefined ? ((Date.now() ^ (Math.random() * 4294967296)) >>> 0)
                                    : (cfg.seed >>> 0)),
      isHost: isHost,
      players: roster,
      // playerIds are always DERIVED from the roster rather than passed in, so the two
      // can't disagree — the studio used to compute them separately from the shell.
      teams: rawTeams.length ? rawTeams.map(function (t) {
        return Object.assign({}, t, {
          playerIds: roster.filter(function (p) { return p.teamId === t.id; })
                           .map(function (p) { return p.id; })
        });
      }) : null,

      onStart: function (cb) { handlers.start = cb; },
      onPlayerJoin: function (cb) { handlers.join = cb; },
      onPlayerLeave: function (cb) { handlers.leave = cb; },
      onMessage: function (cb) { handlers.message = cb; },

      /// Persist small per-game state across relaunches (settings, the phrases used last
      /// time). Reads are synchronous: the harness injects the stored value with the SDK,
      /// so `loadState()` never awaits.
      saveState: function (obj) {
        saved = (obj === undefined ? null : obj);
        call('saveState', saved);
      },
      loadState: function () { return saved; },

      /// Optional: play froze because someone dropped. Timers already stop on their own —
      /// use these only if you need to dim UI or similar.
      onPause: function (cb) { handlers.pause = cb; },
      onResume: function (cb) { handlers.resume = cb; },
      get isPaused() { return clock ? clock.isPaused() : !!w.__tablePaused; },

      /// HOST ONLY: how many shared screens are showing the table right now — a
      /// number on the host, `null` on every client and on a shell too old to know.
      /// Treat `null` as "assume no screen": a phone that shows the whole table is
      /// redundant beside a TV, while a phone that assumes one shows nothing at all.
      get screens() { return screens; },
      /// HOST ONLY: a screen attached or went away (cb receives the new count). A
      /// TV switched on mid-game is normal; republish so the phones can adapt.
      onScreensChange: function (cb) { handlers.screens = cb; },

      /// Room feedback. Shell-owned because iOS WebKit has no vibrate API and gates web
      /// audio behind a per-device user gesture.
      /// haptic: light|medium|heavy|soft|rigid|selection|success|warning|error|thud|buzz|boom
      haptic: function (style) { call('haptic', String(style || 'light')); },
      /// sound: tick|count|ding|chime|buzz|thud|boom|pop|whoosh
      sound: function (name) { call('sound', String(name || '')); },

      send: function (payload) { call('send', payload); },
      broadcast: function (payload) { if (isHost) call('broadcast', payload); },
      sendTo: function (id, payload) { if (isHost) call('sendTo', id, payload); },
      endGame: function (result) { if (isHost) call('endGame', result); }
    };

    /** The harness fires game events in through this. */
    w.__tableFire = function (event, a, b) {
      // The screen count is state the SDK owns, so it is updated before the game
      // hears about it — and only a change is news. A shell fires it on every page
      // load to sync a fresh page, which must not look like a TV coming and going.
      if (event === 'screens') {
        if (!isHost) return;
        var n = Math.max(0, Number(a) || 0);
        if (n === screens) return;
        screens = n;
        a = n;
      }
      var cb = handlers[event];
      if (cb) { try { cb(a, b); } catch (e) { report(e); } }
    };
    // The studio grew up calling it this; kept so old harness code keeps working.
    w.__tableDispatch = w.__tableFire;

    if (clock && clock._notify) {
      clock._notify(function (paused) { w.__tableFire(paused ? 'pause' : 'resume'); });
    }
    if (w.addEventListener) {
      w.addEventListener('error', function (e) { if (io.error) io.error(String(e.message)); });
    }

    return Table;
  }

  global.__frTable = { create: createTable, installTimerShim: installTimerShim };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__frTable;
})(typeof window !== 'undefined' ? window : globalThis);
