/* FISHBOWL — the classic party game, phones instead of paper slips.
   Everyone secretly enters 3 phrases; teams alternate 60-second turns across
   three rounds with the SAME phrases: 1) Describe it  2) One word  3) Act it out.
   Uses the shell's team support (Table.teams). Host authoritative. */

function createGame(Table, root) {
  const MY = Table.me.id;
  const PHRASES_PER_PLAYER = 3;
  const TURN_SECONDS = 60;
  const ROUNDS = [
    { name:'Describe it!',  hint:'Say anything except the words on the card.' },
    { name:'One word only!', hint:'A single word. Choose wisely.' },
    { name:'Act it out!',    hint:'No words, no sounds. Charades!' },
  ];
  let view = null;
  let myEntryDone = false;
  let localDeadline = null;   // giver countdown (device-local clock)
  let tick = null;
  let G = null;

  const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

  // ---------- host ----------
  function initGame(players) {
    const teams = Table.teams.filter(t => t.playerIds.length > 0);
    G = {
      phase:'entry', names:{}, emojis:{},
      teams: teams.map(t => ({ id:t.id, name:t.name, color:t.color, playerIds:t.playerIds.slice(), score:0, giverIdx:0 })),
      submitted:{}, phrases:[],
      round:0, teamIdx:0, bowl:[], current:null, turnEndsAt:null,
    };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.submitted[p.id]=false; });
    G.banner = 'Write your phrases!';
  }

  function everyoneSubmitted(){ return Object.values(G.submitted).every(Boolean); }
  function currentTeam(){ return G.teams[G.teamIdx % G.teams.length]; }
  function currentGiver(){ const t=currentTeam(); return t.playerIds[t.giverIdx % t.playerIds.length]; }

  function startRound() {
    G.bowl = shuffle(G.phrases.map((_,i)=>i));
    G.phase = 'turnReady';
  }
  function beginTurn() {
    G.phase = 'turn';
    G.current = G.bowl[0];
    G.turnEndsAt = Date.now() + TURN_SECONDS*1000;
    G.turnTimer = setTimeout(() => { endTurn(); syncAll(); }, TURN_SECONDS*1000);
  }
  function endTurn() {
    clearTimeout(G.turnTimer);
    const t = currentTeam();
    t.giverIdx++;
    G.teamIdx++;
    G.current = null;
    G.phase = G.bowl.length ? 'turnReady' : 'roundOver';
  }
  function got() {
    currentTeam().score++;
    G.bowl.shift();
    if (!G.bowl.length) { endTurn(); return; }        // bowl empty ends round (and turn)
    G.current = G.bowl[0];
  }
  function skip() {
    if (G.bowl.length < 2) return;                    // nothing to swap to
    G.bowl.push(G.bowl.shift());
    G.current = G.bowl[0];
  }
  function nextRoundOrEnd() {
    if (G.round + 1 >= ROUNDS.length) {
      const ranked = G.teams.slice().sort((a,b)=>b.score-a.score);
      G.phase='gameOver';
      Table.endGame({
        winnerId: ranked[0].id,
        title: ranked[0].score===ranked[1]?.score ? 'It’s a tie!' : undefined,
        standings: ranked.map(t => ({ teamId:t.id, score:t.score })),
      });
      return;
    }
    G.round++; startRound();
  }

  function handleIntent(from, msg) {
    if (msg.t === 'hello') { return; }
    if (G.phase === 'entry' && msg.t === 'phrases' && !G.submitted[from]) {
      const cleaned = (msg.phrases||[]).map(s => String(s).trim()).filter(Boolean).slice(0, PHRASES_PER_PLAYER);
      if (cleaned.length < PHRASES_PER_PLAYER) return;
      G.phrases.push(...cleaned);
      G.submitted[from] = true;
      if (everyoneSubmitted()) { G.phrases = shuffle(G.phrases); startRound(); }
      return;
    }
    if (G.phase === 'turnReady' && msg.t === 'begin' && from === currentGiver()) { beginTurn(); return; }
    if (G.phase === 'turn' && from === currentGiver()) {
      if (msg.t === 'got') got();
      else if (msg.t === 'skip') skip();
      return;
    }
    if (G.phase === 'roundOver' && msg.t === 'next' && from === MY) { nextRoundOrEnd(); return; }
  }

  function publicState() {
    return {
      phase:G.phase, round:G.round, roundName:ROUNDS[G.round].name, roundHint:ROUNDS[G.round].hint,
      names:G.names, emojis:G.emojis,
      teams: G.teams.map(t => ({ id:t.id, name:t.name, color:t.color, score:t.score })),
      submittedCount: Object.values(G.submitted).filter(Boolean).length,
      totalPlayers: Object.keys(G.submitted).length,
      mySubmitted: null,   // filled per-device below
      activeTeamId: (G.phase==='turnReady'||G.phase==='turn') ? currentTeam().id : null,
      giver: (G.phase==='turnReady'||G.phase==='turn') ? currentGiver() : null,
      bowlLeft: G.bowl.length,
      secondsLeft: G.phase==='turn' ? Math.max(0, Math.round((G.turnEndsAt-Date.now())/1000)) : null,
      canSkip: G.bowl.length >= 2,
    };
  }
  function syncAll() {
    const s = publicState();
    Table.broadcast({ t:'state', s });
    // the current phrase goes ONLY to the giver
    if (G.phase === 'turn' && G.current != null) {
      const phrase = G.phrases[G.current];
      if (currentGiver() === MY) { view = {...s, phrase}; startLocalTimer(s.secondsLeft); render(); return; }
      Table.sendTo(currentGiver(), { t:'phrase', phrase, secondsLeft: s.secondsLeft });
    }
    view = s; startLocalTimer(s.secondsLeft); render();
  }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); syncAll(); });
    Table.onMessage((from, msg) => { handleIntent(from, msg); syncAll(); });
    Table.onPlayerLeave(id => {
      if (!G) return;
      G.teams.forEach(t => { t.playerIds = t.playerIds.filter(p => p !== id); });
      G.teams = G.teams.filter(t => t.playerIds.length);
      if (G.phase === 'entry') { delete G.submitted[id]; if (everyoneSubmitted() && G.phrases.length) startRound(); }
      syncAll();
    });
  } else {
    Table.onStart(() => { view=null; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_f, msg) => {
      if (msg.t === 'state') { view = msg.s; startLocalTimer(msg.s.secondsLeft); render(); }
      else if (msg.t === 'phrase') { view = {...view, phrase: msg.phrase}; startLocalTimer(msg.secondsLeft); render(); }
    });
  }

  function startLocalTimer(secondsLeft) {
    clearInterval(tick); localDeadline = null;
    if (secondsLeft == null) return;
    localDeadline = Date.now() + secondsLeft*1000;
    tick = setInterval(() => {
      if (!view || view.phase !== 'turn') { clearInterval(tick); return; }
      renderTimerOnly();
      if (Date.now() >= localDeadline) clearInterval(tick);
    }, 200);
  }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const teamBar = () => `<div class="scorebar">` + view.teams.map(t =>
    `<div class="tscore ${t.id===view.activeTeamId?'active':''}" style="background:${t.color}">
      <span class="n">${esc(t.name.replace(' Team',''))}</span><span class="s">${t.score}</span></div>`).join('') + `</div>`;

  function secondsNow() {
    return localDeadline ? Math.max(0, Math.ceil((localDeadline-Date.now())/1000)) : (view.secondsLeft ?? 0);
  }
  function renderTimerOnly() {
    const bar = root.querySelector('.timer i'); const num = root.querySelector('.timenum');
    if (!bar || !num) return;
    const s = secondsNow();
    num.textContent = s;
    bar.style.width = (s/TURN_SECONDS*100) + '%';
    root.querySelector('.timer').classList.toggle('low', s <= 10);
  }

  function render() {
    if (!view) { root.innerHTML = '<div class="big"><span class="wait">Filling the bowl…</span></div>'; return; }
    const v = view;
    let h = `<div class="hdr"><span class="brand">FISHBOWL</span>
      <span class="sub">Round ${v.round+1}/3 · ${esc(v.roundName)}</span></div>` + teamBar();

    if (v.phase === 'entry') {
      h += `<div class="big"><div class="fish">🐟</div>`;
      if (!myEntryDone) {
        h += `<div class="hint">Enter <b>3 words or phrases</b>. They'll be guessed by everyone — across all three rounds.</div>
          <div class="entrywrap">
            <input type="text" id="ph0" placeholder="e.g. Moonwalk" maxlength="40">
            <input type="text" id="ph1" placeholder="e.g. Taco Tuesday" maxlength="40">
            <input type="text" id="ph2" placeholder="e.g. Beyoncé" maxlength="40">
            <button class="primary" id="submitPhrases" style="width:100%">Drop them in the bowl</button>
          </div>`;
      } else {
        h += `<div class="hint">Your phrases are in the bowl.</div>`;
      }
      h += `<div class="wait">${v.submittedCount}/${v.totalPlayers} players ready</div></div>`;
    }
    else if (v.phase === 'turnReady') {
      const giverMe = v.giver === MY;
      const t = v.teams.find(x=>x.id===v.activeTeamId);
      h += `<div class="roundlbl"><b>${esc(v.roundName)}</b> — ${esc(v.roundHint)} · ${v.bowlLeft} left in the bowl</div>
        <div class="big">
        <div class="fish">${v.emojis[v.giver]||'🐟'}</div>
        <div class="hint"><b style="color:${t.color}">${esc(t.name)}</b> up next.<br>
          <b>${esc(v.names[v.giver]||'')}</b> gives the clues.</div>`;
      h += giverMe
        ? `<button class="primary" id="begin" style="width:100%;max-width:340px">Start my 60 seconds</button>`
        : `<div class="wait">Waiting for ${esc(v.names[v.giver]||'')} to start…</div>`;
      h += `</div>`;
    }
    else if (v.phase === 'turn') {
      const giverMe = v.giver === MY;
      const t = v.teams.find(x=>x.id===v.activeTeamId);
      const onTeam = Table.me.teamId === v.activeTeamId;
      const s = secondsNow();
      h += `<div class="big">
        <div class="timenum">${s}</div>
        <div class="timer ${s<=10?'low':''}"><i style="width:${s/TURN_SECONDS*100}%"></i></div>`;
      if (giverMe) {
        h += `<div class="phrasecard">${esc(v.phrase||'…')}</div>
          <div class="btnrow">
            <button class="good" id="got">Got it ✓</button>
            <button id="skip" ${v.canSkip?'':'disabled'}>Skip ↻</button>
          </div>
          <div class="hint">${esc(v.roundHint)}</div>`;
      } else if (onTeam) {
        h += `<div class="phrasecard">🗣️</div><div class="hint"><b style="color:${t.color}">Your team is up!</b><br>Shout your guesses at ${esc(v.names[v.giver]||'')}!</div>`;
      } else {
        h += `<div class="phrasecard">🤫</div><div class="hint">${esc(t.name)} is guessing.<br>No helping!</div>`;
      }
      h += `<div class="wait">${v.bowlLeft} left in the bowl</div></div>`;
    }
    else if (v.phase === 'roundOver') {
      h += `<div class="big"><div class="fish">🎉</div>
        <div class="hint"><b>${esc(v.roundName)}</b> complete — the bowl is empty!</div>`;
      h += Table.isHost
        ? `<button class="primary" id="next" style="width:100%;max-width:340px">${v.round+1>=3?'Final results':'Next round'}</button>`
        : `<div class="wait">Waiting for the host…</div>`;
      h += `</div>`;
    }

    root.innerHTML = h;
    const sub = root.querySelector('#submitPhrases');
    if (sub) sub.onclick = () => {
      const phrases = [0,1,2].map(i => root.querySelector('#ph'+i).value.trim());
      if (phrases.some(p => !p)) { sub.textContent = 'Fill in all 3!'; return; }
      myEntryDone = true;
      Table.send({ t:'phrases', phrases });
      render();
    };
    const b = root.querySelector('#begin'); if (b) b.onclick = () => Table.send({ t:'begin' });
    const g = root.querySelector('#got');   if (g) g.onclick = () => Table.send({ t:'got' });
    const k = root.querySelector('#skip');  if (k) k.onclick = () => Table.send({ t:'skip' });
    const n = root.querySelector('#next');  if (n) n.onclick = () => Table.send({ t:'next' });
  }

  render();
}
