/* HOLD'EM — the felt.
 *
 * This is the file the game is built around. Poker on phones alone is six people
 * looking down; poker with the board in the middle of the room is a card game.
 * So everything public lives here — the five community cards, the pot, every
 * seat's chips, the button, whose decision the table is waiting on — and a phone
 * is left with the one thing that is nobody else's business.
 *
 * WHAT IS NOT HERE, AND WHY IT CANNOT BE
 *
 * Hole cards. Not because this file is careful, but because it is never given
 * them: the host deals with `Table.sendTo` and a screen receives only broadcasts.
 * The one message type read below is the public `{t:'state'}`. The host's private
 * deal is `{t:'hole'}` and nothing here looks at it — which is exactly what the
 * screen harness probes, by handing this file the private payload anyway and
 * again with every string replaced by a sentinel.
 *
 * Cards do appear here at the showdown, from `state.reveal` — because at a
 * showdown they are public, on a broadcast, in front of everybody. That is the
 * only route by which a card reaches this screen, and it is the host's decision
 * rather than this file's.
 *
 * NO DOM. This runs under JavaScriptCore on an Apple TV, which has no WebKit at
 * all. Everything is the recorded canvas vocabulary, laid out from the safe box
 * so it survives a 16:9 television with overscan and an iPad stood on its end.
 */
