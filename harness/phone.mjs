#!/usr/bin/env node
/*
 * phone.mjs — every phone, every screen it reaches, laid out by a real browser engine.
 *
 *   node harness/phone.mjs holdem
 *   node harness/phone.mjs --all
 *   node harness/phone.mjs holdem --shots out/       # also save screenshots, for a human
 *
 * The playtest proves a game's rules and its wiring. It cannot tell you that the Deal
 * button is below the bottom of an iPhone SE, that a name like "Christopher" pushes the
 * chip count off the right edge, or that the banner sits on top of the pot — its DOM is
 * a regex. Those are the bugs a room finds in the first minute of game night, and the
 * shared-screen harness only ever looked at the TV.
 *
 * So: play the game headless exactly as the playtest does, and record each phone's
 * whole life — every message it was handed, every pause, in order, with the virtual
 * time and the count of its own timer callbacks at each one. Then rebuild that phone,
 * event for event, in WebKit (the engine inside every iPhone's WKWebView): the real
 * bundle, the real SDK, the same seed, on the same virtual clock. At every moment the
 * playtest looked at the table, measure the real layout:
 *
 *   sideways      the page is wider than the phone
 *   off the edge  text or a control cut off by the left or right edge
 *   below fold    a control the player needs is under the bottom of the screen
 *   home bar      text or a control under the home indicator
 *   clipped       text cut off by its own box or a container (an ellipsis is a choice;
 *                 a word sliced in half is not)
 *   overlap       two different pieces of text drawn on top of each other
 *   tap target    a control smaller than 44×44pt — a thumb is not a cursor
 *   blank         nothing on the screen at all
 *
 * The phone rebuilt in the browser must also SAY exactly what the headless phone said,
 * message for message. That is the check on the replay itself — and on the game: a
 * bundle that behaves differently in WebKit than under node is a bundle whose headless
 * tests were testing something else.
 *
 * Phones are measured at the size the GAME gets, not the size of the glass: the shell
 * puts a 44pt bar above the game and lets it run under the home indicator, so an
 * iPhone SE's game is 375×603 with no bottom inset and an iPhone 17's is 402×768 with
 * 34pt it must keep clear. iPads play in either orientation.
 *
 * Needs a browser: `npm ci && npx playwright-core install webkit` once. Everything else
 * in the dev kit is plain node; this is the one check that cannot be, because the
 * question it answers is "what does a browser engine do with this layout".
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGame, REPO, loadBundle, defaultScreens, scrubClocks, SHELL_TEAMS } from './runner.mjs';
import { playOne } from './playtest.mjs';

const SAMPLES = join(REPO, 'playtest/samples');

/* The game's viewport on each device: glass minus the status bar minus the shell's
 * 44pt chrome bar, home indicator inset kept. iPhones are portrait-only (the app's
 * Info.plist); iPads rotate. */
export const SHAPES = [
  { key: 'se',     name: 'iPhone SE',          width: 375,  height: 603,  insets: { top: 0, bottom: 0 },  dpr: 2 },
  { key: 'mini',   name: 'iPhone 13 mini',     width: 375,  height: 718,  insets: { top: 0, bottom: 34 }, dpr: 3 },
  { key: 'i17',    name: 'iPhone 17',          width: 402,  height: 768,  insets: { top: 0, bottom: 34 }, dpr: 3 },
  { key: 'max',    name: 'iPhone 17 Pro Max',  width: 440,  height: 850,  insets: { top: 0, bottom: 34 }, dpr: 3 },
  { key: 'ipadp',  name: 'iPad portrait',      width: 820,  height: 1112, insets: { top: 0, bottom: 20 }, dpr: 2 },
  { key: 'ipadl',  name: 'iPad landscape',     width: 1180, height: 752,  insets: { top: 0, bottom: 20 }, dpr: 2 }
];

/* Names people actually type. The playtest's Ava/Ben/Cal fit anywhere; "Christopher"
 * is the one that finds the layout that doesn't. */
const LONG_ROSTER = [
  ['Alexandra', '🦊'], ['Christopher', '🐙'], ['Emmanuelle', '🐸'], ['Bartholomew', '🦉'],
  ['Georgina', '🐝'], ['Maximilian', '🦄'], ['Anastasia', '🐳'], ['Hal', '🦁']
];

/* -------------------------------------------------------------- recording --- */

/**
 * Play one game headless and return each phone's recorded life. It is driven by the
 * playtest's own player (playOne) — declared moves, the bundle's bot, the screen
 * clicked where a game declares nothing, one player pressing real controls — so every
 * screen the fuzzer reaches is a screen measured here, and a game the playtest can
 * drive is never left sitting on its first screen. Honest play: the question is what
 * real players see. Sometimes a player walks out, so "you're out" gets drawn too.
 */
async function record(dir, { seed, players, screens, leave, ui, bot }) {
  const { manifest } = loadBundle(dir);
  const lo = manifest.minPlayers || 1, hi = Math.min(8, manifest.maxPlayers || 8);
  const n = Math.max(lo, Math.min(hi, players));
  const teamIds = manifest.teams === 'required' ? SHELL_TEAMS.slice(0, 2).map(t => t.id) : null;
  const roster = LONG_ROSTER.slice(0, n).map(([name, emoji], i) => ({
    id: 'p' + i, name, emoji, teamId: teamIds ? teamIds[i % 2] : undefined }));
  const phase = (table) => {
    for (const id of table.players) {
      const v = table.view(id);
      if (v && v.s && v.s.phase) return v.s.phase;
    }
    return '';
  };
  let table = null;
  await playOne(dir, {
    seed, players: roster, screens, leave, ui, bot, maxTurns: 700,
    onBoot: (t) => { table = t; t.sample(`start · ${phase(t)}`); },
    observe: ({ table: t, turn }) => { t.sample(`turn ${turn} · ${phase(t)}`); return null; }
  });
  // The ending as each phone draws it, after the game's own settling beat.
  table.advance(2000);
  table.sample(`end · ${phase(table)}`);
  return {
    manifest, players: n, screens,
    phones: table.players.map(id => table.phoneRecord(id)).filter(p => p && p.generation === 0)
  };
}

