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
  // FR owns turn order, elimination, the RNG and the timers.
  const rng   = FR.rng(Table.seed);
  const seats = FR.seats(Table.players.map(p => p.id));
  const timer = FR.timers();
  let table = null;

  function initGame(players){
    G = {order:players.map(p=>p.id), names:{}, emojis:{}, alive:{}, out:[],
         phase:'playing', turn:0, banner:'', reveal:false};
    players.forEach(p=>{G.names[p.id]=p.name; G.emojis[p.id]=p.emoji;});
    seats.startRound();
    newBank(true);
  }
  const aliveIds = ()=>seats.remaining;
  const curId = ()=>seats.current;
  function newBank(first){
    G.plungers = [0,0,0,0,0];               // 0 unpressed · 1 safe · 2 boom
    G.live = rng.int(5);
    G.reveal = false;
    G.banner = (first?'':'💣 New detonator armed — ') + G.names[curId()] + ', press a plunger';
  }
  function finish(){
    timer.cancelAll();
    G.phase='over';
    const r = FR.standings.byElimination(seats, {
      detail:(id,place)=>place===1 ? 'nerves of steel' : ('out #'+(seats.all.length-place+1))
    });
    Table.endGame({winnerId:r.winnerId, standings:r.standings.map((row,i)=>
      Object.assign({}, row, {score: i===0 ? 'survived' : '💥'}))});
  }
  function publicState(){
    const alive = {};
    G.order.forEach(id => { alive[id] = seats.status(id) !== 'out'; });
    return {phase:G.phase, banner:G.banner, turn:curId(), plungers:G.plungers.slice(),
      live:G.reveal?G.live:-1, names:G.names, emojis:G.emojis, order:G.order, alive};
  }
  function syncAll(){ const s=publicState(); Table.broadcast({t:'state',s}); view=s; render(); }

  if(Table.isHost){
    Table.onStart(p=>{
      initGame(p);
      table = FR.host({
        state:G, seats, timers:timer, hostId:MY,
        phase:()=>G.phase,
        publish:syncAll,
        intents:{
          hello: ()=>{},
          // turn:true IS the out-of-turn guard — FR checks it before run() is reached.
          press: { turn:true, phase:'playing', run:(ctx)=>{
            const i = ctx.msg.i;
            if (!(i >= 0 && i < 5) || G.plungers[i] !== 0) return;   // already pressed
            if (i === G.live) {
              G.plungers[i]=2; G.reveal=true;
              seats.eliminate(ctx.from);
              G.banner = '💥 ' + G.names[ctx.from] + ' hit the detonator!';
              if (seats.settled) { timer.after('finish', 1500, finish); return; }
              // Freeze the table while the blast is on screen, then rearm.
              table.hold(2000, ()=>{ seats.next(); newBank(false); });
            } else {
              G.plungers[i]=1;
              seats.next();
              G.banner = G.names[curId()] + "'s turn — press a plunger";
            }
          } }
        }
      });
      syncAll();
    });
    Table.onMessage((f,m)=>{ if(table) table.handle(f,m); });
    Table.onPlayerLeave(id=>{
      if(!G || seats.status(id)==='out') return;
      const wasTheirTurn = curId()===id;
      seats.eliminate(id);
      if(wasTheirTurn) seats.next();
      if(seats.settled && G.phase!=='over') return finish();
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
