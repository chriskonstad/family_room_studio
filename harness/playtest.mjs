#!/usr/bin/env node
/*
 * playtest.mjs — play a real game bundle with bots, headless, and check it holds up.
 *
 *   node harness/playtest.mjs streak
 *   node harness/playtest.mjs streak --games 200 --players 4
 *   node harness/playtest.mjs ./path/to/bundle --seed 42 --verbose
 *   node harness/playtest.mjs --all
 *
 * This is the thing that replaces "open the studio and tap around" for an agent. It boots
 * the bundle on N virtual phones, has bots press whatever buttons are actually on screen,
 * advances a virtual clock so a 60-second game takes microseconds, and asserts the
 * properties that must hold no matter what anyone taps:
 *
 *   never throws            a game that crashes is broken however pretty it is
 *   always terminates       the commonest real failure — a game that gets stuck with
 *                           nobody able to move, which a human playtest finds only by
 *                           sitting there confused for a minute
 *   ends once               endGame is final; firing twice means two winners
 *   winner is a real player not a stale or departed id
 *   no leaked timers        a finished game must stop ticking
 *   refusals change nothing a rejected intent must leave the published state untouched
 *   replays are exact       the same seed produces the same game, move for move —
 *                           without this, no other failure here can be debugged
 *   buttons do something    a control the phone offers sends an intent the host takes
 *   a reconnect is seamless a phone that drops and reloads shows what a phone that
 *                           never dropped shows
 *   secrets stay put        nothing sent privately to one player is on another's phone
 *
 * Table sizes are swept per seed (min to max, clamped to the manifest), so 2-player
 * edges and full-table elimination orders actually get walked.
 *
 * Modes, rotated through a batch automatically and pinned by flags for reproduction:
 *   --hostile    fire intents nobody's UI offered — out of turn, wrong phase, a ghost
 *   --pause      every phone freezes for 45s mid-game; nothing may move
 *   --ui         bots press the phone's real controls as well as declared moves
 *   --reconnect  a phone drops and the table pauses, as the shell does it; it comes
 *                back warm (its page survived: caught up, must be INVISIBLE to the
 *                game) or cold (the app was killed: rebuilt from the whole history,
 *                its screen compared with a phone that never dropped)
 *   --screens N  shared screens attached at the start (Table.screens on the host)
 *   --toggle-screen  a TV is switched on or off partway through
 *
 * Every run is seeded and prints the seed, so a failure reproduces exactly:
 *   node harness/playtest.mjs streak --seed 137 --verbose
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runGame, REPO, loadBundle, defaultScreens } from './runner.mjs';
import { discoverIntents, candidateValues, buildMessage } from './intents.mjs';

/* A tiny seeded RNG, same algorithm as FR.rng, so bot choices replay. */
export function rng(seed) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (a) => (a.length ? a[r.int(a.length)] : undefined);
  return r;
}

const HOSTILE_INTENTS = ['flip', 'bank', 'next', 'target', 'tap', 'go', 'ready', 'skip', '', 'nonsense'];

/* Keys whose string values are STRUCTURE — a message's type, a refusal's reason, a
 * phase — not content. SCRAMBLE answers a bad word with `why: 'grid'`, and the word
 * "grid" being on somebody else's phone is not a leak of anything. */
const STRUCTURAL = new Set(['t', 'type', 'why', 'reason', 'status', 'kind', 'phase', 'mode',
                            'state', 'code', 'result', 'error', 'action', 'act', 'street']);

/** Every content string anywhere in a value, at least `min` long. */
function strings(value, min, out = [], key) {
  if (typeof value === 'string') { if (value.length >= min && !STRUCTURAL.has(key)) out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(v => strings(v, min, out)); return out; }
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) strings(value[k], min, out, k); return out; }
  return out;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The generic half of "secrets stay put": a string the host sent privately to one
 * player must not turn up on another player's phone.
 *
 * CLIENT phones only. A client can show nothing it wasn't sent — except what it
 * works out for itself, and every client holds `Table.seed`: a client that shuffles
 * a deck "just to animate it" has dealt itself everybody's hand. That is the leak
 * this catches. The HOST's phone is a different problem: it holds the whole game in
 * memory and its own private information never crosses the wire (FISHBOWL's host
 * reads the phrase it is giving out of G, not out of a sendTo), so a string match
 * cannot tell its own secrets from everyone else's. The host's phone is held to the
 * game's own invariants.mjs instead — HOLD'EM's checks every phone for other
 * players' cards.
 *
 * Strings, because they are the one kind of secret a harness can recognise without
 * knowing the game — a phrase, a word list, a role. Numeric secrets (HOLD'EM's cards
 * are `{r,s}`) are the game's own job. A string is not a secret from someone who was
 * told it publicly, sent it privately themselves, or typed it in the first place —
 * and a string sent privately to every other player is public in all but name.
 */
