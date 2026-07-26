/*
 * Table SDK conformance suite — ONE spec, run against every harness.
 *
 * Why this exists: the Playtest Studio and the iOS shell each implement the
 * `Table` global separately, and they drifted. `onPlayerJoin` and
 * `saveState`/`loadState` were documented and implemented in the studio but
 * absent on device, so a game authored in the studio broke on real phones with
 * no warning. This suite is the shared contract.
 *
 * It is pure JS with no imports so the same file can be evaluated:
 *   - in a WKWebView from an XCTest unit test (native harness)
 *   - in the Playtest Studio via its "Run conformance" button
 *   - in node against a reference implementation
 *
 * Usage: __tableConformance.run(Table) -> { pass, fail, total, results: [...] }
 */
(function (global) {
  'use strict';

  /** Every member the Table SDK must expose, and what it must be. */
  var SPEC = [
    // identity
    { path: 'me',            type: 'object',   note: 'local player {id,name,emoji,isHost}' },
    { path: 'me.id',         type: 'string' },
    { path: 'me.name',       type: 'string' },
    { path: 'me.emoji',      type: 'string' },
    { path: 'isHost',        type: 'boolean' },
    { path: 'players',       type: 'array',    note: 'final roster at onStart' },
    { path: 'teams',         type: 'array-or-null', note: 'null when the game is not a team game' },

    // lifecycle registration
    { path: 'onStart',       type: 'function', arity: 1 },
    { path: 'onMessage',     type: 'function', arity: 1 },
    { path: 'onPlayerJoin',  type: 'function', arity: 1 },
    { path: 'onPlayerLeave', type: 'function', arity: 1 },
    { path: 'onPause',       type: 'function', arity: 1 },
    { path: 'onResume',      type: 'function', arity: 1 },
    { path: 'isPaused',      type: 'boolean' },

    // messaging
    { path: 'send',          type: 'function', arity: 1 },
    { path: 'broadcast',     type: 'function', arity: 1 },
    { path: 'sendTo',        type: 'function', arity: 2 },

    // ending
    { path: 'endGame',       type: 'function', arity: 1 },

    // room feedback (shell-owned: WebKit on iOS has no vibrate API)
    { path: 'haptic',        type: 'function', arity: 1 },
    { path: 'sound',         type: 'function', arity: 1 },
    // game feel: semantic layer over animation + haptic + sound (fr-feel.js)
    { path: 'feel',          type: 'function', arity: 2 },
    { path: 'feel.events',   type: 'array',    note: 'names accepted by feel()' },
    { path: 'feel.deal',     type: 'function', arity: 2 },

    // persistence
    { path: 'saveState',     type: 'function', arity: 1 },
    { path: 'loadState',     type: 'function', arity: 0 }
  ];

  function resolve(root, path) {
    var parts = path.split('.'), cur = root;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function kindOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function checkType(value, expected) {
    if (expected === 'array-or-null') return value === null || Array.isArray(value);
    if (expected === 'array') return Array.isArray(value);
    return kindOf(value) === expected;
  }

  function run(Table) {
    var results = [];

    function record(name, ok, detail) {
      results.push({ name: name, ok: !!ok, detail: detail || '' });
    }

    if (!Table || typeof Table !== 'object') {
      record('Table exists', false, 'Table global is missing');
      return summarize(results);
    }
    record('Table exists', true);

    // --- surface ---------------------------------------------------------
    SPEC.forEach(function (item) {
      var value = resolve(Table, item.path);
      var present = value !== undefined;
      if (!present) {
        record('has ' + item.path, false, 'missing' + (item.note ? ' — ' + item.note : ''));
        return;
      }
      var typeOk = checkType(value, item.type);
      record('has ' + item.path, typeOk,
             typeOk ? '' : 'expected ' + item.type + ', got ' + kindOf(value));

      // Arity matters: a handler registered with the wrong shape silently never fires.
      if (typeOk && item.type === 'function' && typeof item.arity === 'number') {
        record(item.path + ' arity ' + item.arity, value.length === item.arity,
               'declared ' + value.length + ' parameter(s)');
      }
    });

    // --- behaviour -------------------------------------------------------
    // Registering a handler must not throw and must not require the callback
    // to fire immediately.
    ['onStart', 'onMessage', 'onPlayerJoin', 'onPlayerLeave', 'onPause', 'onResume']
      .forEach(function (hook) {
        if (typeof Table[hook] !== 'function') return;
        var threw = null;
        try { Table[hook](function () {}); } catch (e) { threw = String(e); }
        record(hook + ' registers without throwing', threw === null, threw || '');
      });

    // Feedback calls must be safe no-ops rather than throwing, so a game runs
    // unchanged on a harness without speakers or a Taptic Engine.
    [['haptic', 'light'], ['sound', 'ding']].forEach(function (pair) {
      var fn = Table[pair[0]];
      if (typeof fn !== 'function') return;
      var threw = null;
      try { fn.call(Table, pair[1]); } catch (e) { threw = String(e); }
      record(pair[0] + '() is callable', threw === null, threw || '');
      // An unknown name must be ignored, not fatal.
      var threwUnknown = null;
      try { fn.call(Table, '__nonexistent__'); } catch (e) { threwUnknown = String(e); }
      record(pair[0] + '() tolerates an unknown name', threwUnknown === null, threwUnknown || '');
    });

    // feel() must be safe with no element, an unknown event, and every documented
    // event name — a game calling it must never be able to crash on a harness.
    if (typeof Table.feel === 'function') {
      var feelThrew = null;
      try {
        Table.feel('gain');
        Table.feel('__nonexistent__', {});
        (Table.feel.events || []).forEach(function (name) { Table.feel(name, {}); });
      } catch (e) { feelThrew = String(e); }
      record('feel() tolerates missing element / unknown event / all events',
             feelThrew === null, feelThrew || '');
      record('feel.events lists the documented set',
             (Table.feel.events || []).indexOf('bust') >= 0
             && (Table.feel.events || []).indexOf('turn') >= 0,
             'got: ' + JSON.stringify(Table.feel.events));
    }

    // saveState/loadState round-trip.
    if (typeof Table.saveState === 'function' && typeof Table.loadState === 'function') {
      var threw = null, roundTripped = false;
      var probe = { __conformance: true, n: 42 };
      try {
        Table.saveState(probe);
        var back = Table.loadState();
        roundTripped = !!back && back.n === 42;
      } catch (e) { threw = String(e); }
      record('saveState/loadState do not throw', threw === null, threw || '');
      record('saveState -> loadState round-trips', roundTripped,
             roundTripped ? '' : 'loadState did not return what was saved');
    }

    // Clients must not be able to act as the host. broadcast/sendTo are
    // documented as host-only no-ops, never errors.
    if (!Table.isHost) {
      var broadcastThrew = null;
      try { Table.broadcast({ conformance: true }); } catch (e) { broadcastThrew = String(e); }
      record('broadcast() on a client is a silent no-op', broadcastThrew === null, broadcastThrew || '');
    }

    // Pausable timers: the shell freezes game clocks when someone drops, which
    // requires setTimeout/setInterval to be the shimmed versions.
    record('setTimeout is available', typeof global.setTimeout === 'function');
    record('setInterval is available', typeof global.setInterval === 'function');

    return summarize(results);
  }

  function summarize(results) {
    var pass = results.filter(function (r) { return r.ok; }).length;
    return {
      total: results.length,
      pass: pass,
      fail: results.length - pass,
      failures: results.filter(function (r) { return !r.ok; }),
      results: results
    };
  }

  global.__tableConformance = { run: run, SPEC: SPEC };
})(typeof window !== 'undefined' ? window : globalThis);
