/* SUMMIT — the shared screen (Apple TV, an iPad, the Studio frame).
 *
 * The whole point of this file: SUMMIT is a HIDDEN-HAND game, and the board is
 * still worth putting on a TV. Both expeditions, the discard piles and the deck
 * are public; the eight cards in each player's hand are not.
 *
 * Nothing here has to be careful about that. The host deals hands with
 * `Table.sendTo`, and a screen is never a `sendTo` recipient — the cards simply
 * are not in the state this file can see. `handCounts` is: how MANY cards
 * somebody holds is public knowledge at a real table.
 *
 * Pure JS, no DOM — this runs under JavaScriptCore on tvOS, where there is no
 * HTML at all. Everything is drawn through the recorded canvas vocabulary.
 */
function createScreen(Table, screen) {
  var view = null;
  var motion = FRScreen.motion();

  Table.onMessage(function (_from, msg) {
    if (msg && msg.t === 'state') view = msg.s;
  });

  var ROUTES = [
    { k: 'glacier', icon: '❄️', color: '#5aa0e0' },
    { k: 'volcano', icon: '🌋', color: '#e0564b' },
    { k: 'jungle',  icon: '🦜', color: '#43b06b' },
    { k: 'desert',  icon: '🏜️', color: '#d99a2e' },
    { k: 'reef',    icon: '🐠', color: '#9b6ee0' }
  ];
  var INK = '#f4f6fb', DIM = 'rgba(244,246,251,0.5)', BG = '#121a26';

  function route(k) {
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].k === k) return ROUTES[i];
    return { k: k, icon: '•', color: '#8899aa' };
  }

  /** The same scoring the host uses, so the board can show what a route is worth. */
  function routeScore(pile) {
    if (!pile || !pile.length) return 0;
    var wagers = 0, sum = 0;
    for (var i = 0; i < pile.length; i++) {
      if (pile[i].v === 0) wagers++; else sum += pile[i].v;
    }
    var score = (sum - 20) * (wagers + 1);
    if (pile.length >= 8) score += 20;
    return score;
  }

  function label(v, id) {
    return ((v.emojis && v.emojis[id]) || '') + ' ' + ((v.names && v.names[id]) || id);
  }

  /* One expedition card. Small, high-contrast, readable across a room: the value
   * is the only thing that matters and the colour says which route it's on. */
  function card(ctx, x, y, w, h, c, col, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(h * 0.3, w * 0.16));
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.font = (Math.min(h * 0.72, w * 0.5) | 0) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.v === 0 ? '★' : String(c.v), x + w / 2, y + h / 2);
    ctx.globalAlpha = 1;
  }

  /* A player's strip: who they are, what they've banked, how many cards they
   * hold, and whether the table is waiting on them. */
  function strip(ctx, b, v, id, y, h, now, alignTop) {
    var mine = v.turn === id;
    var total = (v.totals && v.totals[id]) || 0;
    var shown = motion.follow('t' + id, total, 0.14, screen.dt);
    var hit = motion.pulse('s' + id, total, now, 650);

    ctx.fillStyle = mine ? 'rgba(244,246,251,0.14)' : 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.roundRect(b.x, y, b.w, h, b.u(0.018));
    ctx.fill();
    if (hit > 0) {
      ctx.globalAlpha = hit * 0.4;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.roundRect(b.x, y, b.w, h, b.u(0.018));
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    var pad = b.u(0.022), mid = y + h / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = mine ? INK : DIM;
    var who = label(v, id) + (mine ? '  ← to play' : '');
    ctx.font = FRScreen.fitFont(who, b.w * 0.5, Math.min(h * 0.52, b.u(0.05))) + 'px sans-serif';
    ctx.fillText(who, b.x + pad, mid);

    // Hand SIZE is public at a real table; the cards themselves never arrive here.
    var held = (v.handCounts && v.handCounts[id]) || 0;
    ctx.textAlign = 'right';
    ctx.fillStyle = DIM;
    var cards = held + (held === 1 ? ' card' : ' cards');
    ctx.font = FRScreen.fitFont(cards, b.w * 0.2, Math.min(h * 0.4, b.u(0.034))) + 'px sans-serif';
    ctx.fillText(cards, b.right - pad - b.w * 0.11, mid);

    ctx.fillStyle = INK;
    ctx.font = (Math.min(h * 0.62, b.u(0.062)) | 0) + 'px sans-serif';
    ctx.fillText(String(Math.round(shown)), b.right - pad, mid);

    // Keep the eye on the right strip when the turn changes.
    if (mine) {
      ctx.fillStyle = '#06d6a0';
      ctx.beginPath();
      ctx.roundRect(b.x, alignTop ? y : y + h - b.u(0.006), b.w, b.u(0.006), b.u(0.003));
      ctx.fill();
    }
  }

  function centred(ctx, b, big, small) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.font = FRScreen.fitFont(big, b.w, b.u(0.1)) + 'px sans-serif';
    ctx.fillText(big, b.cx, b.cy - b.u(0.045));
    if (small) {
      ctx.fillStyle = DIM;
      ctx.font = FRScreen.fitFont(small, b.w, b.u(0.042)) + 'px sans-serif';
      ctx.fillText(small, b.cx, b.cy + b.u(0.06));
    }
  }

  screen.onDraw(function (ctx, env) {
    var b = FRScreen.box(env);
    var now = env.t;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, env.width, env.height);

    if (!view) { centred(ctx, b, 'SUMMIT', 'waiting for the table…'); return; }
    var v = view;
    var order = v.order || [];

    // ---- header -----------------------------------------------------------
    var head = b.u(0.055);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = INK;
    var title = 'ROUND ' + (v.round || 1) + ' OF 3';
    ctx.font = FRScreen.fitFont(title, b.w * 0.38, head) + 'px sans-serif';
    ctx.fillText(title, b.x, b.y);

    ctx.textAlign = 'right';
    ctx.fillStyle = DIM;
    var deck = '\u{1F0A0} ' + (v.deckCount || 0) + ' in the deck';
    ctx.font = FRScreen.fitFont(deck, b.w * 0.34, b.u(0.036)) + 'px sans-serif';
    ctx.fillText(deck, b.right, b.y);

    if (v.banner) {
      ctx.textAlign = 'center';
      ctx.fillStyle = INK;
      ctx.font = FRScreen.fitFont(v.banner, b.w * 0.44, b.u(0.04)) + 'px sans-serif';
      ctx.fillText(v.banner, b.cx, b.y + b.u(0.004));
    }

    if (v.phase === 'gameOver') {
      var ranked = order.slice().sort(function (a, c) {
        return ((v.totals && v.totals[c]) || 0) - ((v.totals && v.totals[a]) || 0);
      });
      var champ = ranked[0];
      if (champ && motion.pulse('win', champ, now, 1) > 0.99) {
        motion.burst(b.cx, b.cy, { count: 70, speed: 400, life: 2200, size: b.u(0.016) });
      }
      centred(ctx, b, champ ? label(v, champ) + ' wins!' : 'Game over',
              ranked.map(function (id) {
                return label(v, id) + ' ' + ((v.totals && v.totals[id]) || 0);
              }).join('   ·   '));
      motion.particles(ctx, screen.dt);
      return;
    }

    // ---- the board --------------------------------------------------------
    // Two expeditions grow away from a shared centre line, the way the cards sit
    // on a real table: one player's routes climb up, the other's run down, with
    // the discard pile for each route between them.
    var top = b.y + b.u(0.1);
    var bottom = b.bottom;
    var stripH = Math.max(b.u(0.07), Math.min(b.u(0.095), (bottom - top) * 0.13));
    var boardTop = top + stripH + b.u(0.02);
    var boardBottom = bottom - stripH - b.u(0.02);
    var boardH = boardBottom - boardTop;
    var discH = Math.min(b.u(0.075), boardH * 0.17);
    var halfH = (boardH - discH) / 2;

    strip(ctx, b, v, order[0] || '', top, stripH, now, true);
    strip(ctx, b, v, order[1] || '', bottom - stripH, stripH, now, false);

    var gap = b.w * 0.012;
    var colW = (b.w - gap * (ROUTES.length - 1)) / ROUTES.length;
    var cardW = Math.min(colW * 0.78, b.u(0.1));
    var discMid = boardTop + halfH + discH / 2;

    // The tallest stack on the board decides the card height, so a route that
    // runs to eight cards stays inside its half instead of climbing out of it.
    var deepest = 1;
    for (var p = 0; p < order.length; p++) {
      var rr = (v.routes && v.routes[order[p]]) || {};
      for (var k = 0; k < ROUTES.length; k++) {
        var pile = rr[ROUTES[k].k] || [];
        if (pile.length > deepest) deepest = pile.length;
      }
    }
    var cardH = Math.min(cardW * 0.62, (halfH - b.u(0.03)) / Math.max(deepest, 4) * 1.6);
    var step = Math.min(cardH * 0.72, (halfH - cardH - b.u(0.01)) / Math.max(deepest - 1, 1));

    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i];
      var cx = b.x + colW / 2 + i * (colW + gap);
      var cardX = cx - cardW / 2;

      // The route's own lane, so five columns read as five routes.
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = r.color;
      ctx.beginPath();
      ctx.roundRect(cx - colW / 2, boardTop, colW, boardH, b.u(0.016));
      ctx.fill();
      ctx.globalAlpha = 1;

      // Discard pile on the centre line: the top card, and how deep it is.
      var d = (v.discards && v.discards[r.k]) || { top: null, count: 0 };
      var dy = discMid - discH / 2;
      ctx.strokeStyle = 'rgba(244,246,251,0.18)';
      ctx.lineWidth = Math.max(1, b.u(0.002));
      ctx.beginPath();
      ctx.roundRect(cardX, dy, cardW, discH, b.u(0.01));
      ctx.stroke();
      if (d.top) {
        card(ctx, cardX, dy, cardW, discH, d.top, r.color, 0.92);
      } else {
        ctx.fillStyle = 'rgba(244,246,251,0.35)';
        ctx.font = (discH * 0.5 | 0) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.icon, cx, discMid);
      }
      if (d.count > 1) {
        ctx.fillStyle = DIM;
        ctx.font = (b.u(0.022) | 0) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('×' + d.count, cx + cardW * 0.5 + b.u(0.018), discMid);
      }

      // Each player's pile for this route, growing away from the centre.
      for (var s = 0; s < 2; s++) {
        var pid = order[s];
        if (!pid) continue;
        var pile = ((v.routes && v.routes[pid]) || {})[r.k] || [];
        var fresh = motion.pulse('play' + pid + r.k, pile.length, now, 520);
        for (var c = 0; c < pile.length; c++) {
          var y = s === 0
            ? discMid - discH / 2 - b.u(0.012) - cardH - c * step
            : discMid + discH / 2 + b.u(0.012) + c * step;
          var newest = c === pile.length - 1 ? fresh : 0;
          card(ctx, cardX, y, cardW, cardH, pile[c], r.color, 0.72 + 0.28 * (c / Math.max(pile.length - 1, 1)));
          if (newest > 0) {
            ctx.globalAlpha = newest * 0.7;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1.5, b.u(0.004));
            ctx.beginPath();
            ctx.roundRect(cardX, y, cardW, cardH, Math.min(cardH * 0.3, cardW * 0.16));
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        // What this route is worth right now — the number players argue about.
        if (pile.length) {
          var sc = routeScore(pile);
          var sy = s === 0
            ? discMid - discH / 2 - b.u(0.012) - cardH - (pile.length - 1) * step - b.u(0.022)
            : discMid + discH / 2 + b.u(0.012) + (pile.length - 1) * step + cardH + b.u(0.022);
          ctx.fillStyle = sc < 0 ? '#ef476f' : '#06d6a0';
          ctx.font = (b.u(0.026) | 0) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText((sc > 0 ? '+' : '') + sc, cx, sy);
        }
      }
    }

    if (v.phase === 'roundEnd') {
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, env.width, env.height);
      ctx.globalAlpha = 1;
      centred(ctx, b, 'Round ' + (v.round || 1) + ' complete',
              order.map(function (id) {
                var got = (v.lastRound && v.lastRound[id]) || 0;
                return label(v, id) + ' ' + (got >= 0 ? '+' : '') + got;
              }).join('   ·   '));
    }

    motion.particles(ctx, screen.dt);
  });
}