/* ---------------------------------------------------------------- the page --- */

const SDK = () => ({
  table: readFileSync(join(REPO, 'sdk/table-sdk.js'), 'utf8'),
  feel: readFileSync(join(REPO, 'sdk/fr-feel.js'), 'utf8'),
  game: readFileSync(join(REPO, 'sdk/fr-game.js'), 'utf8')
});

/** CSS `env(safe-area-inset-*)` as this device would resolve it. Headless browsers
 *  report every inset as 0, which is how content ends up under the home indicator
 *  with every test green. */
function withInsets(text, insets) {
  return text.replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g,
    (_, side) => (insets[side] || 0) + 'px');
}

/**
 * Everything the page needs before the bundle's first script: a virtual clock in
 * place of the real one, the SDK booted as THIS phone, FR, and a measuring kit.
 * This is the browser twin of what runner.mjs builds in a vm context.
 */
function prelude(cfg, sdk) {
  return `
(function(){
  'use strict';
  /* ---- the virtual clock: same algorithm, same tie-breaking, as runner.mjs ---- */
  var now = 0, seq = 0, started = 0, jobs = new Map(), EPOCH = 1755000000000;
  function setT(fn, ms){ var id = ++seq; jobs.set(id, { at: now + (ms || 0), fn: fn, every: 0 }); return id; }
  function setI(fn, ms){ var id = ++seq, d = Math.max(1, ms || 1); jobs.set(id, { at: now + d, fn: fn, every: d }); return id; }
  function clr(id){ jobs.delete(id); }
  window.setTimeout = setT; window.setInterval = setI; window.clearTimeout = clr; window.clearInterval = clr;
  window.requestAnimationFrame = function(fn){ return setT(function(){ fn(now); }, 16); };
  window.cancelAnimationFrame = clr;
  var RealDate = Date;
  function VDate(){ var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof VDate)) return new RealDate(EPOCH + now).toString();
    return a.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(a)))() : new RealDate(EPOCH + now); }
  VDate.now = function(){ return EPOCH + now; }; VDate.parse = RealDate.parse; VDate.UTC = RealDate.UTC;
  VDate.prototype = RealDate.prototype;
  window.Date = VDate;
  try { Object.defineProperty(performance, 'now', { value: function(){ return now; }, configurable: true }); } catch (e) {}
  function fireOne(limit){
    var next = null;
    jobs.forEach(function(j, id){ if (!next || j.at < next[1].at) next = [id, j]; });
    if (!next) return 'none';
    if (next[1].at > limit) return 'late';
    var id = next[0], job = next[1];
    now = job.at;
    if (job.every) job.at = now + job.every; else jobs.delete(id);
    started++;
    job.fn();
    return 'ok';
  }
  window.__frClock = {
    get now(){ return now; }, get started(){ return started; }, get armed(){ return jobs.size; },
    /** Run this phone's own timers until \`want\` have started, none due after t. */
    until: function(want, t){
      var guard = 0;
      while (started < want) {
        var r = fireOne(t);
        if (r !== 'ok') return 'the replay expected timer #' + want + ' by ' + t + 'ms and the page had ' + (r === 'none' ? 'none armed' : 'none due');
        if (++guard > 500000) return 'virtual clock livelock';
      }
      if (t > now) now = t;
      return null;
    }
  };

  /* ---- what a thumb can press ---- */
  var PRESS = { click: 1, pointerdown: 1, pointerup: 1, touchstart: 1, touchend: 1, mousedown: 1 };
  var add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts){
    if (PRESS[type] && this.nodeType === 1) {
      this.__frPress = true;
      // The headless shim presses the FIRST press handler a node got (or its
      // onclick); a replayed press must call the same one, not fire every event.
      if (!this.__frFirstPress && typeof fn === 'function') this.__frFirstPress = fn;
    }
    return add.call(this, type, fn, opts);
  };
  /* Animations are measured at rest: a card mid-deal is translated off its spot. */
  if (Element.prototype.animate) {
    var anim = Element.prototype.animate;
    Element.prototype.animate = function(){ var a = anim.apply(this, arguments); try { a.finish(); } catch (e) {} return a; };
  }
  var still = document.createElement('style');
  still.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
  (document.head || document.documentElement).appendChild(still);
})();
${sdk.table}
(function(){
  var cfg = ${JSON.stringify(cfg)};
  var clone = function(v){ return v === undefined ? null : JSON.parse(JSON.stringify(v)); };
  var OUT = window.__frOut = [];
  var ERR = window.__frErrors = [];
  var clock = window.__frTable.installTimerShim(window);
  window.__tableSetPaused = clock.setPaused;
  cfg.clock = clock;
  /* The host's own game hears its own sends and its own sendTo LATER, as a task of
   * their own (TableBridge loops them back through evaluateJavaScript; runner.mjs
   * queues them). The recording has each one, marked self, at the moment it landed,
   * and the replay delivers it there — never inside the call that sent it. */
  window.Table = window.__frTable.create(cfg, {
    send: function(p){ OUT.push({ kind: 'send', payload: clone(p) }); },
    broadcast: function(p){ OUT.push({ kind: 'broadcast', payload: clone(p) }); },
    sendTo: function(to, p){ OUT.push({ kind: 'sendTo', to: to, payload: clone(p) }); },
    endGame: function(r){ OUT.push({ kind: 'endGame', payload: clone(r) }); },
    saveState: function(){}, haptic: function(){}, sound: function(){},
    error: function(m){ ERR.push(String(m)); }
  }, window);
})();
${sdk.feel}
window.__frFeel.install(window.Table, document);
${sdk.game}
${MEASURE}
`;
}