function createScreen(Table, screen) {
  var view = null;
  var motion = FRScreen.motion();

  Table.onMessage(function (_from, msg) {
    // The public state, and nothing else. A screen that stashed whatever arrived
    // would be rendering somebody's hand onto the wall of the room.
    if (msg && msg.t === 'state') view = msg.s;
  });

  /* Card faces. Duplicated from rules.js on purpose: a screen is loaded with
   * FRScreen and nothing else — no rules.js, no DOM — because that is all an
   * Apple TV will hand it. Two lines of lookup table is the right amount of
   * duplication; anything with a RULE in it belongs on the host. */
  var RANK = { 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10',
               11:'J', 12:'Q', 13:'K', 14:'A' };
  var SUIT = ['♠', '♥', '♦', '♣'];

  var INK = '#f2f7f3', DIM = 'rgba(242,247,243,0.55)', FAINT = 'rgba(242,247,243,0.26)';
  var GOLD = '#e8c15a', GOOD = '#5fd39b', BAD = '#e0695c';
  var FELT = '#0d3322', FELT2 = '#09251a', TILE = 'rgba(0,0,0,0.26)';

  var STREET_LABEL = { preflop: 'PRE-FLOP', flop: 'THE FLOP', turn: 'THE TURN', river: 'THE RIVER' };

  function who(v, id) {
    return ((v.emojis && v.emojis[id]) || '') + ' ' + ((v.names && v.names[id]) || id);
  }
  function text(ctx, s, x, y, size, color, align) {
    ctx.fillStyle = color;
    ctx.font = (size | 0) + 'px sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }
  /** Fit a string into a width, then draw it. The only safe way to put text on a
   *  screen whose shape you don't know. */
  function fit(ctx, s, x, y, maxW, maxSize, color, align) {
    text(ctx, s, x, y, FRScreen.fitFont(s, maxW, maxSize, 8), color, align);
  }

  /* One card face. A single string per card ("A♠"), never a rank and a suit
   * drawn as two labels: two labels inside one small card overlap each other at
   * some screen shape, and "is any text drawn through other text" is a thing the
   * headless layout check rightly refuses to let pass. */
  function card(ctx, x, y, w, h, c, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = '#f6f8f4';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(w * 0.14, h * 0.1));
    ctx.fill();
    var face = (RANK[c.r] || '?') + SUIT[c.s];
    text(ctx, face, x + w / 2, y + h / 2, w * 0.48,
         (c.s === 1 || c.s === 2) ? '#c8322c' : '#17241c');
    ctx.globalAlpha = 1;
  }

  /** An empty slot — a card still to come. */
  function slot(ctx, x, y, w, h) {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = Math.max(1, w * 0.02);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(w * 0.14, h * 0.1));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function panel(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  /* ------------------------------------------------------------- a seat --- */

  /**
   * One player's place at the table: who they are, what they have left, what they
   * have in front of them, and whether the room is waiting on them.
   *
   * Three stacked rows inside the tile, each with its own band of the height and
   * its font fitted to the tile's width. That is what keeps eight seats legible
   * on a 720p television and on an iPad stood upright, which are very nearly
   * different layouts.
   */
  function seat(ctx, v, id, x, y, w, h, b, now) {
    var status = (v.status && v.status[id]) || 'active';
    var isOut = status === 'out';
    var folded = status === 'folded';
    var toAct = v.toAct === id && v.phase === 'betting';
    var stack = (v.stacks && v.stacks[id]) || 0;
    var bet = (v.bet && v.bet[id]) || 0;
    var won = (v.reveal && v.reveal.won && v.reveal.won[id]) || 0;

    panel(ctx, x, y, w, h, Math.min(w, h) * 0.12,
          toAct ? 'rgba(232,193,90,0.17)' : TILE);
    if (toAct) {
      // The room's eye goes to whoever has to do something.
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.roundRect(x, y + h - h * 0.055, w, h * 0.055, h * 0.027);
      ctx.fill();
    }
    // A pot just landed in this seat: flash it, once, as the number moves.
    var hit = motion.pulse('w' + id, won, now, 900);
    if (won > 0 && hit > 0) {
      ctx.globalAlpha = hit * 0.45;
      panel(ctx, x, y, w, h, Math.min(w, h) * 0.12, GOOD);
      ctx.globalAlpha = 1;
    }

    var pad = w * 0.07;
    var nameMax = w - pad * 2 - w * 0.16;          // room for the dealer button
    var alpha = isOut ? 0.34 : folded ? 0.52 : 1;

    // What they have done about it — blank for most of a hand.
    var third = '';
    var tint = DIM;
    if (isOut) { third = ''; }
    else if (folded) { third = 'folded'; }
    else if (bet > 0) { third = (status === 'allin' ? 'ALL IN ' : '') + bet; tint = GOLD; }
    else if (status === 'allin') { third = 'ALL IN'; tint = GOLD; }
    else if (v.lastAction && v.lastAction[id] === 'check') { third = 'check'; }

    /* Only the rows that have something in them get space. A fixed three-row
     * tile left a third of every seat empty for most of a hand, which on a
     * television is a lot of nothing — and made the cards smaller than they
     * needed to be to pay for it. */
    var shown = Math.round(motion.follow('s' + id, stack, 0.16, screen.dt));
    var lines = [
      { s: who(v, id), max: nameMax, scale: 0.6, color: toAct ? INK : DIM },
      { s: isOut ? 'OUT' : String(shown), max: w - pad * 2, scale: 0.76,
        color: isOut ? FAINT : INK }
    ];
    if (third) lines.push({ s: third, max: w - pad * 2, scale: 0.55, color: tint });

    ctx.globalAlpha = alpha;
    var band = h / lines.length;
    for (var li = 0; li < lines.length; li++) {
      var L = lines[li];
      fit(ctx, L.s, x + pad, y + band * (li + 0.5), L.max, band * L.scale, L.color, 'left');
    }
    ctx.globalAlpha = 1;

    // The button, where it always is: on the dealer.
    if (v.dealer === id) {
      var r = Math.min(w, h) * 0.11;
      var bx = x + w - pad - r, by = y + h * (lines.length === 2 ? 0.25 : 0.167);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
      text(ctx, 'D', bx, by, r * 1.3, FELT2);
    }
  }

  /* ---------------------------------------------------------- showdown --- */

  /**
   * The moment the game is for. Drawn as a full-screen curtain and then its own
   * rows on top, rather than squeezed into the board: a panel over everything is
   * both what a table wants to look at and the one layout that cannot collide
   * with the board behind it.
   */
  function showdownPanel(ctx, b, v, env, now) {
    /* Opaque, not a wash. At 0.9 the board behind showed straight through the
     * panel — five community cards and every seat tile ghosting under the rows
     * you are trying to read. A showdown is a different screen, not a tint. */
    ctx.fillStyle = FELT2;
    ctx.fillRect(0, 0, env.width, env.height);

    var rev = v.reveal || {};
    var shown = (v.order || []).filter(function (id) {
      return (rev.hole && rev.hole[id]) || (rev.won && rev.won[id]);
    });
    if (!shown.length) shown = (v.order || []).slice(0, 1);

    fit(ctx, v.banner || 'Showdown', b.cx, b.y + b.h * 0.08, b.w * 0.92, b.u(0.075), GOLD);

    var top = b.y + b.h * 0.18;
    var bottom = b.bottom - b.h * 0.06;
    var rowH = Math.min((bottom - top) / Math.max(shown.length, 1), b.u(0.16));
    var cardH = rowH * 0.78;
    var cardW = Math.min(cardH / 1.4, b.w * 0.07);
    cardH = cardW * 1.4;
    /* Columns measured from the cards outward rather than fixed fractions, so a
     * name, two cards, a hand and a number cannot be laid on top of each other
     * at a shape where the cards came out wider than the guess. */
    var cardsX = b.x + b.w * 0.26;
    var handX = cardsX + cardW * 2.15 + b.w * 0.025;
    var wonW = b.w * 0.15;
    var handW = (b.right - b.w * 0.02 - wonW) - handX - b.w * 0.015;

    shown.forEach(function (id, i) {
      var cy = top + rowH * (i + 0.5);
      var winner = (rev.won && rev.won[id]) > 0;
      if (winner) {
        ctx.globalAlpha = 0.16;
        panel(ctx, b.x, cy - rowH * 0.42, b.w, rowH * 0.84, rowH * 0.2, GOOD);
        ctx.globalAlpha = 1;
      }
      // Four columns that do not touch, so four labels cannot land on each other.
      fit(ctx, who(v, id), b.x + b.w * 0.02, cy, b.w * 0.22, rowH * 0.46,
          winner ? INK : DIM, 'left');

      var hole = (rev.hole && rev.hole[id]) || [];
      for (var k = 0; k < hole.length; k++) {
        card(ctx, cardsX + k * (cardW * 1.1), cy - cardH / 2, cardW, cardH,
             hole[k], winner ? 1 : 0.78);
      }
      var hand = (rev.hands && rev.hands[id]) || (rev.uncontested ? 'took it uncontested' : '');
      if (hand) fit(ctx, hand, handX, cy, handW, rowH * 0.44, winner ? GOLD : DIM, 'left');
      var won = (rev.won && rev.won[id]) || 0;
      if (won > 0) fit(ctx, '+' + won, b.right - b.w * 0.02, cy, wonW, rowH * 0.55, GOOD, 'right');
    });

    if (v.phase === 'handEnd') {
      fit(ctx, 'waiting for ' + ((v.names && v.names[(v.order || [])[0]]) || 'the host') + ' to deal',
          b.cx, b.bottom - b.h * 0.025, b.w * 0.7, b.u(0.032), FAINT);
    }
  }

  /* -------------------------------------------------------------- draw --- */

  screen.onDraw(function (ctx, env) {
    var b = FRScreen.box(env);
    var now = env.t;

    /* Felt, in one full-bleed fill. It was two — a darker band across the bottom
     * half — until the layout check pointed out that a fill covering only part of
     * the canvas is content outside the safe area, and it is right: the exemption
     * is for backgrounds, and a half is not one. Depth comes from the seat tiles. */
    ctx.fillStyle = FELT;
    ctx.fillRect(0, 0, env.width, env.height);

    if (!view) {
      fit(ctx, 'HOLD’EM', b.cx, b.cy - b.u(0.04), b.w * 0.8, b.u(0.12), GOLD);
      fit(ctx, 'waiting for the table…', b.cx, b.cy + b.u(0.06), b.w * 0.6, b.u(0.04), DIM);
      return;
    }
    var v = view;
    var order = v.order || [];

    /* Vertical bands, allocated once. Each row draws inside its own band with its
     * font capped by the band's height, so nothing can grow into its neighbour at
     * a shape nobody tried. */
    var headH = b.h * 0.085;
    var potH = b.h * 0.125;
    var boardH = b.h * 0.30;
    var bannerH = b.h * 0.075;
    var headY = b.y;
    var potY = headY + headH;
    var boardY = potY + potH;
    var bannerY = boardY + boardH;
    var seatsY = bannerY + bannerH;
    var seatsH = b.bottom - seatsY;

    // ---- header ----------------------------------------------------------
    fit(ctx, 'HAND ' + (v.hand || 1) + '  ·  BLINDS ' + v.sb + '/' + v.bb,
        b.x, headY + headH / 2, b.w * 0.46, headH * 0.6, DIM, 'left');
    fit(ctx, STREET_LABEL[v.street] || '', b.right, headY + headH / 2,
        b.w * 0.34, headH * 0.6, GOLD, 'right');

    // ---- the pot ---------------------------------------------------------
    var pot = Math.round(motion.follow('pot', v.pot || 0, 0.2, screen.dt));
    fit(ctx, 'POT  ' + pot, b.cx, potY + potH / 2, b.w * 0.55, potH * 0.8, GOLD);

    // ---- community cards -------------------------------------------------
    var gap = b.w * 0.012;
    var cardW = Math.min((b.w * 0.86 - gap * 4) / 5, (boardH * 0.9) / 1.4);
    var cardH = cardW * 1.4;
    var rowW = cardW * 5 + gap * 4;
    var cx0 = b.cx - rowW / 2;
    var cardY = boardY + (boardH - cardH) / 2;
    for (var i = 0; i < 5; i++) {
      var x = cx0 + i * (cardW + gap);
      var c = (v.board || [])[i];
      if (c) {
        // Each card gets a short pop as it lands, keyed on the board's length so
        // it fires when the card arrives and not on every frame after.
        var land = motion.pulse('card' + i, (v.board || []).length, now, 420);
        var lift = land > 0 ? FRScreen.ease.outBack(1 - land) : 1;
        var sh = cardH * (0.9 + 0.1 * lift);
        card(ctx, x, cardY + (cardH - sh) / 2, cardW, sh, c);
      } else {
        slot(ctx, x, cardY, cardW, cardH);
      }
    }

    // ---- banner ----------------------------------------------------------
    if (v.banner) {
      fit(ctx, v.banner, b.cx, bannerY + bannerH / 2, b.w * 0.9, bannerH * 0.72, INK);
    }

    // ---- the seats -------------------------------------------------------
    // Four across on a television, two on an iPad stood up: the same eight
    // players, laid out for the shape that is actually there.
    var n = order.length;
    var perRow = b.portrait ? Math.min(2, n) : Math.min(4, n);
    var rows = Math.ceil(n / perRow);
    var tGap = Math.min(b.w, b.h) * 0.018;
    var tileH = (seatsH - tGap * (rows - 1)) / rows;
    var tileW = (b.w - tGap * (perRow - 1)) / perRow;
    for (var s = 0; s < n; s++) {
      var r = Math.floor(s / perRow), cc = s % perRow;
      // The last row is centred when it isn't full, so a five-player table
      // doesn't look like a four-player table with an orphan.
      var inRow = Math.min(perRow, n - r * perRow);
      var rowWidth = tileW * inRow + tGap * (inRow - 1);
      var sx = b.cx - rowWidth / 2 + cc * (tileW + tGap);
      var sy = seatsY + r * (tileH + tGap);
      seat(ctx, v, order[s], sx, sy, tileW, tileH * 0.94, b, now);
    }

    // ---- the big moments -------------------------------------------------
    if (v.phase === 'showdown' || v.phase === 'handEnd') {
      showdownPanel(ctx, b, v, env, now);
    }

    if (v.phase === 'gameOver') {
      // Opaque, for the same reason the showdown panel is: a near-miss alpha
      // leaves the whole board faintly legible underneath the result.
      ctx.fillStyle = FELT2;
      ctx.fillRect(0, 0, env.width, env.height);
      var champ = null, best = -1;
      order.forEach(function (id) {
        var k = (v.stacks && v.stacks[id]) || 0;
        if (k > best) { best = k; champ = id; }
      });
      // `once`, not `pulse`: a pulse first seen inside this branch never fires.
      if (champ && motion.once('win')) {
        motion.burst(b.cx, b.cy, { count: 80, speed: 420, life: 2400, size: b.u(0.016) });
      }
      fit(ctx, champ ? who(v, champ) + ' takes the table' : 'Game over',
          b.cx, b.cy - b.u(0.05), b.w * 0.9, b.u(0.1), GOLD);
      fit(ctx, best + ' chips, every one of them', b.cx, b.cy + b.u(0.06),
          b.w * 0.6, b.u(0.04), DIM);
    }

    // Bounded: confetti that leaves the safe box is confetti under a television's
    // overscan, which is a layout failure that only happens at the moment of
    // winning — the hardest frame to get a headless run to reach.
    motion.particles(ctx, screen.dt, { bounds: b });
  });
}