function secretWatch(table) {
  // The game's own words. A secret that is also a word the game prints anyway is not
  // evidence of anything: SCRAMBLE's players found "else", and "someone else" is in the
  // game's own copy. Lowercased, so it is compared the way a reader would.
  const copy = (table.source + ' ' + (table.bundle.entryHTML || '')).toLowerCase();
  const inCopy = (x) => new RegExp('(?:^|[^a-z0-9])' + escapeRe(x.toLowerCase()) + '(?![a-z0-9])').test(copy);
  let seenB = 0, seenT = 0, seenS = 0;
  const told = new Set();
  const recipients = new Map();   // string -> Set of player ids it was sent to
  const typed = {};               // id -> strings they sent
  const cache = {};
  let version = 0;                // bumps whenever any string reaches a new recipient
  const MIN = 4;
  return function check(alive) {
    const b = table.wire('broadcast'), t = table.wire('sendTo'), s = table.wire('send');
    for (; seenB < b.length; seenB++) strings(b[seenB].payload, MIN).forEach(x => told.add(x));
    for (; seenT < t.length; seenT++) {
      const e = t[seenT];
      strings(e.payload, MIN).forEach(x => {
        if (!recipients.has(x)) recipients.set(x, new Set());
        if (!recipients.get(x).has(e.to)) { recipients.get(x).add(e.to); version++; }
      });
    }
    for (; seenS < s.length; seenS++) {
      const e = s[seenS];
      (typed[e.from] || (typed[e.from] = new Set()));
      strings(e.payload, MIN).forEach(x => typed[e.from].add(x));
    }
    for (const viewer of alive) {
      if (viewer === table.hostId) continue;
      const others = table.players.filter(id => id !== viewer);
      const key = told.size + ':' + version + ':' + (typed[viewer] ? typed[viewer].size : 0);
      let c = cache[viewer];
      if (!c || c.key !== key) {
        // What this phone was legitimately given. A secret INSIDE one of those is
        // excused: MELTDOWN tells you to "Set the Flux Whisk to 3" when the Flux
        // Whisk is on somebody else's panel — that is the whole game.
        const known = [...told];
        for (const [x, rec] of recipients) if (rec.has(viewer)) known.push(x);
        if (typed[viewer]) known.push(...typed[viewer]);
        const secrets = [];
        for (const [x, rec] of recipients) {
          if (rec.has(viewer) || told.has(x) || (typed[viewer] && typed[viewer].has(x))) continue;
          if (others.every(id => rec.has(id))) continue;
          if (known.some(k => k.length > x.length && k.includes(x))) continue;
          if (inCopy(x)) continue;
          secrets.push(x);
        }
        if (!secrets.length) { cache[viewer] = { key, re: null }; continue; }
        c = cache[viewer] = { key,
          re: new RegExp('(?:^|[^\\w])(' + secrets.map(escapeRe).sort((a, z) => z.length - a.length).join('|') + ')(?![\\w])') };
      }
      if (!c.re) continue;
      const m = c.re.exec(table.text(viewer));
      if (m) {
        const owner = [...recipients.get(m[1])].join(', ');
        return `${viewer}'s phone shows "${m[1]}", which the host sent privately to ${owner}`;
      }
    }
    return null;
  };
}

/**
 * Play one game to completion (or until it stalls).
 * @returns {{ok:boolean, why?:string, turns:number, result:object}}
 */
