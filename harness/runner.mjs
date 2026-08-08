/*
 * runner.mjs — run a real game bundle, headless.
 *
 * This is the piece that makes the whole platform authorable without a Mac. It boots N
 * virtual phones against the SAME `tools/sdk/table-sdk.js` the iOS shell and the studio
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
export const REPO = join(here, '..', '..');

/* ------------------------------------------------------------------ clock --- */

/**
 * Time you control. Same shape as the browser's timer functions, so the SDK's pausable
 * shim installs over it without knowing the difference.
 */
export function virtualClock() {
  let now = 0, seq = 0;
  const jobs = new Map();
  const api = {
    get now() { return now; },
    get armed() { return jobs.size; },
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const d = Math.max(1, ms || 1); jobs.set(id, { at: now + d, fn, every: d }); return id; },
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
        job.fn();
        if (++fired > 100000) throw new Error('virtual clock livelock — a timer is rescheduling itself with no delay');
      }
      now = target;
      return fired;
    }
  };
  return api;
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
    for (const tag of ['button', 'i', 'div', 'span', 'a', 'label', 'p', 'textarea', 'select']) {
      const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)</' + tag + '>', 'gi');
      let m;
      while ((m = re.exec(html))) {
        const attrs = {};
        const ar = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
        let a;
        while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
        out.push({ tag, attrs, raw: m[1], text: m[2].replace(/<[^>]*>/g, '').trim() });
      }
    }
    return out;
  }

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
      addEventListener() {}, removeEventListener() {},
      value: '',
      focus() {}, blur() {}, click() { if (node.onclick) node.onclick({ preventDefault() {}, stopPropagation() {} }); },
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 60, top: 0, left: 0 }),
      get innerHTML() { return node._html; },
      set innerHTML(v) {
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
          h.disabled = p.attrs.disabled !== undefined || / disabled(?=[ >])/.test(p.raw || '');
          (p.attrs.class || '').split(/\s+/).filter(Boolean).forEach(c => h.classList.add(c));
          return h;
        });
      },
      get textContent() { return node._html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); },
      set textContent(v) { node._html = String(v); node._parsed = []; },
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
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, el('div')); return byId.get(id); },
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

/**
 * Boot a game bundle with `players` virtual phones.
 *
 * @param {Object} opts
 *   game      sample key ('streak') or an absolute path to a bundle directory
 *   players   number of players (default 3), or an array of {id,name,emoji,teamId}
 *   seed      seeds the clock-independent RNG handed to bots and to the game
 *   teams     optional [{id,name,color}]
 * @returns a table handle (see the file header)
 */
