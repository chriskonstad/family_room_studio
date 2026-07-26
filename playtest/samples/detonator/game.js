function createGame(Table, root){
  const MY = Table.me.id;
  let view = null, G = null;
  const esc = s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const PLCOLORS = ['#e0564b','#e0a52e','#43b06b','#4a90e0','#9b6ee0'];

  /// Shared game-feel runtime. Optional-chained so this bundle still runs on a
  /// harness that predates Table.feel (and in a plain browser).
  const feel = (e,o)=>{ try{ if(Table.feel) Table.feel(e,o); }catch(_){} };

  // Feedback bookkeeping — cues fire on plunger/turn TRANSITIONS, not per render.
  // Updated at the end of render().
  let seenPlungers = null;   // plunger states at the previous render
  let seenTurn = null;       // whose turn it WAS — i.e. whoever just pressed

  // ---------- host ----------
  function initGame(players){
    G = {order:players.map(p=>p.id), names:{}, emojis:{}, alive:{}, out:[],
         phase:'playing', turn:0, banner:'', reveal:false};
    players.forEach(p=>{G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.alive[p.id]=true;});
    newBank(true);
  }
  const aliveIds = ()=>G.order.filter(id=>G.alive[id]);
  const curId = ()=>G.order[G.turn];
  function newBank(first){
    G.plungers = [0,0,0,0,0];               // 0 unpressed · 1 safe · 2 boom
    G.live = Math.floor(Math.random()*5);
    G.reveal = false;
    G.banner = (first?'':'💣 New detonator armed — ') + G.names[curId()] + ', press a plunger';
  }
  function advanceTurn(){
    const n = G.order.length;
    for(let s=1;s<=n;s++){ const i=(G.turn+s)%n; if(G.alive[G.order[i]]){ G.turn=i; return; } }
  }
  function handleIntent(from,msg){
    if(msg.t==='hello') return;
    if(G.phase!=='playing') return;
    if(msg.t==='press' && from===curId() && G.plungers[msg.i]===0){
      if(msg.i===G.live){
        G.plungers[msg.i]=2; G.reveal=true;
        G.alive[from]=false; G.out.push(from);
        G.banner = '💥 ' + G.names[from] + ' hit the detonator!';
        syncAll();
        if(aliveIds().length<=1){ setTimeout(finish,1500); return; }
        setTimeout(()=>{ advanceTurn(); newBank(false); syncAll(); }, 2000);
      } else {
        G.plungers[msg.i]=1;
        advanceTurn();
        G.banner = G.names[curId()] + "'s turn — press a plunger";
        syncAll();
      }
    }
  }
  function finish(){
    const w = aliveIds()[0] || null;
    const ranked = [...(w?[w]:[]), ...G.out.slice().reverse()];
    G.phase='over';
    Table.endGame({winnerId:w, standings:ranked.map((id,i)=>({
      playerId:id, score:i===0?'survived':'💥',
      detail:i===0?'nerves of steel':('out #'+(ranked.length-i)) }))});
  }
  function publicState(){
    return {phase:G.phase, banner:G.banner, turn:curId(), plungers:G.plungers.slice(),
      live:G.reveal?G.live:-1, names:G.names, emojis:G.emojis, order:G.order, alive:{...G.alive}};
  }
  function syncAll(){ const s=publicState(); Table.broadcast({t:'state',s}); view=s; render(); }

  if(Table.isHost){
    Table.onStart(p=>{ initGame(p); syncAll(); });
    Table.onMessage((f,m)=>handleIntent(f,m));
    Table.onPlayerLeave(id=>{
      if(!G) return;
      if(G.alive[id]){
        G.alive[id]=false; G.out.push(id);
        if(curId()===id) advanceTurn();
        if(aliveIds().length<=1 && G.phase!=='over') return finish();
      }
      syncAll();
    });
  } else {
    Table.onStart(()=>{ view=null; render(); Table.send({t:'hello'}); });
    Table.onMessage((_f,m)=>{ if(m.t==='state'){ view=m.s; render(); } });
  }

  // ---------- render ----------
  function render(){
    if(!view){ root.innerHTML='<div class="big"><span class="wait">Wiring the bombs…</span></div>'; return; }
    const v = view;
    const meTurn = v.turn===MY && v.alive[MY] && v.phase==='playing';
    let h = `<div class="hdr"><span class="brand">THE DETONATOR</span><span class="sub">${v.order.filter(id=>v.alive[id]).length} left</span></div>`;
    h += `<div class="banner ${v.live>=0?'boom':''}">${esc(v.banner||'')}</div>`;
    h += `<div class="players">` + v.order.map(id=>
      `<span class="pl ${v.alive[id]?'':'out'} ${id===v.turn?'turn':''}">${v.emojis[id]}</span>`).join('') + `</div>`;
    h += `<div class="big"><div class="plungers">` + v.plungers.map((st,i)=>{
      const cls = st===2?'boom' : st===1?'safe' : (v.live===i?'live':'');
      const label = st===2?'💥' : st===1?'✓' : (v.live===i?'💣':'⏻');
      const dis = (meTurn && st===0) ? '' : 'disabled';
      return `<button class="plunger ${cls}" data-i="${i}" ${dis} style="--c:${PLCOLORS[i]}">${label}</button>`;
    }).join('') + `</div>`;
    h += meTurn ? `<div class="hint">Pick a plunger… one is live 😬</div>`
                : (v.phase==='playing' ? `<div class="wait">Waiting for ${esc(v.names[v.turn]||'')} to press…</div>` : '');
    h += `</div>`;
    root.innerHTML = h;

    // ---------- feedback (after innerHTML, on live nodes) ----------
    const btns    = root.querySelectorAll('.plungers .plunger');   // aligned with v.plungers
    const plChips = root.querySelectorAll('.players .pl');         // aligned with v.order
    const prev = seenPlungers, presser = seenTurn, mine = presser===MY;

    if(prev){
      let safeI = -1, boomI = -1;
      v.plungers.forEach((st,i)=>{                      // only 0 -> pressed counts
        if(prev[i]===0 && st===1) safeI = i; else if(prev[i]===0 && st===2) boomI = i;
      });
      if(safeI>=0) feel('gain', {el:btns[safeI], mine});
      if(boomI>=0) feel('eliminate', {el:'.plungers', mine});   // the .boom blast plays too
      // A fresh detonator: every plunger back to unpressed.
      if(prev.some(s=>s!==0) && v.plungers.every(s=>s===0)) feel('arrive', {el:'.plungers'});
    }
    if(v.phase==='playing' && v.turn && plChips.length){
      // Standing glow on the active player. Re-applied because render() rebuilds
      // the chips; the selection haptic only when the turn newly becomes YOURS.
      const el = plChips[v.order.indexOf(v.turn)];
      if(el) feel('turn', {el, quiet: !(v.turn!==seenTurn && v.turn===MY)});
    }
    seenPlungers = v.plungers.slice(); seenTurn = v.turn;   // AFTER the DOM is built

    root.querySelectorAll('[data-i]').forEach(b=>{ if(!b.disabled) b.onclick=()=>Table.send({t:'press',i:+b.dataset.i}); });
  }
  render();
}