/* The measuring kit, run inside the page. Kept as source because it executes there. */
const MEASURE = String.raw`
(function(){
  'use strict';
  var state = null;

  function ownText(el){
    var s = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue;
    return s.replace(/\s+/g, ' ').trim();
  }
  /* The box the element's content is actually visible in: its own box if it clips,
   * intersected with every clipping ancestor's. A Range reports the whole laid-out
   * text even where an overflow:hidden box (an ellipsis, a scroller) hides it, so
   * measuring raw text rects reported every deliberately truncated name as running
   * off the screen and into its neighbours. */
  function clipBox(el){
    var box = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
    for (var e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      var c = getComputedStyle(e);
      // Only boxes that HIDE what overflows. A scroller hides it too, but that is
      // not a choice the player can live with — see the scroll check below.
      var cx = /hidden|clip/.test(c.overflowX), cy = /hidden|clip/.test(c.overflowY);
      if (!cx && !cy) continue;
      var r = e.getBoundingClientRect();
      if (cx) { box.left = Math.max(box.left, r.left); box.right = Math.min(box.right, r.right); }
      if (cy) { box.top = Math.max(box.top, r.top); box.bottom = Math.min(box.bottom, r.bottom); }
    }
    return box;
  }
  function rawTextRects(el){
    var out = [], range = document.createRange();
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      range.selectNodeContents(n);
      var rs = range.getClientRects();
      for (var i = 0; i < rs.length; i++) if (rs[i].width > 0.5 && rs[i].height > 0.5) out.push(rs[i]);
    }
    return out;
  }
  function clipRects(rs, box){
    var out = [];
    for (var i = 0; i < rs.length; i++) {
      var l = Math.max(rs[i].left, box.left), t = Math.max(rs[i].top, box.top);
      var r = Math.min(rs[i].right, box.right), b = Math.min(rs[i].bottom, box.bottom);
      if (r - l > 0.5 && b - t > 0.5) out.push({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
    }
    return out;
  }
  function label(el){
    var t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (t.length > 40) t = t.slice(0, 37) + '…';
    return t;
  }
  function path(el){
    var parts = [];
    for (var e = el; e && e.nodeType === 1 && e !== document.body && parts.length < 4; e = e.parentElement) {
      var p = e.tagName.toLowerCase();
      if (e.id) p += '#' + e.id;
      if (typeof e.className === 'string' && e.className.trim()) p += '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  }
  function sig(el){ return path(el) + '|' + label(el).replace(/\d+/g, '#'); }
  function interactive(el){
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return el.type !== 'hidden';
    if (tag === 'A' && el.hasAttribute('href')) return true;
    return !!(el.onclick || el.__frPress || el.hasAttribute('data-act') || el.getAttribute('role') === 'button');
  }
  function visible(el, cs){
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    var o = 1;
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var c = e === el ? cs : getComputedStyle(e);
      if (c.display === 'none') return false;
      o *= parseFloat(c.opacity);
      if (o < 0.06) return false;
    }
    return true;
  }
  /** The nearest ancestor that scrolls and actually has something to scroll. */
  function scroller(el){
    for (var e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      var c = getComputedStyle(e);
      var sx = /auto|scroll/.test(c.overflowX) && e.scrollWidth > e.clientWidth + 1;
      var sy = /auto|scroll/.test(c.overflowY) && e.scrollHeight > e.clientHeight + 1;
      if (sx || sy) return e;
    }
    return null;
  }
  function hash(s){ var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

  function measure(shape, at, problems){
    var W = window.innerWidth, H = window.innerHeight, inset = (shape.insets && shape.insets.bottom) || 0;
    var found = function(kind, el, msg){
      var key = kind + '|' + sig(el);
      if (!problems[key]) problems[key] = { kind: kind, msg: msg, at: at, where: path(el), sample: state.sample };
    };
    var root = document.scrollingElement || document.documentElement;
    if (root.scrollWidth > W + 1) {
      found('sideways', document.body, 'the page is ' + (root.scrollWidth - W) + 'pt wider than the screen, so it scrolls sideways');
    }
    // NOTHING SCROLLS. A party game is played at a glance, mid-conversation, with one
    // thumb: a screen that needs scrolling is a screen where the thing you needed was
    // somewhere you weren't looking.
    if (root.scrollHeight > H + 1) {
      found('scroll', document.body, 'the page is ' + (root.scrollHeight - H) + 'pt taller than the screen, so the player has to scroll');
    }
    var texts = [], controls = [], any = false;
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      var cs = getComputedStyle(el);
      if (!visible(el, cs)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var own = ownText(el), ctl = interactive(el);
      if (own) {
        var raw = rawTextRects(el), cb = clipBox(el);
        texts.push({ el: el, r: r, cs: cs, text: own, raw: raw, rects: clipRects(raw, cb), clip: cb });
        any = true;
      }
      if (ctl) { controls.push({ el: el, r: r, cs: cs }); any = true; }
      else if (el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'SVG') any = true;
    }
    if (!any) found('blank', document.body, 'the screen shows nothing at all');
    // The most crowded screen this phone showed — the one a human most wants to see.
    var fill = texts.length + controls.length;
    if (!state.busiest || fill > state.busiest.fill) state.busiest = { fill: fill, sample: state.sample, at: at };

    var things = texts.map(function(t){ return { el: t.el, r: t.rects.length ? union(t.rects) : t.r, name: '"' + t.text.slice(0, 40) + '"', text: true }; })
      .concat(controls.map(function(c){
        var v = clipRects([c.r], clipBox(c.el.parentElement || c.el));
        return { el: c.el, r: v.length ? v[0] : c.r, name: 'the "' + (label(c.el) || c.el.tagName.toLowerCase()) + '" control', ctl: true }; }));

    for (var k = 0; k < things.length; k++) {
      var th = things[k], rr = th.r;
      var big = rr.width * rr.height > 0.45 * W * H;
      // Inside a scrolling area and not all in view: the player has to scroll for it.
      var sc = scroller(th.el);
      if (sc) {
        var sr = sc.getBoundingClientRect();
        if (rr.top < sr.top - 1 || rr.bottom > sr.bottom + 1 || rr.left < sr.left - 1 || rr.right > sr.right + 1) {
          found('scroll', th.el, th.name + ' is out of view inside a scrolling area (' + path(sc).split(' > ').pop() + ') — the player has to scroll to see it');
          continue;
        }
      }
      if (rr.right > W + 1 || rr.left < -1) {
        var past = rr.right > W + 1 ? Math.round(rr.right - W) : Math.round(-rr.left);
        found('edge', th.el, th.name + ' is cut off by the ' + (rr.right > W + 1 ? 'right' : 'left') + ' edge (' + past + 'pt past it)');
        continue;
      }
      if (big) continue;
      if (rr.top >= H - 1) {
        found(th.ctl ? 'fold' : 'fold-text', th.el, th.name + ' is below the bottom of the screen — the player has to scroll to find it');
      } else if (rr.bottom > H + 1) {
        found(th.ctl ? 'fold' : 'fold-text', th.el, th.name + ' is cut off by the bottom of the screen');
      } else if (inset && rr.bottom > H - inset + 1) {
        found('homebar', th.el, th.name + ' is under the home indicator (the bottom ' + inset + 'pt)');
      }
    }

    // Clipped text: by its own box (unless it ends in an ellipsis), or by a container.
    for (var t = 0; t < texts.length; t++) {
      var tx = texts[t];
      if (!tx.raw.length) continue;
      var box = union(tx.raw);
      var ov = tx.cs.overflowX + ' ' + tx.cs.overflowY;
      // An ellipsis or a line clamp is truncation the author chose; a word sliced is not.
      var chosen = tx.cs.textOverflow === 'ellipsis' || (tx.cs.webkitLineClamp && tx.cs.webkitLineClamp !== 'none');
      if (/hidden|clip/.test(ov) && !chosen
          && (tx.el.scrollWidth > tx.el.clientWidth + 1 || tx.el.scrollHeight > tx.el.clientHeight + 2)) {
        found('clipped', tx.el, '"' + tx.text.slice(0, 40) + '" is cut off inside its own box');
        continue;
      }
      for (var a = tx.el.parentElement; a && a !== document.body; a = a.parentElement) {
        var acs = getComputedStyle(a);
        var cx = /hidden|clip/.test(acs.overflowX), cy = /hidden|clip/.test(acs.overflowY);
        if (!cx && !cy) continue;
        var ar = a.getBoundingClientRect();
        var outX = cx && (box.left < ar.left - 1 || box.right > ar.right + 1);
        var outY = cy && (box.top < ar.top - 1 || box.bottom > ar.bottom + 1);
        // Inside a scroller, out of view is reachable, not cut; with an ellipsis it is a
        // choice the author made.
        if ((outX || outY) && acs.textOverflow !== 'ellipsis' && tx.cs.textOverflow !== 'ellipsis') {
          found('clipped', tx.el, '"' + tx.text.slice(0, 40) + '" is cut off by its container (' + path(a).split(' > ').pop() + ')');
          break;
        }
      }
    }

    // Text on text. Two different strings whose glyphs share real area, where neither
    // is hidden under something else, is a collision nobody drew on purpose.
    for (var x = 0; x < texts.length; x++) {
      for (var y = x + 1; y < texts.length; y++) {
        var A = texts[x], B = texts[y];
        if (A.text === B.text) continue;
        var hit = overlap(A.rects, B.rects);
        if (!hit || covered(A.el, B.el, hit)) continue;
        found('overlap', A.el, '"' + A.text.slice(0, 30) + '" and "' + B.text.slice(0, 30) + '" are drawn on top of each other');
      }
    }

    // A thumb is not a cursor.
    for (var c = 0; c < controls.length; c++) {
      var cr = controls[c].r;
      if (cr.width * cr.height > 0.45 * W * H) continue;
      if (cr.height < 43.5 || cr.width < 43.5) {
        found('target', controls[c].el, 'the "' + (label(controls[c].el) || controls[c].el.tagName.toLowerCase()) + '" control is '
          + Math.round(cr.width) + '×' + Math.round(cr.height) + 'pt — a thumb needs 44×44');
      }
    }
  }
  /* THE CURTAIN. A round-over sheet is an opaque panel over the board with its own
   * text on top; the board's text underneath is hidden, not colliding. Walk the stack
   * of elements at the point where the two texts meet: if something opaque sits above
   * the lower one — the upper text's own panel, or anything else — nobody can see the
   * lower one, and that is not a collision. */
  function opaque(el){
    var c = getComputedStyle(el);
    if (c.backgroundImage && c.backgroundImage !== 'none') return true;
    var m = /rgba?\(([^)]+)\)/.exec(c.backgroundColor);
    if (!m) return false;
    var parts = m[1].split(',').map(function(x){ return parseFloat(x); });
    return (parts.length < 4 ? 1 : parts[3]) * parseFloat(c.opacity) >= 0.85;
  }
  function covered(a, b, hit){
    var stack = document.elementsFromPoint(hit.cx, hit.cy);
    var ia = -1, ib = -1;
    for (var i = 0; i < stack.length; i++) {
      if (ia < 0 && (stack[i] === a || a.contains(stack[i]))) ia = i;
      if (ib < 0 && (stack[i] === b || b.contains(stack[i]))) ib = i;
    }
    if (ia < 0 || ib < 0) return true;              // one of them isn't visible there at all
    var upper = Math.min(ia, ib), lower = Math.max(ia, ib);
    var low = stack[lower];
    for (var j = upper; j < lower; j++) {
      var e = stack[j];
      if (e.contains(low)) continue;                 // an ancestor of the lower text is not above it
      if (opaque(e)) return true;
    }
    return false;
  }
  function union(rs){
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (var i = 0; i < rs.length; i++) { l = Math.min(l, rs[i].left); t = Math.min(t, rs[i].top); r = Math.max(r, rs[i].right); b = Math.max(b, rs[i].bottom); }
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }
  function overlap(as, bs){
    for (var i = 0; i < as.length; i++) for (var j = 0; j < bs.length; j++) {
      var a = as[i], b = bs[j];
      var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox <= 2 || oy <= 2) continue;
      if (ox * oy < 0.2 * Math.min(a.width * a.height, b.width * b.height)) continue;
      return { cx: Math.max(a.left, b.left) + ox / 2, cy: Math.max(a.top, b.top) + oy / 2 };
    }
    return null;
  }

  /** The element the headless phone pressed. A control the page declared and the
   *  game fetched by id is found by its id (the shim knows nothing of its tag);
   *  anything rendered is found by tag and attributes, with its text — which the
   *  shim's regex reads imperfectly inside nested markup — only to break a tie. */
  function findPressed(a){
    if (a.id) return document.getElementById(a.id);
    var norm = function(t){ var d = document.createElement('div'); d.innerHTML = t; return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
    var want = norm(a.text);
    var hits = [];
    var all = document.getElementsByTagName(a.tag);
    for (var i = 0; i < all.length; i++) {
      var el = all[i], ok = true;
      for (var k in a.attrs) {
        if (k === 'class') {
          var cls = String(a.attrs[k]).split(/\s+/).filter(Boolean);
          for (var c = 0; c < cls.length; c++) if (!el.classList.contains(cls[c])) { ok = false; break; }
        } else if (k !== 'style' && el.getAttribute(k) !== a.attrs[k]) ok = false;
        if (!ok) break;
      }
      if (ok && a.root && !(el.onclick || el.__frFirstPress)) ok = false;
      if (ok) hits.push(el);
    }
    if (hits.length > 1 && want) {
      var exact = hits.filter(function(el){ return (el.textContent || '').replace(/\s+/g, ' ').trim() === want; });
      var starts = hits.filter(function(el){ return (el.textContent || '').replace(/\s+/g, ' ').trim().indexOf(want) === 0; });
      hits = exact.length ? exact : (starts.length ? starts : hits);
    }
    return hits[a.nth] || hits[0] || null;
  }

  window.__frReplay = {
    begin: function(timeline, shape){
      state = { timeline: timeline, shape: shape, i: 0, sample: -1, problems: {}, measured: 0, lastSig: null, errors: [], phases: [] };
    },
    /** Replay up to and including sample number \`stop\` (Infinity for the lot). */
    advance: function(stop){
      var tl = state.timeline;
      if (state.sample >= stop) return { done: state.i >= tl.length, sample: state.sample, measured: state.measured };
      while (state.i < tl.length) {
        var e = tl[state.i];
        var late = window.__frClock.until(e.seq, e.t);
        if (late) { state.errors.push('replay diverged: ' + late); state.i = tl.length; break; }
        state.i++;
        if (e.ev === 'sample') {
          state.sample++;
          var ph = String(e.a || '').split(' · ')[1] || '';
          if (ph && state.phases.indexOf(ph) === -1) state.phases.push(ph);
          var s = hash(document.body.innerHTML + '|' + document.body.className + '|' + (document.getElementById('app') || document.body).className);
          if (s !== state.lastSig) { state.lastSig = s; state.measured++; measure(state.shape, e.a, state.problems); }
          if (state.sample >= stop) break;
          continue;
        }
        if (e.ev === 'press') {
          var target = findPressed(e.a);
          if (!target) { state.errors.push('replay diverged: could not find the pressed control "' + e.a.text + '" (' + e.a.tag + ' ' + JSON.stringify(e.a.attrs) + ')'); state.i = tl.length; break; }
          var fn = target.onclick || target.__frFirstPress;
          try { if (fn) fn.call(target, { type: 'click', target: target, currentTarget: target, preventDefault: function(){}, stopPropagation: function(){} }); }
          catch (err) { state.errors.push('pressing "' + e.a.text + '" threw: ' + (err && err.message)); }
          continue;
        }
        try {
          if (e.ev === 'pause') window.__tableSetPaused(!!e.a);
          else window.__tableFire(e.ev, e.a, e.b);
        } catch (err) { state.errors.push(e.ev + ' threw: ' + (err && err.message)); }
      }
      return { done: state.i >= tl.length, sample: state.sample, measured: state.measured };
    },
    result: function(){
      return { problems: Object.keys(state.problems).map(function(k){ return state.problems[k]; }),
               measured: state.measured, samples: state.sample + 1, phases: state.phases, busiest: state.busiest,
               errors: state.errors.concat(window.__frErrors), out: window.__frOut };
    },
    /** Outline what a problem points at, for a screenshot a human can read. */
    outline: function(where){
      document.querySelectorAll('[data-fr-outline]').forEach(function(e){ e.style.outline = ''; e.removeAttribute('data-fr-outline'); });
      var all = document.body.getElementsByTagName('*');
      for (var i = 0; i < all.length; i++) if (path(all[i]) === where) {
        all[i].style.outline = '3px solid #ff2d55'; all[i].style.outlineOffset = '-1px';
        all[i].setAttribute('data-fr-outline', '1');
      }
    }
  };
})();
`;

