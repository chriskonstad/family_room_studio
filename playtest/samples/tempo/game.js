/* TEMPO — a tap-to-the-beat rhythm blitz. Works solo or with up to 6 phones.
   Each phone runs the same seeded 60-second track (accelerating beat) with a
   WebAudio metronome; tap the ring exactly on the beat. Perfect = 100, Good =
   50, Miss = combo-break. Scores stream to the host; results at the end.
   The audio + judging is all local (no network latency in the loop). */

function createGame(Table, root) {
  const MY = Table.me.id;
  const TRACK_SECONDS = 60;

  let view = null;         // shared: phase + live scores
  let G = null;            // host: scores/finished
  let run = null;          // local run state {seed, beats:[times], idx, score, combo, best, timer, audio}

  /// Game-feel shim, so a bundle still runs on a harness that predates
  /// Table.feel (and in a plain browser).
  const feel = (ev, o) => { if (Table.feel) Table.feel(ev, o); };
  const haptic = (s) => { if (Table.haptic) Table.haptic(s); };

  // ---------- deterministic track from a shared seed ----------
  function rng(seed){ let s = seed >>> 0; return () => (s = (s*1664525 + 1013904223) >>> 0) / 4294967296; }
  function buildBeats(seed) {
    // accelerating beat: 92 -> 168 BPM over 60s, with occasional double-taps
    const rand = rng(seed);
    const beats = [];
    let t = 2.0;                       // lead-in
    while (t < TRACK_SECONDS) {
      const progress = t / TRACK_SECONDS;
      const bpm = 92 + progress * 76;
      const interval = 60 / bpm;
      beats.push(t);
      if (progress > 0.4 && rand() < 0.18) beats.push(t + interval/2);   // syncopation!
      t += interval;
    }
    return beats.sort((a,b)=>a-b);
  }

  // ---------- host ----------
  function initGame(players) {
    G = { order:players.map(p=>p.id), names:{}, emojis:{}, scores:{}, finished:{}, phase:'ready',
          seed: Table.seed };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.scores[p.id]=0; G.finished[p.id]=false; });
  }
  // The move space. TEMPO is unusual: the real play is TAPPING TO A BEAT on your own
  // device, which is a timing skill and not a discrete choice — so the only host-visible
  // moves are "start the track", "here's my running score" and "I'm finished". A bot
  // can't be good at TEMPO, but it can prove the game starts, scores and ends cleanly,
  // which is what actually breaks.
  let table = null;
  function buildTable() {
    return FR.host({
      state: G, players: G.order, timers: FR.timers(), hostId: MY,
      phase: () => G.phase,
      publish: syncAll,
      intents: {
        hello: { hidden: true, run: () => {} },
        go:    { host: true, phase: 'ready', run: () => { G.phase = 'playing'; } },
        // A running score is a stream, not a choice — playable, but nothing to enumerate.
        score: { hidden: true, phase: 'playing',
                 run: (ctx) => { G.scores[ctx.from] = Number(ctx.msg.score) || 0; } },
        done:  { phase: 'playing',
                 when: (ctx) => !G.finished[ctx.from],
                 options: () => [{ score: 0 }],   // a bot finishes; a human finishes better
                 run: (ctx) => {
                   G.scores[ctx.from] = Number(ctx.msg.score) || 0;
                   G.finished[ctx.from] = true;
                   if (G.order.every(id => G.finished[id])) {
                     G.phase = 'over';
                     const r = FR.standings.byScore(G.scores);
                     Table.endGame({ winnerId: r.winnerId, standings: r.standings });
                   }
                 } }
      }
    });
  }
  function publicState() {
    return { phase:G.phase, seed:G.seed, names:G.names, emojis:G.emojis, order:G.order,
             scores:{...G.scores}, finished:{...G.finished} };
  }
  function syncAll(){ const s = publicState(); Table.broadcast({ t:'state', s }); onState(s); }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); table = buildTable(); syncAll(); });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
    // Someone leaving counts as finishing — otherwise the game waits forever for a
    // score that is never coming. (This called the old handleIntent, which no longer
    // exists; a leave would have thrown.)
    Table.onPlayerLeave(id => {
      if (!G || G.finished[id]) return;
      G.finished[id] = true;
      if (G.phase === 'playing' && G.order.every(x => G.finished[x])) {
        G.phase = 'over';
        const r = FR.standings.byScore(G.scores);
        Table.endGame({ winnerId: r.winnerId, standings: r.standings });
      }
      syncAll();
    });
  } else {
    Table.onStart(() => { view=null; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_f, msg) => { if (msg.t === 'state') onState(msg.s); });
  }
  function onState(s) {
    const wasReady = !view || view.phase === 'ready';
    const wasPlaying = view && view.phase === 'playing';
    view = s;
    if (s.phase === 'playing' && wasReady && !run) { startRun(s.seed); render(); return; }
    // during play, DON'T rebuild the DOM (it would kill the ring + tap zone):
    // just refresh the live score strip.
    if (s.phase === 'playing' && wasPlaying) { updateScoreStrip(); return; }
    render();
  }
  function updateScoreStrip() {
    const el = root.querySelector('.scores');
    if (!el || !view) return;
    el.innerHTML = view.order.map(id =>
      `<span class="sc">${view.emojis[id]} <b>${view.scores[id]||0}</b>${view.finished[id]?' ✓':''}</span>`).join('');
  }

  // ---------- local run (audio + judging) ----------
  /// iOS WKWebView creates an AudioContext in the `suspended` state and only
  /// honours resume() from inside a user gesture. startRun() runs from a state
  /// broadcast, NOT a tap — which is why the metronome was silent on device.
  /// So the context is created and unlocked on the first real touch instead.
  let sharedAudio = null;
  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!sharedAudio) sharedAudio = new AC();
    if (sharedAudio.state === 'suspended') sharedAudio.resume();
    return sharedAudio;
  }

  function startRun(seed) {
    const audio = unlockAudio();          // already unlocked by the tap that got us here
    run = { beats: buildBeats(seed), idx:0, score:0, combo:0, best:0, hits:0,
            start: performance.now()/1000 + 0.15, audio, lastSent:0, over:false,
            lastFeel:0, lastCount:null };
    scheduleLoop();
  }
  function beep(when, freq, dur=0.07, gain=0.25) {
    const a = run.audio; if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.frequency.value = freq; o.type = 'square';
    g.gain.setValueAtTime(gain, when); g.gain.exponentialRampToValueAtTime(0.001, when+dur);
    o.connect(g); g.connect(a.destination);
    o.start(when); o.stop(when+dur);
  }
  function scheduleLoop() {
    if (!run || run.over) return;
    const nowS = performance.now()/1000 - run.start;
    // schedule metronome beeps just ahead
    if (run.audio) {
      const ctxNow = run.audio.currentTime;
      run.beats.forEach((b,i) => {
        const dt = b - nowS;
        if (dt > 0 && dt < 0.3 && !run['b'+i]) { run['b'+i] = true; beep(ctxNow+dt, 660); }
      });
    }
    // expire beats we never tapped
    while (run.idx < run.beats.length && nowS > run.beats[run.idx] + 0.25) {
      run.combo = 0; run.idx++;
      showVerdict('miss', 'MISS');
    }
    // animate the closing ring toward the next beat
    const next = run.beats[run.idx];
    if (next != null) {
      const dt = next - nowS;
      const pulse = root.querySelector('.pulse');
      if (pulse && dt > 0 && dt < 0.6 && !pulse.classList.contains('animate')) {
        pulse.style.setProperty('--beatms', Math.round(dt*1000)+'ms');
        pulse.classList.add('animate');
        pulse.onanimationend = () => pulse.classList.remove('animate');
      }
    }
    // stream score to host once per second
    if (nowS - run.lastSent > 1) { run.lastSent = nowS; Table.send({ t:'score', score:run.score }); }
    // last three seconds of the track — keyed on the whole second, so it can't
    // fire per frame the way anything else in this loop would
    const left = TRACK_SECONDS - nowS;
    if (left > 0 && left <= 3) {
      const whole = Math.ceil(left);
      if (whole !== run.lastCount) { run.lastCount = whole; feel('countdown'); }
    }
    if (nowS >= TRACK_SECONDS) { finishRun(); return; }
    run.raf = requestAnimationFrame(scheduleLoop);
  }
  function tap() {
    if (!run || run.over) return;
    const nowS = performance.now()/1000 - run.start;
    const next = run.beats[run.idx];
    if (next == null) return;
    const err = Math.abs(nowS - next);
    if (err <= 0.08) { run.score += 100; run.combo++; run.hits++; showVerdict('perfect','PERFECT'); beepNow(990); run.idx++; }
    else if (err <= 0.2) { run.score += 50; run.combo++; run.hits++; showVerdict('good','GOOD'); beepNow(770); run.idx++; }
    else if (nowS < next - 0.2) { run.combo = 0; showVerdict('miss','EARLY'); beepNow(220); }
    run.best = Math.max(run.best, run.combo);
    run.score += run.combo >= 5 ? 10 : 0;    // combo bonus drip
    updateHud();
  }
  function beepNow(freq){ if (run.audio) beep(run.audio.currentTime, freq, 0.05, 0.2); }
  function finishRun() {
    run.over = true;
    cancelAnimationFrame(run.raf);
    Table.send({ t:'done', score:run.score });
    showVerdict('good','DONE!');
  }
  function showVerdict(cls, text) {
    const v = root.querySelector('.verdict');
    if (!v) return;
    v.textContent = text; v.className = 'verdict show '+cls;
    v.onanimationend = () => v.classList.remove('show');
    feelVerdict(cls, text);
    updateHud();
  }
  /// Judging is entirely local here, so "once per event" is just "once per
  /// verdict" — no seen*/prev* bookkeeping needed. The one hazard is the expiry
  /// loop in scheduleLoop(): it runs on requestAnimationFrame, which the pause
  /// shim does NOT freeze, so a stalled frame can retire several beats at once.
  /// The 110ms floor turns that into one buzz instead of five.
  /// Sound stays with the game's own WebAudio beeps — a shell ding layered over
  /// the metronome muddies the beat — so these are haptic-only, and the
  /// PERFECT/GOOD split rides `mine` for intensity (in a solo-judged game that
  /// is the only meaningful weighting left).
  function feelVerdict(cls, text) {
    if (!run) return;
    const now = performance.now();
    if (now - (run.lastFeel || 0) < 110) return;
    run.lastFeel = now;
    if (text === 'DONE!')         feel('win',     { el:'.ring', mine:true });
    else if (cls === 'perfect')   feel('gain',    { mine:true });
    else if (cls === 'good')      feel('gain');
    // A miss keeps blocked's shake and buzz, but not its haptic: `warning` is a
    // half-second multi-pulse pattern, and a run of missed beats issues them
    // faster than that, so each one cancels the last and you feel almost nothing.
    // A single crisp impact repeats cleanly at beat speed.
    else { feel('blocked', { el:'.ring', mine:true, quiet:true }); haptic('rigid'); }
  }
  function updateHud() {
    const c = root.querySelector('.combo');
    if (c && run) c.innerHTML = 'score <b>'+run.score+'</b> · combo <b>'+run.combo+'</b>';
  }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  function render() {
    if (!view) { root.innerHTML = '<div class="big"><span class="wait">Tuning up…</span></div>'; return; }
    const v = view;
    let h = `<div class="hdr"><span class="brand">TEMPO</span><span class="sub">60-second track</span></div>`;
    h += `<div class="scores">` + v.order.map(id =>
      `<span class="sc">${v.emojis[id]} <b>${v.scores[id]||0}</b>${v.finished[id]?' ✓':''}</span>`).join('') + `</div>`;

    if (v.phase === 'ready') {
      h += `<div class="big"><div class="icon">🎵</div>
        <div class="hint">Tap anywhere <b>exactly on the beat</b>. The ring closes in on each pulse —
        tap when it lands. The track speeds up… and watch for double-beats.</div>`;
      h += Table.isHost
        ? `<button class="primary" id="go">Drop the beat</button>`
        : `<div class="wait">Waiting for the host to start…</div>`;
      h += `</div>`;
    } else if (v.phase === 'playing') {
      h += `<div class="stage">
        <div class="verdict"></div>
        <div class="ring"><div class="pulse"></div><span class="beatnum">♪</span></div>
        <div class="combo">score <b>0</b> · combo <b>0</b></div>
        <div class="tapzone" id="tap"></div>
      </div>`;
      if (run && run.over) h += `<div class="wait">Waiting for everyone to finish…</div>`;
    }

    root.innerHTML = h;
    const go = root.querySelector('#go');
    // Unlock audio HERE — this is a genuine user gesture, the only moment iOS
    // will let us start an AudioContext. Do it before the round exists.
    if (go) go.onclick = () => { unlockAudio(); Table.send({ t:'go' }); };
    const tz = root.querySelector('#tap');
    if (tz) {
      tz.addEventListener('pointerdown', tap, { passive:true });
      updateHud();
    }
  }

  render();
}
