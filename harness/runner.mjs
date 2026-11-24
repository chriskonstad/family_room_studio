/*
 * runner.mjs — run a real game bundle, headless.
 *
 * This is the piece that makes the whole platform authorable without a Mac. It boots N
 * virtual phones against the SAME `sdk/table-sdk.js` the iOS shell and the studio
 * use, loads a real bundle's `game.js`, and routes messages between them with the same
 * authoritative-host star topology the shell implements. No browser, no simulator, no
 * WKWebView — just node.
 *
 * Two things make it useful rather than merely possible:
 *
 *   A VIRTUAL CLOCK. Pass the Bomb runs ~20 seconds, TEMPO is a 60-second track, STREAK
 *   holds its round end for 1.7s. An agent cannot wait through that, and a thousand fuzz
 *   games would take a day. Here time is a number you advance, so a full game costs
 *   microseconds and there are no flaky sleeps.
 *
 *   A SEEDED WORLD. The clock, the RNG and the bot policies are all driven from one seed,
 *   so a failure prints a seed that reproduces it exactly.
 *
 * The DOM shim is deliberately dumb. Games render by assigning innerHTML and reading back
 * buttons, so a shim only needs to make that not crash and let us see what was rendered —
 * it is not trying to be a browser. If a game needs real layout, screenshot it in the
 * studio instead; that is a different question from "is the logic right".
 *
 *   import { runGame } from './runner.mjs';
 *   const t = await runGame({ game: 'streak', players: 3, seed: 7 });
 *   t.send('p1', { t: 'flip' });
 *   t.advance(2000);
 *   t.view('p1');           // what p1 last received
 *   t.text('p1');           // p1's screen as text
 *   t.result;               // the endGame payload, once it fires
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..');

/* ------------------------------------------------------------------ clock --- */

/**
 * Time you control. Same shape as the browser's timer functions, so the SDK's pausable
 * shim installs over it without knowing the difference.
 */
export function virtualClock() {
  let now = 0, seq = 0;
  const jobs = new Map();
  /* Every job remembers which device armed it, and every device counts the callbacks
   * of its own that have started. That count is what lets ONE phone be replayed on its
   * own somewhere else — in a real browser, by phone.mjs — in exactly the order it ran
   * here: "deliver this message after the phone's 41st timer callback" is unambiguous
   * where "at 12,500ms" is not, because several things happen at the same instant. */
  const started = {};
  const api = {
    get now() { return now; },
    get armed() { return jobs.size; },
    /** How many of `owner`'s callbacks have started so far. */
    firedBy(owner) { return started[owner] || 0; },
    /** Timers `owner` still has armed. */
    armedBy(owner) { let n = 0; for (const j of jobs.values()) if (j.owner === owner) n++; return n; },
    /** Forget every timer `owner` armed — a page that reloads takes its timers with it. */
    clearOwner(owner) { for (const [id, j] of jobs) if (j.owner === owner) jobs.delete(id); },
    setTimeout(fn, ms, owner) { const id = ++seq; jobs.set(id, { at: now + (ms || 0), fn, every: 0, owner }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn, ms, owner) { const id = ++seq; const d = Math.max(1, ms || 1); jobs.set(id, { at: now + d, fn, every: d, owner }); return id; },
    clearInterval(id) { jobs.delete(id); },
    /** Advance time, firing everything due in order. Returns how many callbacks ran. */
    advance(ms) {
      const target = now + ms;
      let fired = 0;
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= target && (!next || j.at < next[1].at)) next = [id, j];
        if (!next) break;
        const [id, job] = next;
        now = job.at;
        if (job.every) job.at = now + job.every; else jobs.delete(id);
        if (job.owner) started[job.owner] = (started[job.owner] || 0) + 1;
        job.fn();
        if (++fired > 100000) throw new Error('virtual clock livelock — a timer is rescheduling itself with no delay');
      }
      now = target;
      return fired;
    }
  };
  return api;
}

/* ------------------------------------------------------------------- date --- */

/**
 * A Date whose now() reads the virtual clock, from a fixed epoch.
 *
 * Without this, a game sees two different times: its timers run on the virtual clock
 * while Date.now() marches on in real time. That made any Date.now()-derived state
 * (a heat bar, a countdown) simulate wrong AND made replays inexact — the same seed
 * could produce a different game depending on how fast the host machine ran it. It is
 * also truer to the shell: the pausable timer shim freezes a paused game's time, so
 * host logic must not be able to watch real time pass.
 */
function makeVirtualDate(clock) {
  const RealDate = Date;
  const EPOCH = 1755000000000;               // fixed, so timestamps are plausible AND replayable
  function VDate(...args) {
    if (!(this instanceof VDate)) return new RealDate(EPOCH + clock.now).toString();
    return args.length ? new RealDate(...args) : new RealDate(EPOCH + clock.now);
  }
  VDate.now = () => EPOCH + clock.now;
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  VDate.prototype = RealDate.prototype;      // `x instanceof Date` keeps working
  return VDate;
}

/* -------------------------------------------------------------------- dom --- */

/**
 * Enough DOM for a game to render into and be clicked. Elements remember their innerHTML
 * and expose querySelector/querySelectorAll over a crude tag/class/id/attribute match,
 * which is what game code actually uses.
 */