/* ------------------------------------------------------------------ driving --- */

/**
 * Which engines to try, in order. WebKit — the engine inside every iPhone's WKWebView —
 * and nothing else unless asked for by name (`FR_BROWSER=chromium`). This used to fall
 * back to Chromium whenever WebKit would not launch, silently: a machine with a broken
 * WebKit install measured every phone in the wrong engine and reported "fits" — the
 * engine's name was printed only under --verbose.
 */
export function engineOrder(env = process.env) {
  return env.FR_BROWSER ? [env.FR_BROWSER] : ['webkit'];
}

let pw = null;
async function browser() {
  if (pw) return pw;
  let lib;
  try { lib = await import('playwright-core'); }
  catch (e) {
    throw new Error('the phone layout check needs a browser engine. Install it once:\n'
      + '        npm ci && npx playwright-core install webkit');
  }
  const engines = engineOrder();
  let last;
  for (const name of engines) {
    try { pw = { b: await lib[name].launch(), name }; return pw; } catch (e) { last = e; }
  }
  throw new Error('no browser engine would launch (' + String(last && last.message).split('\n')[0] + ').\n'
    + '        Install one with: npx playwright-core install webkit');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };

/** Open one phone in one shape and return its page, ready to replay. */
async function openPhone(context, dir, bundle, phone, shape, sdk) {
  const page = await context.newPage();
  const base = `http://fr.local/${shape.key}/${phone.id}/`;
  await page.route('http://fr.local/**', async (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname.split('/').slice(3).join('/')) || bundle.entry;
    if (rel === bundle.entry) {
      let html = withInsets(bundle.entryHTML, shape.insets).replace('<!--__TABLE_SDK__-->', '');
      const boot = '<script>' + prelude(phone.cfg, sdk).replace(/<\/script/gi, '<\\/script') + '</script>';
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + boot) : boot + html;
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
    if (/text|javascript|json|svg/.test(type)) {
      return route.fulfill({ status: 200, contentType: type, body: withInsets(readFileSync(file, 'utf8'), shape.insets) });
    }
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
  });
  await page.goto(base + bundle.entry, { waitUntil: 'load' });
  await page.evaluate(([tl, sh]) => window.__frReplay.begin(tl, sh), [phone.timeline, shape]);
  return page;
}

