/*
 * rules.js — SCRAMBLE's rules, with no Table, no DOM and no randomness of its own.
 *
 * The host validates every word with this, and the fuzzer's bots FIND words with
 * it. One implementation, two consumers, on purpose: a bot that reimplemented
 * "is this word on the grid?" would be testing a different game from the one that
 * ships, and would agree with itself right up until a real player disagreed.
 *
 * Loaded as a plain script (`<script src="rules.js">`), after dict.js.
 */
var SCRAMBLE_RULES = (function () {
  'use strict';

  var WORDS = typeof SCRAMBLE_WORDS !== 'undefined' ? SCRAMBLE_WORDS : {};

  /* The real 4x4 Boggle dice. A grid rolled from these is PLAYABLE — vowels land
   * where they are needed and Q always arrives as Qu. Sixteen independent random
   * letters gives walls of consonants a table can do nothing with, which is the
   * kind of dud round that makes people put a game down. */
  var DICE = ['aaeegn', 'abbjoo', 'achops', 'affkps',
              'aoottw', 'cimotu', 'deilrx', 'delrvy',
              'distty', 'eeghnw', 'eeinsu', 'ehrtvw',
              'eiosst', 'elrtty', 'himnqu', 'hlnnrz'];

  var SIZE = 4;
  var MIN = 3;
  var MAX = 8;                       // stated in the UI; a bound beats a silent "not a word"

  /* Classic Boggle scoring. The 8-letter cliff is what makes the long shot worth
   * burning the clock on. */
  var POINTS = { 3: 1, 4: 1, 5: 2, 6: 3, 7: 5, 8: 11 };
  var GOLD = 5;                      // for the longest word nobody else found

  function score(word) { return POINTS[word.length] || 0; }

  /** Roll a grid. `r` is an FR.rng — the whole game replays from its seed. */
  function roll(r) {
    var order = r.shuffle(DICE);
    var grid = [];
    for (var i = 0; i < order.length; i++) {
      var face = order[i].charAt(r.int(6));
      grid.push(face === 'q' ? 'qu' : face);    // the Qu die is one cell, two letters
    }
    return grid;
  }

  /* Neighbours of every cell, once, rather than per step of every search. */
  var ADJ = (function () {
    var adj = [];
    for (var i = 0; i < SIZE * SIZE; i++) {
      var list = [], r0 = (i / SIZE) | 0, c0 = i % SIZE;
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          var rr = r0 + dr, cc = c0 + dc;
          if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
          list.push(rr * SIZE + cc);
        }
      }
      adj.push(list);
    }
    return adj;
  })();

  /**
   * Can `word` be traced through the grid, each cell used at most once?
   *
   * A Qu cell matches two letters of the word at one step, which is why this
   * walks by cell rather than by letter.
   */
  function placeable(grid, word) {
    var used = [];

    function from(i, pos) {
      var cell = grid[i];
      if (word.substr(pos, cell.length) !== cell) return false;
      pos += cell.length;
      if (pos >= word.length) return true;
      used[i] = true;
      var near = ADJ[i];
      for (var k = 0; k < near.length; k++) {
        var j = near[k];
        if (!used[j] && from(j, pos)) { used[i] = false; return true; }
      }
      used[i] = false;
      return false;
    }

    for (var i = 0; i < grid.length; i++) if (from(i, 0)) return true;
    return false;
  }

  /** Is this in the word list? Binary search inside the fixed-width block for its length. */
  function known(word) {
    var L = word.length, s = WORDS[L];
    if (!s) return false;
    var lo = 0, hi = (s.length / L) - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, at = s.substr(mid * L, L);
      if (at === word) return true;
      if (at < word) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }

  /**
   * Why this word doesn't count, or null if it does.
   *
   * Reason codes rather than sentences: the phone writes the message, so the host
   * never has to send a player's own typing back to them — which is what keeps a
   * rejected word off the wire entirely.
   */
  function check(grid, word) {
    if (!/^[a-z]+$/.test(word)) return 'letters';
    if (word.length < MIN || word.length > MAX) return 'length';
    if (!placeable(grid, word)) return 'grid';
    if (!known(word)) return 'word';
    return null;
  }

  /* Letters available on the grid, as a 26-bit mask plus counts. A Qu cell offers
   * both letters, which overstates it (they can only be taken together) — this is
   * a filter, and a filter is allowed to be generous as long as it is never wrong
   * in the other direction. */
  function supply(grid) {
    var mask = 0, count = [];
    for (var i = 0; i < 26; i++) count[i] = 0;
    for (var c = 0; c < grid.length; c++) {
      var cell = grid[c];
      for (var k = 0; k < cell.length; k++) {
        var n = cell.charCodeAt(k) - 97;
        mask |= (1 << n);
        count[n]++;
      }
    }
    return { mask: mask, count: count };
  }

  var need = [];                       // reused; allocating one per word costs more than the search

  function couldFit(word, sup) {
    var i, n;
    for (i = 0; i < word.length; i++) {
      if (!(sup.mask & (1 << (word.charCodeAt(i) - 97)))) return false;
    }
    for (i = 0; i < 26; i++) need[i] = 0;
    for (i = 0; i < word.length; i++) {
      n = word.charCodeAt(i) - 97;
      if (++need[n] > sup.count[n]) return false;
    }
    return true;
  }

  /**
   * Every word on this grid, best first.
   *
   * Walks the DICTIONARY testing placement rather than walking the grid testing
   * prefixes: the cheap letter filter below throws most of 200,000 words away
   * without touching the grid at all, and it needs no trie to be built on a phone
   * at the start of every round.
   */
  function solve(grid) {
    var sup = supply(grid);
    var out = [];
    for (var L = MIN; L <= MAX; L++) {
      var s = WORDS[L];
      if (!s) continue;
      for (var off = 0; off + L <= s.length; off += L) {
        var w = s.substr(off, L);
        if (!couldFit(w, sup)) continue;
        if (placeable(grid, w)) out.push(w);
      }
    }
    out.sort(function (a, b) {
      return score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0);
    });
    return out;
  }

  /**
   * Score a round. The party rule: a word two people found is worth nothing to
   * either of them, so the points are in seeing what nobody else sees.
   *
   * @param {Object} found  playerId -> [word]
   * @returns {Object} { rows, points, golden }
   */
  function tally(found) {
    var by = {}, ids = Object.keys(found).sort();
    for (var i = 0; i < ids.length; i++) {
      var list = found[ids[i]] || [];
      for (var j = 0; j < list.length; j++) {
        (by[list[j]] || (by[list[j]] = [])).push(ids[i]);
      }
    }

    var rows = Object.keys(by).sort().map(function (w) {
      var who = by[w];
      return { w: w, pts: score(w), by: who, dup: who.length > 1 };
    });
    rows.sort(function (a, b) {
      return (a.dup - b.dup) || (b.pts - a.pts) || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0);
    });

    var points = {};
    for (i = 0; i < ids.length; i++) points[ids[i]] = 0;
    var longest = 0;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].dup) continue;
      points[rows[i].by[0]] += rows[i].pts;
      if (rows[i].w.length > longest) longest = rows[i].w.length;
    }

    /* The GOLDEN WORD: the longest word nobody else found. Ties all collect —
     * two people doing something that good on the same grid both earned it. */
    var golden = [];
    for (i = 0; i < rows.length; i++) {
      if (!rows[i].dup && rows[i].w.length === longest && longest >= MIN) {
        rows[i].gold = true;
        points[rows[i].by[0]] += GOLD;
        if (golden.indexOf(rows[i].by[0]) === -1) golden.push(rows[i].by[0]);
      }
    }
    return { rows: rows, points: points, golden: golden };
  }

  return {
    DICE: DICE, SIZE: SIZE, MIN: MIN, MAX: MAX, GOLD: GOLD, POINTS: POINTS,
    roll: roll, score: score, placeable: placeable, known: known,
    check: check, solve: solve, tally: tally
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SCRAMBLE_RULES;