function makeDom(clock) {
  function parseButtons(html) {
    // Games wire buttons up by data-act / id after assigning innerHTML. We don't parse
    // HTML properly — we extract the handles a game will ask for.
    // One pass PER TAG over the whole string, not one pass over all tags. A single
    // alternating regex matches the wrapping <div class="btnrow"> first, consumes to
    // its </div>, and the buttons inside it are never seen — which is exactly why
    // actions() came back empty for a game that was clearly rendering buttons.
    const out = [];
    // Void elements first: <input id="ph"> has no closing tag, so the paired-tag scan
    // below can never see it. Games reach their text fields by id, and a null there
    // crashed the render outright.
    for (const m of html.matchAll(/<(input|img|br|hr)\b([^>]*)\/?>/gi)) {
      const attrs = {};
      const ar = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = ar.exec(m[2]))) attrs[a[1]] = a[2];
      out.push({ tag: m[1].toLowerCase(), attrs, raw: m[2], text: '' });
    }
    // `form` is here because a game that types (SCRAMBLE) wraps its input in one to
    // get the iOS keyboard's Go key, and a missing handle is not a silent miss —
    // addEventListener on null takes the render down.
    for (const tag of ['button', 'form', 'i', 'div', 'span', 'a', 'label', 'p', 'textarea', 'select']) {
      const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
      let m;
      while ((m = re.exec(html))) {
        const attrs = {};
        const ar = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
        let a;
        while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
        // Where this element's CONTENT sits in the string, so patching it in place
        // later (see `splice`) can be written back into the page's text.
        const innerStart = m.index + 1 + tag.length + m[1].length + 1;
        out.push({ tag, attrs, raw: m[1], text: m[2].replace(/<[^>]*>/g, '').trim(),
                   inner: [innerStart, innerStart + m[2].length] });
      }
    }
    return out;
  }

  /**
   * Write a patch to a rendered element back into the page it came from.
   *
   * Games are told not to rebuild the DOM under a thumb, so they patch in place —
   * TEMPO rewrites its score strip, SCRAMBLE its readout, FISHBOWL its counters. In a
   * flat list of parsed handles that patch landed on the handle and nowhere else: the
   * page's text never changed, so the harness kept reading a screen from before the
   * patch. A reconnected phone, freshly rendered, looked WRONG next to it.
   */
  function splice(node, html) {
    const own = node._owner;
    if (!own || !node._inner) return;
    const [a, b] = node._inner;
    if (own._html.length < b) return;
    own._html = own._html.slice(0, a) + html + own._html.slice(b);
    const delta = html.length - (b - a);
    for (const h of own._parsed || []) {
      if (h === node || !h._inner) continue;
      const [x, y] = h._inner;
      if (x >= b) h._inner = [x + delta, y + delta];          // after it: shift
      else if (x <= a && y >= b) h._inner = [x, y + delta];   // around it: grow
      else if (x >= a && y <= b) h._inner = null;             // inside it: replaced
    }
    node._inner = [a, a + html.length];
  }
  const escText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function el(tag) {
    const node = {
      tagName: (tag || 'div').toUpperCase(),
      _html: '', style: {}, dataset: {}, children: [],
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                   contains(c) { return this._s.has(c); }, toggle(c, on) { on ? this.add(c) : this.remove(c); } },
      setAttribute(k, v) { node.dataset[k.replace(/^data-/, '')] = v; },
      getAttribute(k) { return node.dataset[k.replace(/^data-/, '')]; },
      appendChild(c) { node.children.push(c); return c; },
      removeChild(c) { node.children = node.children.filter(x => x !== c); },
      remove() {},
      // addEventListener was a no-op, so a game that wires input this way (TEMPO's
      // tap-to-the-beat surface) looked like it had no controls at all. Click handlers
      // are recorded so `clickable()` can see them and a bot can press them.
      addEventListener(type, fn) {
        // Any of these means "the player presses this thing" — TEMPO's tap surface uses
        // pointerdown, not click. Treating only 'click' as interaction made a game whose
        // entire input is a tap zone look like it had no controls.
        var PRESS = ['click', 'pointerdown', 'touchstart', 'mousedown'];
        if (PRESS.indexOf(type) !== -1 && typeof fn === 'function' && !node.onclick) {
          node.onclick = fn;
        }
        (node._listeners || (node._listeners = [])).push([type, fn]);
      },
      removeEventListener() {},
      value: '',
      focus() {}, blur() {}, click() { if (node.onclick) node.onclick({ preventDefault() {}, stopPropagation() {} }); },
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 60, top: 0, left: 0 }),
      get innerHTML() { return node._html; },
      set innerHTML(v) {
        splice(node, String(v));
        node._html = String(v);
        // Build the child handles ONCE per render and keep them. Returning fresh objects
        // from every query threw away the `el.onclick = …` the game had just assigned,
        // so a bot could never actually click anything — it could only guess intents.
        // Live handles mean a bot exercises the game's own event wiring, which is how
        // two-step interactions (select a card, then play it) become reachable.
        node._parsed = parseButtons(node._html).map(p => {
          const h = el(p.tag);
          h._html = p.text;
          h.attrs = p.attrs;
          h.dataset = Object.fromEntries(Object.entries(p.attrs)
            .filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v]));
          // A bare trailing `disabled` (`<button data-act="bank" disabled>`) ends the
          // attribute string — there is no space or `>` after it in `raw`. Requiring one
          // read STREAK's disabled Bank button as live.
          h.disabled = p.attrs.disabled !== undefined || /(?:^|\s)disabled(?=[\s=\/]|$)/.test(p.raw || '');
          (p.attrs.class || '').split(/\s+/).filter(Boolean).forEach(c => h.classList.add(c));
          h._owner = node;
          h._inner = p.inner ? p.inner.slice() : null;
          return h;
        });
      },
      get textContent() { return node._html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); },
      set textContent(v) { splice(node, escText(v)); node._html = String(v); node._parsed = []; },
      get innerText() { return node.textContent; },
      querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parsed = node._parsed || [];
        const m = { tag: null, cls: null, attr: null, val: null, id: null };
        // Descendant selectors ('.hand i', '.order .clock') are flattened to their LAST
        // simple part. This shim keeps one flat list of rendered elements rather than a
        // tree, so ancestry can't be checked — but matching the last part is what the
        // caller means ("the cards", "the clock"). Reading only the FIRST part matched
        // the container instead, so games wired their click handlers onto the wrong
        // element and a bot could never select a card.
        let s = String(sel).trim().split(/[\s>]+/).filter(Boolean).pop() || '';
        if (!/[#.\[a-zA-Z]/.test(s)) return [];
        const at = s.match(/\[([a-zA-Z-]+)(?:=["']?([^\]"']*)["']?)?\]/);
        if (at) { m.attr = at[1]; m.val = at[2]; s = s.replace(at[0], ''); }
        // '#begin' is how half the games reach their buttons. Without id support the
        // query fell through to "match everything" and returned the wrong element, so
        // the game's onclick was assigned to a node nobody could click.
        const idm = s.match(/#([\w-]+)/); if (idm) m.id = idm[1];
        const cl = s.match(/\.([\w-]+)/); if (cl) m.cls = cl[1];
        const tg = s.match(/^([a-zA-Z]+)/); if (tg) m.tag = tg[1].toLowerCase();
        return parsed.filter(h =>
          (!m.id || h.attrs.id === m.id) &&
          (!m.tag || h.tagName.toLowerCase() === m.tag) &&
          (!m.cls || h.classList.contains(m.cls)) &&
          (!m.attr || (h.attrs[m.attr] !== undefined &&
                       (m.val === undefined || m.val === '' || h.attrs[m.attr] === m.val)))
        );
      }
    };
    node._parsed = [];
    return node;
  }

  const byId = new Map();
  const document = {
    body: el('body'),
    head: el('head'),
    documentElement: el('html'),
    createElement: (t) => el(t),
    createTextNode: (t) => ({ textContent: t }),
    getElementById: (id) => { if (!byId.has(id)) { const n = el('div'); n._id = id; byId.set(id, n); } return byId.get(id); },
    querySelector: (s) => document.querySelectorAll(s)[0] || null,
    querySelectorAll: (s) => document._roots().flatMap(r => r.querySelectorAll(s)),
    addEventListener() {}, removeEventListener() {},
    /* Games render into a root they fetched by id (`#app`), not into <body>, so
     * anything inspecting "the screen" has to look at both. Reading only body was
     * why the first run reported an empty screen for a game that was rendering
     * perfectly well. */
    _roots: () => [document.body, ...byId.values()]
  };
  return document;
}


