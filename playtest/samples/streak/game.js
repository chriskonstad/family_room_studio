/* STREAK — game bundle. The SAME file runs on every device.
   Host instance is authoritative; clients render state and send intents.
   Bootstrapped by index.html: createGame(window.Table, rootElement).      */

function createGame(Table, root) {
  const MY = Table.me.id;
  let view = null;   // latest public state (rendered on every device)
  let G = null;      // authoritative state (host only)

  // ---- deck ----
  function buildDeck() {
    const d = [{ k:'num', v:0 }];
    for (let v=1; v<=12; v++) for (let i=0;i<v;i++) d.push({ k:'num', v });
    [2,4,6,8,10].forEach(v => d.push({ k:'mod', mod:'plus', v }));
    d.push({ k:'mod', mod:'x2' });
    for (let i=0;i<3;i++){ d.push({k:'act',act:'freeze'}); d.push({k:'act',act:'triple'}); d.push({k:'act',act:'save'}); }
    return d; // 94 cards
  }
  const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

  // ---- setup (host only) ----
  function initGame(players) {
    G = { phase:'playing', round:1, dealer:0, order:players.map(p=>p.id),
          names:{}, emojis:{}, totals:{}, lines:{}, status:{},
          deck:[], discard:[], turn:0, pending:null, work:[], roundOver:false,
          banner:'', winner:null, lastRound:{} };
    players.forEach(p => { G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.totals[p.id]=0; });
    startRound();
  }
  function startRound() {
    G.deck = shuffle(buildDeck()); G.discard = [];
    G.order.forEach(id => { G.lines[id] = { nums:[], mods:[], hasSave:false }; G.status[id]='active'; });
    G.pending = null; G.work = []; G.roundOver = false; G.winner = null;
    G.turn = nextActiveFrom(G.dealer % G.order.length, true);
    G.phase = 'playing';
    G.banner = 'Round ' + G.round + ' — ' + G.names[curId()] + ' starts';
  }
  const activeIds = () => G.order.filter(id => G.status[id]==='active');
  function nextActiveFrom(idx, inclusive) {
    const n = G.order.length;
    for (let s = inclusive?0:1; s<=n; s++){ const i=(idx+s)%n; if (G.status[G.order[i]]==='active') return i; }
    return -1;
  }
  const curId = () => (G.turn>=0 ? G.order[G.turn] : null);

  function draw() {
    if (!G.deck.length) { G.deck = shuffle(G.discard.length ? G.discard : buildDeck()); G.discard = []; }
    return G.deck.pop();
  }

  // ---- card resolution ----
  function doFlip(pid) {
    const card = draw(), line = G.lines[pid], busted = G.status[pid]==='busted';
    if (card.k === 'num') {
      if (busted) { G.discard.push(card); return; }
      if (line.nums.includes(card.v)) {
        if (line.hasSave) { line.hasSave=false; G.discard.push(card); G.banner = '🛟 '+G.names[pid]+' drew a second '+card.v+' — saved by their Second Chance!'; }
        else { G.status[pid]='busted'; line.bust = card.v; G.banner = '💥 '+G.names[pid]+' drew a second '+card.v+' — BUST!'; }
      } else {
        line.nums.push(card.v); G.banner = G.names[pid]+' flipped '+card.v;
        if (line.nums.length === 7) { G.banner = '🔥 '+G.names[pid]+' hit a FULL STREAK! +15'; G.roundOver = true; }
      }
    } else if (card.k === 'mod') {
      if (busted) { G.discard.push(card); return; }
      line.mods.push(card); G.banner = G.names[pid]+' got '+(card.mod==='x2'?'×2':'+'+card.v);
    } else { // action — resolve immediately, drawer chooses target
      const elig = eligible(card.act);
      if (elig.length === 0) { G.discard.push(card); G.banner = 'No valid target — '+label(card.act)+' discarded'; }
      else if (elig.length === 1) { applyAction(card.act, elig[0], pid); }
      else { G.pending = { chooserId:pid, action:card.act, eligible:elig }; G.banner = G.names[pid]+' drew '+label(card.act)+' — choosing a target…'; }
    }
  }
  function eligible(act) {
    const ids = activeIds();
    return act === 'save' ? ids.filter(id => !G.lines[id].hasSave) : ids; // freeze/triple: any active incl. self
  }
  function applyAction(act, target, chooser) {
    if (act === 'freeze') { G.status[target]='frozen'; G.banner = '🧊 '+G.names[chooser]+' froze '+G.names[target]+' — their points are locked in'; }
    else if (act === 'save') { G.lines[target].hasSave=true; G.banner = G.names[chooser]+' gave '+G.names[target]+' a Second Chance'; }
    else { G.banner = G.names[chooser]+' makes '+G.names[target]+' flip three!';   // triple
           G.work.unshift({t:'flip',pid:target},{t:'flip',pid:target},{t:'flip',pid:target}); }
  }
  function pump() {                                  // process forced work until it needs input or ends
    while (G.work.length && !G.pending && !G.roundOver) {
      const task = G.work.shift();
      if (task.t === 'flip') doFlip(task.pid);
    }
  }

  // ---- intents from players (host only) ----
  function handleIntent(from, msg) {
    if (msg.t === 'hello') return;                       // client webview came up; publish() follows
    if (G.phase === 'gameOver') return;                  // shell owns the results screen + "Play Again"
    if (G.phase === 'roundEnd') { if (msg.t==='next' && from===MY) { G.round++; G.dealer=(G.dealer+1)%G.order.length; G.lastRound={}; startRound(); } return; }
    if (G.phase !== 'playing') return;
    if (G.pending) {
      if (msg.t==='target' && from===G.pending.chooserId && G.pending.eligible.includes(msg.id)) {
        const act = G.pending.action; G.pending = null; applyAction(act, msg.id, from); resolveWork();
      }
      return;
    }
    if (msg.t==='flip' && from===curId()) { G.work.push({t:'flip',pid:from}); resolveWork(); }
    else if (msg.t==='bank' && from===curId() && canBank(from)) { G.status[from]='stayed'; G.banner = G.names[from]+' banked'; endTurnOrRound(); }
  }
  function resolveWork() {
    pump();
    if (G.roundOver) { endRound(); return; }
    if (G.pending) return;                 // waiting on a target choice
    if (G.work.length === 0) endTurnOrRound();
  }
  function endTurnOrRound() {
    if (activeIds().length === 0) { endRound(); return; }
    G.turn = nextActiveFrom(G.turn, false);
    if (G.turn === -1) endRound();
  }
  const canBank = pid => (G.lines[pid].nums.length + G.lines[pid].mods.length) > 0;

  function endRound() {
    G.pending = null; G.work = []; G.lastRound = {};
    G.order.forEach(id => {
      if (G.status[id] === 'busted') { G.lastRound[id] = 0; return; }
      G.lastRound[id] = scoreLine(id);
      G.totals[id] += G.lastRound[id];
    });
    const ranked = G.order.slice().sort((a,b) => G.totals[b]-G.totals[a]);
    const leader = ranked[0];
    if (G.totals[leader] >= 200) {
      G.phase='gameOver'; G.winner=leader; G.banner = '🏆 '+G.names[leader]+' wins with '+G.totals[leader]+'!';
      // Hand the terminal result to the shell for a native results screen + "Play Again".
      Table.endGame({
        winnerId: leader,
        standings: ranked.map(id => ({
          playerId: id,
          score: G.totals[id],
          detail: (G.lastRound && G.lastRound[id] != null) ? ('+'+G.lastRound[id]+' final round') : ''
        }))
      });
    } else { G.phase='roundEnd'; G.banner = 'Round '+G.round+' complete'; }
  }
  function scoreLine(id) {
    const l = G.lines[id];
    let s = l.nums.reduce((a,b)=>a+b,0);
    if (l.mods.some(m=>m.mod==='x2')) s *= 2;
    s += l.mods.filter(m=>m.mod==='plus').reduce((a,m)=>a+m.v,0);
    if (l.nums.length === 7) s += 15;
    return s;
  }
  const liveScore = id => G.status[id]==='busted' ? 0 : scoreLine(id);

  function publicState() {
    return {
      phase:G.phase, round:G.round, banner:G.banner, winner:G.winner,
      turn: G.phase==='playing' ? curId() : null,
      pending: G.pending ? { chooserId:G.pending.chooserId, action:G.pending.action, eligible:G.pending.eligible.slice() } : null,
      players: G.order.map(id => ({
        id, name:G.names[id], emoji:G.emojis[id], total:G.totals[id], status:G.status[id],
        nums:G.lines[id].nums.slice(), mods:G.lines[id].mods.slice(), hasSave:G.lines[id].hasSave,
        bust:(G.lines[id].bust != null) ? G.lines[id].bust : null,
        unique:G.lines[id].nums.length, roundPts:liveScore(id),
        lastRound:(G.lastRound && G.lastRound[id]!=null) ? G.lastRound[id] : null
      }))
    };
  }

  // ---- role wiring (same bundle, branch on isHost) ----
  if (Table.isHost) {
    Table.onStart(players => { initGame(players); publish(); });
    Table.onMessage((from, msg) => { handleIntent(from, msg); publish(); });
    Table.onPlayerLeave(id => {
      if (!G) return;
      if (G.status[id] === 'active') { G.status[id]='stayed'; G.banner = G.names[id]+' left — auto-banked'; if (curId()===id) endTurnOrRound(); }
      publish();
    });
  } else {
    Table.onStart(() => { view = { phase:'connecting' }; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_from, msg) => { if (msg.t === 'state') { view = msg.s; render(); } });
  }
  function publish() { const s = publicState(); Table.broadcast({ t:'state', s }); view = s; render(); }

  // ---- rendering (every device renders the same public state) ----
  const label = a => a==='freeze' ? 'Freeze' : a==='triple' ? 'Flip Three' : 'Second Chance';
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  // Animation bookkeeping: pop in only chips that are NEW since the last render,
  // and shake/flash a row only on the transition into busted/frozen.
  let seenChips = {};    // pid -> chip count last render
  let seenStatus = {};   // pid -> status last render

  function chipsHTML(p) {
    const prev = (seenChips[p.id] != null) ? seenChips[p.id] : 0;
    const chips = [];
    p.nums.forEach(n => chips.push({ cls: 'c' + (p.bust === n ? ' dup' : ''), txt: n }));
    p.mods.forEach(m => chips.push({ cls: 'c mod', txt: m.mod==='x2' ? '×2' : '+'+m.v }));
    if (p.bust != null) chips.push({ cls: 'c dup drawn', txt: p.bust });   // the fatal duplicate they drew
    if (p.hasSave) chips.push({ cls: 'c save', txt: '2ND' });
    if (!chips.length) return '<span class="empty">no cards yet</span>';
    const shrunk = chips.length < prev;   // new round — don't pop everything
    return chips.map((c, i) =>
      `<i class="${c.cls}${(!shrunk && i >= prev) ? ' pop' : ''}">${c.txt}</i>`).join('');
  }

  function render() {
    if (!view || !view.players) {
      root.innerHTML = '<span class="wait">Connecting to the table…</span>';
      return;
    }
    const v = view, meTurn = v.turn===MY, iChoose = v.pending && v.pending.chooserId===MY;
    const bannerCls = v.banner && v.banner.indexOf('💥')===0 ? ' bust'
                    : v.banner && v.banner.indexOf('🧊')===0 ? ' frozen'
                    : v.banner && v.banner.indexOf('🔥')===0 ? ' streak' : '';

    let h = `<div class="hdr"><span class="brand">STREAK</span>
      <span class="roundlbl">Round ${v.round}</span><span class="goal">first to 200</span></div>
      <div class="banner${bannerCls}">${esc(v.banner||'')}</div><div class="board">`;

    v.players.forEach(p => {
      const mine = p.id===MY;
      const state = p.status==='busted' ? `<span class="st bust">💥 BUST — double ${p.bust!=null?p.bust:''}</span>`
                  : p.status==='frozen' ? '<span class="st frozen">🧊 FROZEN</span>'
                  : p.status==='stayed' ? '<span class="st banked">🏦 banked</span>'
                  : p.roundPts+' pts';
      const justBusted = p.status==='busted' && seenStatus[p.id] !== 'busted';
      const justFrozen = p.status==='frozen' && seenStatus[p.id] !== 'frozen';
      h += `<div class="prow ${p.status} ${p.id===v.turn?'active-turn':''} ${mine?'me-row':''}${justBusted?' shake':''}${justFrozen?' freezeflash':''}">
        <div class="top"><span class="pemoji">${p.emoji}</span><span class="who">${esc(p.name)}</span>
          ${mine?'<span class="you">YOU</span>':''}
          <span class="meta">${state} · ${p.unique}/7 · <b>${p.total}</b></span></div>
        <div class="chips">${chipsHTML(p)}</div></div>`;
    });
    h += '</div><div class="ctrl">';

    if (v.phase === 'playing') {
      if (v.pending && !iChoose) {
        const c = v.players.find(p=>p.id===v.pending.chooserId);
        h += `<span class="wait">Waiting for ${c?esc(c.emoji+' '+c.name):'…'} to choose a target…</span>`;
      } else if (meTurn && !v.pending) {
        const me = v.players.find(p=>p.id===MY);
        h += `<div class="btnrow"><button data-act="flip" class="primary">Flip</button>
          <button data-act="bank" ${(me.nums.length+me.mods.length)===0?'disabled':''}>Bank${me.roundPts?` (${me.roundPts})`:''}</button></div>`;
      } else if (!v.pending) {
        const t = v.players.find(p=>p.id===v.turn);
        h += `<span class="wait">Waiting for ${t?esc(t.emoji+' '+t.name):'…'}</span>`;
      }
    }
    h += '</div>';

    // Overlays
    if (v.phase === 'playing' && iChoose) {
      let btns = '';
      v.pending.eligible.forEach(id => {
        const p = v.players.find(x=>x.id===id);
        btns += `<button data-act="target" data-id="${id}">${p.emoji} ${esc(p.name)}${id===MY?' (you)':''}</button>`;
      });
      h += `<div class="overlay"><div class="sheet">
        <h2 class="gold">${label(v.pending.action)}</h2>
        <p class="sub">Choose who gets it:</p>
        <div class="rowbtns">${btns}</div></div></div>`;
    } else if (v.phase === 'roundEnd') {
      // Between-rounds recap. The final game-over screen is the shell's (Table.endGame).
      const ranked = v.players.slice().sort((a,b)=>b.total-a.total);
      let rows = '';
      ranked.forEach(p => {
        rows += `<div class="score-row">
          <span>${p.emoji} ${esc(p.name)}</span>
          <span class="pts">+${(p.lastRound??0)} · <b>${p.total}</b></span></div>`;
      });
      const cta = Table.isHost
        ? `<button data-act="next" class="primary cta" style="width:100%">Next Round</button>`
        : `<span class="wait">Waiting for the host…</span>`;
      h += `<div class="overlay"><div class="sheet">
        <h2>Round ${v.round} complete</h2>
        <p class="sub">Running totals</p>
        ${rows}${cta}</div></div>`;
    }

    root.innerHTML = h;

    // update animation bookkeeping AFTER building the DOM
    v.players.forEach(p => {
      seenChips[p.id] = p.nums.length + p.mods.length + (p.bust!=null?1:0) + (p.hasSave?1:0);
      seenStatus[p.id] = p.status;
    });

    root.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a==='flip') Table.send({t:'flip'});
      else if (a==='bank') Table.send({t:'bank'});
      else if (a==='target') Table.send({t:'target', id:b.dataset.id});
      else if (a==='next') Table.send({t:'next'});
    });
  }

  render();
}