export async function playOne(game, {
  seed = 1, players = 3, hostile = false, pause = false, ui = false,
  reconnect = false, screens, toggleScreen = false, maxTurns = 4000, verbose = false,
  bot = null, invariants = null, observe = null, reconnectIgnore = [], onBoot = null
} = {}) {
  const r = rng(seed);
  // Decisions about the SHAPE of a run (who reconnects, when the TV comes on) come
  // from their own stream. Drawing them from `r` would shift every bot choice after
  // them, and a reconnect run could no longer be compared move for move with the
  // same game played without one.
  const shape = rng(seed ^ 0x9E3779B9);
  let table;
  try {
    table = await runGame({ game, players, seed, screens });
  } catch (e) {
    return { ok: false, why: `boot failed: ${e.message}`, turns: 0 };
  }

  if (onBoot) onBoot(table);
  const ids = table.players;
  // What this bundle can be sent. FR.host knows its own intent table; reading it out of
  // the source with a regex is the fallback for a game that isn't built on it.
  const declared = table.intents();
  const vocabulary = discoverIntents(table.source);
  const vocab = declared
    ? declared.filter(d => !d.hidden).map(d => d.name)
    : vocabulary.map(v => v.fixed.t || v.fixed.type).filter(Boolean);
  let turns = 0, idleStreak = 0;
  const uiChecked = {};
  const dropped = new Set();
  const legalSeen = {};      // intent -> times some player was offered it
  const clicked = { presses: 0, intents: 0 };
  // And a quarter get paused mid-game for 44 virtual seconds, at a seeded moment —
  // drawn from `shape`, so the same game can be played again WITHOUT the pause and
  // compared move for move (see playtest()).
  const pauseAt = pause ? (2 + shape.int(25)) : 0;
  const reconnectAt = reconnect ? (3 + shape.int(30)) : 0;
  const reconnectWho = ids.length > 1 ? ids[1 + shape.int(ids.length - 1)] : null;
  let reconnected = null;       // { at, broadcasts } once the shadow is up
  let reconnectMode = null;
  let apart = null;             // { since, broadcasts, got, want } while it disagrees
  const toggleAt = toggleScreen ? (2 + shape.int(40)) : 0;
  // A reconnect run drives the returning player through their own screen too. Their
  // phone keeps state of its own (MELTDOWN flips a switch locally the moment you tap
  // it), and a move the bot made for them behind the phone's back makes the phone that
  // never dropped show something stale — the comparison would blame the reconnect.
  let uiPlayer = ui ? ids[shape.int(ids.length)] : (reconnect && reconnectWho ? reconnectWho : null);
  const ui2 = !!uiPlayer;
  let uiStuck = 0;
  const peek = secretWatch(table);
  // Every phone still at the table, as one comparable string. Snapshotting only the
  // HOST's view missed games that publish per-player state via sendTo (private hands,
  // panels) — a refused intent leaking into one client's private view was invisible.
  const liveViews = () => JSON.stringify(
    ids.filter(id => !dropped.has(id)).map(id => table.view(id)));
  const alive = () => ids.filter(id => !dropped.has(id));
  const fail = (why) => ({ ok: false, why, turns });

  while (!table.over && turns < maxTurns) {
    turns++;
    let acted = false;

    for (const id of ids) {
      if (dropped.has(id)) continue;
      // A bundle can ship its own bot when the generic one can't drive it — text entry,
      // or a selection step whose options aren't distinguishable from decoration. It gets
      // the same handles a player would touch, and returns true if it acted.
      if (bot) {
        let took = false;
        try { took = !!bot({ table, playerId: id, rng: r, send: (m) => table.send(id, m) }); }
        catch (e) { return fail(`bot threw for ${id}: ${e.message}`); }
        if (took) { acted = true; continue; }
      }

      const legal = table.legalMoves(id);
      if (legal) for (const m of legal) legalSeen[m.t] = (legalSeen[m.t] || 0) + 1;

      // A game driven entirely through legalMoves never touches its own UI — so a build
      // where nobody can actually PLAY (every onclick deleted, every button disabled)
      // used to pass green. Whenever the rules say this player may act, the screen has to
      // offer them something.
      //
      // Every turn, not once per game. Checked only at each player's FIRST legal moment,
      // this passed HOLD'EM while a host who had folded was never shown the Deal button —
      // the bots dealt for them behind the screen, and on a real table nobody could. A
      // few turns' grace covers a screen that is a beat behind its state.
      if (legal && legal.length && !hiddenOnly(legal)) {
        const live = table.clickable(id).filter(h => h.onclick);
        const acts = table.actions(id);
        if (!live.length && !acts.length) {
          if ((uiChecked[id] = (uiChecked[id] || 0) + 1) >= 3) {
            return fail(`${id} can ${legal.slice(0, 3).map(m => JSON.stringify(m)).join(' or ')} but there is nothing `
               + `on their screen to do it with (${uiChecked[id]} turns running) — no wired control, no `
               + `data-act button. The rules allow it; on a real table nobody can.\n          ${id}'s screen: "${clip(table.text(id))}"`);
          }
        } else uiChecked[id] = 0;
      }

      // PRESS THE REAL BUTTONS. Driving a game through legalMoves alone proves the rules
      // and never runs a single line of the phone's own wiring — `Number(b.dataset.to)`,
      // the handler that reads which card is selected, the button a client shows for an
      // intent only the host may send. So in --ui runs ONE player plays entirely through
      // their screen, pressing controls the phone actually rendered, and whatever a
      // press sends must be something the host takes. A button that sends a refused
      // intent is a button that does nothing when a thumb lands on it, which on game
      // night reads as the app being broken.
      //
      // One player, all the way, rather than everybody some of the time: a phone keeps
      // its own state about what its player has done (CAPTAIN latches your first tap so
      // a second does nothing), and an intent the bot sent on that player's behalf
      // behind the phone's back leaves the phone believing something false.
      if (ui2 && id === uiPlayer) {
        const live = table.clickable(id).filter(h => h.onclick);
        if (live.length) {
          const control = r.pick(live);
          const sentBefore = table.wire('send').length;
          const refusedBefore = refusedTotal(table);
          const viewBefore = liveViews();
          // The reconnected copy presses FIRST, its sends going nowhere. Pressed after,
          // it would already have heard the host's answer to the real press and react
          // to a world where its own tap had happened — which a single phone never sees.
          if (table.hasShadow(id)) table.mirrorClick(id, control);
          try { table.press(id, control); } catch (e) {
            return fail(`threw when ${id} pressed "${control.textContent}": ${e.message}`);
          }
          clicked.presses++;
          const mine = table.wire('send').slice(sentBefore).filter(e => e.from === id);
          clicked.intents += mine.length;
          const refusedNow = refusedTotal(table);
          if (mine.length && refusedNow !== null && refusedNow > refusedBefore) {
            const why = (table.rejections() || []).slice(-1)[0];
            if (why && why.why !== 'busy') {
              return fail(`${id}'s phone offered "${control.textContent || control.tagName}", which sent `
                + `${JSON.stringify(mine[mine.length - 1].payload)} — and the host refused it (${why.why}). `
                + `A control that does nothing when pressed; hide or disable it when it can't be used`);
            }
            if (why && why.why === 'busy' && liveViews() !== viewBefore) {
              return fail(`a press refused as busy still changed the published state`);
            }
          }
          if (mine.length) { uiStuck = 0; acted = true; continue; }
          // A press that sent nothing — selecting a card, opening a panel, a colour
          // that is already locked in. Fine. But a player whose TURN it is, pressing
          // a dozen things and never sending anything, is lost on their own screen:
          // stop driving them through it for the rest of the game rather than send a
          // move behind the phone's back, which would leave it believing something
          // false and report the next press as a dead button.
          if (++uiStuck < 12 || !(legal && legal.length)) { acted = true; continue; }
          uiPlayer = null;
        }
      }

      // Best case: the game is built on FR.host and can simply TELL us what's legal.
      // No DOM, no guessing, and every move offered is one the host will accept — which
      // is what makes a game with two-step selection or typed input fuzzable at all.
      if (legal && legal.length) {
        try { table.send(id, r.pick(legal)); } catch (e) {
          return fail(`threw on a declared-legal move from ${id}: ${e.message}`);
        }
        acted = true;
        continue;
      }
      if (legal) continue;      // FR.host game with nothing legal for this player yet

      // First choice: CLICK something the game rendered and wired up itself. That runs
      // the game's own handler, so selection state (pick a card, then play it) and any
      // client-side validation happen exactly as they would under a thumb.
      const live = table.clickable(id).filter(h => h.onclick);
      if (live.length && r() < 0.85) {
        try { table.press(id, r.pick(live)); } catch (e) {
          return fail(`threw on a click from ${id}: ${e.message}`);
        }
        acted = true;
        continue;
      }

      const acts = table.actions(id);
      let msg = null;
      if (acts.length) {
        const choice = r.pick(acts);
        // The DOM says WHICH action is available; the discovered vocabulary says what
        // FIELDS it carries. SUMMIT's button is data-act="play" but the intent is
        // {t:'play', card:…} — sending the bare verb is rejected forever, which looked
        // like the game hanging.
        const spec = vocabulary.find(v => v.fixed.t === choice.act || v.fixed.type === choice.act);
        msg = spec
          ? buildMessage(spec, candidateValues(table.handles(id), ids), r.pick)
          : { t: choice.act };
        if (choice.id) msg.id = choice.id;
      } else if (vocabulary.length) {
        // Nothing labelled on screen — fall back to the discovered vocabulary, filling
        // dynamic fields from the data-* values currently rendered for this player.
        const intent = r.pick(vocabulary);
        if (intent.fixed.t === 'hello' || intent.fixed.type === 'hello') continue;
        msg = buildMessage(intent, candidateValues(table.handles(id), ids), r.pick);
      }
      if (!msg) continue;
      try { table.send(id, msg); } catch (e) {
        return fail(`threw on intent ${JSON.stringify(msg)} from ${id}: ${e.message}`);
      }
      acted = true;
    }

    // The shell pauses every phone when an app backgrounds or a call lands mid-game.
    // The SDK freezes all shimmed timers, but real time keeps passing — so any game
    // state that moves during the pause is being driven by wall-clock deltas or a
    // timer that escaped the shim. That's the class of bug where a resumed game's
    // countdown has silently expired or its fuse detonates the instant play resumes.
    if (pauseAt && turns === pauseAt && pause !== 'reference') {
      const frozen = liveViews();
      table.setPaused(true);
      // 44s, not 45: a whole number of 16ms animation frames AND 250ms turns. Anything
      // else leaves a game's frame loop a few milliseconds out of step after the pause,
      // and a tap judged one frame late reads as the pause having changed the game.
      try { table.advance(44000); } catch (e) {
        table.setPaused(false);
        return fail(`threw while the table was paused: ${e.message}`);
      }
      table.setPaused(false);
      if (liveViews() !== frozen) {
        return fail(`published state moved while the table was paused — game time is coming `
             + `from wall-clock deltas or a timer the pause shim doesn't own`);
      }
    }

    // Somebody's phone goes to the lock screen and comes back. Not a Leave: the shell
    // holds the seat and pauses the table, then the returning phone RELOADS the bundle
    // and is replayed the host's last broadcast and its own last private payload. The
    // run this is compared against takes the same pause with nobody dropping, so the
    // games are otherwise identical move for move.
    // A phone drops — right after its player acted, when what it knows that a fresh
    // page wouldn't is greatest, or at the latest a few turns on. The shell pauses the
    // table; nobody's game hears a thing. Then it comes back:
    //   warm    its page survived (backgrounded, suspended): it is caught up with
    //           exactly what it missed, and the whole thing must be INVISIBLE —
    //           playtest() plays the same game again with only a pause there, and the
    //           two must say exactly the same things.
    //   cold    iOS killed the app: a fresh page, rebuilt from the whole history. Half
    //           the time it simply carries on as the phone (what it then SENDS is
    //           real — TEMPO's restarted track once wiped a score this way); half the
    //           time it is booted beside the phone that never dropped, mute, and the
    //           two screens are compared.
    const justActed = reconnectWho && table.wire('send').slice(-ids.length * 3).some(e => e.from === reconnectWho);
    if (reconnectAt && !reconnected && turns >= reconnectAt && (justActed || turns >= reconnectAt + 12)
        && reconnectWho) {
      const roll = shape();
      reconnectMode = reconnect === 'reference' ? 'reference' : roll < 0.4 ? 'warm' : roll < 0.7 ? 'cold' : 'shadow';
      try {
        if (reconnectMode === 'reference') {
          table.setPaused(true); table.advance(3000); table.setPaused(false);
        } else {
          table.disconnect(reconnectWho);
          table.advance(3000);
          table.reconnect(reconnectWho, { cold: reconnectMode !== 'warm', shadow: reconnectMode === 'shadow' });
        }
      } catch (e) {
        return fail(`threw when ${reconnectWho} reconnected (${reconnectMode}): ${e.message}`);
      }
      const thrown = table.wire('throw');
      if (thrown.length) return fail(`${thrown[0].from} threw during a ${reconnectMode} reconnect: ${thrown[0].message.split('\n')[0]}`);
      reconnected = { at: turns, broadcasts: table.wire('broadcast').length };
    }

    // A TV switched on — or off — mid-game. Only the host's game hears it; a game that
    // shows the phones something different with a screen in the room has to cope with
    // the room changing its mind.
    if (toggleAt && turns === toggleAt) {
      try { table.setScreens(table.screens ? 0 : 1); } catch (e) {
        return fail(`threw when a shared screen ${table.screens ? 'left' : 'arrived'}: ${e.message}`);
      }
    }

    // Hostile mode: fire things no UI offered, from anyone, including a ghost.
    if (hostile) {
      // Nobody impersonates the player whose phone is being compared.
      const from = r.pick(ids.filter(id => !reconnect || id !== reconnectWho).concat(['ghost-id']));
      const wild = r() < 0.5 && vocabulary.length
        ? buildMessage(r.pick(vocabulary), candidateValues(table.handles(r.pick(ids)), ids), r.pick)
        : (r() < 0.5 && declared && declared.length
            ? { t: r.pick(declared).name }
            : { t: r.pick(HOSTILE_INTENTS) });
      // The invariant that matters most here: a REFUSED intent must change nothing.
      // FR.host records every refusal, so if OUR intent is the newest refusal and the
      // state the host publishes moved anyway, something mutated state outside the
      // reducer's guards — an unguarded onMessage branch, a publish in the wrong
      // place. That is exactly the class of bug that lets one stray tap corrupt a
      // whole table. (An ACCEPTED hostile intent changing state is fine — that's the
      // game working.)
      const viewBefore = liveViews();
      const refusedBefore = refusedTotal(table);
      try { table.send(from, wild); } catch (e) {
        return fail(`threw on hostile intent ${JSON.stringify(wild)} from ${from}: ${e.message}`);
      }
      const refusedAfter = refusedTotal(table);
      if (refusedBefore !== null && refusedAfter > refusedBefore && liveViews() !== viewBefore) {
        const last = (table.rejections() || []).slice(-1)[0] || {};
        return fail(`a refused intent ${JSON.stringify(wild)} from ${from} (refused: ${last.why}) `
             + `changed the published state — state is being mutated outside the reducer's guards`);
      }
    }

    // Let timers run. Games that are waiting on a fuse or a hold need this to progress,
    // and it is also how we detect a genuine stall: nothing to press AND nothing pending.
    let fired;
    try { fired = table.advance(acted ? 250 : 2000); } catch (e) {
      return fail(`threw in a timer: ${e.message}`);
    }

    if (!acted && !fired) {
      if (++idleStreak > 5) {
        return fail('stalled — no player has an action and no timer is pending');
      }
    } else idleStreak = 0;

    const thrown = table.wire('throw');
    if (thrown.length) return fail(`${thrown[0].from} threw: ${thrown[0].message.split('\n')[0]}`);

    const leak = peek(alive());
    if (leak) return fail(`LEAK: ${leak}`);

    // The reconnected copy must come to show what the phone that never dropped shows.
    // A moment apart is fine — a draft bid made before the drop is a reasonable thing
    // to lose — but a difference that outlasts several turns AND several things the
    // host announced is a phone that came back to the wrong screen: no cards in its
    // hand, an order it can no longer see, buttons for a tap it already made.
    if (reconnected && reconnectMode === 'shadow') {
      // A bundle may name text it knowingly recomputes after a reload (TEMPO's own
      // running score is judged on the phone and resumes from the last one the host
      // heard, up to a second behind) — `export const reconnectIgnore = [/…/]` in
      // its invariants.mjs. Everything else must come back exactly.
      const mask = (t) => reconnectIgnore.reduce((acc, re) => acc.replace(re, '…'), t);
      const want = mask(table.text(reconnectWho)), got = mask(table.text(reconnectWho, true));
      const said = table.wire('broadcast').length;
      if (want === got) apart = null;
      else if (!apart) apart = { since: turns, broadcasts: said, got, want };
      else {
        apart.got = got; apart.want = want;
        if (turns - apart.since >= 4 && said - apart.broadcasts >= 3) {
          const [g, w] = firstDiff(got, want);
          return fail(`after ${reconnectWho} reconnected (turn ${reconnected.at}), their reloaded phone still `
            + `disagreed with one that never dropped ${turns - apart.since} turns and ${said - apart.broadcasts} `
            + `host updates later.\n          reconnected:   "${g}"\n          never dropped: "${w}"`);
        }
      }
    }

    // Game-specific properties, from the bundle's own invariants.mjs: things only the
    // game can know ("exactly one living player holds the bomb", "dice never come
    // back"). Checked every turn, so a violation is caught at the moment it happens
    // and the seed replays straight to it.
    if (invariants) {
      let bad = null;
      try { bad = invariants({ table, players: alive(), done: false, result: null }); }
      catch (e) { return fail(`invariants.mjs threw: ${e.message}`); }
      if (bad) return fail(`game invariant violated: ${bad}`);
    }
    if (observe) {
      const bad = observe({ table, turn: turns, alive: alive() });
      if (bad) return fail(bad);
    }
  }

  if (!table.over) return fail(`did not finish in ${maxTurns} turns`);

  const result = table.result;
  const done = (why) => ({ ok: false, why, turns, result });
  const errors = table.wire('error');
  if (errors.length) return done(`game reported an error: ${errors[0].message}`);
  if (table.wire('endGame').length !== 1) {
    return done(`endGame fired ${table.wire('endGame').length} times`);
  }
  // A team game legitimately names a TEAM as the winner — Table.endGame takes playerId
  // or teamId in standings, and FISHBOWL's winner is 't1'. Asserting "must be a player"
  // reported a healthy game as broken.
  const teamIds = (table.teams || []).map(t => t.id);
  const valid = ids.concat(teamIds);
  if (result.winnerId && !valid.includes(result.winnerId)) {
    return done(`winner "${result.winnerId}" is neither a player nor a team`);
  }
  if (Array.isArray(result.standings)) {
    for (const row of result.standings) {
      const who = row.playerId || row.teamId;
      if (who && !valid.includes(who)) {
        return done(`standings name "${who}", who is neither a player nor a team`);
      }
    }
  }
  // A finished game must stop ticking. Give it a long beat first — endGame legitimately
  // schedules a little settling work — then require silence.
  //
  // Skipped when somebody left: a disconnected phone never receives the final broadcast,
  // so its own render loop keeps running, and the shared virtual clock can't attribute a
  // timer to a device. That is real behaviour, not a leak — the shell pauses or tears
  // down a device that has gone. Runs without a drop still hold the line.
  if (dropped.size === 0) {
    table.advance(10000);
    table.advance(60000);
    if (table.clock.armed > 0) {
      return done(`left ${table.clock.armed} timers running after the game ended`);
    }
  }
  // The bundle's invariants get one last look at the finished game, result in hand.
  if (invariants) {
    let bad = null;
    try { bad = invariants({ table, players: alive(), done: true, result }); }
    catch (e) { return done(`invariants.mjs threw at game end: ${e.message}`); }
    if (bad) return done(`game invariant violated at game end: ${bad}`);
  }
  // What actually crossed the wire, by intent name — the raw material for the batch's
  // coverage report. An intent that is never once sent in a whole batch is a code path
  // the suite is silently vouching for.
  const sent = {};
  for (const e of table.wire('send')) {
    const t = e.payload && e.payload.t;
    if (t) sent[t] = (sent[t] || 0) + 1;
  }
  // A fingerprint of everything the host said, for the determinism check: turns and a
  // winner agree for two quite different games far more often than you'd hope.
  const said = table.wire().filter(e => e.kind === 'broadcast' || e.kind === 'sendTo' || e.kind === 'endGame');
  const fingerprint = hash(JSON.stringify(said.map(e => [e.t, e.kind, e.to || '', e.payload])));
  // The same, without the clock: what was said, in order, regardless of when.
  const story = hash(JSON.stringify(said.map(e => [e.kind, e.to || '', e.payload])));
  if (verbose) console.log(`    seed ${seed}: ${turns} turns, winner ${result.winnerId}`
    + (ui ? `, pressed ${clicked.presses} controls (${clicked.intents} intents)` : ''));
  return { ok: true, turns, result, sent, legal: legalSeen, vocab, fingerprint, story, declared: !!declared, reconnectMode,
           phases: phasesOf(table) };
}

