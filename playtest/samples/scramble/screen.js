/* SCRAMBLE — the shared screen.
 *
 * This one is not optional, and the reason is the SCORING. Every player traces
 * words on their own phone and nobody is told a single score while the clock is
 * running; when the round ends it is read out here, one word at a time, in front
 * of everyone — short shared words first, then the long shared ones, then the
 * uniques from short to long, so the board barely moves and then starts jumping
 * and the last word is the longest thing one person saw alone. A phone cannot be
 * the place a table watches that happen. `"screen": "required"` is the shell's
 * version of that sentence.
 *
 * It can show the letters and the scores because both are public. It cannot show
 * anybody's words during a round because it is never given them — the host sends
 * each player's list with `sendTo`, and a screen receives only broadcasts. It
 * cannot run ahead during the reveal either: the host broadcasts the words it has
 * already read out and no more.
 *
 * Pure JS, no DOM: on an Apple TV this runs under JavaScriptCore and draws into a
 * SwiftUI Canvas. Everything goes through the recorded canvas vocabulary.
 *
 * A note on case. Everything drawn here is UPPERCASE, because that is how a letter
 * grid should look from across a room — and for no other reason. It is worth being
 * explicit about that, because uppercasing LOOKS like a privacy measure and is the
 * opposite of one: a screen that rendered a player's private word list drew "CATS"
 * while the wire said "cats", and the leak check, which compared strings, saw
 * nothing wrong. That is why the harness now probes with a sentinel instead of
 * hunting for English inside English (see harness/screen.mjs). The protection here
 * is one line and nothing else: only `t:'state'` is ever read.
 */
