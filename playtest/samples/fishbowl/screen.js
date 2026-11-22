/* FISHBOWL — the shared screen (Apple TV, an iPad, the Studio frame).
 *
 * The screen is NOT a player. It receives the host's public broadcasts and never
 * a private `sendTo`, which is why this file can be written without thinking hard
 * about secrecy: the phrase being acted out is sent only to the giver's phone, so
 * it is not in the state this file can see. The bowl's contents cannot leak here
 * because they never arrive here.
 *
 * Pure JS, no DOM — this runs under JavaScriptCore on tvOS, where there is no
 * HTML at all. Everything is drawn through the recorded canvas vocabulary.
 */
function createScreen(Table, screen) {
  var view = null;
  var motion = FRScreen.motion();
  var ease = FRScreen.ease;

  Table.onMessage(function (_from, msg) {
    if (msg && msg.t === 'state') view = msg.s;
  });

  var INK = '#f6f1e6', DIM = 'rgba(246,241,230,0.55)', BG = '#10243a';

  function roundLabel(v) {
    return 'ROUND ' + (v.round + 1) + ' · ' + String(v.roundName || '').toUpperCase();
  }

  /* A ring that empties as the turn runs out. Reads from across a room far better
   * than a bar, and the colour shift is the "hurry up" signal. */
  function drawTimer(ctx, cx, cy, r, seconds, total, now) {
    var frac = Math.max(0, Math.min(1, seconds / total));
    var low = seconds <= 10;
    ctx.lineWidth = r * 0.16;
    ctx.lineCap = 'round';

    ctx.strokeStyle = 'rgba(246,241,230,0.14)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // A soft pulse in the last ten seconds, so a glance catches it.
    var urgency = low ? 1 + Math.sin(now / 110) * 0.05 : 1;
    ctx.strokeStyle = low ? '#ef476f' : '#06d6a0';
    ctx.beginPath();
    ctx.arc(cx, cy, r * urgency, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();

    ctx.fillStyle = low ? '#ef476f' : INK;
    ctx.font = (r * 0.78 | 0) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.ceil(seconds)), cx, cy);
  }

  function drawTeams(ctx, b, v, now) {
    var teams = v.teams || [];
    if (!teams.length) return;
    var ys = b.rows(teams.length, b.u(0.04));
    var rowH = (b.h - b.u(0.08)) / teams.length;
    var x = b.x, w = b.w;

    for (var i = 0; i < teams.length; i++) {
      var t = teams[i], y = ys[i], active = v.activeTeamId === t.id;
      var hit = motion.pulse('score' + t.id, t.score, now, 700);
      var shown = motion.follow('shown' + t.id, t.score, 0.16, screen.dt);

      // The active team's row lifts; a team that just scored flashes.
      ctx.fillStyle = active ? 'rgba(246,241,230,0.12)' : 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.roundRect(x, y - rowH * 0.38, w, rowH * 0.76, b.u(0.02));
      ctx.fill();

      if (hit > 0) {
        ctx.globalAlpha = hit * 0.5;
        ctx.fillStyle = t.color || '#ffd166';
        ctx.beginPath();
        ctx.roundRect(x, y - rowH * 0.38, w, rowH * 0.76, b.u(0.02));
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = t.color || INK;
      ctx.beginPath();
      ctx.roundRect(x + b.u(0.02), y - rowH * 0.22, b.u(0.018), rowH * 0.44, b.u(0.01));
      ctx.fill();

      ctx.fillStyle = active ? INK : DIM;
      ctx.font = FRScreen.fitFont(t.name, w - b.u(0.22), b.u(0.055)) + 'px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.name, x + b.u(0.06), y);

      ctx.fillStyle = INK;
      ctx.font = (b.u(0.085) * (1 + hit * 0.25) | 0) + 'px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(shown)), x + w - b.u(0.03), y);
    }
  }

  function centred(ctx, b, big, small, now) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    // Size to the WIDTH available, not just the screen's short edge: the same
    // headline that fits across a 16:9 TV runs off the side of an iPad stood up.
    ctx.font = FRScreen.fitFont(big, b.w, b.u(0.11)) + 'px sans-serif';
    ctx.fillText(big, b.cx, b.cy - b.u(0.04));
    if (small) {
      ctx.fillStyle = DIM;
      ctx.font = FRScreen.fitFont(small, b.w, b.u(0.045)) + 'px sans-serif';
      ctx.fillText(small, b.cx, b.cy + b.u(0.07));
    }
  }

  screen.onDraw(function (ctx, env) {
    var b = FRScreen.box(env);
    var now = env.t;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, env.width, env.height);

    if (!view) { centred(ctx, b, 'FISHBOWL', 'waiting for the table…', now); return; }
    var v = view;

    // Header: which round, and what the rule is this time.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = INK;
    ctx.font = FRScreen.fitFont(roundLabel(v), b.w * 0.62, b.u(0.06)) + 'px sans-serif';
    ctx.fillText(roundLabel(v), b.x, b.y);
    if (v.roundHint) {
      ctx.fillStyle = DIM;
      ctx.font = FRScreen.fitFont(v.roundHint, b.w * 0.72, b.u(0.035)) + 'px sans-serif';
      ctx.fillText(v.roundHint, b.x, b.y + b.u(0.075));
    }

    // Bowl count, top right — the thing everyone keeps asking out loud.
    ctx.textAlign = 'right';
    ctx.fillStyle = DIM;
    var bowl = '🐟 ' + (v.bowlLeft || 0) + ' left in the bowl';
    ctx.font = FRScreen.fitFont(bowl, b.w * 0.34, b.u(0.04)) + 'px sans-serif';
    ctx.fillText(bowl, b.right, b.y);

    var body = { width: env.width, height: env.height,
                 safe: { top: (env.safe ? env.safe.top : 0) + b.u(0.17),
                         right: env.safe ? env.safe.right : 0,
                         bottom: env.safe ? env.safe.bottom : 0,
                         left: env.safe ? env.safe.left : 0 } };
    var inner = FRScreen.box(body);

    if (v.phase === 'entry') {
      var waiting = (v.writing || []).length;
      centred(ctx, inner,
        'Filling the bowl…',
        waiting ? (waiting + ' still writing · ' + (v.totalPhrases || 0) + ' phrases in')
                : 'everyone is ready', now);
      return;
    }

    if (v.phase === 'gameOver') {
      var best = (v.teams || []).slice().sort(function (a, c) { return c.score - a.score; })[0];
      // `once`, not `pulse`: see fr-screen's note — a pulse first seen here is
      // silent on this frame and unchanged on every frame after, so this never
      // fired at all.
      if (best && motion.once('win')) {
        motion.burst(inner.cx, inner.cy, { count: 80, speed: 420, life: 2200, size: inner.u(0.02) });
      }
      centred(ctx, inner, (best ? best.name : 'Nobody') + ' wins!', null, now);
      drawTeams(ctx, FRScreen.box({ width: env.width, height: env.height,
        safe: { top: env.height * 0.55, right: inner.x, bottom: b.u(0.04), left: inner.x } }), v, now);
      // Bounded to the safe box, now that the burst above can actually happen:
      // confetti past the overscan is a layout failure like any other.
      motion.particles(ctx, screen.dt, { bounds: b });
      return;
    }

    // A TV is wide, an iPad stood up is tall. Side by side only works for the
    // first: at portrait the timer ring ran off the left edge entirely, which the
    // headless layout check caught before any hardware existed to show it.
    var tall = inner.portrait;
    var timerCx, timerCy, timerR, teamsSafe;

    if (tall) {
      timerCx = inner.cx;
      timerCy = inner.y + inner.h * 0.22;
      timerR  = Math.min(inner.w * 0.3, inner.h * 0.16);
      teamsSafe = { top: inner.y + inner.h * 0.44, right: env.safe ? env.safe.right : 0,
                    bottom: env.safe ? env.safe.bottom : 0, left: env.safe ? env.safe.left : 0 };
    } else {
      timerCx = inner.x + inner.w * 0.19;
      timerCy = inner.cy;
      timerR  = Math.min(inner.w * 0.15, inner.h * 0.3);
      teamsSafe = { top: body.safe.top, right: env.safe ? env.safe.right : 0,
                    bottom: env.safe ? env.safe.bottom : 0, left: inner.x + inner.w * 0.38 };
    }

    if (v.phase === 'turn' && v.secondsLeft != null) {
      drawTimer(ctx, timerCx, timerCy, timerR, v.secondsLeft, 60, now);
    } else {
      var wait = v.phase === 'roundOver' ? 'round over' : 'get ready';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = DIM;
      ctx.font = FRScreen.fitFont(wait, timerR * 2.4, inner.u(0.05)) + 'px sans-serif';
      ctx.fillText(wait, timerCx, timerCy);
    }

    if (v.giver && v.names) {
      var giving = (v.emojis[v.giver] || '') + ' ' + (v.names[v.giver] || '') + ' is giving';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = INK;
      ctx.font = FRScreen.fitFont(giving, timerR * 2.6, inner.u(0.045)) + 'px sans-serif';
      ctx.fillText(giving, timerCx, timerCy + timerR * 1.25);
    }

    drawTeams(ctx, FRScreen.box({ width: env.width, height: env.height, safe: teamsSafe }), v, now);

    motion.particles(ctx, screen.dt, { bounds: b });
  });
}