/** What a phone said, as a comparable list. Clock readings are scrubbed by name:
 * a 250ms tick fires a different number of times under WebKit than headless, so
 * FR.clock's `now`/`deadline`/`*Ends` fields legitimately differ while the game
 * logic — and the layout being measured — is identical. */
const said = (out) => JSON.stringify(out.map(o => [o.kind, o.to || '', scrubClocks(o.payload)]));

/**
 * Check every phone of one bundle at every shape.
 * @returns {{failures:Array, measured:number, phases:Array, runs:number, engine:string}}
 */
export async function checkPhones(gameKey, { seed = 1, shapes = SHAPES, shots = null, verbose = false, runs: runList = null } = {}) {
  const dir = gameKey.includes('/') ? gameKey : join(SAMPLES, gameKey);
  const bundle = loadBundle(dir);
  const { manifest } = bundle;
  let bot = null;
  if (existsSync(join(dir, 'bot.mjs'))) bot = (await import(pathToFileURL(join(dir, 'bot.mjs')).href)).default;
  let extra = [];
  if (existsSync(join(dir, 'phone-states.mjs'))) extra = (await import(pathToFileURL(join(dir, 'phone-states.mjs')).href)).default || [];

  const hi = Math.min(8, manifest.maxPlayers || 8), lo = Math.max(manifest.minPlayers || 1, 2);
  const screenModes = manifest.screen === 'optional' ? [0, 1] : [defaultScreens(manifest)];
  // A full table (the tightest layout), a small one, and — when the game can run
  // either way — the full table again with the other screen setting.
  const runs = runList || [
    { seed, players: hi, screens: screenModes[0], leave: true, ui: true },
    { seed: seed + 1, players: Math.min(hi, Math.max(lo, 3)), screens: screenModes[0], leave: false, ui: true },
    ...screenModes.slice(1).map(sc => ({ seed: seed + 2, players: hi, screens: sc, leave: false }))
  ];

  const { b, name: engine } = await browser();
  const sdk = SDK();
  const failures = [];
  const seen = new Set();
  const phases = new Set();
  let measured = 0;

  for (const run of runs) {
    const rec = await record(dir, { ...run, bot });
    // Each phone is replayed at each shape; several at once.
    const jobs = [];
    for (const phone of rec.phones) for (const shape of shapes) jobs.push({ phone, shape });
    const ctxs = new Map();
    const contextFor = async (shape) => {
      if (!ctxs.has(shape.key)) {
        ctxs.set(shape.key, await b.newContext({ viewport: { width: shape.width, height: shape.height },
          deviceScaleFactor: shots ? shape.dpr : 1, hasTouch: true, isMobile: engine === 'chromium' }));
      }
      return ctxs.get(shape.key);
    };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const { phone, shape } = jobs[next++];
        const ctx = await contextFor(shape);
        let page;
        try {
          page = await openPhone(ctx, dir, bundle, phone, shape, sdk);
          await page.evaluate(() => window.__frReplay.advance(Infinity));
          const res = await page.evaluate(() => window.__frReplay.result());
          measured += res.measured;
          if (res.busiest) (phone.busiest || (phone.busiest = {}))[shape.key] = res.busiest.sample;
          res.phases.forEach(p => phases.add(p));
          const tag = `${shape.name}, ${run.players} players${manifest.screen === 'optional' ? (run.screens ? ', TV on' : ', no TV') : ''}, ${phone.isHost ? 'host' : 'player'} ${phone.id}`;
          const where = { players: run.players, screens: run.screens, seed: run.seed, phone: phone.id, shape: shape.key };
          if (res.errors.length) {
            failures.push({ ...where, kind: 'throw', why: `${tag}: ${res.errors[0]}` });
          } else if (said(res.out) !== said(phone.outbox)) {
            const a = res.out, w = phone.outbox;
            let i = 0; while (i < a.length && i < w.length && said([a[i]]) === said([w[i]])) i++;
            failures.push({ ...where, kind: 'diverged', why: `${tag}: in WebKit this phone's message #${i + 1} was `
              + `${JSON.stringify(a[i] || null).slice(0, 160)} but headless it was ${JSON.stringify(w[i] || null).slice(0, 160)} — `
              + `the game behaves differently in a real browser than in the harness` });
          }
          for (const p of res.problems) {
            const key = p.kind + '|' + shape.key + '|' + p.where + '|' + p.msg.replace(/\d+/g, '#');
            if (seen.has(key)) continue;
            seen.add(key);
            failures.push({ ...where, kind: p.kind, sample: p.sample, why: `${tag} at ${p.at}: ${p.msg}`, path: p.where });
          }
        } catch (e) {
          failures.push({ kind: 'harness', why: `${shape.name} ${phone.id}: ${String(e.message).split('\n')[0]}`, players: run.players, screens: run.screens, seed: run.seed });
        } finally {
          if (page) await page.close();
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const c of ctxs.values()) await c.close();

    if (shots) await screenshots(b, dir, bundle, rec, run, shapes, sdk, failures.filter(f => f.seed === run.seed && f.sample !== undefined), shots, engine);
  }

  // Hand-written phone states, for screens a played game rarely reaches.
  for (const entry of extra) {
    const res = await checkState(b, dir, bundle, manifest, entry, shapes, sdk, engine, shots);
    for (const f of res) {
      const key = f.why.replace(/\d+/g, '#');
      if (!seen.has(key)) { seen.add(key); failures.push(f); }
    }
  }

  if (verbose) console.log(`    ${measured} distinct screens measured · engine ${engine} · phases: ${[...phases].join(', ')}`);
  return { failures, measured, phases: [...phases], runs: runs.length, engine };
}

