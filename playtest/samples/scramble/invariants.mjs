/*
 * SCRAMBLE's own rules, checked by the fuzzer after every turn and at game end.
 *
 * The load-bearing ones re-derive rather than trust:
 *
 *   every scored word really is on that grid and really is in the word list —
 *   recomputed here with rules.js, so a host that accepted something it shouldn't
 *   have is caught by the rules rather than by the host agreeing with itself;
 *
 *   the cancel rule, which is the entire game: a word two people found scores
 *   nobody anything, and every point in `points` is accounted for by a row;
 *
 *   and privacy ON THE WIRE: while a round is running, nothing the host sent to
 *   one player privately may appear in a broadcast. That is the property the
 *   shared screen's safety rests on, and it is true whether or not a TV is in the
 *   room — a broadcast word is already on every phone.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./dict.js', import.meta.url), 'utf8') +
            readFileSync(new URL('./rules.js', import.meta.url), 'utf8');
const R = new Function('module', src + '; return SCRAMBLE_RULES;')({});

/** Every string a payload SAYS — its values, never its keys. */
function stringValues(v, out = []) {
  if (typeof v === 'string') { out.push(v); return out; }
  if (Array.isArray(v)) { v.forEach(x => stringValues(x, out)); return out; }
  if (v && typeof v === 'object') { Object.values(v).forEach(x => stringValues(x, out)); return out; }
  return out;
}

export default function scrambleInvariants({ table, players, done, result }) {
  const seen = table._scTotals || (table._scTotals = {});

  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s) continue;

    if (s.round < 0 || s.round >= s.rounds) return `round ${s.round} is outside the game`;
    if (s.secondsLeft < 0 || s.secondsLeft > 90) return `the clock shows ${s.secondsLeft}s`;

    // Sixteen dice, and the only two-letter face in Boggle is Qu.
    if (!Array.isArray(s.grid) || s.grid.length !== 16) {
      return `the grid has ${s.grid ? s.grid.length : 'no'} cells`;
    }
    for (const cell of s.grid) {
      if (!/^[a-z]$/.test(cell) && cell !== 'qu') return `"${cell}" is not a die face`;
    }

    for (const pid of s.seats) {
      if ((s.counts[pid] || 0) < 0) return `${pid} has a negative word count`;
      if (s.phase === 'ready' && s.counts[pid]) {
        return `${pid} already has ${s.counts[pid]} words before the round started`;
      }
      const total = s.totals[pid] || 0;
      if (total < 0) return `${pid} has ${total} points`;
      const mine = seen[pid];
      if (mine !== undefined && total < mine) {
        return `${pid}'s score fell from ${mine} to ${total}`;
      }
      seen[pid] = total;
    }

    // NO SPOILERS. The tally does not exist until the round is over, so there is
    // nothing for a screen (or a curious player) to read early.
    if (s.phase !== 'tally' && (s.rows || s.points)) {
      return `the tally was published during the "${s.phase}" phase`;
    }

    if (s.phase === 'tally') {
      const rows = s.rows || [];
      if (rows.length > s.possible) {
        return `${rows.length} words were found on a grid holding ${s.possible}`;
      }

      const earned = {};
      let longestUnique = 0;
      const words = new Set();
      for (const row of rows) {
        if (words.has(row.w)) return `"${row.w}" is in the tally twice`;
        words.add(row.w);

        // The two things the host had to get right, re-derived.
        if (!R.placeable(s.grid, row.w)) return `"${row.w}" scored but is not on this grid`;
        if (!R.known(row.w)) return `"${row.w}" scored but is not in the word list`;
        if (row.pts !== R.score(row.w)) return `"${row.w}" scored ${row.pts}, not ${R.score(row.w)}`;

        if (!row.by.length) return `"${row.w}" was found by nobody`;
        if (new Set(row.by).size !== row.by.length) return `"${row.w}" credits someone twice`;
        if (row.dup !== row.by.length > 1) return `"${row.w}" has dup=${row.dup} with ${row.by.length} finders`;

        if (!row.dup) {
          earned[row.by[0]] = (earned[row.by[0]] || 0) + row.pts;
          if (row.w.length > longestUnique) longestUnique = row.w.length;
        }
      }

      // The golden word, and nobody else, collects the bonus.
      const gold = new Set();
      for (const row of rows) {
        if (!row.dup && row.w.length === longestUnique && longestUnique > 0) {
          gold.add(row.by[0]);
          earned[row.by[0]] = (earned[row.by[0]] || 0) + s.gold;
          if (!row.gold) return `"${row.w}" is the longest unique word but is not marked golden`;
        } else if (row.gold) {
          return `"${row.w}" is marked golden but ${row.dup ? 'was cancelled' : 'is not the longest'}`;
        }
      }
      for (const pid of s.seats) {
        const claimed = (s.points || {})[pid] || 0;
        if (claimed !== (earned[pid] || 0)) {
          return `${pid} was given ${claimed} for the round but their words are worth ${earned[pid] || 0}`;
        }
        if (gold.has(pid) !== ((s.golden || []).indexOf(pid) !== -1)) {
          return `${pid}'s golden-word status disagrees with the words`;
        }
      }
    }
  }

  // PRIVACY, on the wire rather than on trust. A word is yours until the round
  // ends; the host must not put one in a broadcast before then.
  const priv = table._scPrivate ||
    (table._scPrivate = { words: new Set(), seen: 0, innocent: null, round: -1 });
  for (const e of table.wire('sendTo')) {
    const list = e.payload && e.payload.words;
    if (Array.isArray(list)) list.forEach(w => priv.words.add(w));
  }

  /* Knowing a word is in a broadcast is not enough, because a broadcast is FULL of
   * words: the message type is "state", the phase is "round", a player may be
   * called Pat, and someone will eventually find DONE on a grid — all of which
   * looked like leaks when this was a substring search, and none of which are.
   *
   * So the baseline is taken rather than listed. The FIRST broadcast of a round
   * goes out before anybody can have submitted anything, so every word in it is
   * part of the state's own vocabulary by definition. Anything that shows up later
   * and matches a word a player was told privately is the real thing. The
   * exclusion list maintains itself, which is the only kind that stays true.
   */
  const broadcasts = table.wire('broadcast');
  for (; priv.seen < broadcasts.length; priv.seen++) {
    const payload = broadcasts[priv.seen].payload;
    const s = payload && payload.s;
    if (!s || s.phase !== 'round') continue;          // at the tally they are all public
    const tokens = new Set();
    for (const said of stringValues(payload)) {
      for (const token of String(said).toLowerCase().match(/[a-z]+/g) || []) tokens.add(token);
    }
    if (!priv.innocent || priv.round !== s.round) {
      priv.round = s.round;
      priv.innocent = tokens;
      continue;
    }
    for (const token of tokens) {
      if (priv.words.has(token) && !priv.innocent.has(token)) {
        return `the word "${token}" was broadcast to the whole table mid-round`;
      }
    }
  }

  if (done && result && Array.isArray(result.standings) && result.standings.length) {
    const top = Math.max(...result.standings.map(r => r.score));
    const winner = result.standings.find(r => r.playerId === result.winnerId);
    if (winner && winner.score !== top) {
      return `${result.winnerId} won with ${winner.score} but ${top} was the best score`;
    }
  }
  return null;
}
