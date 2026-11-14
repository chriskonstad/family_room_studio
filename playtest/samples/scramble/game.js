/* SCRAMBLE — sixteen letters, everyone at once.
 *
 * Boggle dice are rolled onto the shared screen and onto every phone, and for
 * ninety seconds everybody traces words out of the grid with a finger. Every
 * word you find pays. A word NOBODY else found pays DOUBLE — which is the whole
 * game: the safe four-letter word everyone sees is worth having, and the one
 * only you saw is worth twice as much.
 *
 * Nobody is told their score while a round is running. The only thing the table
 * can see is how many words each person has banked, which is exactly enough to
 * panic about and not enough to play off. The scores arrive afterwards, one word
 * at a time, on the screen: short shared words first, then long shared ones, then
 * the uniques from short to long — so the last word read out is the longest thing
 * one person saw alone, and the biggest jump on the board is the last one.
 *
 * `"screen": "required"`. The round is scored THERE, in front of everyone, and
 * the running order is the point of it — a phone cannot be the place where a
 * table watches a scoreboard move. Plays solo too; with one person every word is
 * unique by definition, so it becomes a race against your own best round.
 *
 * Host authoritative. The rules — dice, placement, the word list, scoring — are
 * in rules.js, which the fuzzer's bots load too, so the bot cannot be playing a
 * different game from the one that ships.
 *
 * PRIVACY. Your words are yours until the round ends: the host keeps them and
 * sends each player only their OWN list. The shared screen is fed the broadcast
 * stream and never a `sendTo`, so it cannot show your words even by accident —
 * it is not given them. Nor are the unrevealed ones: during the reveal the host
 * broadcasts only the words it has already read out.
 */