/** How many intents the host has ever refused, or null for a game not on FR.host. */
function refusedTotal(table) { return table.refusedTotal(); }

/** Phases the host published, in the order first seen. */
function phasesOf(table) {
  const seen = [];
  for (const e of table.wire('broadcast')) {
    const ph = e.payload && e.payload.s && e.payload.s.phase;
    if (ph && !seen.includes(ph)) seen.push(ph);
  }
  return seen;
}

/** FNV-1a, enough to compare two long strings without keeping both. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16) + ':' + str.length;
}

/**
 * The run modes for game `i` of a batch. Every mode is reached in any batch of eight,
 * and an explicit flag pins it — which is what a reproduce command needs.
 */
export function modesFor(i, opts, manifest) {
  const pin = (k, dflt) => (opts[k] !== undefined ? opts[k] : dflt);
  const optional = manifest && manifest.screen === 'optional';
  return {
    hostile: pin('hostile', i % 2 === 1),
    pause: pin('pause', i % 4 === 2),
    ui: pin('ui', i % 3 === 0 && i % 4 !== 1),
    reconnect: pin('reconnect', i % 4 === 1),
    // A game that can run with or without a TV is played both ways, half and half,
    // and every fifth game has the room change its mind partway through.
    screens: pin('screens', optional ? (i % 2) : defaultScreens(manifest)),
    toggleScreen: pin('toggleScreen', optional && i % 5 === 4)
  };
}

