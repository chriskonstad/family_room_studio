function createGame(Table, root){
  const MY = Table.me.id;
  let view = null, G = null;
  const rnd = (a,b)=>a+Math.random()*(b-a);
  const pick = a=>a[Math.floor(Math.random()*a.length)];
  const esc = s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  /// Shared game-feel runtime. Optional-chained so this bundle still runs on a
  /// harness that predates Table.feel (and in a plain browser).
  const feel = (e,o)=>{ try{ if(Table.feel) Table.feel(e,o); }catch(_){} };

  // This game re-broadcasts 4x/SECOND to drive the heat bar, so render() runs
  // ~4x/second. Every cue below is therefore gated on a transition, and these
  // are updated at the very end of render().
  let seenPhase = null;      // phase at the previous render
  let seenHolder = null;     // who held the bomb at the previous render
  let heatIdx = 0;           // next unfired fuse mark; only ever moves forward
  const HEAT_MARKS = [0.5, 0.72, 0.88, 0.96];

  // ---------- host ----------
  function initGame(players){
    G = {order:players.map(p=>p.id), names:{}, emojis:{}, alive:{}, out:[],
         phase:'ready', holder:null, heat:0, banner:'Light the fuse!'};
    players.forEach(p=>{G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.alive[p.id]=true;});
  }
  const aliveIds = ()=>G.order.filter(id=>G.alive[id]);

  function lightBomb(){
    G.holder = pick(aliveIds());
    G.phase = 'live';
    G.start = Date.now();
    G.fuse  = rnd(9000, 19000);
    G.est   = G.fuse * 1.18;
    G.heat  = 0;
    G.banner = '🔥 HOT POTATO — pass it!';
    clearTimeout(G.boomT); clearInterval(G.heatT);
    G.boomT = setTimeout(explode, G.fuse);
    G.heatT = setInterval(()=>{ G.heat = Math.min(1,(Date.now()-G.start)/G.est); syncAll(); }, 250);
    syncAll();
  }
  function explode(){
    clearInterval(G.heatT); clearTimeout(G.boomT);
    const dead = G.holder;
    G.alive[dead] = false; G.out.push(dead);
    G.heat = 1; G.phase = 'boom';
    G.banner = '💥 ' + G.names[dead] + ' got blown up!';
    syncAll();
    if(aliveIds().length <= 1) setTimeout(finish, 1500);
    else setTimeout(()=>{ lightBomb(); }, 1900);
  }
  function finish(){
    const winner = aliveIds()[0] || null;
    const ranked = [...(winner?[winner]:[]), ...G.out.slice().reverse()];
    G.phase = 'over';
    Table.endGame({winnerId:winner, standings:ranked.map((id,i)=>({
      playerId:id, score:i===0?'survived':'💥',
      detail:i===0?'last one standing':('out #'+(ranked.length-i)) }))});
  }
  function handleIntent(from,msg){
    if(msg.t==='hello') return;
    if(G.phase==='ready' && msg.t==='light' && from===MY){ lightBomb(); return; }
    if(G.phase==='live' && msg.t==='pass' && from===G.holder && G.alive[msg.to] && msg.to!==from){
      G.holder = msg.to;
      G.banner = G.names[from] + ' threw it to ' + G.names[msg.to] + '!';
      syncAll();
    }
  }
  function publicState(){
    return {phase:G.phase, banner:G.banner, holder:G.holder, heat:G.heat,
      names:G.names, emojis:G.emojis, order:G.order, alive:{...G.alive}};
  }
  function syncAll(){ const s=publicState(); Table.broadcast({t:'state',s}); view=s; render(); }

  if(Table.isHost){
    Table.onStart(p=>{ initGame(p); syncAll(); });
    Table.onMessage((f,m)=>handleIntent(f,m));
    Table.onPlayerLeave(id=>{
      if(!G) return;
      if(G.alive[id]){
        G.alive[id]=false; G.out.push(id);
        if(G.holder===id && G.phase==='live'){ const l=aliveIds(); if(l.length) G.holder=pick(l); }
        if(aliveIds().length<=1 && G.phase!=='over'){ clearTimeout(G.boomT); clearInterval(G.heatT); return finish(); }
      }
      syncAll();
    });
  } else {
    Table.onStart(()=>{ view=null; render(); Table.send({t:'hello'}); });
    Table.onMessage((_f,m)=>{ if(m.t==='state'){ view=m.s; render(); } });
  }

  // ---------- render ----------
  function render(){
    if(!view){ root.innerHTML='<div class="big"><span class="wait">Arming…</span></div>'; return; }
    const v = view;
    const alive = v.order.filter(id=>v.alive[id]);
    let h = `<div class="hdr"><span class="brand">PASS THE BOMB</span><span class="sub">${alive.length} left</span></div>`;
    h += `<div class="heat ${v.heat>0.6?'hot':''}"><i style="width:${Math.round((v.heat||0)*100)}%"></i></div>`;
    h += `<div class="banner">${esc(v.banner||'')}</div>`;

    if(v.phase==='ready'){
      h += `<div class="big"><div class="bomb">💣</div>
        <div class="hint">Whoever's holding the bomb when it blows is <b>out</b>. Tap a friend to throw it — don't get caught!</div>`;
      h += Table.isHost ? `<button class="primary" id="light">Light the fuse 🔥</button>`
                        : `<div class="wait">Waiting for the host…</div>`;
      h += `</div>`;
    } else if(v.phase==='live'){
      const meHold = v.holder===MY, meAlive = v.alive[MY];
      if(meHold){
        const dur = Math.max(120, 320 - v.heat*260);
        h += `<div class="big"><div class="bomb hold" style="animation-duration:${dur}ms">💣</div>
          <div class="hint"><b>You've got it!</b> Throw it — fast!</div>
          <div class="throws">` + alive.filter(id=>id!==MY).map(id=>
            `<button class="throw" data-to="${id}">${v.emojis[id]} ${esc(v.names[id])}</button>`).join('') + `</div></div>`;
      } else {
        h += `<div class="big"><div class="bomb">${v.emojis[v.holder]||'💣'}</div>
          <div class="hint"><b>${esc(v.names[v.holder]||'')}</b> is holding the bomb…<br>${meAlive?'stay cool 😎':'💥 you\'re out — watch the chaos'}</div></div>`;
      }
    } else if(v.phase==='boom'){
      h += `<div class="big"><div class="bomb boom">💥</div><div class="hint">${esc(v.banner)}</div></div>`;
    }
    root.innerHTML = h;

    // ---------- feedback (after innerHTML, on live nodes) ----------
    const newBomb    = v.phase==='live' && seenPhase!=='live';
    const justPassed = v.phase==='live' && seenPhase==='live' && seenHolder && v.holder!==seenHolder;
    const justBoom   = v.phase==='boom' && seenPhase!=='boom';

    if(newBomb) heatIdx = 0;                       // fresh fuse, re-arm the marks
    if(newBomb || justPassed){                     // one holder change = one cue
      if(v.holder===MY) feel('arrive', {el:'.bomb', mine:true});   // it lands in YOUR hands
      else feel('pass');                                           // whoosh, it went past you
    }
    if(justBoom) feel('eliminate', {el:'.big', mine:v.holder===MY});

    // Fuse ticks, for the HOLDER only — five other phones stay quiet. The pointer
    // never rewinds, so each mark fires once, and at most one tick per render.
    if(v.phase==='live' && v.holder===MY){
      let crossed = false;
      while(heatIdx<HEAT_MARKS.length && (v.heat||0)>=HEAT_MARKS[heatIdx]){ heatIdx++; crossed = true; }
      if(crossed) feel('tick', {mine:true});
    }
    // Silent standing state; re-applied because render() rebuilds the bar 4x/sec.
    if(v.phase==='live' && (v.heat||0)>0.6) feel('urgent', {el:'.heat i'});

    seenPhase = v.phase; seenHolder = v.holder;     // bookkeeping AFTER the DOM is built

    const lb = root.querySelector('#light'); if(lb) lb.onclick=()=>Table.send({t:'light'});
    root.querySelectorAll('[data-to]').forEach(b=>b.onclick=()=>Table.send({t:'pass',to:b.dataset.to}));
  }
  render();
}
