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
  /* The reveal's pacing. It used to be a flat 420ms a word, which read the whole
   * round out at the same speed whether it was a shared three-letter word or the
   * eight-letter one person saw alone — the scoring went past before anybody
   * could react to it.
   *
   * The running order already climbs (shared short, shared long, then the
   * uniques short to long), so the pacing climbs with it: the bulk goes briskly,
   * a word only one person found is given room, and there is a real beat at the
   * turn where the shared words run out and the uniques begin. The biggest jump
   * on the board is the last one, and now it lands rather than flickers. */
  const REVEAL_SHARED_MS = 520;      // the bulk, where nobody's score moves much
  const REVEAL_UNIQUE_MS = 900;      // one person saw this
  const REVEAL_PER_LETTER_MS = 70;   // and a long one hangs a little longer
  const REVEAL_THEME_MS = 220;       // an occasion word pays double; let it register
  const REVEAL_TURN_MS = 1100;       // the beat before the uniques start
  /* ...all of which is a SHAPE, not a duration. Played out literally, a busy
   * five-player round reads for 55 seconds — longer than the round itself, which
   * is its own kind of wrong. So the weights above are relative, and the whole
   * reveal is fitted into a budget: a long round compresses and keeps its shape,
   * a short one is left alone (the scale never stretches). The floor stops a
   * forty-word round from becoming a flicker. */
  const REVEAL_BUDGET_MS = 30000;
  const REVEAL_MIN_MS = 260;
  const AFTER_REVEAL_SECONDS = 6;    // a beat to read the final board before the next grid
  /* A grid with nothing in it is a dead round nobody can do anything about, so a
   * dud is re-rolled rather than handed over. Every roll comes off the same seeded
   * stream, so the re-roll replays exactly like everything else. */
  const MIN_WORDS_ON_GRID = 60;
  const MAX_ROLLS = 8;

  /* How far out from a tile's middle, as a fraction of the tile, a corner stops
   * answering. The live zone is everything EXCEPT where both axes exceed this —
   * a cross. See cellUnder: 0.20 measured best against synthetic finger paths. */
  const DEAD_CORNER = 0.20;

  /* A themed game is allowed more rolls to find a grid the theme can live on,
   * and stops early once it has this many theme words available. */
  /* How many theme words to plant, and how many planted boards to try before
   * settling for a rolled one. Six is where the measurements stop improving:
   * the dice only carry so many of a theme's letters at once (there is exactly
   * one `b` among the sixteen), so asking for eight gets the same five. */
  const THEME_WORDS_WANTED = 6;
  const PLANT_TRIES = 4;

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
  let revealPlan = [];   // HOST ONLY — how long to hold before each of those rows
  let solution = [];     // HOST ONLY — every word on the grid, for the "were there" count
  let table = null;
  let ended = false;

  function initGame(players) {
    G = {
      /* The table picks an occasion before the first grid. It is one tap and the
       * host makes it, so it costs a party nothing and it is the difference
       * between a word game and a word game AT a baby shower. */
      phase: 'setup', round: 0, rounds: ROUNDS,
      theme: 'none',
      seats: players.map(p => p.id),
      names: {}, emojis: {}, totals: {}, counts: {}, done: {},
      grid: [], possible: 0, themeOnGrid: 0, secondsLeft: READY_SECONDS,
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

  /**
   * Roll a grid worth playing, and under a theme, one worth playing THAT theme on.
   *
   * Sixteen dice do not care what day it is: a Christmas grid with no Christmas
   * word on it is a theme in name only, and a table would notice by the end of
   * round one. So a themed game keeps rolling and takes the grid that offers the
   * most theme words, with the playable-grid floor still the thing that decides
   * when a roll is good enough to stop early.
   *
   * Counting theme words is cheap — a hundred `placeable` calls against a list,
   * not another pass over the dictionary — so this costs one extra solve per
   * extra roll and nothing else. Every roll comes off the seeded stream, so the
   * grid the table gets is still a pure function of the seed.
   */
  function rollGrid() {
    const themed = G.theme && G.theme !== 'none';
    let best = null;

    const consider = (grid) => {
      const words = R.solve(grid, G.theme);
      const hits = themed ? R.themeHits(grid, G.theme) : 0;
      const cand = { grid, words, hits, ok: words.length >= MIN_WORDS_ON_GRID };
      if (!best || better(cand, best)) best = cand;
      return cand.ok;
    };

    /* A themed grid is BUILT, not hoped for. Re-rolling found an average of two
     * baby words on a board of 143 — the occasion was a scoring rule and a
     * colour scheme and nothing you could see in the letters. Planting puts the
     * words in and then lets the dice fill the rest, which roughly doubles it;
     * the playability floor still decides whether a grid is good enough to keep,
     * and a planted board that fails it falls through to an ordinary roll. */
    if (themed) {
      for (let i = 0; i < PLANT_TRIES; i++) {
        const made = R.plant(G.theme, rng, THEME_WORDS_WANTED);
        if (!made) break;
        if (consider(made.grid)) break;
      }
    }
    if (!best || !best.ok) {
      for (let i = 0; i < MAX_ROLLS; i++) if (consider(R.roll(rng))) break;
    }

    G.grid = best.grid;
    solution = best.words;
    G.possible = best.words.length;
    G.themeOnGrid = best.hits;
    found = {};
    G.seats.forEach(id => { G.counts[id] = 0; G.done[id] = false; });
  }

  /** A playable grid beats an unplayable one; after that, more theme words wins. */
  function better(a, b) {
    if (a.ok !== b.ok) return a.ok;
    if (a.hits !== b.hits) return a.hits > b.hits;
    return a.words.length > b.words.length;
  }

  /** Accept or refuse one word. The word itself never travels back. */
  function submit(id, msg) {
    const typed = String(msg && msg.w != null ? msg.w : '').toLowerCase().replace(/[^a-z]/g, '');
    const list = found[id] || (found[id] = []);
    let why = R.check(G.grid, typed, G.theme);
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

  /** Lock the occasion in and roll the first grid for it. */
  function chooseTheme(key) {
    if (G.phase !== 'setup') return;
    G.theme = R.themeOf(key);
    rollGrid();                       // the first grid is chosen FOR the theme
    G.phase = 'ready';
    G.secondsLeft = READY_SECONDS;
  }

  function beginRound() {
    G.phase = 'round';
    G.secondsLeft = PLAY_SECONDS;
  }

  /* The reveal. Points land on the board one word at a time rather than all at
   * once, because watching it climb IS the scoring. The host drives it so every
   * screen and every phone is on the same word. */
  function endRound() {
    const result = R.tally(found, G.theme);
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
    planReveal();
    scheduleReveal();
  }

  /** What a word is WORTH in time, before the budget is applied. */
  function revealWeight(row, at) {
    var ms = row.dup ? REVEAL_SHARED_MS : REVEAL_UNIQUE_MS;
    ms += Math.max(0, row.w.length - 3) * REVEAL_PER_LETTER_MS;
    if (row.theme) ms += REVEAL_THEME_MS;
    // The turn: the first word nobody else found. Everything after this is
    // somebody pulling ahead, so the room gets a moment to notice it starting.
    if (!row.dup && at > 0 && pending[at - 1] && pending[at - 1].dup) ms += REVEAL_TURN_MS;
    return ms;
  }

  /** Fit the whole running order into the budget, keeping its shape. */
  function planReveal() {
    const raw = pending.map(revealWeight);
    const total = raw.reduce((a, b) => a + b, 0);
    const scale = total > REVEAL_BUDGET_MS ? REVEAL_BUDGET_MS / total : 1;
    revealPlan = raw.map(ms => Math.max(REVEAL_MIN_MS, Math.round(ms * scale)));
  }

  /* Self-scheduling rather than a fixed interval, because every word now waits a
   * different amount of time. */
  function scheduleReveal() {
    const at = G.revealed;
    const next = pending[at];
    if (!next) { timer.cancel('reveal'); return; }
    timer.after('reveal', revealPlan[at] || REVEAL_MIN_MS, () => {
      revealNext();
      syncAll();
      scheduleReveal();
    });
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
  function revealAll() {
    timer.cancel('reveal');            // nothing left to land on its own
    while (revealNext()) { /* keep going */ }
  }

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
        next: { phase: 'tally', run: () => nextRound() },
        /* The occasion. Host-only — it is the host's party — but declared with
         * `options` so the headless bots pick one too and every theme's scoring
         * gets played rather than merely unit-tested. */
        theme: {
          phase: 'setup',
          when: (ctx) => ctx.from === MY,
          options: () => R.THEME_KEYS.map((k) => ({ k: k })),
          run: (ctx) => chooseTheme(ctx.msg && ctx.msg.k)
        }
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
      /* The screen runs screen.js ALONE — no rules.js, no dictionary — so a
       * theme's name and emoji travel with the state rather than being looked
       * up. A screen that had to import the rules to render a label would be a
       * second copy of the rules on a device that cannot run them. */
      theme: G.theme, themeOnGrid: G.themeOnGrid,
      themeName: R.THEMES[G.theme].name,
      themeEmoji: R.THEMES[G.theme].emoji,
      /* ...and so do its colours, for the same reason. A phone could look the
       * palette up in rules.js and does; the screen has no rules.js to look in. */
      palette: { ...R.THEMES[G.theme].palette },
      themeBonus: R.THEME_BONUS,
      themeChoices: G.phase === 'setup'
        ? R.THEME_KEYS.map((k) => ({
            k: k, name: R.THEMES[k].name, emoji: R.THEMES[k].emoji,
            // The TV shows the choice in its own colours, so each option carries
            // them; they go away with the picker, one phase later.
            palette: { ...R.THEMES[k].palette }
          }))
        : null,
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
   * There are two ways to get this wrong and they pull in opposite directions.
   *
   * Hit-test the whole RECTANGLE and a finger sweeping toward the tile
   * diagonally below clips the corner of one it never meant to touch — and that
   * tile IS adjacent, so the letter lands in the word. Driving the real grid
   * with synthetic finger paths: 31% of words came out with a letter in them
   * that nobody drew.
   *
   * Answer only near the MIDDLE and the opposite happens. A hand does not stop
   * at each tile's centre, it ROUNDS the turn — so a tile the word genuinely
   * passes through never reports, and the letter vanishes. Same measurement
   * against a 26%-of-a-tile middle: 69% of words lost a letter. That is the
   * version that shipped, and it is why diagonals felt dead.
   *
   * So the live zone is a CROSS: the full width of the tile through its middle
   * both ways, with the four corners dead. You can enter from any edge straight
   * on, because that is where an across-or-down move crosses; but the one place
   * four tiles meet answers for none of them, so a diagonal sweep passes through
   * it cleanly. Measured the same way, at a hand wobble of 0, 10% and 20% of a
   * tile: 100%, 98%, 92% of words come out exactly as drawn.
   *
   * The first and last touches are the exception — they take the whole square,
   * corners and gaps included. Neither can insert a letter into the MIDDLE of a
   * word: one has no path yet and the other ends it. That asymmetry is what
   * lets the middle stay strict.
   */
  function cellUnder(x, y, near) {
    if (!geom) return -1;
    const col = Math.floor((x - geom.x) / geom.w);
    const row = Math.floor((y - geom.y) / geom.h);
    if (col < 0 || col > 3 || row < 0 || row > 3) return -1;
    if (!near) return row * 4 + col;
    const dx = Math.abs(x - (geom.x + (col + 0.5) * geom.w)) / geom.w;
    const dy = Math.abs(y - (geom.y + (row + 0.5) * geom.h)) / geom.h;
    return (dx > DEAD_CORNER && dy > DEAD_CORNER) ? -1 : row * 4 + col;
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
    const wordEl = root.querySelector('#fword');
    if (wordEl) wordEl.textContent = text || '—';
    else readout.textContent = text || '—';
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

  /* The occasion repaints the room.
   *
   * These are exactly the custom properties `:root` declares in index.html, so
   * every rule in the stylesheet follows the theme without knowing that themes
   * exist — and nothing in the markup has to be re-rendered to change colour.
   * Keyed on the theme, so it writes fourteen properties once a game rather than
   * on every state broadcast, and it is a no-op under the headless harness,
   * which has no documentElement to style. */
  let painted = null;
  function paint(key) {
    const k = R.themeOf(key || 'none');
    if (k === painted) return;
    painted = k;
    const el = typeof document !== 'undefined' && document.documentElement;
    if (!el || !el.style || !el.style.setProperty) return;
    const p = R.THEMES[k].palette;
    R.PALETTE_KEYS.forEach((name) => el.style.setProperty('--' + name.toLowerCase(), p[name]));
  }

  function render() {
    paint(view && view.theme);
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

    /* One tap, on the host's phone, before anything else happens. A screen is
     * required for this game, so everyone is already looking at the same place
     * to see what got picked. */
    if (v.phase === 'setup') {
      if (!Table.isHost) {
        root.innerHTML = '<div class="wrap center">' +
          '<div class="brand">SCRAMBLE</div>' +
          '<div class="waiting">The host is picking the occasion…</div></div>';
        return;
      }
      root.innerHTML =
        '<div class="wrap center">' +
          '<div class="brand">SCRAMBLE</div>' +
          '<div class="big">What\u2019s the occasion?</div>' +
          '<div class="themes">' +
            /* Each row wears the palette it would apply, because "Christmas" is
             * a word and the green is the thing being chosen. The colours come
             * off the theme, never out of this file — see index.html's :root. */
            R.THEME_KEYS.map((k) => {
              const t = R.THEMES[k], p = t.palette;
              return '<button class="theme" type="button" data-k="' + esc(k) + '"' +
                ' style="background:' + p.bg1 + ';border-color:' + p.line +
                ';color:' + p.text + '">' +
                '<span class="te">' + esc(t.emoji) + '</span>' +
                '<span class="tt"><b>' + esc(t.name) + '</b>' +
                '<i style="color:' + p.muted + '">' + esc(t.blurb) + '</i></span>' +
                '<span class="sw"><i style="background:' + p.accent + '"></i>' +
                '<i style="background:' + p.tile + '"></i>' +
                '<i style="background:' + p.good + '"></i></span></button>';
            }).join('') +
          '</div>' +
        '</div>';
      const buttons = root.querySelectorAll('.theme');
      for (const b of buttons) {
        b.addEventListener('click', () => {
          feel('arrive', { mine: true });
          send({ t: 'theme', k: b.getAttribute('data-k') });
        });
      }
      return;
    }

    if (v.phase === 'ready') {
      root.innerHTML =
        '<div class="wrap center">' +
          '<div class="brand">SCRAMBLE</div>' +
          '<div class="count" id="ready">' + v.secondsLeft + '</div>' +
          '<div class="big">Round ' + (v.round + 1) + ' of ' + v.rounds + '</div>' +
          '<div class="hint">Drag across the letters to spell a word.<br>' +
          'A word nobody else finds is worth double.' +
          (v.theme && v.theme !== 'none'
            ? '<br>' + esc(R.THEMES[v.theme].emoji) + ' ' +
              esc(R.THEMES[v.theme].name) + ' words count double too.' +
              /* The promise, in numbers. The occasion used to be a scoring rule
               * and a colour scheme — nothing you could point at in the letters.
               * Now the words are planted in the grid, so the grid can say so,
               * and a table starts the round hunting for them. */
              (v.themeOnGrid > 0
                ? '<br><b>' + v.themeOnGrid + ' of them ' +
                  (v.themeOnGrid === 1 ? 'is' : 'are') + ' hiding in this grid.</b>'
                : '')
            : '') + '</div>' +
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
          '<div class="forming" id="forming">' +
            '<span id="fword">—</span><span class="rz" id="why"></span></div>' +
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
      /* The last ten seconds, in the hand as well as on the wall.
       *
       * This used to be `tick`, which is a light haptic and a soft click — a
       * notice you do not get while dragging a finger across a grid and staring
       * at the television. `countdown` is the shell's countdown cue, and `mine`
       * escalates it to a heavy thump for the final three, so the round does not
       * simply stop while somebody is halfway through a word. */
      if (v.phase === 'round' && v.secondsLeft <= 10 && v.secondsLeft !== lastSecond) {
        lastSecond = v.secondsLeft;
        if (v.secondsLeft > 0) feel('countdown', { mine: v.secondsLeft <= 3 });
        else feel('blocked', { mine: true });        // pencils down
      }
    }

    const roundlbl = root.querySelector('#roundlbl');
    if (roundlbl) {
      roundlbl.textContent = 'Round ' + (v.round + 1) + ' of ' + v.rounds +
        (v.theme && v.theme !== 'none' ? ' ' + (v.themeEmoji || '') : '');
    }

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
        const themeTag = r && r.theme
          ? '<i class="thm">' + esc(R.THEMES[v.theme].emoji) + '</i>' : '';
        const tag = !r ? '' : (r.dup ? '<i>shared</i>' : '<i class="only">only you</i>');
        return '<div class="chip' + (r ? (r.dup ? ' shared' : ' uniq') : '') +
               (r && r.theme ? ' thm' : '') + '">' +
               '<span>' + esc(w.toUpperCase()) + '</span>' +
               '<span class="tags">' + themeTag + tag + '</span></div>';
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
        const wordEl = root.querySelector('#fword');
        if (wordEl) wordEl.textContent = settling; else readout.textContent = settling;
        readout.className = 'forming ' + (a.why ? 'bad' : 'good');
        if (why) why.textContent = a.why ? (WHY[a.why] || '') : '';
        feel(a.why ? 'blocked' : 'gain', { el: readout, mine: true });
      }
      privy = { words: privy.words, ack: null };    // fired once, not on every render
    }
  }

  render();
}