function reproduce(game, f) {
  return `node harness/playtest.mjs ${game} --games 1 --seed ${f.seed} --players ${f.players}`
    + (f.hostile ? ' --hostile' : '') + (f.pause ? ' --pause' : '')
    + (f.ui ? ' --ui' : '') + (f.reconnect ? ' --reconnect' : '')
    + (f.screens !== undefined ? ` --screens ${f.screens}` : '') + (f.toggleScreen ? ' --toggle-screen' : '')
    + ' --verbose';
}

const clip = (s) => (s.length > 160 ? s.slice(0, 157) + '…' : s);
/** Moves no screen is expected to offer: typed text the game marks hidden. */
function hiddenOnly(legal) { return legal.every(m => m.t === 'hello'); }

/** The stretch where two texts part ways, with a little context on either side. */
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length, eb = b.length;
  while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const from = Math.max(0, i - 40);
  const cut = (s, e) => (from > 0 ? '…' : '') + s.slice(from, Math.min(s.length, Math.max(e, i) + 40))
    + (Math.max(e, i) + 40 < s.length ? '…' : '');
  return [cut(a, ea), cut(b, eb)];
}

/** Play many seeded games of one bundle. */
export async function playtest(game, opts = {}) {
  // An optional `bot.mjs` beside the bundle, for games whose input isn't a button:
  //   export default function ({ table, playerId, rng, send }) { … return didSomething; }
  // Returning false hands control back to the generic bot, so a bundle only has to teach
  // the harness the one thing it can't infer.
  const dir = game.includes('/') ? game : join(REPO, 'playtest/samples', game);
  const { manifest } = loadBundle(dir);
  let bot = null;
  const botPath = join(dir, 'bot.mjs');
  if (existsSync(botPath)) bot = (await import(pathToFileURL(botPath).href)).default;
  // An optional `invariants.mjs` beside the bundle: game-specific properties the
  // generic checks can't know. ({table, players, done, result}) -> violation string
  // or null. See playtest/samples/passbomb/invariants.mjs for the shape.
  let invariants = null, reconnectIgnore = [];
  const invPath = join(dir, 'invariants.mjs');
  if (existsSync(invPath)) {
    const mod = await import(pathToFileURL(invPath).href);
    invariants = mod.default;
    reconnectIgnore = (mod.reconnectIgnore || []).map(re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  }
  opts = { ...opts, bot, invariants, reconnectIgnore };

  const games = opts.games || 40;
  const first = opts.seed || 1;
  const failures = [];
  const notes = [];
  let totalTurns = 0;
  // Coverage: which intent names the bots actually sent, across the batch's HONEST
  // runs (hostile runs inject wild intents, which would count paths nobody real took).
  const sent = {}, legal = {};
  const phases = [];
  let vocab = [];

  // Sweep the table size unless one was asked for. Games break differently at their
  // minimum and maximum counts (2-player edge cases, 8-player elimination order), and
  // always booting 3 phones meant those paths were never walked. The runner clamps to
  // the bundle's own min/max, so an out-of-range count just tests the nearest edge.
  const SWEEP = [3, 2, 4, 6, 8];

  for (let i = 0; i < games; i++) {
    const seed = first + i;
    const players = opts.players || SWEEP[i % SWEEP.length];
    const modes = modesFor(i, opts, manifest);
    const run = { ...opts, ...modes, seed, players };
    const res = await playOne(game, run);
    totalTurns += res.turns;
    if (!res.ok) {
      failures.push({ seed, why: res.why, players, ...modes });
      if (failures.length >= 5) break;       // five is plenty to diagnose
      continue;
    }
    vocab = res.vocab;
    for (const ph of res.phases) if (!phases.includes(ph)) phases.push(ph);
    for (const [t, n] of Object.entries(res.legal)) legal[t] = (legal[t] || 0) + n;
    if (!modes.hostile) for (const [t, n] of Object.entries(res.sent)) sent[t] = (sent[t] || 0) + n;

    // A pause must cost the game NOTHING but time. The shell freezes every timer while
    // the table waits, so a correct game, paused for 45 seconds and resumed, then says
    // exactly what it would have said with no pause at all — later, and otherwise
    // identically. Comparing only the frozen moment itself (above) could not see the
    // worse failure: a countdown kept on the wall clock that blows the instant play
    // resumes. Play the same game again without the pause, and the two must agree.
    // A warm reconnect must be invisible to the game: caught up with exactly what it
    // missed, the phone is indistinguishable from one that only sat through a pause.
    if (modes.reconnect && res.reconnectMode === 'warm') {
      const paused = await playOne(game, { ...run, reconnect: 'reference' });
      if (paused.ok && paused.story !== res.story) {
        failures.push({ seed, players, ...modes,
          why: `a warm reconnect changed the game — the same seed with only a pause in its place said `
             + `different things. The shell's catch-up must be invisible; something reacts to who is connected` });
      }
    }
    if (modes.pause) {
      const plain = await playOne(game, { ...run, pause: 'reference' });
      if (plain.ok && plain.story !== res.story) {
        failures.push({ seed, players, ...modes,
          why: `a 44s pause changed the game, not just its timing — the same seed played with no pause `
             + `said different things (${plain.turns} turns/winner ${plain.result?.winnerId} unpaused, `
             + `${res.turns}/${res.result?.winnerId} paused). Game time is leaking from the wall clock` });
      }
    }

    // Determinism: the whole point of seeding everything is that (seed, bots) fully
    // determines the game — replaying a seed must reproduce it move for move. A game
    // that drifts (Math.random, real Date.now, iteration over an unordered structure)
    // can't be debugged from a seed, which quietly defeats every other check here.
    // Checked for the first game of EACH mode, not just the first game: a game that
    // is only nondeterministic after a reconnect is exactly as undebuggable.
    if (i < 8) {
      const again = await playOne(game, run);
      if (!again.ok || again.fingerprint !== res.fingerprint) {
        failures.push({ seed, players, ...modes,
          why: `not deterministic — the same seed played twice gave `
             + `${res.turns} turns/winner ${res.result?.winnerId} then `
             + `${again.turns} turns/winner ${again.result?.winnerId}`
             + (again.ok && again.turns === res.turns ? ' (same length, different messages)' : '')
             + `; something outside FR.rng(Table.seed) is steering the game` });
      }
    }
  }
  // Intents the whole batch never once sent. 'hello' is plumbing, and an intent the
  // game marks hidden is deliberately outside the enumerable move space (free text
  // with a bot.mjs, a score stream) — flagging those would train people to ignore the
  // warning that matters. "Never legal" is the stronger signal: no bot ever COULD.
  const neverSent = [...new Set(vocab)].filter(t => t !== 'hello' && !sent[t]);
  const neverLegal = neverSent.filter(t => !legal[t]);
  return { games, totalTurns, failures, neverSent, neverLegal, notes, phases, sent };
}

/* ------------------------------------------------------------------ cli --- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i === -1 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
  };
  const VALUED = ['games', 'players', 'seed', 'screens'];
  const targets = args.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && VALUED.includes(args[i - 1].replace(/^--/, ''))));

  const samplesDir = join(REPO, 'playtest/samples');
  let list = targets;
  if (flag('all', false) || !list.length) {
    list = readdirSync(samplesDir).filter(d => existsSync(join(samplesDir, d, 'game.js')));
  }

  const opts = {
    games: Number(flag('games', 40)),
    // 0 = sweep table sizes; an explicit --players N pins every game to N phones.
    players: Number(flag('players', 0)) || undefined,
    seed: Number(flag('seed', 1)),
    verbose: !!flag('verbose', false),
    // Unset = rotate per seed. Set (from a reproduce command) = pin the mode.
    hostile: args.includes('--hostile') ? true : undefined,
    pause: args.includes('--pause') ? true : undefined,
    ui: args.includes('--ui') ? true : undefined,
    reconnect: args.includes('--reconnect') ? true : undefined,
    screens: flag('screens', undefined) === undefined ? undefined : Number(flag('screens')),
    toggleScreen: args.includes('--toggle-screen') ? true : undefined
  };
  // A reproduce command pins one run exactly; any mode it doesn't name is OFF.
  if (opts.games === 1 && args.includes('--seed')) {
    for (const k of ['hostile', 'pause', 'ui', 'reconnect', 'toggleScreen']) {
      if (opts[k] === undefined) opts[k] = false;
    }
  }

  const gapsPath = join(REPO, 'harness/known-gaps.json');
  const gaps = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, 'utf8')) : {};

  let bad = 0, skipped = 0;
  for (const game of list) {
    // A known harness gap is reported loudly but doesn't fail the run: these bundles play
    // fine in the studio and on device, and treating them as failures would make --all
    // useless as a gate. Anything NOT listed here is expected to pass.
    if (gaps[game] && !targets.includes(game)) {
      console.log(`  ~ ${game.padEnd(12)} skipped — ${gaps[game]}`);
      skipped++;
      continue;
    }
    const label = game.padEnd(12);
    const t0 = Date.now();
    let out;
    try { out = await playtest(game, opts); }
    catch (e) { console.log(`  ✗ ${label} harness error: ${e.stack || e.message}`); bad++; continue; }
    const ms = Date.now() - t0;
    if (!out.failures.length) {
      console.log(`  ✓ ${label} ${out.games} games, ${out.totalTurns} turns, ${ms}ms`
        + (opts.verbose ? ` · phases: ${out.phases.join(', ')}` : ''));
      if (out.neverLegal.length) {
        console.log(`      ⚠ never even legal in ${out.games} games: ${out.neverLegal.join(', ')} — `
                  + `no bot could ever have sent these; the path is unreachable or its options/when are wrong`);
      }
      const merely = out.neverSent.filter(t => !out.neverLegal.includes(t));
      if (merely.length) {
        console.log(`      ⚠ legal but never sent in ${out.games} games: ${merely.join(', ')} — `
                  + `untested paths; run more games or check the bot's choices`);
      }
      for (const n of out.notes) console.log(`      · ${n}`);
    } else {
      bad++;
      console.log(`  ✗ ${label} ${out.failures.length} failing:`);
      for (const f of out.failures) {
        const tags = ['hostile', 'pause', 'ui', 'reconnect', 'toggleScreen'].filter(k => f[k]);
        console.log(`      seed ${f.seed}${tags.map(t => ` (${t})`).join('')}${f.screens ? ' (screen on)' : ''}: ${f.why}`);
        // The reproduce command must pin EVERYTHING the batch varied — player count and
        // every mode — or it replays a different game than the one that failed, which
        // is worse than no command at all.
        console.log(`        reproduce: ${reproduce(game, f)}`);
      }
    }
  }
  const ran = list.length - skipped;
  console.log(bad
    ? `\n${bad} bundle(s) failing${skipped ? `, ${skipped} skipped (known harness gaps)` : ''}`
    : `\nAll ${ran} playable bundle(s) pass${skipped ? `; ${skipped} skipped (known harness gaps)` : ''}`);
  process.exit(bad ? 1 : 0);
}
