/*
 * fr-feel — the Family Room "game feel" runtime.
 *
 * Injected by the harness alongside the Table SDK, so every game gets it for
 * free with zero bundle cost and it can be improved centrally. ONE copy lives
 * here in the dev kit; the iOS shell bundles this exact file and the Playtest
 * Studio loads it, the same single-source-of-truth arrangement as the games and
 * the conformance spec.
 *
 * It provides two things games kept re-implementing by hand:
 *
 *   1. A shared animation vocabulary as CSS (fr-pop / fr-shake / fr-flash /
 *      fr-glow / fr-blink / fr-deal) plus the base reset, safe-area padding,
 *      rounded system font and tabular numerals that all 11 games had copied.
 *
 *   2. `Table.feel(event, opts)` — semantic feedback that fires the RIGHT
 *      animation, haptic and sound together, so authors express intent
 *      ("this player busted") instead of wiring three APIs and remembering
 *      which pairing is correct.
 *
 * The critical property: feel() applies animations to LIVE NODES after render,
 * never as a class baked into a rendered HTML string. That is what stops
 * animations replaying on every re-render — the bug that needed 13 pieces of
 * hand-written bookkeeping in STREAK.
 */
(function (global) {
  'use strict';

  /*
   * PRECEDENCE: this stylesheet is injected at documentStart, so it lands BEFORE
   * a game's own <style> in document order. On equal specificity the game wins —
   * these are defaults a game may override freely (verified: a game's
   * `body{padding:env(top) 0 env(bottom)}` beats the four-inset rule below).
   */
  var CSS = [
    /* ---- base: what every game was copying ---- */
    '*,*::before,*::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
    'html,body{height:100%}',
    'body{margin:0;font-family:ui-rounded,-apple-system,system-ui,sans-serif;',
    '  -webkit-user-select:none;user-select:none;',
    '  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}',
    '.fr-num,[data-num]{font-variant-numeric:tabular-nums}',

    /* ---- one-shot: AN EVENT HAPPENED ---- */
    '.fr-pop{animation:fr-pop .32s ease-out}',
    '@keyframes fr-pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}',

    '.fr-shake{animation:fr-shake .45s ease-in-out}',
    '@keyframes fr-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}',
    '  40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}',

    '.fr-flash-good{animation:fr-flash-good .5s ease-out}',
    '@keyframes fr-flash-good{0%{box-shadow:0 0 0 0 rgba(90,220,140,.9)}100%{box-shadow:0 0 0 14px rgba(90,220,140,0)}}',

    '.fr-flash-bad{animation:fr-flash-bad .5s ease-out}',
    '@keyframes fr-flash-bad{0%{box-shadow:0 0 0 0 rgba(255,90,80,.9)}100%{box-shadow:0 0 0 14px rgba(255,90,80,0)}}',

    '.fr-flash-cool{animation:fr-flash-cool .5s ease-out}',
    '@keyframes fr-flash-cool{0%{box-shadow:0 0 0 0 rgba(120,180,255,.9)}100%{box-shadow:0 0 0 14px rgba(120,180,255,0)}}',

    '.fr-deal{animation:fr-pop .32s ease-out backwards}',   /* pair with animation-delay */

    /* ---- infinite: A STANDING INVITATION ---- */
    '.fr-glow{animation:fr-glow 2s ease-in-out infinite}',
    '@keyframes fr-glow{50%{filter:brightness(1.18)}}',

    '.fr-blink{animation:fr-blink .5s steps(2,end) infinite}',
    '@keyframes fr-blink{50%{opacity:.45}}',

    '@media (prefers-reduced-motion:reduce){',
    '  .fr-pop,.fr-shake,.fr-flash-good,.fr-flash-bad,.fr-flash-cool,.fr-deal,.fr-glow,.fr-blink{animation:none}',
    '}'
  ].join('\n');

  /* Each semantic event: the animation, the haptic, the sound.
     `strong` is used when the event happened to the LOCAL player — your own
     disaster should hit harder than someone else's, or a six-player table
     becomes a buzzing mess. */
  var EVENTS = {
    // good things
    gain:      { anim: 'fr-pop',        haptic: 'light',  sound: 'ding',  strongHaptic: 'medium' },
    win:       { anim: 'fr-pop',        haptic: 'success', sound: 'chime' },
    heal:      { anim: 'fr-flash-good', haptic: 'success', sound: 'ding' },

    // bad things
    bust:      { anim: 'fr-shake',      haptic: 'light',  sound: 'thud',  strongHaptic: 'error', strongSound: 'boom' },
    eliminate: { anim: 'fr-shake',      haptic: 'light',  sound: 'thud',  strongHaptic: 'error', strongSound: 'boom' },
    hit:       { anim: 'fr-flash-bad',  haptic: 'warning', sound: 'thud' },
    freeze:    { anim: 'fr-flash-cool', haptic: 'warning', sound: 'buzz' },
    blocked:   { anim: 'fr-shake',      haptic: 'warning', sound: 'buzz' },

    // neutral / movement
    arrive:    { anim: 'fr-pop',        haptic: 'light',  sound: 'pop' },
    pass:      { anim: null,            haptic: 'light',  sound: 'whoosh' },
    reveal:    { anim: 'fr-pop',        haptic: null,     sound: null },
    tick:      { anim: null,            haptic: 'light',  sound: 'tick' },
    countdown: { anim: null,            haptic: 'light',  sound: 'count', strongHaptic: 'heavy' },

    // standing states (infinite animations; call with {off:true} to clear)
    turn:      { anim: 'fr-glow',   persist: true, haptic: 'selection', sound: null },
    urgent:    { anim: 'fr-blink',  persist: true, haptic: null,        sound: null }
  };

  function styleInjected(doc) {
    return !!doc.getElementById('fr-feel-style');
  }

  function injectCSS(doc) {
    if (styleInjected(doc)) return;
    var el = doc.createElement('style');
    el.id = 'fr-feel-style';
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  function resolve(target, doc) {
    if (!target) return null;
    if (typeof target === 'string') return doc.querySelector(target);
    if (target.nodeType === 1) return target;
    return null;
  }

  /** One-shot animation that cleans up after itself, so it can be re-fired. */
  function playOnce(el, cls) {
    if (!el || !cls) return;
    el.classList.remove(cls);
    // force a reflow so re-adding restarts the animation
    void el.offsetWidth;
    el.classList.add(cls);
    var done = function () {
      el.classList.remove(cls);
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }

  function install(Table, doc) {
    doc = doc || global.document;
    injectCSS(doc);

    /**
     * Table.feel(event, opts) — semantic feedback.
     *
     *   event : one of Object.keys(Table.feel.events)
     *   opts  : { el, mine, silent, quiet, off, delay }
     *     el     element or CSS selector to animate (optional). NOTE a selector
     *            string is resolved against `document`, not your render root —
     *            fine because a game owns the whole document, but pass the
     *            element itself if your selector could match more than once.
     *     mine   true if this happened to the LOCAL player -> stronger feedback
     *     silent skip the sound
     *     quiet  skip the haptic
     *     off    for persistent events (turn/urgent): remove the state
     *     delay  ms of animation-delay, for staggering a dealt hand
     */
    Table.feel = function (event, opts) {
      opts = opts || {};
      var spec = EVENTS[event];
      if (!spec) return;
      var el = resolve(opts.el, doc);

      if (spec.persist) {
        if (el) {
          if (opts.off) el.classList.remove(spec.anim);
          else el.classList.add(spec.anim);
        }
        if (opts.off) return;                  // clearing a state is silent
      } else if (el && spec.anim) {
        if (opts.delay) {
          el.style.animationDelay = opts.delay + 'ms';
        }
        playOnce(el, spec.anim);
      }

      var haptic = (opts.mine && spec.strongHaptic) || spec.haptic;
      var sound  = (opts.mine && spec.strongSound)  || spec.sound;
      try { if (haptic && !opts.quiet && Table.haptic) Table.haptic(haptic); } catch (e) {}
      try { if (sound && !opts.silent && Table.sound) Table.sound(sound); } catch (e) {}
    };

    Table.feel.events = Object.keys(EVENTS);

    /** Stagger a freshly dealt set: Table.feel.deal(nodes) */
    Table.feel.deal = function (nodes, step) {
      step = step || 45;
      Array.prototype.forEach.call(nodes || [], function (el, i) {
        el.style.animationDelay = (i * step) + 'ms';
        playOnce(el, 'fr-deal');
      });
    };

    return Table;
  }

  global.__frFeel = { install: install, CSS: CSS, EVENTS: EVENTS };

  // Auto-install when a Table already exists (native injects the SDK first).
  if (global.Table && !global.Table.feel) {
    try { install(global.Table, global.document); } catch (e) {}
  }
})(typeof window !== 'undefined' ? window : globalThis);
