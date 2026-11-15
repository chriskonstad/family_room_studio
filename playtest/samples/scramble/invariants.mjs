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

/* A theme word that cannot be submitted is not a bonus, it is a lie: `check()`
 * refuses anything outside MIN..MAX or with a non-letter in it, whatever list it
 * is on. Checked once, here, so a theme word nobody could ever score fails the
 * build instead of disappointing a room. */
const themeFault = (() => {
  for (const key of R.THEME_KEYS) {
    for (const w of R.THEMES[key].words) {
      if (!/^[a-z]+$/.test(w)) return `theme "${key}" has "${w}", which is not plain letters`;
      if (w.length < R.MIN || w.length > R.MAX) {
        return `theme "${key}" has "${w}" (${w.length} letters), outside ${R.MIN}-${R.MAX}`;
      }
      if (!R.isThemeWord(key, w)) return `theme "${key}" does not recognise its own "${w}"`;
    }
  }
  return null;
})();


/* ---------------------------------------------------------------- colour ---
 *
 * A theme repaints the phones and the TV, which puts three new ways to ship a
 * broken evening into a bundle that otherwise can't ship one:
 *
 *   a palette missing a key — canvas IGNORES `fillStyle = undefined` and keeps
 *   whatever colour was set last, so the TV would draw a word in the colour of
 *   the thing before it and nothing would throw;
 *
 *   a palette nobody can read — the game is light text on a dark room, and a
 *   pastel occasion is exactly the request that ends in grey-on-grey;
 *
 *   and a colour written anywhere other than a palette, which is a patch of the
 *   screen that stays purple at Christmas. That one can only be caught by
 *   reading the files, so it is read here.
 *
 * Checked once per run, before the first turn.
 */
const HEX = /^#[0-9a-f]{6}$/;

function lumOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c) => (c /= 255, c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
function contrast(a, b) {
  const x = lumOf(a), y = lumOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* What has to stay readable, and how readable. The floors sit under the three
 * shipped themes with room to spare; they are here to stop the next theme, not
 * to grade these. 4.5 is WCAG AA for body text, 3.0 its large-text floor. */
const READABLE = [
  ['text', 'bg1', 6], ['text', 'bg2', 6], ['text', 'panel', 6],
  ['muted', 'bg1', 3.5], ['muted', 'panel', 3.5],
  ['accent', 'bg1', 4.5], ['good', 'bg1', 3.5], ['bad', 'bg1', 3.5],
  // The letters on their tiles, and the label on the gold button.
  ['tileInk', 'tile', 6], ['tileInk', 'accent', 6], ['tileInk', 'accentLit', 6]
];

/** Colour literals outside the one block that is allowed them. */
function strayColour(file, allowed) {
  const text = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
  const open = text.indexOf(allowed);
  if (open < 0) return `${file} no longer has its ${allowed.trim()} block`;
  const end = text.indexOf('\n  }', open);
  const rest = text.slice(0, open) + text.slice(end < 0 ? open : end);
  const hex = rest.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hex) return `${file} hard-codes ${hex[0]} — a theme cannot repaint it`;
  const rgb = rest.match(/rgba?\(\s*[\d.]/);
  if (rgb) return `${file} hard-codes an rgb() colour — a theme cannot repaint it`;
  return null;
}

const paletteFault = (() => {
  for (const key of R.THEME_KEYS) {
    const p = R.THEMES[key].palette;
    if (!p) return `theme "${key}" has no palette`;
    for (const k of R.PALETTE_KEYS) {
      if (!HEX.test(String(p[k]))) return `theme "${key}" palette.${k} is "${p[k]}", not a 6-digit hex`;
    }
    for (const k of Object.keys(p)) {
      if (!R.PALETTE_KEYS.includes(k)) return `theme "${key}" palette has an unused "${k}"`;
    }
    for (const [a, b, floor] of READABLE) {
      const got = contrast(p[a], p[b]);
      if (got < floor) {
        return `theme "${key}": ${a} on ${b} is ${got.toFixed(2)}:1, under ${floor}:1`;
      }
    }
  }
  // The stylesheet's :root and the screen's FALLBACK are the two places a colour
  // may be written down; everywhere else must go through them.
  return strayColour('screen.js', '  var FALLBACK = {') ||
         strayColour('index.html', '  :root{');
})();

export default function scrambleInvariants({ table, players, done, result }) {
  if (themeFault) return themeFault;
  if (paletteFault) return paletteFault;
  const seen = table._scTotals || (table._scTotals = {});

  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s) continue;

    if (s.round < 0 || s.round >= s.rounds) return `round ${s.round} is outside the game`;

    /* The TV paints from this and from nothing else, so it has to be the whole
     * palette of the theme that is actually running — not the one before it. */
    const want = R.THEMES[R.themeOf(s.theme)].palette;
    for (const k of R.PALETTE_KEYS) {
      if (s.palette?.[k] !== want[k]) {
        return `the broadcast palette.${k} is "${s.palette?.[k]}", not "${want[k]}" of theme "${s.theme}"`;
      }
    }
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
      // Scores only exist between rounds; the rest of the time there is nothing
      // published to check, which is itself asserted below.
      if (!s.totals) continue;
      const total = s.totals[pid] || 0;
      if (total < 0) return `${pid} has ${total} points`;
      const mine = seen[pid];
      if (mine !== undefined && total < mine) {
        return `${pid}'s score fell from ${mine} to ${total}`;
      }
      seen[pid] = total;
    }

    /* NOTHING IS KNOWN UNTIL IT IS READ OUT.
     *
     * Three separate secrets, and all three are kept by leaving things OUT of the
     * broadcast rather than by leaving them off a layout:
     *   - no tally at all before the round ends;
     *   - NO SCORES while a round is running, so no phone and no screen can show
     *     one even if it wanted to;
     *   - during the reveal, only the words already read out. */
    if (s.phase !== 'tally' && s.phase !== 'gameOver') {
      if (s.rows || s.points) return `the tally was published during the "${s.phase}" phase`;
      if (s.totals) return `scores were published during the "${s.phase}" phase`;
    }

    if (s.phase === 'tally') {
      const rows = s.rows || [];
      if (rows.length !== s.revealed) {
        return `${rows.length} words were published but only ${s.revealed} have been read out`;
      }
      if (s.revealed > s.totalRows) return `${s.revealed} words read out of ${s.totalRows}`;
      if (s.totalRows > s.possible) {
        return `${s.totalRows} words were found on a grid holding ${s.possible}`;
      }

      const earned = {};
      const words = new Set();
      for (const row of rows) {
        if (words.has(row.w)) return `"${row.w}" is in the tally twice`;
        words.add(row.w);

        // The three things the host had to get right, re-derived.
        if (!R.placeable(s.grid, row.w)) return `"${row.w}" scored but is not on this grid`;
        // A theme brings its own vocabulary for as long as it is on, so the word
        // list a scored word has to be in is the dictionary PLUS that theme's.
        if (!R.known(row.w) && !R.isThemeWord(s.theme, row.w)) {
          return `"${row.w}" scored but is in neither the word list nor the ${s.theme} theme`;
        }
        if (!!row.theme !== R.isThemeWord(s.theme, row.w)) {
          return `"${row.w}" is marked theme=${!!row.theme} under the ${s.theme} theme`;
        }
        if (row.pts !== R.score(row.w)) return `"${row.w}" is worth ${row.pts}, not ${R.score(row.w)}`;

        if (!row.by.length) return `"${row.w}" was found by nobody`;
        if (new Set(row.by).size !== row.by.length) return `"${row.w}" credits someone twice`;
        if (row.dup !== row.by.length > 1) return `"${row.w}" has dup=${row.dup} with ${row.by.length} finders`;

        // Every word pays; a word nobody else found pays double; a word that
        // fits the occasion pays double again, and the two multiply.
        const want = row.pts * (row.dup ? 1 : s.unique) * (row.theme ? s.themeBonus : 1);
        if (row.value !== want) {
          return `"${row.w}" paid ${row.value}, but a ${row.dup ? 'shared' : 'unique'} ` +
                 `${row.theme ? 'theme ' : ''}${row.pts}-pointer is worth ${want}`;
        }
        for (const pid of row.by) earned[pid] = (earned[pid] || 0) + row.value;
      }

      // The running order: shared before unique, short before long inside each.
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.dup === b.dup) {
          if (a.w.length > b.w.length) {
            return `"${a.w}" was read out before the shorter "${b.w}"`;
          }
        } else if (!a.dup && b.dup) {
          return `the unique "${a.w}" was read out before the shared "${b.w}"`;
        }
      }

      for (const pid of s.seats) {
        const claimed = (s.points || {})[pid] || 0;
        if (claimed !== (earned[pid] || 0)) {
          return `${pid} was given ${claimed} so far but the words read out are worth ${earned[pid] || 0}`;
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