/** A hand-written state: a client phone booted and handed exactly these messages. */
async function checkState(b, dir, bundle, manifest, entry, shapes, sdk, engine, shots) {
  const n = entry.players || Math.min(8, manifest.maxPlayers || 8);
  const roster = LONG_ROSTER.slice(0, n).map(([name, emoji], i) => ({ id: 'p' + i, name, emoji }));
  const me = entry.as || 'p1';
  const cfg = { me: roster.find(p => p.id === me), players: roster, teams: [], isHost: false, saved: null, seed: 1 };
  const timeline = [{ t: 0, seq: 0, ev: 'start', a: roster, b: null }];
  (entry.messages || []).forEach((m, i) => timeline.push({ t: 10 * (i + 1), seq: 0, ev: 'message', a: 'p0', b: m, self: false }));
  timeline.push({ t: 10 * timeline.length + 10, seq: 0, ev: 'sample', a: `state "${entry.name}" · ${entry.name}` });
  const out = [];
  for (const shape of shapes) {
    const ctx = await b.newContext({ viewport: { width: shape.width, height: shape.height }, hasTouch: true, isMobile: engine === 'chromium' });
    let page;
    try {
      // The timer budget is unknown for a synthetic state, so let its own timers run
      // freely up to each message rather than demanding an exact count.
      const tl = timeline.map(e => ({ ...e, seq: 0 }));
      page = await openPhone(ctx, dir, bundle, { id: me, cfg, timeline: tl }, shape, sdk);
      await page.evaluate(() => window.__frReplay.advance(Infinity));
      const res = await page.evaluate(() => window.__frReplay.result());
      if (res.errors.length) out.push({ kind: 'throw', why: `${shape.name}, state "${entry.name}": ${res.errors[0]}`, state: entry.name });
      for (const p of res.problems) out.push({ kind: p.kind, why: `${shape.name}, state "${entry.name}": ${p.msg}`, state: entry.name });
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `${bundle.manifest.id.split('.').pop()}-state-${entry.name.replace(/\W+/g, '-')}-${shape.key}.png`) });
      }
    } finally { if (page) await page.close(); await ctx.close(); }
  }
  return out;
}

