/* MELTDOWN — frantic cooperative reactor control (a SpaceTeam-style shouting
   game; original content). Every phone shows a different control panel. Your
   orders usually apply to SOMEONE ELSE'S panel — so read them out loud, fast.
   Keep the reactor together as the levels speed up. Host authoritative. */

function createGame(Table, root) {
  const MY = Table.me.id;

  const ADJ = ['Flux','Quantum','Gyro','Plasma','Turbo','Ion','Crypto','Neutron',
               'Hyper','Retro','Omega','Sub-Space','Auxiliary','Manifold','Photon','Baryon'];
  const NOUN = ['Bellows','Coupler','Dampener','Sprocket','Capacitor','Valve','Diode',
                'Actuator','Crank','Regulator','Snorkel','Gasket','Piston','Throttle','Whisk','Governor'];
  const CONTROLS_PER_PLAYER = 4;
  const SUCCESSES_PER_LEVEL = 8;
  const START_INTEGRITY = 100;

  let view = null;         // shared state everyone renders
  let myPanel = [];        // my controls [{id,label,type,value}]
  let myOrder = null;      // my current instruction {text, deadline}
  let localTick = null;
  let G = null;

  const shuffle = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random()*a.length)];

  // ---------- host ----------
  function initGame(players) {
    const names = shuffle(ADJ.flatMap(a => NOUN.map(n => a+' '+n))).slice(0, players.length*CONTROLS_PER_PLAYER);
    let ni = 0;
    G = {
      order: players.map(p=>p.id), names:{}, emojis:{},
      level:1, integrity:START_INTEGRITY, progress:0, actions:{},
      panels:{}, orders:{}, timers:{}, phase:'briefing',
    };
    players.forEach(p => {
      G.names[p.id]=p.name; G.emojis[p.id]=p.emoji; G.actions[p.id]=0;
      G.panels[p.id] = Array.from({length:CONTROLS_PER_PLAYER}, (_,i) => {
        const type = ['push','switch','dial','push'][i % 4];
        return { id:p.id+'-c'+i, owner:p.id, label:names[ni++], type,
                 value: type==='dial' ? 1 : (type==='switch' ? false : null) };
      });
    });
    G.banner = 'Reactor briefing';
  }

  function orderTimeLimit(){ return Math.max(4, 12 - G.level); }   // seconds

  function newOrderFor(pid) {
    // usually target ANOTHER player's control (that's the game)
    const others = G.order.filter(id => id !== pid && !G.dead?.[id]);
    const targetPlayer = (others.length && Math.random() < 0.8) ? pick(others) : pid;
    const ctl = pick(G.panels[targetPlayer]);
    let text, want;
    if (ctl.type === 'push') { text = 'Engage the '+ctl.label+'!'; want = { kind:'push' }; }
    else if (ctl.type === 'switch') {
      const to = !ctl.value;
      text = (to?'Switch ON':'Switch OFF')+' the '+ctl.label+'!'; want = { kind:'switch', to };
    } else {
      let to; do { to = 1 + Math.floor(Math.random()*3); } while (to === ctl.value);
      text = 'Set '+ctl.label+' to '+to+'!'; want = { kind:'dial', to };
    }
    const order = { forPid:pid, controlId:ctl.id, want, text, deadline:Date.now()+orderTimeLimit()*1000 };
    G.orders[pid] = order;
    clearTimeout(G.timers[pid]);
    G.timers[pid] = setTimeout(() => { orderExpired(pid); }, orderTimeLimit()*1000);
    Table.isHost && sendOrder(pid, order);
  }
  function sendOrder(pid, order) {
    const payload = { t:'order', text:order.text, seconds:orderTimeLimit() };
    if (pid === MY) { myOrder = { text:order.text, deadline:Date.now()+orderTimeLimit()*1000 }; render(); }
    else Table.sendTo(pid, payload);
  }
  function orderExpired(pid) {
    G.integrity -= 8;
    G.banner = '💥 '+G.names[pid]+"'s order timed out!";
    if (G.integrity <= 0) { gameOver(); syncAll(); return; }
    newOrderFor(pid);
    syncAll();
  }

  function handleAct(from, msg) {
    // apply the physical action to the control
    const ctl = G.panels[from]?.find(c => c.id === msg.control);
    if (!ctl) return;
    if (ctl.type === 'switch') ctl.value = msg.value;
    if (ctl.type === 'dial') ctl.value = msg.value;

    // does it satisfy ANY outstanding order?
    for (const pid of Object.keys(G.orders)) {
      const o = G.orders[pid];
      if (!o || o.controlId !== ctl.id) continue;
      const w = o.want;
      const ok = (w.kind==='push' && ctl.type==='push')
              || (w.kind==='switch' && ctl.value === w.to)
              || (w.kind==='dial' && ctl.value === w.to);
      if (ok) {
        G.actions[from]++;
        G.progress++;
        G.integrity = Math.min(100, G.integrity + 1);
        G.banner = '✅ '+o.text.replace('!','')+' — nice.';
        if (G.progress >= SUCCESSES_PER_LEVEL) { levelUp(); }
        else newOrderFor(pid);
        syncAll();
        return;
      }
    }
    // wrong action: small penalty
    G.integrity -= 2;
    if (G.integrity <= 0) { gameOver(); }
    syncAll();
  }

  function levelUp() {
    G.level++; G.progress = 0;
    G.banner = '⬆️ LEVEL '+G.level+' — faster!';
    G.order.forEach(pid => newOrderFor(pid));
  }
  function beginGame() {
    G.phase = 'running';
    G.banner = 'Keep it together!';
    G.order.forEach(pid => newOrderFor(pid));
  }
  function gameOver() {
    G.phase = 'over';
    Object.values(G.timers).forEach(clearTimeout);
    const ranked = G.order.slice().sort((a,b)=>G.actions[b]-G.actions[a]);
    Table.endGame({
      title: '☢️ MELTDOWN at Level '+G.level,
      standings: ranked.map(id => ({ playerId:id, score:G.actions[id], detail:'orders completed' })),
    });
  }

  function publicState() {
    return {
      phase:G.phase, level:G.level, integrity:G.integrity,
      progress:G.progress, goal:SUCCESSES_PER_LEVEL, banner:G.banner,
      names:G.names, emojis:G.emojis,
    };
  }
  function syncAll() {
    const s = publicState();
    Table.broadcast({ t:'state', s });
    view = s; render();
  }

  // ---------- wiring ----------
  if (Table.isHost) {
    Table.onStart(players => {
      initGame(players);
      myPanel = G.panels[MY];
      G.order.forEach(pid => { if (pid !== MY) Table.sendTo(pid, { t:'panel', panel:G.panels[pid] }); });
      syncAll();
    });
    Table.onMessage((from, msg) => {
      if (msg.t === 'hello') { Table.sendTo(from, { t:'panel', panel:G.panels[from] }); syncAll(); return; }
      if (msg.t === 'begin' && from === MY0()) { if (G.phase==='briefing') beginGame(); syncAll(); return; }
      if (msg.t === 'act' && G.phase === 'running') handleAct(from, msg);
    });
    Table.onPlayerLeave(id => {
      if (!G) return;
      (G.dead = G.dead || {})[id] = true;
      clearTimeout(G.timers[id]); delete G.orders[id];
      G.banner = G.names[id]+' was ejected from the reactor!';
      syncAll();
    });
  } else {
    Table.onStart(() => { view=null; render(); Table.send({ t:'hello' }); });
    Table.onMessage((_f, msg) => {
      if (msg.t === 'state') { view = msg.s; render(); }
      else if (msg.t === 'panel') { myPanel = msg.panel; render(); }
      else if (msg.t === 'order') { myOrder = { text:msg.text, deadline:Date.now()+msg.seconds*1000 }; render(); }
    });
  }
  function MY0(){ return G.order[0]; }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  function startClock() {
    clearInterval(localTick);
    localTick = setInterval(() => {
      const el = root.querySelector('.order .clock');
      if (!el || !myOrder) { clearInterval(localTick); return; }
      const s = Math.max(0, (myOrder.deadline - Date.now())/1000);
      el.textContent = s.toFixed(1);
      root.querySelector('.order')?.classList.toggle('urgent', s < 2.5);
    }, 100);
  }

  function render() {
    if (!view) { root.innerHTML = '<div class="big"><span class="wait">Powering up…</span></div>'; return; }
    const v = view;
    let h = `<div class="hdr"><span class="brand">MELTDOWN</span>
      <span class="lvl">LEVEL <b>${v.level}</b> · ${v.progress}/${v.goal}</span></div>
      <div class="integrity ${v.integrity<35?'low':''}"><i style="width:${Math.max(0,v.integrity)}%"></i></div>`;

    if (v.phase === 'briefing') {
      h += `<div class="big"><div class="icon">☢️</div>
        <div class="hint"><b>Co-op.</b> Orders appear on your screen — but the control they name is
        probably on <b>someone else's phone</b>. Read your orders OUT LOUD and flip what your
        crewmates shout at you. Wrong flips and timeouts damage the reactor.</div>`;
      h += (Table.me.id === (view.firstId || 'p0') || Table.isHost)
        ? `<button class="primary" id="begin">Start the reactor</button>`
        : `<div class="wait">Waiting for the host to start…</div>`;
      h += `</div>`;
    } else {
      h += `<div class="order"><span class="t">${myOrder ? esc(myOrder.text) : '<span class="done">Stand by…</span>'}</span>
        <span class="clock"></span></div>`;
      h += `<div class="panel">` + myPanel.map(c => {
        let inner;
        if (c.type === 'push') inner = `<button class="push" data-act="${c.id}">PUSH</button>`;
        else if (c.type === 'switch') inner = `<button class="sw ${c.value?'on':''}" data-sw="${c.id}">${c.value?'ON':'OFF'}</button>`;
        else inner = `<div class="dialrow">` + [1,2,3].map(n =>
          `<button class="${c.value===n?'cur':''}" data-dial="${c.id}" data-v="${n}">${n}</button>`).join('') + `</div>`;
        return `<div class="ctl" id="${c.id}"><div class="nm">${esc(c.label)}</div>${inner}</div>`;
      }).join('') + `</div>`;
    }

    root.innerHTML = h;
    startClock();

    const b = root.querySelector('#begin'); if (b) b.onclick = () => Table.send({ t:'begin' });
    root.querySelectorAll('[data-act]').forEach(el => el.onclick = () => {
      Table.send({ t:'act', control:el.dataset.act });
      el.closest('.ctl').classList.add('flash-good');
    });
    root.querySelectorAll('[data-sw]').forEach(el => el.onclick = () => {
      const c = myPanel.find(x=>x.id===el.dataset.sw);
      c.value = !c.value;
      Table.send({ t:'act', control:c.id, value:c.value });
      render();
    });
    root.querySelectorAll('[data-dial]').forEach(el => el.onclick = () => {
      const c = myPanel.find(x=>x.id===el.dataset.dial);
      c.value = +el.dataset.v;
      Table.send({ t:'act', control:c.id, value:c.value });
      render();
    });
  }

  render();
}
