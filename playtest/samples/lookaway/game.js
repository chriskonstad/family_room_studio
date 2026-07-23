function createGame(Table, root){
  const MY = Table.me.id;
  let view = null, G = null, myPick = null, tick = null, deadlineLocal = 0;
  const DIRS = [
    {k:'up',    ic:'⬆️'}, {k:'left', ic:'⬅️'}, {k:'ctr', ic:'⏺️'},
    {k:'right', ic:'➡️'}, {k:'down', ic:'⬇️'}
  ];
  const pick = a=>a[Math.floor(Math.random()*a.length)];
  const esc = s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const dic = k=>{ const d=DIRS.find(x=>x.k===k); return d?d.ic:''; };

  // ---------- host ----------
  function initGame(players){
    G = {order:players.map(p=>p.id), names:{}, emojis:{}, lives:{},
         phase:'ready', round:0, banner:'Get ready to dodge!', lookerIdx:-1, reveal:false, win:4200};
    players.forEach(p=>{G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.lives[p.id]=3;});
  }
  const withLives = ()=>G.order.filter(id=>G.lives[id]>0);
  function nextRound(){
    if(withLives().length<=1){ finish(); return; }
    G.round++;
    do{ G.lookerIdx=(G.lookerIdx+1)%G.order.length; } while(G.lives[G.order[G.lookerIdx]]<=0);
    G.looker = G.order[G.lookerIdx];
    G.picks = {}; G.reveal = false; G.phase = 'pick';
    G.banner = '👀 ' + G.names[G.looker] + ' is looking!';
    clearTimeout(G.roundT);
    G.roundT = setTimeout(resolve, G.win);
    syncAll();
  }
  function handleIntent(from,msg){
    if(msg.t==='hello') return;
    if(G.phase==='ready' && msg.t==='go' && from===MY){ nextRound(); return; }
    if(G.phase==='pick' && msg.t==='look' && G.lives[from]>0 && G.picks[from]==null){
      G.picks[from] = msg.dir;
      if(Object.keys(G.picks).length === withLives().length) resolve();
    }
  }
  function resolve(){
    clearTimeout(G.roundT);
    withLives().forEach(id=>{ if(G.picks[id]==null) G.picks[id]=pick(DIRS).k; });   // auto for stragglers
    const ld = G.picks[G.looker], caught = [];
    withLives().forEach(id=>{ if(id!==G.looker && G.picks[id]===ld){ G.lives[id]--; caught.push(id); } });
    G.reveal = true; G.phase = 'reveal';
    G.banner = caught.length ? ('😵 caught: ' + caught.map(id=>G.emojis[id]).join(' '))
                             : '😅 everyone looked away!';
    syncAll();
    if(withLives().length<=1) setTimeout(finish, 1600);
    else setTimeout(nextRound, 2000);
  }
  function finish(){
    const ranked = G.order.slice().sort((a,b)=>G.lives[b]-G.lives[a]);
    G.phase='over';
    Table.endGame({winnerId:ranked[0], standings:ranked.map(id=>({
      playerId:id, score:G.lives[id], detail:'❤️ '+G.lives[id] }))});
  }
  function publicState(){
    return {phase:G.phase, banner:G.banner, round:G.round, looker:G.looker, win:G.win,
      lives:{...G.lives}, names:G.names, emojis:G.emojis, order:G.order,
      picks:G.reveal?{...G.picks}:null};
  }
  function syncAll(){ const s=publicState(); Table.broadcast({t:'state',s}); onState(s); }
  function onState(s){
    const prev = view; view = s;
    if(s.phase==='pick' && (!prev || prev.phase!=='pick' || prev.round!==s.round)){
      myPick = null; startLocalTimer();
    }
    render();
  }

  if(Table.isHost){
    Table.onStart(p=>{ initGame(p); syncAll(); });
    Table.onMessage((f,m)=>{ const wasLook = m.t==='look'; handleIntent(f,m); if(!wasLook) syncAll(); });
    Table.onPlayerLeave(id=>{
      if(!G) return;
      G.lives[id]=0;
      if(G.phase==='pick' && Object.keys(G.picks).length>=withLives().length) resolve();
      else syncAll();
    });
  } else {
    Table.onStart(()=>{ view=null; render(); Table.send({t:'hello'}); });
    Table.onMessage((_f,m)=>{ if(m.t==='state') onState(m.s); });
  }

  function startLocalTimer(){
    clearInterval(tick);
    deadlineLocal = Date.now() + (view.win||4000);
    tick = setInterval(()=>{
      const bar = root.querySelector('.tbar i');
      if(!bar || !view || view.phase!=='pick'){ clearInterval(tick); return; }
      const left = Math.max(0, (deadlineLocal-Date.now())/(view.win||4000));
      bar.style.width = (left*100) + '%';
      if(left<=0) clearInterval(tick);
    }, 60);
  }

  // ---------- render ----------
  function render(){
    if(!view){ root.innerHTML='<div class="big"><span class="wait">Peeking…</span></div>'; return; }
    const v = view;
    const meLooker = v.looker===MY, meAlive = v.lives[MY]>0;
    let h = `<div class="hdr"><span class="brand">LOOK AWAY</span><span class="sub">round ${v.round}</span></div>`;
    h += `<div class="lives">` + v.order.map(id=>
      `<span class="lf ${v.lives[id]>0?'':'out'} ${id===v.looker?'looker':''}">${v.emojis[id]} ${'❤️'.repeat(v.lives[id])||'💀'}</span>`).join('') + `</div>`;
    h += `<div class="banner">${esc(v.banner||'')}</div>`;

    if(v.phase==='ready'){
      h += `<div class="big"><div class="ic">👀</div>
        <div class="hint">Each round one player <b>looks</b> a direction. Everyone else, secretly <b>look away</b> — pick the same direction as the looker and you lose a ❤️. Most hearts left wins!</div>`;
      h += Table.isHost ? `<button class="primary" id="go">Start staring 👁️</button>`
                        : `<div class="wait">Waiting for the host…</div>`;
      h += `</div>`;
    } else if(v.phase==='pick'){
      h += `<div class="tbar"><i></i></div>`;
      h += `<div class="dirs">` + DIRS.map(d=>
        `<button class="dir ${myPick===d.k?'picked':''}" data-d="${d.k}" ${meAlive?'':'disabled'}>${d.ic}</button>`).join('') + `</div>`;
      h += meAlive
        ? (meLooker ? `<div class="hint"><b>You're looking 👁️</b> — pick where to look and try to catch someone!</div>`
                    : (myPick ? `<div class="wait">Locked ${dic(myPick)}</div>`
                              : `<div class="hint">Look <b>away</b> from ${esc(v.names[v.looker])}!</div>`))
        : `<div class="wait">💀 out of hearts — spectating</div>`;
    } else if(v.phase==='reveal'){
      const ld = v.picks[v.looker];
      h += `<div class="reveal"><div class="rlooker">${v.emojis[v.looker]} looked ${dic(ld)}</div><div class="rgrid">` +
        v.order.filter(id=>id!==v.looker && v.picks[id]!=null).map(id=>{
          const caught = v.picks[id]===ld;
          return `<div class="rp ${caught?'caught':''}">${v.emojis[id]} ${dic(v.picks[id])}${caught?' 😵':''}</div>`;
        }).join('') + `</div><div class="hint">${esc(v.banner)}</div></div>`;
    }
    root.innerHTML = h;
    const g = root.querySelector('#go'); if(g) g.onclick=()=>Table.send({t:'go'});
    root.querySelectorAll('[data-d]').forEach(b=>{ if(!b.disabled) b.onclick=()=>{
      if(myPick) return; myPick = b.dataset.d; Table.send({t:'look',dir:b.dataset.d}); render();
    };});
  }
  render();
}