/** Screenshots of every problem's moment, outlined, plus each phase once, per shape —
 *  for the human who wants to SEE every screen at every size without a phone. */
async function screenshots(b, dir, bundle, rec, run, shapes, sdk, problems, outDir, engine) {
  mkdirSync(outDir, { recursive: true });
  const game = bundle.manifest.id.split('.').pop();
  const gallery = [];
  for (const shape of shapes) {
    const ctx = await b.newContext({ viewport: { width: shape.width, height: shape.height }, deviceScaleFactor: shape.dpr, hasTouch: true, isMobile: engine === 'chromium' });
    for (const phone of [rec.phones[0], rec.phones[1]].filter(Boolean)) {
      // First moment of each phase this phone saw.
      const marks = [];
      let k = -1;
      for (const e of phone.timeline) {
        if (e.ev !== 'sample') continue;
        k++;
        const ph = String(e.a || '').split(' · ')[1] || '';
        if (ph && !marks.some(m => m.phase === ph)) marks.push({ sample: k, phase: ph });
      }
      const mine = problems.filter(p => p.shape === shape.key && p.phone === phone.id).slice(0, 6)
        .map(p => ({ sample: p.sample, problem: p }));
      const busiest = phone.busiest && phone.busiest[shape.key];
      const stops = mine.concat(marks.map(m => ({ sample: m.sample, phase: m.phase })))
        .concat(busiest !== undefined && !marks.some(m => m.sample === busiest) ? [{ sample: busiest, phase: 'fullest' }] : [])
        .sort((a, z) => a.sample - z.sample);
      const page = await openPhone(ctx, dir, bundle, phone, shape, sdk);
      const tag = `${run.players}p${run.screens ? '-tv' : ''}-${phone.id}-${shape.key}`;
      let n = 0;
      for (const stop of stops) {
        await page.evaluate((s) => window.__frReplay.advance(s), stop.sample);
        await page.evaluate((w) => window.__frReplay.outline(w), stop.problem ? stop.problem.path : '');
        const what = stop.problem ? stop.problem.kind : 'phase-' + stop.phase;
        const file = join(outDir, `${game}-${tag}-${String(++n).padStart(2, '0')}-${what}.png`);
        await page.screenshot({ path: file });
        if (stop.problem) stop.problem.shot = file;
        gallery.push({ file, shape: shape.name, phone: phone.isHost ? 'host' : phone.id,
                       run: `${run.players} players${run.screens ? ', TV on' : ''}`, what: stop.problem ? stop.problem.why : stop.phase,
                       bad: !!stop.problem });
      }
      await page.close();
    }
    await ctx.close();
  }
  // A contact sheet: open it in any browser and scroll.
  const idx = join(outDir, `${game}.html`);
  const prev = existsSync(idx) ? readFileSync(idx, 'utf8') : '';
  const cards = gallery.map(g => `<figure class="${g.bad ? 'bad' : ''}"><img src="${g.file.split('/').pop()}" loading="lazy">`
    + `<figcaption><b>${g.shape}</b> · ${g.phone} · ${g.run}<br>${g.what.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</figcaption></figure>`).join('\n');
  const head = `<!doctype html><meta charset="utf-8"><title>${game} phones</title><style>`
    + `body{font:13px -apple-system,system-ui,sans-serif;margin:16px;background:#111;color:#ddd}`
    + `main{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}figure{margin:0;max-width:260px}`
    + `img{width:100%;border-radius:12px;border:1px solid #333}figure.bad img{border:2px solid #ff2d55}`
    + `figcaption{margin-top:4px;line-height:1.35}</style><h1>${game}</h1><main>`;
  writeFileSync(idx, (prev ? prev.replace('</main>', '') : head) + cards + '</main>');
}

