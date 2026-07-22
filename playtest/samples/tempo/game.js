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
          seed: Math.floor(Math.random()*1e9) };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.scores[p.id]=0; G.finished[p.id]=false; });
  }
  function handleIntent(from, msg) {
    if (msg.t === 'hello') return;
    if (msg.t === 'go' && from === MY && G.phase === 'ready') { G.phase = 'playing'; }
    else if (msg.t === 'score' && G.phase === 'playing') { G.scores[from] = msg.score; }
    else if (msg.t === 'done' && G.phase === 'playing') {
      G.scores[from] = msg.score; G.finished[from] = true;
      if (G.order.every(id => G.finished[id])) {
        const ranked = G.order.slice().sort((a,b)=>G.scores[b]-G.scores[a]);
        G.phase = 'over';
        Table.endGame({
          winnerId: ranked[0],
          standings: ranked.map(id => ({ playerId:id, score:G.scores[id] })),
        });
      }
    }
  }
  function publicState() {
    return { phase:G.phase, seed:G.seed, names:G.names, emojis:G.emojis, order:G.order,
             scores:{...G.scores}, finished:{...G.finished} };
  }
  function syncAll(){ const s = publicState(); Table.broadcast({ t:'state', s }); onState(s); }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); syncAll(); });
    Table.onMessage((from, msg) => { handleIntent(from, msg); syncAll(); });
    Table.onPlayerLeave(id => { if (G) { G.finished[id] = true; handleIntent(id, {t:'done', score:G.scores[id]||0}); syncAll(); } });
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
  function startRun(seed) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const audio = AC ? new AC() : null;
    run = { beats: buildBeats(seed), idx:0, score:0, combo:0, best:0, hits:0,
            start: performance.now()/1000 + 0.15, audio, lastSent:0, over:false };
    if (audio && audio.state === 'suspended') audio.resume();
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
    updateHud();
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
    if (go) go.onclick = () => { Table.send({ t:'go' }); };
    const tz = root.querySelector('#tap');
    if (tz) {
      tz.addEventListener('pointerdown', tap, { passive:true });
      updateHud();
    }
  }

  render();
}