function createGame(Table, root) {
  const MY = Table.me.id;
  const R = SCRAMBLE_RULES;

  const ROUNDS = 3;
  const READY_SECONDS = 3;
  const PLAY_SECONDS = 90;
  const REVEAL_MS = 420;             // one word at a time, fast enough to stay a reveal
  const AFTER_REVEAL_SECONDS = 6;    // a beat to read the final board before the next grid
  /* A grid with nothing in it is a dead round nobody can do anything about, so a
   * dud is re-rolled rather than handed over. Every roll comes off the same seeded
   * stream, so the re-roll replays exactly like everything else. */
  const MIN_WORDS_ON_GRID = 60;
  const MAX_ROLLS = 8;

  const WHY = {
    letters: 'letters only',
    length:  'three to eight letters',
    grid:    'that path isn’t on the grid',
    word:    'not in the word list',
    already: 'you already found that'
  };

  let view = null;                       // the public state, as the whole table sees it
  let privy = { words: [], ack: null };  // my own side of it
  let lastPhase = null;
  let lastCount = -1;
  let lastRevealed = -1;
  let lastSecond = null;

  function feel(event, opts) {
    try { if (Table.feel) Table.feel(event, opts || {}); } catch (e) {}
  }

  /* ------------------------------------------------------------------ host --- */

  const rng = FR.rng(Table.seed);
  const timer = FR.timers();
  let G = null;
  let found = {};        // playerId -> [word]  — HOST ONLY, private until the reveal
  let pending = [];      // HOST ONLY — the scored rows, handed out one at a time
  let solution = [];     // HOST ONLY — every word on the grid, for the "were there" count
  let table = null;
  let ended = false;

  function initGame(players) {
    G = {
      phase: 'ready', round: 0, rounds: ROUNDS,
      seats: players.map(p => p.id),
      names: {}, emojis: {}, totals: {}, counts: {}, done: {},
      grid: [], possible: 0, secondsLeft: READY_SECONDS,
      rows: null, points: null, revealed: 0, totalRows: 0
    };
    players.forEach(p => seatPlayer(p));
    rollGrid();
  }

  /* G.seats is the live roster, and FR.host holds the SAME ARRAY — it is what
   * refuses intents from an id that is not at the table. So it is mutated in
   * place, never reassigned: a filtered copy would leave the host checking a
   * roster that stopped changing the moment somebody walked out. */
  function seatPlayer(p) {
    if (G.seats.indexOf(p.id) === -1) G.seats.push(p.id);
    G.names[p.id] = p.name;
    G.emojis[p.id] = p.emoji;
    if (G.totals[p.id] == null) G.totals[p.id] = 0;
    // Somebody reconnecting keeps the words they already found this round.
    G.counts[p.id] = (found[p.id] || []).length;
    if (G.done[p.id] == null) G.done[p.id] = false;
  }

  function unseatPlayer(id) {
    const at = G.seats.indexOf(id);
    if (at !== -1) G.seats.splice(at, 1);
    delete G.names[id];
    delete G.emojis[id];
    delete G.done[id];
    delete G.counts[id];
  }

  function rollGrid() {
    let best = null;
    for (let i = 0; i < MAX_ROLLS; i++) {
      const grid = R.roll(rng);
      const words = R.solve(grid);
      if (!best || words.length > best.words.length) best = { grid, words };
      if (words.length >= MIN_WORDS_ON_GRID) break;
    }
    G.grid = best.grid;
    solution = best.words;
    G.possible = best.words.length;
    found = {};
    G.seats.forEach(id => { G.counts[id] = 0; G.done[id] = false; });
  }

  /** Accept or refuse one word. The word itself never travels back. */
  function submit(id, msg) {
    const typed = String(msg && msg.w != null ? msg.w : '').toLowerCase().replace(/[^a-z]/g, '');
    const list = found[id] || (found[id] = []);
    let why = R.check(G.grid, typed);
    if (!why && list.indexOf(typed) !== -1) why = 'already';
    if (!why) {
      list.push(typed);
      G.counts[id] = list.length;
    }
    // No points in here. Nobody learns their score mid-round, including from
    // their own phone adding numbers up quietly.
    sendPrivate(id, { n: msg && msg.n, why: why || null });
  }

  function sendPrivate(id, ack) {
    const payload = { t: 'mine', words: (found[id] || []).slice(), ack: ack || null };
    if (id === MY) { privy = payload; return; }     // the host is a player too
    Table.sendTo(id, payload);
  }

  function everyoneDone() {
    return G.seats.length > 0 && G.seats.every(id => G.done[id]);
  }

  function beginRound() {
    G.phase = 'round';
    G.secondsLeft = PLAY_SECONDS;
  }

  /* The reveal. Points land on the board one word at a time rather than all at
   * once, because watching it climb IS the scoring. The host drives it so every
   * screen and every phone is on the same word. */
  function endRound() {
    const result = R.tally(found);
    pending = result.rows;
    G.revealed = 0;
    G.totalRows = pending.length;
    G.points = {};
    G.seats.forEach(id => { G.points[id] = 0; });
    G.phase = 'tally';
    G.secondsLeft = AFTER_REVEAL_SECONDS;
    // Everything is public now — including each player's own list, which is the
    // reveal. Send it once more so a phone can mark off what it had.
    G.seats.forEach(id => sendPrivate(id, null));
    timer.every('reveal', REVEAL_MS, () => { revealNext(); syncAll(); });
  }

  function revealNext() {
    if (G.revealed >= pending.length) { timer.cancel('reveal'); return false; }
    const row = pending[G.revealed++];
    for (const id of row.by) {
      if (G.points[id] == null) continue;           // somebody who has since left
      G.points[id] += row.value;
      G.totals[id] = (G.totals[id] || 0) + row.value;
    }
    if (G.revealed >= pending.length) timer.cancel('reveal');
    return true;
  }

  /** Skip to the end of the reveal with every point still awarded. */
  function revealAll() { while (revealNext()) { /* keep going */ } }

  function nextRound() {
    revealAll();                        // never advance past unawarded points
    if (G.round + 1 >= ROUNDS) return finish();
    G.round++;
    G.rows = null; G.points = null; G.revealed = 0; G.totalRows = 0;
    rollGrid();
    G.seats.forEach(id => sendPrivate(id, null));
    G.phase = 'ready';
    G.secondsLeft = READY_SECONDS;
  }

  function finish() {
    if (ended) return;
    ended = true;
    G.phase = 'gameOver';
    timer.cancelAll();                 // nothing ticks under the results screen
    const scores = {};
    G.seats.forEach(id => { scores[id] = G.totals[id] || 0; });
    const result = FR.standings.byScore(scores, {
      detail: (id, n) => n + (n === 1 ? ' point' : ' points')
    });
    syncAll();
    Table.endGame({
      winnerId: result.winnerId,
      title: (G.names[result.winnerId] || 'Nobody') + ' saw the most',
      standings: result.standings
    });
  }

  /* One clock for the whole game. It is an FR timer, so it freezes when the table
   * pauses — a wall-clock deadline would eat the round while somebody reconnects. */
  function startClock() {
    timer.every('clock', 1000, () => {
      if (!G || G.phase === 'gameOver') return;
      // While words are still being read out, the clock waits: the reveal is not
      // on a deadline and a long round must not be cut off mid-sentence.
      if (G.phase === 'tally' && G.revealed < G.totalRows) return;
      G.secondsLeft = Math.max(0, G.secondsLeft - 1);
      if (G.secondsLeft <= 0) {
        if (G.phase === 'ready') beginRound();
        else if (G.phase === 'round') endRound();
        else if (G.phase === 'tally') nextRound();
      }
      syncAll();
    });
  }

  function buildTable() {
    return FR.host({
      state: G, timers: timer, hostId: MY,
      players: G.seats,
      phase: () => G.phase,
      publish: syncAll,
      intents: {
        hello: { hidden: true, run: () => {} },
        /* A traced word: playable, never enumerable. The bundle's bot.mjs supplies
         * it, using the same rules.js the host validates with. */
        word: {
          hidden: true, phase: 'round',
          when: (ctx) => !G.done[ctx.from],
          run: (ctx) => submit(ctx.from, ctx.msg)
        },
        /* "I'm out of ideas." Everyone done ends the round early — nobody wants to
         * sit out the last thirty seconds of a grid they've finished with. */
        done: {
          phase: 'round',
          when: (ctx) => !G.done[ctx.from],
          run: (ctx) => { G.done[ctx.from] = true; if (everyoneDone()) endRound(); }
        },
        next: { phase: 'tally', run: () => nextRound() }
      }
    });
  }

  function publicState() {
    /* Scores exist only once the round is over. Hiding them in the UI would be a
     * promise; leaving them out of the broadcast is the thing itself — there is
     * nothing on any phone, or any screen, to read them off. */
    const scored = G.phase === 'tally' || G.phase === 'gameOver';
    return {
      phase: G.phase, round: G.round, rounds: G.rounds,
      names: { ...G.names }, emojis: { ...G.emojis },
      seats: G.seats.slice(),
      counts: { ...G.counts }, done: { ...G.done },
      // The grid is public — it is the thing everyone is looking at.
      grid: G.grid.slice(), possible: G.possible,
      secondsLeft: G.secondsLeft,
      totals: scored ? { ...G.totals } : null,
      // Only the words already read out. The rest are still somebody's secret.
      rows: scored ? pending.slice(0, G.revealed) : null,
      points: scored ? { ...G.points } : null,
      revealed: scored ? G.revealed : 0,
      totalRows: scored ? G.totalRows : 0,
      unique: R.UNIQUE
    };
  }

  function syncAll() {
    if (!G) return;
    const s = publicState();
    Table.broadcast({ t: 'state', s });
    view = s;
    render();
  }

  /* ---------------------------------------------------------------- wiring --- */

  if (Table.isHost) {
    Table.onStart(players => {
      initGame(players);
      table = buildTable();
      startClock();
      syncAll();
    });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
    Table.onPlayerJoin(p => {
      if (!G) return;
      seatPlayer(p);
      sendPrivate(p.id, null);
      syncAll();
    });
    Table.onPlayerLeave(id => {
      if (!G) return;
      // Their words stay in the round — a word they found still shares yours,
      // which is the only answer that doesn't rewrite everyone else's score.
      unseatPlayer(id);
      if (!G.seats.length) return finish();
      if (G.phase === 'round' && everyoneDone()) endRound();
      syncAll();
    });
  } else {
    Table.onStart(() => { view = null; render(); Table.send({ t: 'hello' }); });
    Table.onMessage((_from, msg) => {
      if (!msg) return;
      if (msg.t === 'state') { view = msg.s; render(); }
      else if (msg.t === 'mine') { privy = msg; render(); }
    });
  }

  /* ------------------------------------------------------------------- ui --- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function send(msg) {
    if (Table.isHost) { if (table) table.handle(MY, msg); }
    else Table.send(msg);
  }

  function clock(seconds) {
    const s = Math.max(0, seconds | 0);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  /* --------------------------------------------------------- tracing --- */

  /* A finger on the letters, not a keyboard. Typing meant the keyboard covered
   * half the game and autocorrect fought every word; tracing is how a word game
   * on a touchscreen is supposed to feel, and it makes an illegal path
   * impossible to even draw rather than something the host explains afterwards.
   *
   * The path is held here, not in the DOM, because a render must never disturb a
   * finger that is halfway through a word. */
  let path = [];
  let tracing = false;
  let submitted = 0;
  let geom = null;        // the board's size, measured once per trace
  let last = null;        // the finger's previous position, so no tile is jumped over
  let settling = null;    // a word that has been sent and is waiting for a verdict

  const rowOf = (i) => (i / 4) | 0;
  const colOf = (i) => i % 4;
  function adjacent(a, b) {
    return a !== b && Math.abs(rowOf(a) - rowOf(b)) <= 1 && Math.abs(colOf(a) - colOf(b)) <= 1;
  }

  function measureBoard() {
    const board = root.querySelector('#board');
    if (!board || !board.getBoundingClientRect) return null;
    const r = board.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left, y: r.top, w: r.width / 4, h: r.height / 4 };
  }

  /**
   * Which tile is under the finger.
   *
   * `near` is what makes a diagonal work. Hit-testing the tile RECTANGLE means a
   * finger cutting toward the tile diagonally below clips the corner of one it
   * never meant to touch — and that tile IS adjacent, so the letter goes into the
   * word. Measured on a real grid, a bow of 5% of a tile's width was enough to do
   * it, which is every human finger ever.
   *
   * So a tile only answers near its MIDDLE. The corner where four tiles meet
   * belongs to none of them, a sweep passes through cleanly, and only a
   * deliberate arrival registers. Same measurement, same grid: clean through 25%.
   *
   * The first and last touches are the exception — they take the whole square,
   * gaps included. Neither can insert a letter into the middle of a word: one has
   * no path yet and the other is the end of it. That asymmetry is what lets the
   * middle be strict. Measured on a real grid: a sweep survives a 30% bow, and
   * you can let go 40% off the middle of the last tile and still get it.
   */
  function cellUnder(x, y, near) {
    if (!geom) return -1;
    const col = Math.floor((x - geom.x) / geom.w);
    const row = Math.floor((y - geom.y) / geom.h);
    if (col < 0 || col > 3 || row < 0 || row > 3) return -1;
    if (!near) return row * 4 + col;
    const dx = x - (geom.x + (col + 0.5) * geom.w);
    const dy = y - (geom.y + (row + 0.5) * geom.h);
    const r = 0.26 * Math.min(geom.w, geom.h);
    return (dx * dx + dy * dy) <= r * r ? row * 4 + col : -1;
  }

  /**
   * Follow the finger from where it was to where it is.
   *
   * A tighter middle is only safe if nothing can jump over it. Pointer events
   * arrive every frame at best, and a quick flick across a phone moves further
   * between two of them than a tile is wide — so testing only the points the OS
   * hands over would silently drop letters out of fast words. Walking the line
   * between them in sub-tile steps makes the small target unmissable, which is
   * what lets the target be small.
   */
  function traceTo(x, y) {
    const step = Math.min(geom.w, geom.h) * 0.3;
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      const span = Math.sqrt(dx * dx + dy * dy);
      const hops = Math.min(64, Math.ceil(span / step));
      for (let k = 1; k < hops; k++) {
        extendTo(cellUnder(last.x + dx * k / hops, last.y + dy * k / hops, true));
      }
    }
    extendTo(cellUnder(x, y, true));
    last = { x: x, y: y };
  }

  function extendTo(i) {
    if (i < 0) return;
    if (path.length >= 2 && path[path.length - 2] === i) { path.pop(); paintPath(); return; }
    if (path.indexOf(i) !== -1) return;
    if (path.length && !adjacent(path[path.length - 1], i)) return;
    path.push(i);
    feel('tick', { mine: true });
    paintPath();
  }

  function wordOf(indices) {
    const grid = (view && view.grid) || [];
    return indices.map(i => grid[i] || '').join('');
  }

  /* The word you are drawing IS the feedback. It sits above the grid while you
   * trace, and when you let go it turns green or red where it stands — no second
   * line of status text to read, nothing that says "banked". */
  function showWord(text, state) {
    const readout = root.querySelector('#forming');
    if (!readout) return;
    readout.textContent = text || '—';
    readout.className = 'forming' + (state ? ' ' + state : '');
    const why = root.querySelector('#why');
    if (why) why.textContent = '';
  }

  function paintPath() {
    const cells = root.querySelectorAll('.cell');
    for (const cell of cells) {
      const i = parseInt(cell.getAttribute('data-i'), 10);
      const at = path.indexOf(i);
      cell.className = 'cell' + (at === -1 ? '' : (at === path.length - 1 ? ' on head' : ' on'));
    }
    const line = root.querySelector('#trailline');
    if (line) {
      // Pure arithmetic in a 0–100 box: a render must not have to measure the DOM,
      // and the grid is a fixed 4x4 square whatever size the phone is.
      line.setAttribute('points', path.map(i =>
        ((colOf(i) + 0.5) * 25).toFixed(1) + ',' + ((rowOf(i) + 0.5) * 25).toFixed(1)).join(' '));
    }
    if (path.length) showWord(wordOf(path).toUpperCase(), path.length >= R.MIN ? 'ready' : null);
  }

  function endTrace() {
    if (!tracing) return;
    tracing = false;
    // Whatever square you were over when you let go is the letter you meant.
    if (last) extendTo(cellUnder(last.x, last.y, false));
    last = null;
    const word = wordOf(path);
    path = [];
    paintPath();
    if (word.length < R.MIN) { showWord('—', null); return; }
    settling = word.toUpperCase();
    showWord(settling, 'sent');
    send({ t: 'word', w: word, n: ++submitted });
  }

  function wireBoard() {
    const board = root.querySelector('#board');
    if (!board || !board.addEventListener) return;
    const point = (e) => (e && e.touches && e.touches[0]) || e;
    const at = (e, near) => {
      const p = point(e);
      return (p && typeof p.clientX === 'number') ? cellUnder(p.clientX, p.clientY, near) : -1;
    };
    const moveTo = (e) => {
      const p = point(e);
      if (p && typeof p.clientX === 'number') traceTo(p.clientX, p.clientY);
    };
    board.addEventListener('pointerdown', (e) => {
      geom = measureBoard();
      const i = at(e, false);
      if (i < 0) return;
      if (e.preventDefault) e.preventDefault();
      if (board.setPointerCapture && e.pointerId != null) {
        try { board.setPointerCapture(e.pointerId); } catch (err) {}
      }
      tracing = true;
      settling = null;
      path = [i];
      const p0 = point(e);
      last = { x: p0.clientX, y: p0.clientY };
      feel('tick', { mine: true });
      paintPath();
    });
    board.addEventListener('pointermove', (e) => {
      if (!tracing) return;
      if (e.preventDefault) e.preventDefault();
      moveTo(e);
    });
    board.addEventListener('pointerup', endTrace);
    board.addEventListener('pointercancel', endTrace);
  }

  /* ------------------------------------------------------------ rendering --- */

  function render() {
    if (!view) {
      root.innerHTML = '<div class="wrap"><div class="waiting">Getting the letters…</div></div>';
      lastPhase = null;
      return;
    }
    if (view.phase !== lastPhase) {
      lastPhase = view.phase;
      lastCount = -1;
      lastRevealed = -1;
      path = [];
      tracing = false;
      buildPhase();
    }
    patch();
  }

  function gridHTML(grid) {
    let out = '<div class="boardwrap"><div class="board" id="board">';
    for (let i = 0; i < 16; i++) {
      out += '<div class="cell" data-i="' + i + '"><span>' +
             esc(String(grid[i] || '').toUpperCase()) + '</span></div>';
    }
    out += '</div><svg class="trail" viewBox="0 0 100 100" preserveAspectRatio="none">' +
           '<polyline id="trailline" points=""/></svg></div>';
    return out;
  }

  function buildPhase() {
    const v = view;
    if (v.phase === 'ready') {
      root.innerHTML =
        '<div class="wrap center">' +
          '<div class="brand">SCRAMBLE</div>' +
          '<div class="count" id="ready">' + v.secondsLeft + '</div>' +
          '<div class="big">Round ' + (v.round + 1) + ' of ' + v.rounds + '</div>' +
          '<div class="hint">Drag across the letters to spell a word.<br>' +
          'A word nobody else finds is worth double.</div>' +
        '</div>';
      return;
    }

    if (v.phase === 'round') {
      root.innerHTML =
        '<div class="wrap">' +
          '<div class="hdr">' +
            '<span class="brand">SCRAMBLE</span>' +
            '<span class="sub" id="roundlbl"></span>' +
            '<span class="time" id="time"></span>' +
          '</div>' +
          '<div class="forming" id="forming">—</div>' +
          '<div class="why" id="why"></div>' +
          gridHTML(v.grid) +
          '<div class="chips" id="chips"></div>' +
          '<div class="foot">' +
            '<span id="tally">0 words</span>' +
            '<button id="done" type="button">I’m done</button>' +
          '</div>' +
        '</div>';
      wireBoard();
      root.querySelector('#done').addEventListener('click', () => {
        feel('pass', { mine: true });
        send({ t: 'done' });
      });
      return;
    }

    if (v.phase === 'tally') {
      root.innerHTML =
        '<div class="wrap">' +
          '<div class="hdr">' +
            '<span class="brand">SCRAMBLE</span>' +
            '<span class="sub">Round ' + (v.round + 1) + '</span>' +
            '<span class="time" id="time"></span>' +
          '</div>' +
          '<div class="scored" id="scored"></div>' +
          '<div class="chips" id="chips"></div>' +
          '<div class="foot">' +
            '<span class="hint">Look up.</span>' +
            '<button id="next" type="button">Skip</button>' +
          '</div>' +
        '</div>';
      root.querySelector('#next').addEventListener('click', () => send({ t: 'next' }));
      return;
    }

    root.innerHTML = '<div class="wrap center"><div class="brand">SCRAMBLE</div>' +
      '<div class="big">That’s the game.</div></div>';
  }

  /** Everything that moves while a phase is on screen. */
  function patch() {
    const v = view;

    const ready = root.querySelector('#ready');
    if (ready) {
      if (ready.textContent !== String(v.secondsLeft)) {
        ready.textContent = v.secondsLeft;
        feel('countdown', { el: ready, mine: true });
      }
      return;
    }

    const time = root.querySelector('#time');
    if (time) {
      const waiting = v.phase === 'tally' && v.revealed < v.totalRows;
      time.textContent = waiting ? '…' : clock(v.secondsLeft);
      time.className = 'time' + (v.phase === 'round' && v.secondsLeft <= 10 ? ' low' : '');
      if (v.phase === 'round' && v.secondsLeft <= 10 && v.secondsLeft !== lastSecond) {
        lastSecond = v.secondsLeft;
        feel('tick', { mine: true });
      }
    }

    const roundlbl = root.querySelector('#roundlbl');
    if (roundlbl) roundlbl.textContent = 'Round ' + (v.round + 1) + ' of ' + v.rounds;

    const words = privy.words || [];

    /* Your words, one per line. There is no score on this phone anywhere — not
     * per word, not per round, not a running total. The whole point is that
     * nobody can work out where they stand until the screen says so. During the
     * reveal a line is marked as it is read out, which says WHICH kind of word it
     * was without saying what it was worth. */
    const shownAt = v.phase === 'tally' ? v.revealed : -1;
    if (root.querySelector('#chips') && (words.length !== lastCount || shownAt !== lastRevealed)) {
      lastCount = words.length;
      lastRevealed = shownAt;
      const row = {};
      if (v.rows) v.rows.forEach(r => { row[r.w] = r; });
      root.querySelector('#chips').innerHTML = words.slice().reverse().map(w => {
        const r = row[w];
        const tag = !r ? '' : (r.dup ? '<i>shared</i>' : '<i class="only">only you</i>');
        return '<div class="chip' + (r ? (r.dup ? ' shared' : ' uniq') : '') + '">' +
               '<span>' + esc(w.toUpperCase()) + '</span>' + tag + '</div>';
      }).join('');
    }

    const tallyLine = root.querySelector('#tally');
    if (tallyLine) {
      tallyLine.textContent = words.length + (words.length === 1 ? ' word' : ' words') +
        (v.done[MY] ? ' · waiting' : '');
    }

    const doneBtn = root.querySelector('#done');
    if (doneBtn) doneBtn.disabled = !!v.done[MY];

    const scored = root.querySelector('#scored');
    if (scored) {
      const reading = v.revealed < v.totalRows;
      scored.innerHTML =
        '<div class="big">' + (reading ? 'Reading the round out…' : 'Round scored') + '</div>' +
        '<div class="hint">' + (v.totalRows
          ? (reading ? v.revealed + ' of ' + v.totalRows : 'the screen has the scores')
          : 'nobody found a thing') + '</div>';
    }

    if (privy.ack) {
      const a = privy.ack;
      const readout = root.querySelector('#forming');
      const why = root.querySelector('#why');
      if (readout && settling) {
        readout.textContent = settling;
        readout.className = 'forming ' + (a.why ? 'bad' : 'good');
        if (why) why.textContent = a.why ? (WHY[a.why] || '') : '';
        feel(a.why ? 'blocked' : 'gain', { el: readout, mine: true });
      }
      privy = { words: privy.words, ack: null };    // fired once, not on every render
    }
  }

  render();
}