/* ---------------------------------------------------------------------- cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
  const VALUED = ['seed', 'shots', 'shape', 'max'];
  let list = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1].replace(/^--/, ''))));
  if (flag('all', false) || !list.length) list = readdirSync(SAMPLES).filter(d => existsSync(join(SAMPLES, d, 'game.js'))).sort();
  const only = flag('shape', null);
  const shapes = only ? SHAPES.filter(s => String(only).split(',').includes(s.key)) : SHAPES;
  const shots = flag('shots', null);

  let bad = 0;
  for (const key of list) {
    const t0 = Date.now();
    let out;
    try { out = await checkPhones(key, { seed: Number(flag('seed', 1)), shapes, shots: shots === true ? 'phone-shots' : shots, verbose: !!flag('verbose', false) }); }
    catch (e) { console.log(`  ✗ ${key.padEnd(12)} ${e.message}`); bad++; if (/browser engine|playwright/.test(e.message)) break; continue; }
    const ms = Date.now() - t0;
    if (!out.failures.length) {
      console.log(`  ✓ ${key.padEnd(12)} ${out.measured} screens · ${shapes.length} shapes · ${out.runs} games · fits · ${ms}ms${out.engine !== 'webkit' ? ` · ENGINE ${out.engine.toUpperCase()}, NOT WEBKIT` : ''}`);
      continue;
    }
    bad++;
    const byKind = {};
    for (const f of out.failures) (byKind[f.kind] || (byKind[f.kind] = [])).push(f);
    console.log(`  ✗ ${key.padEnd(12)} ${out.failures.length} problem(s): ${Object.entries(byKind).map(([k, v]) => `${v.length} ${k}`).join(', ')}`);
    for (const f of out.failures.slice(0, Number(flag('max', 12)))) {
      console.log(`      ${f.why}`);
      if (f.shot) console.log(`        screenshot: ${f.shot}`);
    }
    if (out.failures.length > Number(flag('max', 12))) console.log(`      … and ${out.failures.length - Number(flag('max', 12))} more (--max N to see them)`);
    if (out.failures[0] && out.failures[0].seed) console.log(`        reproduce: node harness/phone.mjs ${key} --seed ${out.failures.find(f => f.seed)?.seed ?? 1} --shots phone-shots --verbose`);
  }
  if (pw) await pw.b.close();
  console.log(bad ? `\n${bad} bundle(s) with phone layout problems` : `\nAll ${list.length} bundle(s) fit on every phone`);
  process.exit(bad ? 1 : 0);
}
