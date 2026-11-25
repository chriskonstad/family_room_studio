/*
 * rebuild.test.mjs — a TEMPO phone rebuilt from the history (iOS killed the app; the
 * shell replays `start` and every message) must pick its track up where the host last
 * heard from it, and a player the host already has as finished gets no second track.
 *
 *   node playtest/samples/tempo/rebuild.test.mjs
 *
 * The fuzzer cannot see this: the rebuilt phone's own score and combo are exactly the
 * text invariants.mjs's reconnectIgnore masks, and a restarted track's lower scores are
 * swallowed by the host keeping the best it has heard.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const BUNDLE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.FR_REPO || join(BUNDLE, '../../..');
const { runGame } = await import(pathToFileURL(join(REPO, 'harness/runner.mjs')).href);

let pass = 0, fail = 0;
const out = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fail++; out.push(`  ✗ ${name}\n      ${e.message}`); }
}
function ok(what, cond, detail) { if (!cond) throw new Error(`${what}${detail ? ': ' + detail : ''}`); }

/** Start the track and play `seconds` of it, p1 tapping now and then. */
async function playing(seconds) {
  const t = await runGame({ game: BUNDLE, players: 2, seed: 3 });
  t.send('p0', { t: 'go' });
  for (let i = 0; i < seconds * 4; i++) {
    const zone = t.clickable('p1').find(h => h.onclick && (h._id === 'tap' || (h.attrs && h.attrs.id === 'tap')));
    if (zone && i % 3 === 0) t.press('p1', zone);
    t.advance(250);
  }
  t.state = () => t.wire('broadcast').slice(-1)[0].payload.s;
  t.sentBy = (id, from) => t.wire('send').slice(from).filter(e => e.from === id).map(e => e.payload);
  return t;
}

await test('a phone rebuilt mid-track resumes at the position and score the host last heard', async () => {
  const t = await playing(25);
  const before = t.state();
  ok('p1 was well into the track', before.at.p1 > 20, `at ${before.at.p1}`);
  ok('p1 had scored', before.scores.p1 > 0, `score ${before.scores.p1}`);

  t.disconnect('p1'); t.advance(3000);
  const mark = t.wire('send').length;
  t.reconnect('p1', { cold: true });
  t.advance(2600);
  const sent = t.sentBy('p1', mark).filter(m => m.t === 'score');
  ok('the rebuilt phone streams its track', sent.length >= 2, `${sent.length} score messages`);
  for (const m of sent) {
    ok('it carries on from where it was, not from the top of the track', m.at >= before.at.p1,
       `sent at ${m.at} after the host had heard ${before.at.p1}`);
    ok('it carries on with the score it had', m.score >= before.scores.p1,
       `sent ${m.score} after the host had heard ${before.scores.p1}`);
  }
});

await test('a phone rebuilt after it finished waits for the others instead of playing again', async () => {
  const t = await playing(10);
  t.send('p1', { t: 'done', score: t.state().scores.p1 });   // as its own track's end would
  t.advance(250);
  ok('the host has p1 finished', t.state().finished.p1 === true);

  t.disconnect('p1'); t.advance(1000);
  const mark = t.wire('send').length;
  t.reconnect('p1', { cold: true });
  t.advance(5000);
  const sent = t.sentBy('p1', mark);
  ok('the rebuilt phone plays no second track', sent.length === 0, JSON.stringify(sent.slice(0, 3)));
  ok('it says it is waiting', /Waiting for everyone to finish/.test(t.text('p1')), t.text('p1'));
});

// A rebuilt phone resumes from a fractional `at`, and a pause shifts its track's start.
// Kept in seconds, those two additions rounded differently from the same game played
// without the pause, so a 1-second streaming threshold landed a frame apart and the
// published `at` read 2.02 where the unpaused game said 2.00. playtest's batch rotation
// never pauses a game that also reconnects, so this asks for both, every game.
await test('a pause after a reconnect changes nothing but timing', async () => {
  const { playtest } = await import(pathToFileURL(join(REPO, 'harness/playtest.mjs')).href);
  const res = await playtest(BUNDLE, { games: 12, seed: 1, pause: true, reconnect: true });
  ok('every game says the same with and without its pause', !res.failures.length,
     res.failures.slice(0, 2).map(f => `seed ${f.seed}: ${f.why}`).join(' | '));
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