function createScreen(Table, screen) {
  var view = null;
  var motion = FRScreen.motion();

  Table.onMessage(function (_from, msg) {
    if (msg && msg.t === 'state') view = msg.s;
  });

  /* The palette is the THEME'S, and it arrives in the host's broadcast — this
   * file has no rules.js to look it up in. Everything drawn below reads these
   * variables and nothing writes a colour of its own: a literal here is a patch
   * of the TV that stays purple at Christmas, so `invariants.mjs` fails the
   * bundle if one appears outside the fallback block.
   *
   * The fallback is Classic, for the seconds before the first broadcast lands,
   * and it is the one copy of those values that is not in rules.js. */
  var FALLBACK = {
    glow: '#3b2660', bg1: '#2a1b45', bg2: '#160d27',
    panel: '#352457', line: '#4b3677',
    text: '#f4eeff', muted: '#a493c7',
    accent: '#ffd166', accentLit: '#fff0c2',
    good: '#6ee7a8', bad: '#ff7a8a',
    tile: '#f3e9d2', tileInk: '#2a1b45',
    spark: '#8ab6ff'
  };

  var BG, INK, DIM, FAINT, TILE, TILEINK, GOLD, HOT, GOOD, SPARK;
  var PAID_TINT, HIT_TINT, SEAT_TINT;
  var applied = null;

  /* Alpha variants are derived rather than declared, so a theme states each
   * colour once and the translucent versions can never disagree with it. */
  function alpha(hex, a) {
    var n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function usePalette(p) {
    if (!p || !p.bg2) p = FALLBACK;
    if (p.bg2 === applied) return;        // once a game, not once a frame
    applied = p.bg2;
    BG = p.bg2; INK = p.text; TILE = p.tile; TILEINK = p.tileInk;
    GOLD = p.accent; HOT = p.bad; GOOD = p.good; SPARK = p.spark;
    DIM = alpha(p.text, 0.55);
    FAINT = alpha(p.text, 0.12);
    PAID_TINT = alpha(p.good, 0.26);
    HIT_TINT = alpha(p.accent, 0.22);
    SEAT_TINT = alpha(p.text, 0.07);
  }

  usePalette(FALLBACK);

  var PLAY_SECONDS = 90;        // only for the bar's fullness; the host owns the clock

  function up(s) { return String(s == null ? '' : s).toUpperCase(); }

  function text(ctx, s, x, y, size, color, align, baseline) {
    ctx.fillStyle = color;
    ctx.font = (Math.max(6, size) | 0) + 'px sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = baseline || 'middle';
    ctx.fillText(s, x, y);
  }

  /** The same width estimate fitFont and the layout checker both use. */
  function widthOf(s, size) { return String(s).length * size * 0.55; }

  function fitted(ctx, s, maxW, maxSize, x, y, color, align, baseline) {
    var size = FRScreen.fitFont(s, maxW, maxSize, 6);
    text(ctx, s, x, y, size, color, align, baseline);
    return size;
  }

  function panel(ctx, x, y, w, h, radius, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  }

  /* ------------------------------------------------------------- pieces --- */

  function drawHead(ctx, b, head, v) {
    var mid = head.y + head.h * 0.40;
    var left = 'ROUND ' + (v.round + 1) + ' OF ' + v.rounds +
               (v.theme && v.theme !== 'none' ? '   ' + (v.themeEmoji || '') : '');
    fitted(ctx, left, head.w * 0.5, head.h * 0.46, head.x, mid, INK, 'left', 'middle');

    var right = '', color = DIM;
    if (v.phase === 'round') {
      var s = Math.max(0, v.secondsLeft | 0);
      right = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      color = s <= 10 ? HOT : INK;
    } else if (v.phase === 'tally') {
      right = 'NEXT IN ' + Math.max(0, v.secondsLeft | 0);
    } else if (v.phase === 'ready') {
      right = 'GET READY';
    }
    if (right) fitted(ctx, right, head.w * 0.3, head.h * 0.46, head.x + head.w, mid, color, 'right', 'middle');

    // The clock as a bar, for the half of the room that is not reading numbers.
    var barY = head.y + head.h * 0.78, barH = Math.max(2, head.h * 0.08);
    panel(ctx, head.x, barY, head.w, barH, barH / 2, FAINT);
    if (v.phase === 'round') {
      var frac = Math.max(0, Math.min(1, v.secondsLeft / PLAY_SECONDS));
      if (frac > 0) {
        panel(ctx, head.x, barY, head.w * frac, barH, barH / 2,
              v.secondsLeft <= 10 ? HOT : GOOD);
      }
    }
  }

  function drawGrid(ctx, box, v, now) {
    var grid = v.grid || [];
    if (!grid.length) return;
    var side = Math.min(box.w, box.h) * 0.94;
    var cell = side / 4;
    var pad = cell * 0.07;
    var x0 = box.x + (box.w - side) / 2;
    var y0 = box.y + (box.h - side) / 2;

    // A whole-grid settle when a new one is rolled: the letters land together.
    var land = motion.pulse('grid', grid.join(''), now, 650);
    var lift = FRScreen.ease.outCubic(1 - land) * 1 + land * 0;

    for (var i = 0; i < 16; i++) {
      var col = i % 4, row = (i / 4) | 0;
      var cx = x0 + col * cell, cy = y0 + row * cell;
      var inset = pad + (1 - lift) * cell * 0.12;
      var w = cell - inset * 2;
      if (w <= 1) continue;
      panel(ctx, cx + inset, cy + inset, w, w, w * 0.17, TILE);

      var letter = up(grid[i]);
      fitted(ctx, letter, w * 0.72, cell * 0.5,
             cx + cell / 2, cy + cell / 2 + cell * 0.02, TILEINK, 'center', 'middle');
    }
  }

  function drawReady(ctx, box, v, now) {
    var n = Math.max(0, v.secondsLeft | 0);
    var pop = motion.pulse('ready', n, now, 400);
    fitted(ctx, String(n), box.w * 0.4, box.h * 0.46 * (1 + pop * 0.08),
           box.cx, box.y + box.h * 0.42, GOLD, 'center', 'middle');
    fitted(ctx, 'LOOK UP — LETTERS COMING', box.w * 0.8, box.h * 0.1,
           box.cx, box.y + box.h * 0.78, DIM, 'center', 'middle');
  }

  function drawWaiting(ctx, b, line) {
    fitted(ctx, 'SCRAMBLE', b.w * 0.7, b.u(0.14), b.cx, b.cy - b.u(0.05), GOLD, 'center', 'middle');
    fitted(ctx, line, b.w * 0.7, b.u(0.05), b.cx, b.cy + b.u(0.07), DIM, 'center', 'middle');
  }

  /* THE REVEAL — the reason this game needs a screen at all.
   *
   * One word at a time, in the running order the host built: short shared words
   * first (everyone scores, nobody moves), then long shared ones, then the
   * uniques from short to long. So the board barely shifts for the first half and
   * then starts jumping, and the last word read out is the longest thing one
   * person saw alone. The host drives the pacing, so every screen in the room is
   * on the same word.
   *
   * Only the words already read out are even on this device — the host sends the
   * revealed slice and nothing more, so there is no way to run ahead.
   */
  /* The occasion, while the host is choosing it. A screen is REQUIRED for this
   * game, so this is where the table finds out what it is playing — the host is
   * looking down at three buttons and everyone else is looking up at this. */
  function drawSetup(ctx, box, v, now) {
    fitted(ctx, 'WHAT\u2019S THE OCCASION?', box.w * 0.8, box.h * 0.13,
           box.cx, box.y + box.h * 0.2, INK, 'center', 'middle');

    var choices = v.themeChoices || [];
    if (!choices.length) {
      fitted(ctx, 'GETTING READY', box.w * 0.6, box.h * 0.1,
             box.cx, box.cy, DIM, 'center', 'middle');
      return;
    }
    /* Each option is shown in the palette it would paint the room with — the
     * table is choosing a colour as much as a word list, and this is the one
     * surface everybody is already looking at. */
    var n = choices.length;
    var slotW = box.w / n;
    var cardW = slotW * 0.84, cardH = box.h * 0.44, cardY = box.y + box.h * 0.32;
    for (var i = 0; i < n; i++) {
      var cx = box.x + slotW * (i + 0.5);
      var p = choices[i].palette || FALLBACK;
      panel(ctx, cx - cardW / 2, cardY, cardW, cardH, cardH * 0.12, p.bg1);
      panel(ctx, cx - cardW / 2, cardY, cardW, cardH * 0.035, cardH * 0.02, p.accent);
      var bob = Math.sin(now / 520 + i * 1.1) * box.h * 0.012;
      fitted(ctx, choices[i].emoji, cardW * 0.5, box.h * 0.2,
             cx, cardY + cardH * 0.42 + bob, p.text, 'center', 'middle');
      fitted(ctx, up(choices[i].name), cardW * 0.82, box.h * 0.075,
             cx, cardY + cardH * 0.8, p.text, 'center', 'middle');
    }
    fitted(ctx, 'THE HOST IS PICKING', box.w * 0.6, box.h * 0.07,
           box.cx, box.y + box.h * 0.9, FAINT, 'center', 'middle');
  }

  function drawTally(ctx, box, v, b, now) {
    var rows = v.rows || [];
    var total = v.totalRows || 0;
    var current = rows.length ? rows[rows.length - 1] : null;

    var counter = total ? v.revealed + ' OF ' + total : 'NOBODY FOUND A THING';
    fitted(ctx, counter, box.w * 0.6, box.h * 0.07, box.cx, box.y + box.h * 0.06,
           DIM, 'center', 'middle');

    if (!current) {
      fitted(ctx, 'ROUND ' + (v.round + 1) + ' SCORED', box.w * 0.8, box.h * 0.12,
             box.cx, box.cy, DIM, 'center', 'middle');
      return;
    }

    // The word itself, landing. A new one arrives scaled up and settles.
    var pop = motion.pulse('word', current.w, now, 320);
    var grow = 1 + FRScreen.ease.outCubic(pop) * 0.12;
    var shared = current.dup;
    fitted(ctx, up(current.w), box.w * 0.84, box.h * 0.26 * grow,
           box.cx, box.y + box.h * 0.32, shared ? INK : GOLD, 'center', 'middle');

    var label = shared ? 'SHARED · +' + current.value + ' EACH'
                       : 'ONLY THEM · ' + current.pts + ' ×' + (v.unique || 2) +
                         ' = +' + current.value;
    fitted(ctx, label, box.w * 0.7, box.h * 0.09,
           box.cx, box.y + box.h * 0.52, shared ? DIM : GOOD, 'center', 'middle');

    /* A theme word gets its own line rather than a longer label: this is the
     * moment the occasion pays off, and it should read across a room. */
    if (current.theme) {
      var thm = (v.themeEmoji || '') + ' ' + up(v.themeName || '') + ' WORD · ×' +
                (v.themeBonus || 2);
      var flash = 0.6 + 0.4 * Math.abs(Math.sin(now / 300));
      fitted(ctx, thm, box.w * 0.7, box.h * 0.075,
             box.cx, box.y + box.h * 0.60, flash > 0.85 ? INK : GOLD, 'center', 'middle');
    }

    // Who it just paid.
    var who = (current.by || []).map(function (id) {
      return ((v.emojis || {})[id] || '') + ' ' + up((v.names || {})[id] || '');
    }).join('   ');
    fitted(ctx, who, box.w * 0.9, box.h * 0.1,
           box.cx, box.y + box.h * 0.68, INK, 'center', 'middle');

    // A thin bar for how far through the reading we are.
    if (total) {
      var barW = box.w * 0.6, barH = Math.max(2, box.h * 0.016);
      var barX = box.cx - barW / 2, barY = box.y + box.h * 0.84;
      panel(ctx, barX, barY, barW, barH, barH / 2, FAINT);
      panel(ctx, barX, barY, barW * (v.revealed / total), barH, barH / 2, GOOD);
    }
  }

  function drawWinner(ctx, box, v, b, now) {
    var seats = v.seats || [];
    var best = null;
    for (var i = 0; i < seats.length; i++) {
      var id = seats[i], n = (v.totals || {})[id] || 0;
      if (!best || n > best.n) best = { id: id, n: n };
    }
    if (motion.pulse('win', best ? best.id : '-', now, 1) > 0.99) {
      motion.burst(box.cx, box.y + box.h * 0.4, {
        count: 90, speed: 420, life: 2600, size: b.u(0.018),
        colors: [GOLD, HOT, GOOD, SPARK]
      });
    }
    var who = best ? ((v.emojis || {})[best.id] || '') + ' ' + up((v.names || {})[best.id] || '') : '';
    fitted(ctx, who || 'NOBODY', box.w * 0.85, box.h * 0.3, box.cx, box.y + box.h * 0.38,
           GOLD, 'center', 'middle');
    fitted(ctx, 'SAW THE MOST', box.w * 0.6, box.h * 0.12, box.cx, box.y + box.h * 0.66,
           INK, 'center', 'middle');
  }

  /* --------------------------------------------------------- the people --- */

  /* What a name is worth looking at right now.
   *
   * During a round that is a WORD COUNT and nothing else. Scores do not exist on
   * this screen while the clock is running — not hidden, not greyed out: the host
   * does not send them, so there is nothing here to show. Knowing Ava has eleven
   * words and you have four is the right amount of pressure; knowing she is nine
   * points ahead would just tell you to give up. */
  function cellValue(v, id) {
    if (v.phase === 'round' || v.phase === 'ready') {
      return String((v.counts || {})[id] || 0) + ((v.done || {})[id] ? ' ✓' : '');
    }
    return String(Math.round(motion.follow('t' + id, (v.totals || {})[id] || 0, 0.22, screen.dt)));
  }

  /** Did the word being read out just pay this person? */
  function justPaid(v, id) {
    var rows = v.rows || [];
    var row = rows.length ? rows[rows.length - 1] : null;
    return !!(row && row.by && row.by.indexOf(id) !== -1);
  }

  function shortName(v, id) {
    var name = up((v.names || {})[id] || '');
    if (name.length > 9) name = name.slice(0, 8) + '…';
    var emoji = (v.emojis || {})[id] || '';
    return (emoji ? emoji + ' ' : '') + name;
  }

  /* Everyone is on the board for the scoring, in seat order so nobody has to
   * find themselves again between words. */
  function highlight(v, id, now) {
    var paid = v.phase === 'tally' && justPaid(v, id);
    var hit = motion.pulse('p' + id, cellValue(v, id), now, 600);
    if (paid) return PAID_TINT;
    if (hit > 0) return HIT_TINT;
    return SEAT_TINT;
  }

  /** A TV is wide: the table goes down the right-hand side. */
  function drawPeopleColumn(ctx, box, v, now) {
    var seats = v.seats || [];
    if (!seats.length) return;
    var rowH = Math.min(box.h / Math.max(seats.length, 1), box.h * 0.2);
    var top = box.y + (box.h - rowH * seats.length) / 2;
    for (var i = 0; i < seats.length; i++) {
      var id = seats[i];
      var y = top + rowH * i;
      panel(ctx, box.x, y + rowH * 0.08, box.w, rowH * 0.84, rowH * 0.18, highlight(v, id, now));
      fitted(ctx, shortName(v, id), box.w * 0.62, rowH * 0.34,
             box.x + box.w * 0.06, y + rowH * 0.5, INK, 'left', 'middle');
      fitted(ctx, cellValue(v, id), box.w * 0.3, rowH * 0.4,
             box.x + box.w * 0.94, y + rowH * 0.5,
             justPaid(v, id) && v.phase === 'tally' ? GOOD : INK, 'right', 'middle');
    }
  }

  /** An iPad stood up is tall: the table goes along the bottom instead. */
  function drawPeopleStrip(ctx, box, v, now) {
    var seats = v.seats || [];
    if (!seats.length) return;
    var colW = box.w / seats.length;
    for (var i = 0; i < seats.length; i++) {
      var id = seats[i];
      var x = box.x + colW * i;
      panel(ctx, x + colW * 0.05, box.y + box.h * 0.1, colW * 0.9, box.h * 0.8, colW * 0.12,
            highlight(v, id, now));
      fitted(ctx, shortName(v, id), colW * 0.82, box.h * 0.22,
             x + colW / 2, box.y + box.h * 0.34, INK, 'center', 'middle');
      fitted(ctx, cellValue(v, id), colW * 0.82, box.h * 0.34,
             x + colW / 2, box.y + box.h * 0.68,
             justPaid(v, id) && v.phase === 'tally' ? GOOD : INK, 'center', 'middle');
    }
  }

  /* ---------------------------------------------------------------- draw --- */

  screen.onDraw(function (ctx, env) {
    var b = FRScreen.box(env);
    var now = env.t;

    usePalette(view && view.palette);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, env.width, env.height);

    if (!view) { drawWaiting(ctx, b, 'WAITING FOR THE TABLE…'); return; }
    var v = view;
    if (!v.seats || !v.seats.length) { drawWaiting(ctx, b, 'WAITING FOR PLAYERS…'); return; }

    var head = { x: b.x, y: b.y, w: b.w, h: b.u(0.11) };
    var restY = head.y + head.h, restH = b.h - head.h;
    var main, people, tall = b.portrait;

    if (tall) {
      var ph = Math.min(restH * 0.3, b.u(0.3));
      main = FRScreen.box({ width: env.width, height: env.height,
        safe: { top: restY, left: b.x, right: env.width - b.right, bottom: env.height - (restY + restH - ph) } });
      people = { x: b.x, y: restY + restH - ph, w: b.w, h: ph };
    } else {
      var pw = Math.max(b.w * 0.22, b.u(0.26));
      main = FRScreen.box({ width: env.width, height: env.height,
        safe: { top: restY, left: b.x, right: env.width - (b.right - pw - b.u(0.03)), bottom: env.height - b.bottom } });
      people = { x: b.right - pw, y: restY, w: pw, h: restH };
    }

    drawHead(ctx, b, head, v);

    if (v.phase === 'setup') drawSetup(ctx, main, v, now);
    else if (v.phase === 'ready') drawReady(ctx, main, v, now);
    else if (v.phase === 'round') drawGrid(ctx, main, v, now);
    else if (v.phase === 'tally') drawTally(ctx, main, v, b, now);
    else drawWinner(ctx, main, v, b, now);

    if (tall) drawPeopleStrip(ctx, people, v, now);
    else drawPeopleColumn(ctx, people, v, now);

    // Confetti stays inside the safe rectangle — a TV's overscan would eat it,
    // and a square drawn off the panel is a layout bug like any other.
    motion.particles(ctx, screen.dt, { bounds: { x: b.x, y: b.y, w: b.w, h: b.h } });
  });
}
