function createGame(Table, root){
  const MY = Table.me.id;
  let view = null, G = null, myTap = null, tick = null, deadlineLocal = 0;
  const COLORS = [
    {k:'red',    ic:'🔴', c:'#e0564b'},
    {k:'blue',   ic:'🔵', c:'#4a90e0'},
    {k:'green',  ic:'🟢', c:'#43b06b'},
    {k:'yellow', ic:'🟡', c:'#e0a52e'}
  ];
  const pick = a=>a[Math.floor(Math.random()*a.length)];
  const esc = s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const colIc = k=>{ const c=COLORS.find(x=>x.k===k); return c?c.ic:''; };

  /// Shared game-feel runtime. Optional-chained so this bundle still runs on a
  /// harness that predates Table.feel (and in a plain browser).
  const feel = (e,o)=>{ try{ if(Table.feel) Table.feel(e,o); }catch(_){} };

  // Feedback bookkeeping. render() runs on every state AND on my own tap, so
  // every cue below is gated on a TRANSITION and these are updated after render.
  let seenAlive = {};        // id -> alive at the previous render
  let seenPromptRound = 0;   // round whose order we already announced
  let seenRevealRound = 0;   // round whose result we already resolved
  let beeps = [];            // countdown thresholds (ms left) still unfired this round

  // ---------- host ----------
  function initGame(players){
    G = {order:players.map(p=>p.id), names:{}, emojis:{}, alive:{}, out:[],
         phase:'ready', round:0, banner:'Get ready!', reveal:false};
    players.forEach(p=>{G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.alive[p.id]=true;});
  }
  const aliveIds = ()=>G.order.filter(id=>G.alive[id]);
  function nextRound(){
    G.round++;
    const col = pick(COLORS).k, real = Math.random() < 0.68;
    const win = Math.max(1300, 3200 - G.round*160);
    G.prompt = {color:col, real, win};
    G.taps = {}; G.reveal = false; G.phase = 'prompt';
    G.banner = real ? ('CAPTAIN SAYS tap ' + colIc(col)) : ('tap ' + colIc(col));
    clearTimeout(G.roundT);
    G.roundT = setTimeout(resolve, win);
    syncAll();
  }
  function handleIntent(from,msg){
    if(msg.t==='hello') return;
    if(G.phase==='ready' && msg.t==='go' && from===MY){ nextRound(); return; }
    if(G.phase==='prompt' && msg.t==='tap' && G.alive[from] && G.taps[from]==null){
      G.taps[from] = msg.color;   // record first tap only
    }
  }
  function resolve(){
    clearTimeout(G.roundT);
    const p = G.prompt, outs = [];
    aliveIds().forEach(id=>{
      const t = G.taps[id];
      const ok = p.real ? (t===p.color) : (t==null);
      if(!ok) outs.push(id);
    });
    if(outs.length && outs.length < aliveIds().length){
      outs.forEach(id=>{ G.alive[id]=false; G.out.push(id); });
      G.banner = '💥 Out: ' + outs.map(id=>G.emojis[id]).join(' ');
    } else if(outs.length){
      G.banner = '😅 Everyone survived that one!';   // would-eliminate-all → void
    } else {
      G.banner = '✅ Nobody caught out!';
    }
    G.reveal = true; G.phase = 'reveal';
    syncAll();
    if(aliveIds().length <= 1) setTimeout(finish, 1400);
    else setTimeout(nextRound, 1600);
  }
  function finish(){
    const w = aliveIds()[0] || null;
    const ranked = [...(w?[w]:[]), ...G.out.slice().reverse()];
    G.phase='over';
    Table.endGame({winnerId:w, standings:ranked.map((id,i)=>({
      playerId:id, score:i===0?'winner':'out',
      detail:i===0?'last sailor standing':('out #'+(ranked.length-i)) }))});
  }
  function publicState(){
    return {phase:G.phase, banner:G.banner, round:G.round,
      prompt:G.prompt?{color:G.prompt.color, real:G.prompt.real, win:G.prompt.win}:null,
      alive:{...G.alive}, names:G.names, emojis:G.emojis, order:G.order,
      taps:G.reveal?{...G.taps}:null};
  }
  function syncAll(){ const s=publicState(); Table.broadcast({t:'state',s}); onState(s); }
  function onState(s){
    const prev = view; view = s;
    if(s.phase==='prompt' && (!prev || prev.phase!=='prompt' || prev.round!==s.round)){
      myTap = null; startLocalTimer();
    }
    render();
  }

  if(Table.isHost){
    Table.onStart(p=>{ initGame(p); syncAll(); });
    Table.onMessage((f,m)=>{ const wasTap = m.t==='tap'; handleIntent(f,m); if(!wasTap) syncAll(); });
    Table.onPlayerLeave(id=>{
      if(!G) return;
      if(G.alive[id]){ G.alive[id]=false; G.out.push(id); if(aliveIds().length<=1 && G.phase!=='over') return finish(); }
      syncAll();
    });
  } else {
    Table.onStart(()=>{ view=null; render(); Table.send({t:'hello'}); });
    Table.onMessage((_f,m)=>{ if(m.t==='state') onState(m.s); });
  }

  function startLocalTimer(){
    clearInterval(tick);
    if(!view.prompt) return;
    deadlineLocal = Date.now() + view.prompt.win;
    beeps = [1000, 640, 300];              // one beep each, re-armed per round
    tick = setInterval(()=>{
      const bar = root.querySelector('.tbar i');
      if(!bar || !view || view.phase!=='prompt'){ clearInterval(tick); return; }
      const remain = Math.max(0, deadlineLocal-Date.now());
      const left = remain/view.prompt.win;
      bar.style.width = (left*100) + '%';
      // Final second: three beeps, the last one heavy. Shifting the threshold off
      // the list is what guarantees each beep fires exactly once per round.
      while(view.alive[MY] && beeps.length && remain <= beeps[0]){
        beeps.shift();
        feel('countdown', {mine: beeps.length===0});
      }
      // …and the bar itself starts blinking. Re-applied because render() rebuilds
      // the node; `urgent` is silent, so this is a class add, never a repeated cue.
      if(left<=0.25 && !bar.classList.contains('fr-blink')) feel('urgent', {el:bar});
      if(left<=0) clearInterval(tick);
    }, 60);
  }

  // ---------- render ----------
  function render(){
    if(!view){ root.innerHTML='<div class="big"><span class="wait">Assembling the crew…</span></div>'; return; }
    const v = view;
    let h = `<div class="hdr"><span class="brand">CAPTAIN SAYS</span><span class="sub">${v.order.filter(id=>v.alive[id]).length} left</span></div>`;
    h += `<div class="crew">` + v.order.map(id=>
      `<span class="cm ${v.alive[id]?'':'out'}">${v.emojis[id]}${(v.taps&&v.taps[id]!=null)?' •':''}</span>`).join('') + `</div>`;
    h += `<div class="banner ${v.prompt&&v.prompt.real?'says':'trap'}">${esc(v.banner||'')}</div>`;

    if(v.phase==='ready'){
      h += `<div class="big"><div class="ic">🫡</div>
        <div class="hint">Only obey when the <b>Captain says</b>! Tap the right color in time. Tap on a plain order (no "Captain says") and you're <b>out</b>. Last sailor standing wins.</div>`;
      h += Table.isHost ? `<button class="primary" id="go">Set sail ⚓️</button>`
                        : `<div class="wait">Waiting for the host…</div>`;
      h += `</div>`;
    } else if(v.phase==='prompt'){
      const meAlive = v.alive[MY];
      h += `<div class="tbar"><i></i></div>`;
      h += `<div class="colors">` + COLORS.map(c=>
        `<button class="col ${myTap===c.k?'picked':''}" data-c="${c.k}" ${meAlive?'':'disabled'} style="--c:${c.c}">${c.ic}</button>`).join('') + `</div>`;
      h += meAlive
        ? (myTap ? `<div class="wait">Locked in ${colIc(myTap)}</div>`
                 : `<div class="hint">${v.prompt.real ? 'obey! tap '+colIc(v.prompt.color) : '⚠️ trap — tap nothing'}</div>`)
        : `<div class="wait">💥 you're out — watch the rest</div>`;
    } else if(v.phase==='reveal'){
      const ok = (v.banner||'').indexOf('💥') < 0;
      // Show what everybody actually tapped — a reaction round is unreadable
      // without it. "Was in this round" = alive now, or alive at the last render.
      const played = v.taps ? v.order.filter(id=>v.alive[id] || seenAlive[id]) : [];
      const taps = played.map(id=>`${v.emojis[id]}${v.taps[id]!=null?colIc(v.taps[id]):'—'}`).join('  ');
      h += `<div class="big"><div class="ic">${ok?'✅':'💥'}</div>
        ${taps?`<div class="hint" style="font-size:20px;letter-spacing:.05em">${taps}</div>`:''}
        <div class="hint">${esc(v.banner)}</div></div>`;
    }
    root.innerHTML = h;

    // ---------- feedback (after innerHTML, on live nodes) ----------
    const chips = root.querySelectorAll('.crew .cm');      // index-aligned with v.order
    const chipOf = id => chips[v.order.indexOf(id)] || null;

    if(v.phase==='prompt' && seenPromptRound!==v.round){
      seenPromptRound = v.round;                           // once per round
      feel('arrive', {el:'.banner'});                      // a new order just landed
    }
    if(v.phase==='reveal' && seenRevealRound!==v.round){
      seenRevealRound = v.round;                           // once per round
      feel('reveal', {el:'.big .ic'});
      const outs = v.order.filter(id => !v.alive[id] && seenAlive[id]===true);
      const iAmOut = outs.indexOf(MY) >= 0;
      // Shake EVERY chip that just went out, but make a noise only once — yours
      // if you're in it, otherwise the first — so a 6-player table isn't a mess.
      outs.forEach((id,i)=>{
        const lead = iAmOut ? id===MY : i===0;
        feel('eliminate', {el:chipOf(id), mine:iAmOut && id===MY, silent:!lead, quiet:!lead});
      });
      if(v.alive[MY] && seenAlive[MY]===true){             // you survived the round
        feel('gain', {el:chipOf(MY), mine:true, silent:outs.length>0, quiet:outs.length>0});
      }
    }
    // bookkeeping AFTER the DOM is built and the reveal list has been read
    v.order.forEach(id=>{ seenAlive[id] = !!v.alive[id]; });

    const g = root.querySelector('#go'); if(g) g.onclick=()=>Table.send({t:'go'});
    root.querySelectorAll('[data-c]').forEach(b=>{ if(!b.disabled) b.onclick=()=>{
      if(myTap) return; myTap = b.dataset.c; Table.send({t:'tap',color:b.dataset.c});
      feel('tick', {mine:true});                           // guarded by the myTap latch
      render();
    };});
  }
  render();
}
