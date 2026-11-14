/*
 * SCRAMBLE is driven by typed words, and the generic bot has nothing to type. Worse
 * than nothing: "I'm done" IS a declared move, so left alone the bots would end
 * every round in one tick having found nothing, and the game would look tested.
 *
 * So this plays properly. It loads the bundle's OWN rules.js and dictionary and
 * solves the grid the same way the host validates it — one implementation, so a
 * passing fuzz run means the shipping rules work, not that two guesses agree.
 *
 * It deliberately plays badly as well as well: it repeats itself, types words that
 * aren't on the grid, and types things that aren't words, because those are the
 * paths a real table hits constantly and they have to be exercised too. And it
 * picks from the SHARED solution list, so two bots find the same word often —
 * which is the only way the cancel rule, the heart of the game, gets driven.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./dict.js', import.meta.url), 'utf8') +
            readFileSync(new URL('./rules.js', import.meta.url), 'utf8');
const R = new Function('module', src + '; return SCRAMBLE_RULES;')({});

/* Typed by people who are out of ideas: too short, too long, not on this grid,
 * and not a word at all. One of each kind of refusal. */
const JUNK = ['zz', 'qjx', 'xylophonists', 'jukebox', 'vrrrt', 'zyzzyva'];

const WORDS_PER_ROUND = 9;

export default function scrambleBot({ table, playerId, rng, send }) {
  const v = table.view(playerId);
  const s = v && v.s;
  if (!s) return false;

  /* Sit through the reveal rather than skipping it. "Skip" is a legal move, so
   * the generic bot would press it on the first frame of every tally and the
   * word-by-word scoring — a screen's whole reason for existing in this game —
   * would never be drawn in a headless run. Hand back control once the last word
   * has been read out. */
  if (s.phase === 'tally') return s.revealed < s.totalRows;

  /* Pick an occasion, rotating through them across a batch so every theme's
   * scoring and its added vocabulary actually get PLAYED, not just unit-tested.
   * Only the host's intent is accepted, so the others fall through harmlessly. */
  if (s.phase === 'setup') {
    const keys = R.THEME_KEYS;
    send({ t: 'theme', k: keys[rng.int(keys.length)] });
    return true;
  }

  if (s.phase !== 'round') return false;           // everything else is a button

  const mem = table._scramble || (table._scramble = {});
  const key = s.round + ':' + (s.theme || 'none') + ':' + (s.grid || []).join('');
  if (mem.key !== key) {
    mem.key = key;
    // Solved WITH the theme, so the theme's own words get found and the double
    // actually pays out in a headless run.
    mem.solved = R.solve(s.grid || [], s.theme);
    mem.players = {};
  }
  const me = mem.players[playerId] || (mem.players[playerId] = { sent: 0, said: [] });

  if (s.done && s.done[playerId]) return true;     // already finished; just wait it out

  if (me.sent >= WORDS_PER_ROUND) {
    me.sent++;
    send({ t: 'done' });
    return true;
  }
  me.sent++;

  const roll = rng.int(10);
  let word;
  if (roll === 0 && me.said.length) word = rng.pick(me.said);        // already found it
  else if (roll === 1) word = rng.pick(JUNK);                        // not happening
  else if (mem.solved.length) {
    /* Weighted toward the front of the list, which is sorted best-first: real
     * players chase long words, and the overlap between bots is what makes the
     * duplicate rule fire. */
    const span = Math.max(1, Math.min(mem.solved.length, 40));
    word = mem.solved[rng.int(span)];
    me.said.push(word);
  } else {
    word = rng.pick(JUNK);
  }

  send({ t: 'word', w: word, n: me.sent });
  return true;
}
