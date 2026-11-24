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
  let myOrder = null;      // my current instruction {text, deadline} — deadline in host game time (FR.clock)
  let prevIntegrity = null;
  let seenAct = 0;         // panel outcome we've already reacted to
  let localTick = null;
  let G = null;

  /// Game-feel shim, so a bundle still runs on a harness that predates
  /// Table.feel (and in a plain browser).
  const feel = (ev, o) => { if (Table.feel) Table.feel(ev, o); };
  /// Confirming the local player's own tap BEFORE the host rules on it — pure
  /// latency masking, not a game event, so it stays a raw haptic.
  const tapAck = () => { try { if (Table.haptic) Table.haptic('medium'); } catch (e) {} };

  // Seeded from the table: the panel layout and the order sequence replay exactly.
  const rng = FR.rng(Table.seed);
  const shuffle = a => rng.shuffle(a);
  const pick = a => rng.pick(a);

  // ---------- host ----------
  // FR.clock is the table's one clock: the host ticks it on FR timers (so it
  // freezes while the table is paused), stamps `now` into every state, and
  // expresses order deadlines in that time; phones anchor their countdowns to
  // it. Counting down from when a message ARRIVED instead restarted a rebuilt
  // phone's order at the full limit — the bug this replaced, twice removed.
  const timer = FR.timers();
  const clock = FR.clock(Table.isHost ? timer : null);
  function initGame(players) {
    const names = shuffle(ADJ.flatMap(a => NOUN.map(n => a+' '+n))).slice(0, players.length*CONTROLS_PER_PLAYER);
    let ni = 0;
    G = {
      order: players.map(p=>p.id), names:{}, emojis:{},
      level:1, integrity:START_INTEGRITY, progress:0, actions:{},
      panels:{}, orders:{}, phase:'briefing',
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
    // Never issue to a player who has left, and never after the reactor is cold: a
    // ghost's order can't be satisfied, so it expired for damage and re-armed itself
    // forever. Found once the harness started dropping players mid-game.
    if (G.phase === 'over' || (G.dead && G.dead[pid])) return;
    // usually target ANOTHER player's control (that's the game)
    const others = G.order.filter(id => id !== pid && !G.dead?.[id]);
    const targetPlayer = (others.length && rng() < 0.8) ? pick(others) : pid;
    const ctl = pick(G.panels[targetPlayer]);
    let text, want;
    if (ctl.type === 'push') { text = 'Engage the '+ctl.label+'!'; want = { kind:'push' }; }
    else if (ctl.type === 'switch') {
      const to = !ctl.value;
      text = (to?'Switch ON':'Switch OFF')+' the '+ctl.label+'!'; want = { kind:'switch', to };
    } else {
      let to; do { to = rng.range(1, 3); } while (to === ctl.value);
      text = 'Set '+ctl.label+' to '+to+'!'; want = { kind:'dial', to };
    }
    const order = { forPid:pid, controlId:ctl.id, want, text, deadline:clock.deadlineIn(orderTimeLimit()) };
    G.orders[pid] = order;
    timer.after('order:'+pid, orderTimeLimit()*1000, () => orderExpired(pid));
    Table.isHost && sendOrder(pid, order);
  }
  function sendOrder(pid, order) {
    const payload = { t:'order', text:order.text, deadline:order.deadline };
    if (pid === MY) { myOrder = { text:order.text, deadline:order.deadline }; render(); }
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
        // Who flipped what, and did it work: the flipper's own phone needs this
        // to answer their tap, and it's the only place that attribution exists.
        G.lastAct = { pid:from, control:ctl.id, ok:true, n:(G.actSeq=(G.actSeq||0)+1) };
        if (G.progress >= SUCCESSES_PER_LEVEL) { levelUp(); }
        else newOrderFor(pid);
        syncAll();
        return;
      }
    }
    // wrong action: small penalty (and, at last, a NO for the person who flipped)
    G.lastAct = { pid:from, control:ctl.id, ok:false, n:(G.actSeq=(G.actSeq||0)+1) };
    G.integrity -= 2;
    if (G.integrity <= 0) { gameOver(); }
    syncAll();
  }

  function levelUp() {
    G.level++; G.progress = 0;
    G.banner = '⬆️ LEVEL '+G.level+' — faster!';
    G.order.forEach(pid => { if (!(G.dead && G.dead[pid])) newOrderFor(pid); });
  }
  function beginGame() {
    clock.start();
    G.phase = 'running';
    G.banner = 'Keep it together!';
    G.order.forEach(pid => { if (!(G.dead && G.dead[pid])) newOrderFor(pid); });
  }
  function gameOver() {
    G.phase = 'over';
    timer.cancelAll();
    const ranked = G.order.slice().sort((a,b)=>G.actions[b]-G.actions[a]);
    Table.endGame({
      title: '☢️ MELTDOWN at Level '+G.level,
      standings: ranked.map(id => ({ playerId:id, score:G.actions[id], detail:'orders completed' })),
    });
  }

  function publicState() {
    return {
      phase:G.phase, level:G.level, integrity:G.integrity, now:clock.now(),
      progress:G.progress, goal:SUCCESSES_PER_LEVEL, banner:G.banner,
      names:G.names, emojis:G.emojis, lastAct:G.lastAct||null,
    };
  }
  function syncAll() {
    const s = publicState();
    Table.broadcast({ t:'state', s });
    view = s; clock.see(s); render();
  }

  // ---------- wiring ----------
  // The move space. MELTDOWN is co-op and simultaneous: everyone works their own panel
  // at once, so there is no turn. Each control is a move, and a dial has three positions
  // — `options` enumerates the whole panel, which is what lets a bot actually operate the
  // reactor rather than mash at it.
  let table = null;
  function buildTable() {
    return FR.host({
      state: G, players: G.order, timers: timer, hostId: MY,
      phase: () => G.phase,
      publish: syncAll,
      intents: {
        begin: { phase: 'briefing', when: (ctx) => ctx.from === MY0(), run: () => beginGame() },
        act:   { phase: 'running',
                 when: (ctx) => !!G.panels[ctx.from] && !(G.dead && G.dead[ctx.from]),
                 options: (ctx) => (G.panels[ctx.from] || []).flatMap(c =>
                   c.type === 'switch' ? [{ control:c.id, value:true }, { control:c.id, value:false }]
                                       : [1,2,3].map(v => ({ control:c.id, value:v }))),
                 run: (ctx) => handleAct(ctx.from, ctx.msg) } 
      }
    });
  }

  if (Table.isHost) {
    Table.onStart(players => {
      initGame(players);
      myPanel = G.panels[MY];
      G.order.forEach(pid => { if (pid !== MY) Table.sendTo(pid, { t:'panel', panel:G.panels[pid] }); });
      table = buildTable();
      syncAll();
    });
    Table.onMessage((from, msg) => { if (table) table.handle(from, msg); });
  } else {
    Table.onStart(() => { view=null; render(); });
    Table.onMessage((_f, msg) => {
      if (msg.t === 'state') { view = msg.s; clock.see(msg.s); render(); }
      else if (msg.t === 'panel') { myPanel = msg.panel; render(); }
      else if (msg.t === 'order') {
        myOrder = { text:msg.text, deadline: msg.deadline != null ? msg.deadline : clock.now() + (msg.seconds || 0) * 1000 };
        render();
      }
    });
  }
  function MY0(){ return G.order[0]; }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  let urgentOn = false;   // last urgency we applied, so the blink flips once, not 10×/s
  function startClock() {
    clearInterval(localTick);
    // The reactor is cold: stop ticking. This interval only ever self-cancelled when the
    // clock element or the order went away, neither of which happens at game over — so
    // every phone kept a 10Hz timer alive under the results screen, forever. Found by
    // the headless playtest harness, which asserts a finished game leaves nothing armed.
    if (!view || view.phase === 'over') { localTick = null; myOrder = null; return; }
    urgentOn = false;     // render() rebuilt .order, so nothing is applied to it yet
    localTick = setInterval(() => {
      const el = root.querySelector('.order .clock');
      if (!el || !myOrder) { clearInterval(localTick); return; }
      const s = clock.left(myOrder.deadline);
      el.textContent = s.toFixed(1);
      const ord = root.querySelector('.order');
      if (ord && (s < 2.5) !== urgentOn) {
        urgentOn = s < 2.5;
        ord.classList.toggle('urgent', urgentOn);        // red border (our palette)
        feel('urgent', { el: ord, off: !urgentOn });      // ...and the shared blink
      }
    }, 100);
  }

  /// Banner styling follows the message, so tone can't drift from text.
  function bannerTone(text) {
    if (!text) return '';
    if (text.indexOf('💥') === 0) return ' bad';
    if (text.indexOf('⬆️') === 0) return ' up';
    return '';
  }

  function render() {
    if (!view) { root.innerHTML = '<div class="big"><span class="wait">Powering up…</span></div>'; return; }
    const v = view;
    const hurt = prevIntegrity != null && v.integrity < prevIntegrity;
    prevIntegrity = v.integrity;
    let h = `<div class="hdr"><span class="brand">MELTDOWN</span>
      <span class="lvl">LEVEL <b>${v.level}</b> · ${v.progress}/${v.goal}</span></div>
      <div class="integrity ${v.integrity<35?'low':''}"><i style="width:${Math.max(0,v.integrity)}%"></i></div>
      <div class="banner${bannerTone(v.banner)}">${esc(v.banner || '')}</div>`;

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
      // Once the reactor has blown, the panel is a picture of what happened, not a set of
      // controls: every tap between the meltdown and the results screen was refused.
      const off = v.phase !== 'running' ? ' disabled' : '';
      h += `<div class="panel">` + myPanel.map(c => {
        let inner;
        if (c.type === 'push') inner = `<button class="push" data-act="${c.id}"${off}>PUSH</button>`;
        else if (c.type === 'switch') inner = `<button class="sw ${c.value?'on':''}" data-sw="${c.id}"${off}>${c.value?'ON':'OFF'}</button>`;
        else inner = `<div class="dialrow">` + [1,2,3].map(n =>
          `<button class="${c.value===n?'cur':''}" data-dial="${c.id}" data-v="${n}"${off}>${n}</button>`).join('') + `</div>`;
        return `<div class="ctl" id="${c.id}"><div class="nm">${esc(c.label)}</div>${inner}</div>`;
      }).join('') + `</div>`;
    }

    root.innerHTML = h;
    startClock();

    // ---- game feel, on the live nodes we just wrote ----
    // Your own flip lands on the control you touched; a crewmate's success just
    // nudges the shared progress readout. Guarded by the host's act sequence, so
    // it fires once per flip even though render() also runs on local taps.
    const la = v.lastAct;
    const freshAct = !!la && la.n !== seenAct;
    const myWrongFlip = freshAct && la.pid === MY && !la.ok;
    if (freshAct) {
      seenAct = la.n;
      if (la.pid === MY) feel(la.ok ? 'heal' : 'blocked', { el: document.getElementById(la.control), mine:true });
      else if (la.ok) feel('gain', { el: root.querySelector('.lvl') });
    }
    // Damage should be felt, not just seen on a 14px bar — flash it and shake the
    // whole reactor. prevIntegrity keeps it to the one render where the bar drops.
    // When the damage IS our own wrong flip, stay visual: the buzz above said it.
    if (hurt) {
      feel('hit', { el: root.querySelector('.integrity'), mine:true,
                    silent: myWrongFlip, quiet: myWrongFlip });
      document.body.classList.add('fr-shake');
      setTimeout(() => document.body.classList.remove('fr-shake'), 460);
    }

    const b = root.querySelector('#begin'); if (b) b.onclick = () => Table.send({ t:'begin' });
    root.querySelectorAll('[data-act]').forEach(el => el.onclick = () => {
      Table.send({ t:'act', control:el.dataset.act });
      tapAck();
    });
    root.querySelectorAll('[data-sw]').forEach(el => el.onclick = () => {
      const c = myPanel.find(x=>x.id===el.dataset.sw);
      c.value = !c.value;
      Table.send({ t:'act', control:c.id, value:c.value });
      tapAck();
      render();
    });
    root.querySelectorAll('[data-dial]').forEach(el => el.onclick = () => {
      const c = myPanel.find(x=>x.id===el.dataset.dial);
      c.value = +el.dataset.v;
      Table.send({ t:'act', control:c.id, value:c.value });
      tapAck();
      render();
    });
  }

  render();
}
