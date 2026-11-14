/* SCRAMBLE — the letters live on the TV.
 *
 * Sixteen Boggle dice are rolled onto the shared screen and everyone hunts words
 * at the same time, typing them on their own phone. The party rule: a word that
 * TWO of you found is worth nothing to either of you. So the points are not in
 * finding words, they are in finding the ones nobody else sees — and the longest
 * word nobody else found takes the GOLDEN WORD bonus on top.
 *
 * This game declares `"screen": "required"`. That is not decoration: the grid is
 * on the screen and nowhere else, the way a Boggle box sits in the middle of a
 * table. A phone is a pencil here, and the shell will not let the round start
 * without a display attached.
 *
 * Host authoritative. The rules themselves — the dice, placement, the word list,
 * scoring — live in rules.js, which the fuzzer's bots load too, so the bot cannot
 * be playing a different game from the one that ships.
 *
 * PRIVACY. Your words are yours until the round ends: the host keeps them and
 * sends each player only their OWN list with `sendTo`. The shared screen is fed
 * the broadcast stream and never a `sendTo`, so it cannot show your words even by
 * accident — it is not given them. At the tally they all become public at once,
 * which is the moment the whole game is built around.
 */

function createGame(Table, root) {
  const MY = Table.me.id;
  const R = SCRAMBLE_RULES;

  const ROUNDS = 3;
  const READY_SECONDS = 3;
  const PLAY_SECONDS = 90;
  const TALLY_SECONDS = 16;
  /* A grid with nothing in it is a dead round nobody can do anything about, so a
   * dud is re-rolled rather than handed over. Every roll comes off the same seeded
   * stream, so the re-roll replays exactly like everything else. */
  const MIN_WORDS_ON_GRID = 60;
  const MAX_ROLLS = 8;

  const WHY = {
    letters: 'letters only',
    length:  'words are 3–8 letters',
    grid:    'not on the screen',
    word:    'not in the word list',
    already: 'you already found that'
  };

  let view = null;                       // the public state, as the whole table sees it
  let privy = { words: [], ack: null };  // my own side of it
  let submitted = {};                    // n -> what I typed, so the host never has to echo it
  let nextN = 1;
  let lastPhase = null;
  let lastCount = 0;
  let lastSecond = null;

  function feel(event, opts) {
    try { if (Table.feel) Table.feel(event, opts || {}); } catch (e) {}
  }

  /* ------------------------------------------------------------------ host --- */

  const rng = FR.rng(Table.seed);
  const timer = FR.timers();
  let G = null;
  let found = {};        // playerId -> [word]  — HOST ONLY, private until the tally
  let solution = [];     // HOST ONLY — every word on the grid, so we can say how many
  let table = null;
  let ended = false;

  function initGame(players) {
    G = {
      phase: 'ready', round: 0, rounds: ROUNDS,
      seats: players.map(p => p.id),
      names: {}, emojis: {}, totals: {}, counts: {}, done: {},
      grid: [], possible: 0, secondsLeft: READY_SECONDS,
      rows: null, points: null, golden: [], roundFound: 0
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
    let pts = 0;
    if (!why) {
      list.push(typed);
      pts = R.score(typed);
      G.counts[id] = list.length;
    }
    sendPrivate(id, { n: msg && msg.n, why: why || null, pts });
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

  function endRound() {
    const result = R.tally(found);
    G.rows = result.rows;
    G.points = result.points;
    G.golden = result.golden;
    G.roundFound = result.rows.length;
    G.seats.forEach(id => {
      G.totals[id] = (G.totals[id] || 0) + (result.points[id] || 0);
    });
    // Everything is public now — including each player's own list, which is the
    // reveal. Send it once more so a phone can strike through what was cancelled.
    G.seats.forEach(id => sendPrivate(id, null));
    G.phase = 'tally';
    G.secondsLeft = TALLY_SECONDS;
  }

  function nextRound() {
    if (G.round + 1 >= ROUNDS) return finish();
    G.round++;
    G.rows = null; G.points = null; G.golden = [];
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
        /* Free text: playable, never enumerable. The bundle's bot.mjs supplies it,
         * using the same rules.js the host validates with. */
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
    return {
      phase: G.phase, round: G.round, rounds: G.rounds,
      names: { ...G.names }, emojis: { ...G.emojis },
      seats: G.seats.slice(),
      totals: { ...G.totals }, counts: { ...G.counts }, done: { ...G.done },
      // The grid is public — it is the thing everyone is looking at.
      grid: G.grid.slice(), possible: G.possible,
      secondsLeft: G.secondsLeft,
      // Spoiler-free until the round is over: null during play, by construction.
      rows: G.phase === 'tally' ? G.rows : null,
      points: G.phase === 'tally' ? G.points : null,
      golden: G.phase === 'tally' ? G.golden : [],
      gold: R.GOLD
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
      // Their words stay in the round — a word they found still cancels yours,
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

  function trySubmit() {
    const input = root.querySelector('#entry');
    if (!input) return;
    const typed = String(input.value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    input.value = '';
    if (!typed) return;
    const n = nextN++;
    submitted[n] = typed;
    send({ t: 'word', w: typed, n });
  }

  function clock(seconds) {
    const s = Math.max(0, seconds | 0);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  /* The shell of the screen is built ONCE per phase. Everything that changes
   * second to second is patched in place, because rebuilding the DOM under an
   * open keyboard throws away what someone is halfway through typing. */
  function render() {
    if (!view) {
      root.innerHTML = '<div class="wrap"><div class="waiting">Getting the letters…</div></div>';
      lastPhase = null;
      return;
    }
    if (view.phase !== lastPhase) {
      lastPhase = view.phase;
      lastCount = -1;
      buildPhase();
    }
    patch();
  }

  function buildPhase() {
    const v = view;
    if (v.phase === 'ready') {
      root.innerHTML =
        '<div class="wrap center">' +
          '<div class="brand">SCRAMBLE</div>' +
          '<div class="count" id="ready">' + v.secondsLeft + '</div>' +
          '<div class="big">Round ' + (v.round + 1) + ' of ' + v.rounds + '</div>' +
          '<div class="hint">Look up — the letters are on the screen.<br>' +
          'Anything two of you find is worth nothing to either of you.</div>' +
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
          '<form id="form" autocomplete="off">' +
            '<input id="entry" type="text" inputmode="text" enterkeyhint="go" ' +
              'autocomplete="off" autocorrect="off" autocapitalize="characters" ' +
              'spellcheck="false" placeholder="type a word you can see">' +
          '</form>' +
          '<div class="ack" id="ack">&nbsp;</div>' +
          '<div class="chips" id="chips"></div>' +
          '<div class="foot">' +
            '<span id="tally">0 words</span>' +
            '<button id="done" type="button">I’m done</button>' +
          '</div>' +
        '</div>';
      const form = root.querySelector('#form');
      form.addEventListener('submit', (e) => { e.preventDefault(); trySubmit(); });
      root.querySelector('#done').addEventListener('click', () => {
        feel('pass', { mine: true });
        send({ t: 'done' });
      });
      root.querySelector('#entry').focus();
      return;
    }

    if (v.phase === 'tally') {
      root.innerHTML =
        '<div class="wrap">' +
          '<div class="hdr">' +
            '<span class="brand">SCRAMBLE</span>' +
            '<span class="sub">Round ' + (v.round + 1) + ' scored</span>' +
            '<span class="time" id="time"></span>' +
          '</div>' +
          '<div class="scored" id="scored"></div>' +
          '<div class="chips" id="chips"></div>' +
          '<div class="foot">' +
            '<span class="hint">Cancelled words are crossed out.</span>' +
            '<button id="next" type="button">Next</button>' +
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
      time.textContent = clock(v.secondsLeft);
      time.className = 'time' + (v.phase === 'round' && v.secondsLeft <= 10 ? ' low' : '');
      if (v.phase === 'round' && v.secondsLeft <= 10 && v.secondsLeft !== lastSecond) {
        lastSecond = v.secondsLeft;
        feel('tick', { mine: true });
      }
    }

    const roundlbl = root.querySelector('#roundlbl');
    if (roundlbl) roundlbl.textContent = 'Round ' + (v.round + 1) + ' of ' + v.rounds;

    const words = privy.words || [];
    const chips = root.querySelector('#chips');
    if (chips && words.length !== lastCount) {
      lastCount = words.length;
      const cancelled = {};
      if (v.rows) v.rows.forEach(row => { if (row.dup) cancelled[row.w] = true; });
      chips.innerHTML = words.slice().reverse().map(w =>
        '<span class="chip' + (cancelled[w] ? ' dead' : '') + '">' + esc(w.toUpperCase()) +
        '<i>' + R.score(w) + '</i></span>').join('');
    }

    const tallyLine = root.querySelector('#tally');
    if (tallyLine) {
      tallyLine.textContent = words.length + (words.length === 1 ? ' word' : ' words') +
        (v.done[MY] ? ' · waiting' : '');
    }

    const doneBtn = root.querySelector('#done');
    if (doneBtn) doneBtn.disabled = !!v.done[MY];

    const scored = root.querySelector('#scored');
    if (scored && v.points) {
      const got = v.points[MY] || 0;
      const gold = (v.golden || []).indexOf(MY) !== -1;
      scored.innerHTML =
        '<div class="rscore">+' + got + '</div>' +
        '<div class="hint">' + (gold ? '🏅 GOLDEN WORD — the longest nobody else had' :
          got ? 'from the words only you found' : 'everything you found, somebody else had too') +
        '</div>';
    }

    const ack = root.querySelector('#ack');
    if (ack && privy.ack) {
      const a = privy.ack;
      const word = (submitted[a.n] || '').toUpperCase();
      if (a.why) {
        ack.className = 'ack bad';
        ack.textContent = (word ? word + ' — ' : '') + (WHY[a.why] || 'no good');
        feel('blocked', { el: ack, mine: true });
      } else {
        ack.className = 'ack good';
        ack.textContent = word + ' +' + a.pts;
        feel('gain', { el: ack, mine: true });
      }
      privy = { words: privy.words, ack: null };    // fired once, not on every render
    }
  }

  render();
}