export async function runGame(opts = {}) {
  const dir = opts.game && opts.game.includes('/')
    ? opts.game
    : join(REPO, 'tools/playtest/samples', opts.game || 'streak');
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
   * nothing. Take the inline scripts (skipping src= includes, which we load in
   * order ourselves) and run them after, as a browser would. */
  const entryHTML = existsSync(join(dir, entry)) ? readFileSync(join(dir, entry), 'utf8') : '';
  const inlineScripts = [...entryHTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1])
    .filter(s => s.trim() && !s.includes('__TABLE_SDK__'));
  const bodyIds = [...entryHTML.matchAll(/id=["']([\w-]+)["']/g)].map(m => m[1]);
  const tableSDK = readFileSync(join(REPO, 'tools/sdk/table-sdk.js'), 'utf8');
  const frFeel = readFileSync(join(REPO, 'tools/sdk/fr-feel.js'), 'utf8');
  const frGame = readFileSync(join(REPO, 'tools/sdk/fr-game.js'), 'utf8');

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

  const hostId = roster[0].id;

  /* The router. This mirrors the shell's star topology: clients send only to the host,
     the host broadcasts to everyone (including itself) or targets one player. Getting
     this wrong would make the harness disagree with the real thing, so it is small and
     literal on purpose. */
  const bus = {
    send(from, payload) {
      log.push({ t: clock.now, kind: 'send', from, payload });
      deliver(hostId, from, payload);
    },
    broadcast(from, payload) {
      if (from !== hostId) return;
      log.push({ t: clock.now, kind: 'broadcast', from, payload });
      // The sender does NOT receive its own broadcast — both real harnesses skip it,
      // and the host renders its own copy directly instead. Delivering it back here
      // put the host in an infinite publish -> onMessage -> publish loop.
      for (const id of phones.keys()) {
        if (id === from) { record(id, payload); continue; }
        deliver(id, from, payload);
      }
    },
    sendTo(from, to, payload) {
      if (from !== hostId) return;
      log.push({ t: clock.now, kind: 'sendTo', from, to, payload });
      deliver(to, from, payload);
    },
    endGame(from, r) {
      if (from !== hostId || result) return;
      log.push({ t: clock.now, kind: 'endGame', payload: r });
      result = r;
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

  function deliver(toId, fromId, payload) {
    const phone = phones.get(toId);
    if (!phone || phone.dropped) return;
    if (fromId === hostId) record(toId, payload);
    phone.fire('message', fromId, JSON.parse(JSON.stringify(payload)));
  }

  for (const p of roster) {
    const isHost = p.id === hostId;
    const document = makeDom(clock);
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, info() {} },
      structuredClone, JSON, Math, Date, Object, Array, String, Number, Boolean, Error,
      Map, Set, Promise, RegExp, isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval, clearInterval: clock.clearInterval,
      requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now), 16),
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
    sandbox.__cfg = {
      me: { id: p.id, name: p.name, emoji: p.emoji, teamId: p.teamId },
      players: roster.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, teamId: r.teamId })),
      teams, isHost, saved: null,
      // The whole table shares the run's seed, so `--seed N` replays the exact game.
      seed: (opts.seed === undefined ? 1 : opts.seed) >>> 0
    };
    sandbox.__io = {
      send: (payload) => bus.send(p.id, payload),
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

    phones.set(p.id, {
      id: p.id, isHost, sandbox, document, saved: null, lastView: null, dropped: false,
      fire: (ev, a, b) => {
        try { sandbox.__tableFire(ev, a, b); }
        catch (e) { log.push({ t: clock.now, kind: 'throw', from: p.id, message: String(e && e.stack || e) }); throw e; }
      }
    });

    // Pre-create the elements the entry HTML declares, so getElementById('app')
    // returns the same node the bootstrap and the game both reach for.
    for (const id of bodyIds) document.getElementById(id);

    // game.js defines; the entry HTML's inline script starts. Both, in order.
    try { vm.runInContext(gameSrc, sandbox); }
    catch (e) { throw new Error(`${p.id}: game.js threw on load — ${e.message}`); }
    for (const script of inlineScripts) {
      try { vm.runInContext(script, sandbox); }
      catch (e) { throw new Error(`${p.id}: ${entry} bootstrap threw — ${e.message}`); }
    }
  }

  // Everyone gets onStart once every phone has loaded, mirroring the shell.
  const startRoster = roster.map(r => ({ id: r.id, name: r.name, emoji: r.emoji, teamId: r.teamId }));
  for (const phone of phones.values()) phone.fire('start', startRoster);

  return {
    manifest, log, clock,
    /** How many players actually booted, after the manifest's range was applied. */
    playerCount: roster.length,
    /** The teams this table was booted with (empty for a non-team game). */
    teams,
    get result() { return result; },
    get over() { return result !== null; },
    players: roster.map(r => r.id),
    hostId,

    /** Send an intent as a player, exactly as a tap would. */
    send(playerId, payload) { bus.send(playerId, payload); return this; },
    /** Advance virtual time. Returns the number of timer callbacks that fired. */
    advance(ms) { return clock.advance(ms); },
    /** The last state this player received. */
    view(playerId) { return phones.get(playerId)?.lastView ?? null; },
    /** This player's screen, as plain text — what a bot or an agent "sees". */
    text(playerId) {
      const d = phones.get(playerId)?.document;
      if (!d) return '';
      return d._roots().map(r => r.textContent).filter(Boolean)
              .join(' ').replace(/\s+/g, ' ').trim();
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
      try { return host.legalMoves(playerId); } catch (e) { return null; }
    },

    /** Live, clickable elements on this player's screen — buttons plus anything the
     *  game tagged with a data-* attribute (cards, swatches, plungers). Clicking one
     *  runs the game's own handler, which is what makes two-step interactions like
     *  "select a card, then play it" reachable by a bot. */
    clickable(playerId) {
      const d = phones.get(playerId)?.document;
      if (!d) return [];
      return ['button', 'i', 'div', 'span', 'a', 'label']
        .flatMap(tag => d.querySelectorAll(tag))
        .filter(h => !h.disabled && (h.onclick ||
                     Object.keys(h.attrs || {}).some(k => k.startsWith('data-'))));
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
    /** Simulate a disconnect / reconnect. */
    drop(playerId) { const p = phones.get(playerId); if (p) p.dropped = true; for (const o of phones.values()) if (o.id !== playerId && !o.dropped) o.fire('leave', playerId); return this; },
    /** Every message that crossed the wire — the authoritative record for assertions. */
    wire(kind) { return kind ? log.filter(e => e.kind === kind) : log; },
    /** Haptic/sound calls a game made, so feedback can be asserted headlessly. */
    feedback() { return log.filter(e => e.kind === 'haptic' || e.kind === 'sound'); }
  };
}