/* ------------------------------------------------------------------- table --- */

/** Read a bundle off disk: its manifest, its document's scripts in order, its ids. */
export function loadBundle(game) {
  const dir = game && game.includes('/')
    ? game
    : join(REPO, 'playtest/samples', game || 'streak');
  if (!existsSync(join(dir, 'game.js'))) {
    throw new Error(`No game.js in ${dir} — pass a sample key or a bundle directory`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const entry = manifest.entry || 'index.html';
  const gameSrc = readFileSync(join(dir, 'game.js'), 'utf8');

  /* A bundle's entry point is its HTML, and the bootstrap lives there —
   * `<script>createGame(window.Table, document.getElementById('app'))</script>`.
   * Running only game.js loads the game's definitions and never starts it, which
   * is exactly what happened the first time this ran: it booted cleanly and did
   * nothing. So run the document's scripts the way a browser would: in order,
   * reading each `src=` include out of the bundle directory.
   *
   * That last part used to be a comment claiming it happened and no code doing
   * it, which meant a bundle whose code spans more than one file (SCRAMBLE ships
   * a 200k-word dictionary beside its game) loaded fine on a phone and in the
   * Studio, and silently lost half of itself HERE — the one place that is
   * supposed to be stricter than a phone. */
  const entryHTML = existsSync(join(dir, entry)) ? readFileSync(join(dir, entry), 'utf8') : '';
  const docScripts = [];
  for (const m of entryHTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(m[1]);
    if (!src) {
      if (m[2].trim() && !m[2].includes('__TABLE_SDK__')) docScripts.push({ name: entry, code: m[2] });
      continue;
    }
    // Offline-only is a bundle rule the validator enforces; nothing to fetch here.
    if (/^[a-z]+:|^\/\//i.test(src[1])) continue;
    const file = join(dir, src[1]);
    if (existsSync(file)) docScripts.push({ name: src[1], code: readFileSync(file, 'utf8') });
  }
  // A bundle with no entry HTML — or one that forgot the tag — still gets its game.
  if (!docScripts.some(s => s.name === 'game.js')) docScripts.unshift({ name: 'game.js', code: gameSrc });
  const bodyIds = [...entryHTML.matchAll(/id=["']([\w-]+)["']/g)].map(m => m[1]);
  return { dir, manifest, entry, entryHTML, gameSrc, docScripts, bodyIds };
}

/** How many screens a bundle is booted with when the caller doesn't say. */
export function defaultScreens(manifest) {
  return manifest && manifest.screen === 'required' ? 1 : 0;
}

/**
 * Boot a game bundle with `players` virtual phones.
 *
 * @param {Object} opts
 *   game       sample key ('streak') or an absolute path to a bundle directory
 *   players    number of players (default 3), or an array of {id,name,emoji,teamId}
 *   seed       seeds the clock-independent RNG handed to bots and to the game
 *   teams      optional [{id,name,color}]
 *   screens    shared screens attached at the start (host's `Table.screens`). Defaults
 *              to 1 for a `"screen": "required"` bundle and 0 otherwise.
 *   beforeGame (window, playerId) => void, run in every phone after the SDK and FR are
 *              installed and BEFORE the bundle's own scripts — the place a scripted test
 *              stacks the deck by wrapping `window.FR.rng`.
 * @returns a table handle (see the file header)
 */
export async function runGame(opts = {}) {
  const bundle = loadBundle(opts.game);
  const { manifest, gameSrc, docScripts, bodyIds } = bundle;
  const tableSDK = readFileSync(join(REPO, 'sdk/table-sdk.js'), 'utf8');
  const frFeel = readFileSync(join(REPO, 'sdk/fr-feel.js'), 'utf8');
  const frGame = readFileSync(join(REPO, 'sdk/fr-game.js'), 'utf8');

  /* Respect the bundle's own player range. SUMMIT is strictly 2-player and FISHBOWL
   * needs 4+, so booting everything with a default 3 made them look like they hung —
   * the games were right and the harness was wrong. The shell enforces this too, so a
   * count it would refuse is not worth testing. */
  const wanted = Array.isArray(opts.players) ? opts.players.length : (opts.players || 0);
  const lo = manifest.minPlayers || 1;
  const hi = manifest.maxPlayers || 8;
  const count = Math.min(hi, Math.max(lo, wanted || Math.min(hi, Math.max(lo, 3))));

  /* A `"teams": "required"` bundle gets teams from the shell's lobby, not from itself —
   * it reads Table.teams and refuses to start without them. Booting one with no teams
   * left FISHBOWL stuck in its entry phase forever, which looked like the game hanging. */
  let teams = opts.teams || [];
  if (!teams.length && manifest.teams === 'required') {
    teams = [{ id: 't1', name: 'Red', color: '#e0574a' }, { id: 't2', name: 'Blue', color: '#4a86e0' }];
  }
  const assignTeam = (i) => (teams.length ? teams[i % teams.length].id : undefined);
  const roster = Array.isArray(opts.players) ? opts.players
    : Array.from({ length: count }, (_, i) => ({
        teamId: assignTeam(i),
        id: 'p' + i, name: ['Ava', 'Ben', 'Cal', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'][i] || ('P' + i),
        emoji: ['🦊', '🐙', '🐸', '🦉', '🐝', '🦄', '🐳', '🦁'][i] || '🎲'
      }));
  const clock = virtualClock();
  const log = [];
  const phones = new Map();
  let result = null;
  let screens = typeof opts.screens === 'number' ? opts.screens : defaultScreens(manifest);
  const seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;

  const hostId = roster[0].id;

  /* The shell's connection layer (TableLink in the app): every game message bound for
   * a player — each broadcast, each private send — is kept, in order, for the whole
   * game. A phone that drops is caught up from it when it comes back: just what it
   * missed if its page survived (warm), the WHOLE history into a fresh page if it
   * didn't (cold — iOS killed the app). Games never see any of it: no `leave`, no
   * resync handshake, a table that paused and carried on. */
  const history = {};          // playerId -> [{ from, payload }]

  /* The router. This mirrors the shell's star topology: clients send only to the host,
     the host broadcasts to everyone (including itself) or targets one player. Getting
     this wrong would make the harness disagree with the real thing, so it is small and
     literal on purpose. */
  const bus = {
    send(from, payload, fromGame) {
      // A phone that has left (or lost its connection) reaches nobody. Delivering what
      // its game kept sending — TEMPO's track runs on and reports "done" — meant a
      // departed player could still finish a game the harness was testing them leave.
      // A disconnected phone's intents wait in its outbox and go when it's back, as
      // the shell's TableLink does — exactly once, in order.
      const sender = phones.get(from);
      if (fromGame && sender && sender.dropped) { sender.outboxQueue.push(payload); return; }
      log.push({ t: clock.now, kind: 'send', from, payload });
      if (fromGame) outbox(from, 'send', payload);
      // An INTENT, even one the host sends itself, is never a view — recording it as
      // one made the fuzzer think a refused intent had changed the published state.
      // `self` marks the host's OWN game sending to itself: a phone replayed on its
      // own (phone.mjs) loops that back by itself and must not be handed it twice.
      deliver(hostId, from, payload, false, !!fromGame && from === hostId);
    },
    broadcast(from, payload) {
      if (from !== hostId) return;
      log.push({ t: clock.now, kind: 'broadcast', from, payload });
      outbox(from, 'broadcast', payload);
      // The sender does NOT receive its own broadcast — both real harnesses skip it,
      // and the host renders its own copy directly instead. Delivering it back here
      // put the host in an infinite publish -> onMessage -> publish loop.
      for (const id of phones.keys()) {
        if (id === from) { record(id, payload); continue; }
        post(id, from, payload);
      }
    },
    sendTo(from, to, payload) {
      if (from !== hostId) return;
      log.push({ t: clock.now, kind: 'sendTo', from, to, payload });
      outbox(from, 'sendTo', payload, to);
      if (to === from) deliver(to, from, payload, true, true);   // the host to itself: no wire
      else post(to, from, payload);
    },
    endGame(from, r) {
      if (from !== hostId) return;
      outbox(from, 'endGame', r);
      // Every call is logged, INCLUDING a second one. This used to return early when a
      // result already existed, which made playtest's "endGame fires once" assertion
      // unfalsifiable — it could not fail by construction. Neither real harness dedupes:
      // HostSession.endGame overwrites gameResult and re-broadcasts, so on a real phone a
      // second call replaces the results screen with a different winner.
      log.push({ t: clock.now, kind: 'endGame', payload: r });
      if (!result) result = r;
    },
    feedback(from, kind, value) { log.push({ t: clock.now, kind, from, value }); },
    saveState(from, v) { phones.get(from).saved = v; },
    error(from, message) { log.push({ t: clock.now, kind: 'error', from, message }); }
  };

  /** Remember what a phone was last shown, without firing a handler. */
  function record(toId, payload) {
    const phone = phones.get(toId);
    if (phone) phone.lastView = payload;
  }

  /** What a phone's own game said, in order — the replay's check on itself. */
  function outbox(fromId, kind, payload, to) {
    const phone = phones.get(fromId);
    if (!phone) return;
    phone.outbox.push(JSON.parse(JSON.stringify(to === undefined ? { kind, payload } : { kind, to, payload })));
  }

  /** Host -> one player, through the connection layer: kept in their history, and
   *  delivered now if they're connected. */
  function post(toId, fromId, payload) {
    if (!phones.has(toId)) return;
    (history[toId] || (history[toId] = [])).push({ from: fromId, payload: JSON.parse(JSON.stringify(payload)) });
    const phone = phones.get(toId);
    if (phone.dropped) return;
    phone.seen = history[toId].length;
    deliver(toId, fromId, payload, true);
  }

  function deliver(toId, fromId, payload, isView, self) {
    const phone = phones.get(toId);
    if (!phone || phone.dropped) return;
    // A page that hasn't started yet gets its messages after its start, as on a phone:
    // TableBridge queues everything until the page is ready, then fires start, then
    // drains the queue. Delivering them first (as this used to) had a client's own
    // onStart wipe the state it had just been sent — the reason every game grew a
    // `hello` handshake to ask for it again.
    if (!phone.started) { phone.early.push([fromId, JSON.parse(JSON.stringify(payload)), isView, self]); return; }
    if (isView) record(toId, payload);
    phone.fire('message', fromId, JSON.parse(JSON.stringify(payload)), self);
    // A shadow (see reconnect) hears everything its player hears from here on.
    const shadow = shadows.get(toId);
    if (shadow) shadow.fire('message', fromId, JSON.parse(JSON.stringify(payload)), self);
  }

  /* Second copies of a phone, made by reconnect({shadow:true}): booted the way a
   * reloaded page is, then fed everything the real phone is fed. Its sends reach the
   * host only while it is coming up (its `hello`); after that it is a pair of eyes. */
  const shadows = new Map();

  /**
   * Load one phone: a fresh page, the SDK injected first, then the bundle's scripts.
   * Called once per phone at boot, and again for a phone that RELOADS — which is what
   * the shell does to a player who reconnects, so it is the path a rejoin exercises.
   */
  function bootPhone(p, generation, asShadow) {
    const isHost = p.id === hostId;
    const owner = p.id + '#' + generation + (asShadow ? 's' : '');
    const document = makeDom(clock);
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, info() {} },
      structuredClone, JSON, Math, Date: makeVirtualDate(clock), Object, Array, String, Number, Boolean, Error,
      Map, Set, Promise, RegExp, isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms, owner), clearTimeout: clock.clearTimeout,
      setInterval: (fn, ms) => clock.setInterval(fn, ms, owner), clearInterval: clock.clearInterval,
      requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now), 16, owner),
      cancelAnimationFrame: (id) => clock.clearTimeout(id),
      performance: { now: () => clock.now },
      document, navigator: { userAgent: 'fr-harness' }, location: { href: 'about:blank' },
      window: null
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.addEventListener = () => {};
    vm.createContext(sandbox);

    vm.runInContext(tableSDK, sandbox);
    const cfg = {
      me: { id: p.id, name: p.name, emoji: p.emoji, teamId: p.teamId },
      players: roster.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, teamId: r.teamId })),
      teams, isHost, saved: phones.get(p.id)?.saved ?? null,
      // The whole table shares the run's seed, so `--seed N` replays the exact game.
      seed,
      // Only the host's shell knows how many screens are attached.
      screens: isHost ? screens : undefined
    };
    sandbox.__cfg = Object.assign({}, cfg);
    sandbox.__io = {
      send: (payload) => {
        // While a reloading page is coming up, what it sends is still on its way to
        // the host — see reconnect().
        if (phoneRef.hold) { phoneRef.queue.push(payload); return; }
        if (!asShadow || phoneRef.live) bus.send(p.id, payload, true);
      },
      broadcast: (payload) => bus.broadcast(p.id, payload),
      sendTo: (to, payload) => bus.sendTo(p.id, to, payload),
      endGame: (r) => bus.endGame(p.id, r),
      saveState: (v) => bus.saveState(p.id, v),
      haptic: (s) => bus.feedback(p.id, 'haptic', s),
      sound: (n) => bus.feedback(p.id, 'sound', n),
      error: (m) => bus.error(p.id, m)
    };
    vm.runInContext(`
      var clock = __frTable.installTimerShim(window);
      window.__tableSetPaused = clock.setPaused;
      __cfg.clock = clock;
      window.Table = __frTable.create(__cfg, __io, window);
    `, sandbox);
    vm.runInContext(frFeel, sandbox);
    vm.runInContext('__frFeel.install(window.Table, document)', sandbox);
    vm.runInContext(frGame, sandbox);
    if (opts.beforeGame) opts.beforeGame(sandbox, p.id);

    const prior = phones.get(p.id);
    const phoneRef = { live: true, hold: false, queue: [] };
    const phone = {
      id: p.id, isHost, sandbox, document, owner, generation, cfg,
      saved: prior ? prior.saved : null, lastView: null, dropped: false, gone: false,
      started: false, early: [], seen: 0, outboxQueue: [],
      /* Everything that happened TO this phone, in order, and the moments it was looked
       * at. Enough to rebuild it, event for event, in a real browser. */
      timeline: [], outbox: [],
      fire: (ev, a, b, self) => {
        if (ev === 'start') phone.started = true;
        phone.timeline.push({ t: clock.now, seq: clock.firedBy(owner), ev,
          a: a === undefined ? null : JSON.parse(JSON.stringify(a)),
          b: b === undefined ? null : JSON.parse(JSON.stringify(b)), self: !!self });
        try { sandbox.__tableFire(ev, a, b); }
        catch (e) { log.push({ t: clock.now, kind: 'throw', from: p.id, message: String(e && e.stack || e) }); throw e; }
      }
    };
    phone.ref = phoneRef;
    if (asShadow) shadows.set(p.id, phone); else phones.set(p.id, phone);

    // Pre-create the elements the entry HTML declares, so getElementById('app')
    // returns the same node the bootstrap and the game both reach for.
    for (const id of bodyIds) document.getElementById(id);

    // game.js defines; the entry HTML's inline script starts. In document order.
    for (const script of docScripts) {
      try { vm.runInContext(script.code, sandbox); }
      catch (e) { throw new Error(`${p.id}: ${script.name} threw on load — ${e.message}`); }
    }
    return phone;
  }

  /** Freeze or thaw every connected phone's clocks, the way the shell's pause does. */
  function pauseAll(on) {
    for (const p of phones.values()) {
      if (p.dropped) continue;
      p.timeline.push({ t: clock.now, seq: clock.firedBy(p.owner), ev: 'pause', a: !!on, b: null });
      try { p.sandbox.window.__tableSetPaused(!!on); } catch (e) {}
    }
  }

  for (const p of roster) bootPhone(p, 0);

  // Everyone gets onStart once every phone has loaded, mirroring the shell — and then
  // whatever arrived for them before it, in order.
  const startRoster = roster.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, teamId: r.teamId }));
  function startPhone(phone) {
    phone.fire('start', startRoster);
    for (const [from, payload, isView, self] of phone.early.splice(0)) {
      if (isView) record(phone.id, payload);
      phone.fire('message', from, payload, self);
    }
  }
  for (const phone of phones.values()) startPhone(phone);

  return {
    manifest, log, clock, bundle, seed,
    /** How many players actually booted, after the manifest's range was applied. */
    playerCount: roster.length,
    /** The teams this table was booted with (empty for a non-team game). */
    teams,
    roster: startRoster,
    get result() { return result; },
    get over() { return result !== null; },
    players: roster.map(r => r.id),
    hostId,
    /** Shared screens attached right now. */
    get screens() { return screens; },

    /** Send an intent as a player, exactly as a tap would. */
    send(playerId, payload) { bus.send(playerId, payload); return this; },
    /** Advance virtual time. Returns the number of timer callbacks that fired. */
    advance(ms) { return clock.advance(ms); },
    /** The last state this player received. */
    view(playerId) { return phones.get(playerId)?.lastView ?? null; },
    /** This player's screen, as plain text — what a bot or an agent "sees". Pass
     *  `shadow` for the copy a reconnect({shadow:true}) made. */
    text(playerId, shadow) {
      const d = (shadow ? shadows : phones).get(playerId)?.document;
      if (!d) return '';
      return d._roots().map(r => r.textContent).filter(Boolean)
              .join(' ').replace(/\s+/g, ' ').trim();
    },
    /** This player's screen as markup — for a test that asks what is ON it, not what
     *  it says. Pass `shadow` for a reconnect's copy. */
    html(playerId, shadow) {
      const d = (shadow ? shadows : phones).get(playerId)?.document;
      if (!d) return '';
      return d._roots().map(r => r._html).filter(Boolean).join('\n');
    },
    /** Buttons currently on this player's screen: [{act, id, text}]. */
    actions(playerId) {
      const d = phones.get(playerId)?.document;
      if (!d) return [];
      return d.querySelectorAll('button')
        .filter(b => b.attrs && b.attrs['data-act'])
        .map(b => ({ act: b.attrs['data-act'], id: b.attrs['data-id'], text: b.textContent }));
    },
    /**
     * What the HOST says this player may legally do right now, if the game is built on
     * FR.host. This is strictly better than reading the DOM: it is the real move space,
     * including moves a UI expresses as two taps or as typed text, and every move it
     * returns is one `handle` will accept.
     * @returns {?Array<Object>} null when the game doesn't use FR.host.
     */
    legalMoves(playerId) {
      const host = phones.get(hostId)?.sandbox?.__frHostTable;
      if (!host || typeof host.legalMoves !== 'function') return null;
      // A throw here used to read as "this game declares no moves", and the fuzzer
      // fell back to clicking — Liar's Dice was fuzzed that way, never through its
      // declared move space, and nothing said so. It is a bug in the game; say so.
      try { return host.legalMoves(playerId); }
      catch (e) {
        log.push({ t: clock.now, kind: 'throw', from: hostId,
                   message: `legalMoves(${playerId}) threw: ${String(e && e.stack || e)}` });
        return null;
      }
    },

    /**
     * The host's intent table, as FR.host describes it: every intent's name and flags.
     * This — not a regex over `Table.send({...})` literals — is the vocabulary a
     * coverage report has to be measured against. HOLD'EM and SCRAMBLE send through a
     * local helper, so the regex found exactly one intent in each (`hello`) and the
     * "never sent" warning could not fire for either game.
     * @returns {?Array<{name, hidden, host, turn, phase, options}>}
     */
    intents() {
      const host = phones.get(hostId)?.sandbox?.__frHostTable;
      if (!host || typeof host.describe !== 'function') return null;
      try { return host.describe(); } catch (e) { return null; }
    },

    /**
     * The host table's recent refusals (FR.host's `rejected`), or null when the game
     * isn't built on FR.host. This is what lets the fuzzer assert the invariant that
     * matters most under hostile input: a REFUSED intent must change nothing — if the
     * refusal list grew but the published state moved, some side channel mutated state
     * outside the reducer's guards.
     */
    rejections() {
      const host = phones.get(hostId)?.sandbox?.__frHostTable;
      if (!host) return null;
      try { return host.rejected; } catch (e) { return null; }
    },
    /** Every refusal the host has ever made (FR.host's refusedTotal), or null. */
    refusedTotal() {
      const host = phones.get(hostId)?.sandbox?.__frHostTable;
      if (!host) return null;
      try { return typeof host.refusedTotal === 'number' ? host.refusedTotal : null; } catch (e) { return null; }
    },
    /** True while the host table is frozen by a hold or sequence (FR.host's `busy`). */
    busy() {
      const host = phones.get(hostId)?.sandbox?.__frHostTable;
      try { return !!(host && host.busy); } catch (e) { return false; }
    },

    /** Live, clickable elements on this player's screen — buttons plus anything the
     *  game tagged with a data-* attribute (cards, swatches, plungers). Clicking one
     *  runs the game's own handler, which is what makes two-step interactions like
     *  "select a card, then play it" reachable by a bot. */
    clickable(playerId, shadow) {
      const d = (shadow ? shadows : phones).get(playerId)?.document;
      if (!d) return [];
      const rendered = ['button', 'i', 'div', 'span', 'a', 'label']
        .flatMap(tag => d.querySelectorAll(tag))
        .filter(h => !h.disabled && (h.onclick ||
                     Object.keys(h.attrs || {}).some(k => k.startsWith('data-'))));
      // Controls declared statically in index.html and fetched by id — BLITZ's tap
      // button, TEMPO's tap surface — are ROOTS in this shim, not children of a
      // rendered tree, so they were invisible here. A game whose only input is a
      // static button looked like it had no UI at all.
      const roots = d._roots().filter(h => h.onclick && !h.disabled);
      return rendered.concat(roots);
    },
    /** Every rendered element carrying attributes — raw material for a bot deciding
     *  what values an intent's dynamic fields could take (data-i, data-c, data-id…). */
    handles(playerId) {
      const d = phones.get(playerId)?.document;
      if (!d) return [];
      return ['button', 'i', 'div', 'span', 'input', 'a', 'label']
        .flatMap(tag => d.querySelectorAll(tag))
        .filter(h => h.attrs && Object.keys(h.attrs).length)
        .map(h => ({ tag: h.tagName.toLowerCase(), attrs: h.attrs, text: h.textContent }));
    },
    /** The bundle's own source, so a bot can discover its intent vocabulary. */
    source: gameSrc,
    /** There is no such thing as leaving mid-game: the shell treats it as any other
     *  absence (see disconnect). Kept as a name so old callers model the new shell. */
    drop(playerId) { return this.disconnect(playerId); },

    /**
     * The connection drops without a Leave — a phone backgrounded to answer a text.
     * This is NOT drop(): the shell holds the seat and pauses the whole table, and
     * nobody's game hears `leave`. Pair it with reconnect().
     */
    disconnect(playerId) {
      const p = phones.get(playerId);
      if (!p || p.dropped) return this;
      // Its own shell freezes it too: a phone whose link dropped shows "Reconnecting…"
      // with its game's clocks stopped, exactly like everyone else's.
      pauseAll(true);
      p.dropped = true;
      return this;
    },

    /**
     * They're back. What the shell does depends on whether their page survived:
     *
     *   warm (default) — backgrounded, suspended, the socket died, but the page is
     *     alive: they are handed exactly the messages they missed, in order, and their
     *     game never knows anything happened.
     *   cold — iOS killed the app: a fresh page, `start`, and then the WHOLE game so
     *     far, in order (with sound and haptics muted on a real phone).
     *   cold + shadow — the cold rebuild, booted BESIDE the phone that never dropped
     *     (which is caught up warm and carries on), so the two screens can be compared.
     *
     * Every other device's game hears `join` for them, as from HostSession, and the
     * table unpauses. Nobody's game ever heard that they were gone.
     */
    reconnect(playerId, { cold = false, shadow = false } = {}) {
      const old = phones.get(playerId);
      if (!old || old.gone) return this;
      const info = roster.find(r => r.id === playerId);
      const mine = history[playerId] || [];
      // Nobody's game hears that they're back, any more than it heard they were gone:
      // rosters are fixed once a game starts, and a game that reacts to connectivity
      // (SCRAMBLE re-seated a returning player and republished) is a game doing the
      // shell's job.
      const catchUp = (phone) => {
        for (const m of mine.slice(phone.seen)) { record(playerId, m.payload); phone.fire('message', m.from, m.payload); }
        phone.seen = mine.length;
      };
      const flushOutbox = (phone) => { for (const payload of phone.outboxQueue.splice(0)) bus.send(playerId, payload, true); };
      if (!cold) {
        old.dropped = false;
        catchUp(old);
        flushOutbox(old);
        pauseAll(false);
        return this;
      }
      let phone;
      if (shadow) {
        old.dropped = false;
        catchUp(old);
        flushOutbox(old);
        const prev = shadows.get(playerId);
        if (prev) clock.clearOwner(prev.owner);
        phone = bootPhone(info, old.generation + 1, true);
      } else {
        clock.clearOwner(old.owner);
        phone = bootPhone(info, old.generation + 1);
      }
      /* The shell's order: TableBridge.pageDidLoad fires `start`, then drains what it
       * queued while the page loaded — the whole history. Whatever the fresh page sends
       * from onStart is a round trip and comes back after that. */
      phone.ref.hold = true;
      phone.started = true;
      phone.fire('start', startRoster);
      for (const m of mine) { phone.lastView = m.payload; phone.fire('message', m.from, m.payload); }
      phone.seen = mine.length;
      phone.ref.hold = false;
      for (const payload of phone.ref.queue.splice(0)) bus.send(playerId, payload, true);
      if (shadow) phone.ref.live = false;
      pauseAll(false);
      return this;
    },
    /**
     * Press a control on a player's screen, the way a thumb would — and write down
     * WHICH control, so phone.mjs can press the same one in a real browser when it
     * rebuilds this phone. (A press is the one input that comes from the phone itself
     * rather than over the wire, so without this the rebuilt phone went quiet.)
     */
    press(playerId, control) {
      const phone = phones.get(playerId);
      if (phone) {
        const sig = (h) => h.tagName + '|' + (h.textContent || '') + '|' + JSON.stringify(h.attrs || {});
        const same = this.clickable(playerId).filter(h => sig(h) === sig(control));
        phone.timeline.push({ t: clock.now, seq: clock.firedBy(phone.owner), ev: 'press',
          a: { tag: control.tagName.toLowerCase(), attrs: control.attrs || {}, text: control.textContent || '',
               nth: Math.max(0, same.indexOf(control)), root: !control.attrs, id: control._id || null }, b: null });
      }
      control.click();
      return this;
    },
    /** Press the shadow's copy of a control just pressed on the real phone, so local
     *  state made after the reconnect (a selection, a draft) is made on both. */
    mirrorClick(playerId, control) {
      const d = shadows.get(playerId)?.document;
      if (!d) return false;
      const sig = (h) => h.tagName + '|' + (h.textContent || '') + '|' + JSON.stringify(h.attrs || {});
      const want = sig(control);
      const twin = this.clickable(playerId, true).find(h => h.onclick && sig(h) === want);
      if (!twin) return false;
      try { twin.click(); } catch (e) { return false; }
      return true;
    },
    hasShadow(playerId) { return shadows.has(playerId); },

    /** A shared screen attached or went away. Only the host's game hears about it. */
    setScreens(n) {
      screens = Math.max(0, n | 0);
      const host = phones.get(hostId);
      if (host && !host.dropped) host.fire('screens', screens);
      return this;
    },

    /** Hand one phone a message directly, as if the host had sent it. For hand-written
     *  phone states a played game can't reach. */
    deliverTo(playerId, payload, from) { deliver(playerId, from || hostId, payload, true); return this; },

    /**
     * Pause or resume EVERY phone, the way the shell does when an app backgrounds or a
     * call lands mid-game. The SDK's timer shim freezes each device's timers and fires
     * Table.onPause/onResume; while paused, `advance()` still moves the clock (real
     * time passes on a paused phone too), so state that leaks wall-clock time into
     * game logic shows itself here.
     */
    setPaused(on) { pauseAll(on); return this; },

    /** Mark "look at this phone now" on every phone's timeline. phone.mjs measures the
     *  real layout at exactly these moments. */
    sample(label) {
      for (const p of phones.values()) {
        if (p.dropped) continue;
        p.timeline.push({ t: clock.now, seq: clock.firedBy(p.owner), ev: 'sample', a: label || null, b: null });
      }
      return this;
    },
    /** One phone's recorded life: its config, what happened to it, and what it said. */
    phoneRecord(playerId) {
      const p = phones.get(playerId);
      if (!p) return null;
      return { id: p.id, isHost: p.isHost, generation: p.generation, cfg: p.cfg,
               timeline: p.timeline, outbox: p.outbox };
    },
    /** Every message that crossed the wire — the authoritative record for assertions. */
    wire(kind) { return kind ? log.filter(e => e.kind === kind) : log; },
    /** Haptic/sound calls a game made, so feedback can be asserted headlessly. */
    feedback() { return log.filter(e => e.kind === 'haptic' || e.kind === 'sound'); }
  };
}
