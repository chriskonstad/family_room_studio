/*
 * fr-screen.js — drawing for the shared screen (Apple TV, iPad, the Studio).
 *
 * A "screen" is an auxiliary display, not a player: it receives the host's public
 * broadcasts and never a private `sendTo`, so a game's hands stay on phones by
 * construction rather than by the author remembering.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS NOT HTML
 *
 *   tvOS has no WebKit. Not a restricted one — none: `import WebKit` fails to
 *   compile for arm64-apple-tvos. No WKWebView, no DOM, no HTML, no CSS, no
 *   WebGL. So a screen view cannot be a web page, and `screen.html` is not a
 *   thing that can ever render on an Apple TV.
 *
 *   What tvOS does have is JavaScriptCore and a GPU. So a game's screen code is
 *   plain JS that DRAWS, and each platform draws the result its own way:
 *
 *     Studio / iPad / phone   replay onto a real <canvas>
 *     tvOS                    flush to a native SwiftUI Canvas via JavaScriptCore
 *     node / harness          don't replay at all — just read the ops
 *
 * HOW THE DRIFT IS KEPT OUT
 *
 *   A game never touches a real CanvasRenderingContext2D. It draws into the
 *   recorder below, which implements exactly the op set every renderer supports
 *   and nothing else. So the browser is STRICTER than a browser: reach for an op
 *   the Apple TV can't do and it is a TypeError in the Studio, immediately, on a
 *   laptop — instead of a blank rectangle on a TV in someone's living room.
 *
 *   That is deliberate. This project's recurring failure has been a permissive
 *   test environment agreeing with itself while a real device disagreed.
 *
 * WHY A COMMAND BUFFER RATHER THAN DIRECT CALLS
 *
 *   Each JS->native crossing costs. A 60fps board is hundreds of ops a frame,
 *   which would be hundreds of thousands of crossings a second. Recording into
 *   an array and flushing once per frame makes it one. It also makes a frame a
 *   VALUE — so a test can assert on what was drawn without any renderer running,
 *   which is how "no private hand ever reaches a screen" becomes checkable.
 */
(function (global) {
  'use strict';

  var FRScreen = { version: '1.0.0' };

  /* ------------------------------------------------------------------ ops --- */

  /* The contract. Every renderer must honour exactly this and authors may use
   * exactly this. Adding to it means teaching BOTH renderers, on purpose. */
  var PROPS = ['fillStyle', 'strokeStyle', 'lineWidth', 'font',
               'textAlign', 'textBaseline', 'globalAlpha', 'lineCap', 'lineJoin'];

  var METHODS = ['save', 'restore', 'translate', 'rotate', 'scale',
                 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'rect', 'roundRect',
                 'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect', 'fillText'];

  FRScreen.PROPS = PROPS.slice();
  FRScreen.METHODS = METHODS.slice();

  /**
   * A canvas-2d-shaped recorder. Looks enough like a context that ordinary
   * drawing code works unchanged; records instead of rasterising.
   */
  FRScreen.context = function () {
    var ops = [];
    var ctx = {};

    METHODS.forEach(function (m) {
      ctx[m] = function () {
        ops.push([m].concat(Array.prototype.slice.call(arguments)));
        return ctx;
      };
    });

    PROPS.forEach(function (p) {
      var current = null;
      Object.defineProperty(ctx, p, {
        enumerable: true,
        get: function () { return current; },
        set: function (v) { current = v; ops.push(['=', p, v]); }
      });
    });

    /**
     * Approximate, and deliberately so.
     *
     * A browser measures with its own font engine and tvOS with CoreText, so the
     * same string is genuinely a different width on each. Any layout computed
     * from a real measureText would be subtly wrong on one of them. This returns
     * a consistent estimate everywhere — WRONG BY THE SAME AMOUNT on every
     * renderer, which is far more useful than being right on one.
     *
     * Use textAlign/textBaseline for real positioning; treat this as a hint.
     */
    ctx.measureText = function (s) {
      var size = parseFloat(String(ctx.font || '16px')) || 16;
      return { width: String(s == null ? '' : s).length * size * 0.55 };
    };

    /** The frame so far. */
    ctx.ops = function () { return ops; };
    /** Start a new frame. */
    ctx.reset = function () { ops.length = 0; return ctx; };
    /** Every string this frame would put on screen — the leak check reads this. */
    ctx.texts = function () {
      return ops.filter(function (o) { return o[0] === 'fillText'; })
                .map(function (o) { return String(o[1]); });
    };

    return ctx;
  };

  /* -------------------------------------------------------------- replay --- */

  /**
   * Replay a recorded frame onto a real CanvasRenderingContext2D.
   * Used by the Studio, an iPad and a phone acting as a screen. tvOS has its own
   * replayer in Swift, held to the same op list.
   */
  FRScreen.replay = function (ops, c2d) {
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op[0] === '=') { c2d[op[1]] = op[2]; continue; }
      // Degrade before skipping. roundRect is recent, and an older canvas that
      // lacks it should still get the shape — checking "is this op missing?"
      // first threw the rectangle away entirely.
      if (op[0] === 'roundRect' && typeof c2d.roundRect !== 'function') {
        if (typeof c2d.rect === 'function') c2d.rect(op[1], op[2], op[3], op[4]);
        continue;
      }
      var fn = c2d[op[0]];
      if (typeof fn !== 'function') continue;        // renderer predates an op
      fn.apply(c2d, op.slice(1));
    }
    return ops.length;
  };

  /* -------------------------------------------------------------- layout --- */

  /**
   * Screens are not one shape. A TV is 16:9 with overscan the edges of which may
   * be physically off the panel; an iPad is 4:3-ish and may be either way up; the
   * Studio frame is whatever we draw. So a screen view is given the REAL size and
   * a safe rectangle, and lays out responsively — rather than being handed a
   * fixed design resolution and letterboxed, which wastes an iPad and looks dated.
   *
   * @param {Object} env { width, height, safe:{top,right,bottom,left} }
   * @returns {Object} the usable rectangle plus the conveniences layout needs
   */
  FRScreen.box = function (env) {
    var s = env.safe || { top: 0, right: 0, bottom: 0, left: 0 };
    var x = s.left, y = s.top;
    var w = env.width - s.left - s.right;
    var h = env.height - s.top - s.bottom;
    return {
      x: x, y: y, w: w, h: h,
      right: x + w, bottom: y + h,
      cx: x + w / 2, cy: y + h / 2,
      /** Shorter edge — the right basis for text and padding so a 4:3 iPad and a
       *  16:9 TV feel the same rather than one looking enormous. */
      unit: Math.min(w, h),
      portrait: h > w,
      /** A fraction of the shorter edge, for sizes that should scale with the screen. */
      u: function (f) { return Math.min(w, h) * f; },
      /** Evenly spaced row centres — scoreboards, team lists, a Boggle grid. */
      rows: function (n, pad) {
        pad = pad || 0;
        var inner = h - pad * 2, step = inner / n, out = [];
        for (var i = 0; i < n; i++) out.push(y + pad + step * i + step / 2);
        return out;
      },
      cols: function (n, pad) {
        pad = pad || 0;
        var inner = w - pad * 2, step = inner / n, out = [];
        for (var i = 0; i < n; i++) out.push(x + pad + step * i + step / 2);
        return out;
      }
    };
  };

  /* ------------------------------------------------------------- motion --- */

  /* Easings. Small, pure, identical on every platform. */
  FRScreen.ease = {
    linear:    function (t) { return t; },
    inQuad:    function (t) { return t * t; },
    outQuad:   function (t) { return t * (2 - t); },
    inOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    outCubic:  function (t) { return (--t) * t * t + 1; },
    outBack:   function (t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    outElastic: function (t) {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
    }
  };

  /**
   * Keyed motion state. A screen redraws from scratch every frame, so anything
   * that moves needs somewhere to remember where it was — holding that per-key
   * here keeps the draw function a pure function of (state, time).
   */
  FRScreen.motion = function () {
    var values = {};     // key -> current, eased toward a target
    var pulses = {};     // key -> { at, last } a decaying 1->0 on change
    var parts = [];      // particles

    var api = {
      /**
       * Ease a number toward a target. Scores that tick up, bars that slide.
       * `rate` is roughly "fraction of the remaining gap per 16ms frame".
       */
      follow: function (key, target, rate, dt) {
        rate = rate == null ? 0.18 : rate;
        if (values[key] == null) { values[key] = target; return target; }
        var k = 1 - Math.pow(1 - rate, Math.max(0, dt || 16) / 16);
        values[key] += (target - values[key]) * k;
        if (Math.abs(target - values[key]) < 0.001) values[key] = target;
        return values[key];
      },

      /** Snap a followed value (a new round, a reset) without animating to it. */
      set: function (key, v) { values[key] = v; return v; },

      /**
       * 1 when `trigger` changes, decaying to 0 over `ms`. Flashes a team row
       * when it scores, thumps a timer when a second ticks.
       */
      pulse: function (key, trigger, now, ms) {
        ms = ms || 450;
        var p = pulses[key];
        if (!p) { pulses[key] = { last: trigger, at: -1e9 }; return 0; }
        if (p.last !== trigger) { p.last = trigger; p.at = now; }
        var age = now - p.at;
        return age >= ms ? 0 : 1 - age / ms;
      },

      /** Throw particles. Confetti on a win, sparks on a steal. */
      burst: function (x, y, opts) {
        opts = opts || {};
        var n = opts.count || 24;
        var rnd = opts.rng || Math.random;
        for (var i = 0; i < n; i++) {
          var a = rnd() * Math.PI * 2, sp = (opts.speed || 240) * (0.4 + rnd() * 0.6);
          parts.push({
            x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (opts.lift || 120),
            life: opts.life || 1200, age: 0,
            size: (opts.size || 10) * (0.5 + rnd()),
            color: (opts.colors || ['#ffd166', '#ef476f', '#06d6a0', '#118ab2'])[(rnd() * 4) | 0]
          });
        }
        return api;
      },

      /** Step and draw the particles. Call once per frame, after your board. */
      particles: function (ctx, dt, gravity) {
        var g = gravity == null ? 520 : gravity;
        var s = Math.max(0, dt || 16) / 1000;
        for (var i = parts.length - 1; i >= 0; i--) {
          var p = parts[i];
          p.age += dt;
          if (p.age >= p.life) { parts.splice(i, 1); continue; }
          p.vy += g * s; p.x += p.vx * s; p.y += p.vy * s;
          ctx.globalAlpha = 1 - p.age / p.life;
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        }
        ctx.globalAlpha = 1;
        return parts.length;
      },

      /** Particles currently alive — lets a test assert a celebration happened. */
      alive: function () { return parts.length; },
      clear: function () { values = {}; pulses = {}; parts.length = 0; return api; }
    };
    return api;
  };

  global.FRScreen = FRScreen;
  if (typeof module !== 'undefined' && module.exports) module.exports = FRScreen;
})(typeof window !== 'undefined' ? window : globalThis);
