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
  var UNIQUE = 2;                    // a word nobody else found is worth double
  var THEME_BONUS = 2;               // and a word that fits the occasion, again

  /**
   * What a theme repaints.
   *
   * An occasion that only changes the word list is a scoring rule wearing a
   * label. The table SEES Christmas before it scores a single Christmas word, so
   * the palette is part of the theme — and it lives in the rules, not in the
   * stylesheet, for one hard reason: the Apple TV runs `screen.js` alone, with no
   * rules.js and no dictionary. The only way the TV and the phones can agree on
   * what Christmas looks like is for the colours to travel in the host's
   * broadcast. A second copy on the screen would drift, and the night it drifted
   * the room would be green and the TV would still be purple.
   *
   * Every value is a solid 6-digit hex. Alpha variants are derived where they are
   * used (`rgba()` on the screen, `opacity` in CSS) so a theme never restates the
   * same colour twice, and `invariants.mjs` checks every theme carries every key,
   * that the text can be read on the background, and that nothing anywhere draws
   * a colour a theme cannot reach.
   */
  var PALETTE_KEYS = [
    'glow',                          // the light behind the top of the page
    'bg1', 'bg2',                    // the page, top and bottom
    'panel', 'line',                 // chips, buttons, their borders
    'text', 'muted',                 // what it says, and what it murmurs
    'accent', 'accentLit',           // the live tile, the brand, the next button
    'good', 'bad',                   // banked, bounced
    'tile', 'tileInk',               // the letters, and the letters on them
    'spark'                          // the fourth confetti colour
  ];

  /**
   * Themes.
   *
   * A theme does two things, and the second one is why it is in RULES and not in
   * the UI. Its words score double — stacking with UNIQUE, so the baby word only
   * you spotted is worth four times its face value. And its words are ADDED to
   * the word list for as long as the theme is on.
   *
   * That second part is not a flourish. `santa` is not in the dictionary: the
   * harvester drops capitalised entries on purpose, because otherwise every
   * first name on the machine becomes a legal word. Which is right in general
   * and intolerable at a Christmas table — drawing SANTA and being told it is
   * not a word is the single worst thing this game could do that evening. So a
   * theme brings its own vocabulary with it, and takes it away again after.
   *
   * Every other word here was checked against the shipped dictionary when it was
   * written; `invariants.mjs` re-checks the whole list on every run, so a theme
   * word that nobody can score is a test failure rather than a disappointment.
   */
  var THEMES = {
    none: {
      name: 'Classic', emoji: '\uD83D\uDD21',
      blurb: 'The word list, nothing else.',
      palette: {
        glow: '#3b2660', bg1: '#2a1b45', bg2: '#160d27',
        panel: '#352457', line: '#4b3677',
        text: '#f4eeff', muted: '#a493c7',
        accent: '#ffd166', accentLit: '#fff0c2',
        good: '#6ee7a8', bad: '#ff7a8a',
        tile: '#f3e9d2', tileInk: '#2a1b45',
        spark: '#8ab6ff'
      },
      words: []
    },
    baby: {
      name: 'Baby Shower', emoji: '\uD83C\uDF7C',
      blurb: 'Baby words score double.',
      /* Not pastel-on-white. The game is played in a dark room on bright
       * phones, and a baby shower at 11pm is still a dark room — so this is
       * twilight blue with the pastels doing the talking: soft pink on the live
       * tile, mint for a word that banked, cream letters. */
      palette: {
        glow: '#4b6f94', bg1: '#2d4a66', bg2: '#152838',
        panel: '#335573', line: '#4a7595',
        text: '#f6f6ff', muted: '#a9c4da',
        accent: '#ffc2d6', accentLit: '#ffe6ef',
        good: '#9fe8cd', bad: '#ff8fa6',
        tile: '#fdf5ec', tileInk: '#223b52',
        spark: '#ffe9a8'
      },
      words: [
        'aunt', 'babble', 'babies', 'baby', 'bath', 'bathe', 'bib', 'bibs', 'blanket',
        'bonnet', 'booties', 'booty', 'bottle', 'bottles', 'boy', 'buggy', 'bump', 'burp',
        'burping', 'cake', 'cheeks', 'colic', 'coo', 'cot', 'cradle', 'crawl', 'crib',
        'cribs', 'cuddle', 'cute', 'daddy', 'diaper', 'diapers', 'dribble', 'dribbles',
        'due', 'dummy', 'father', 'feed', 'feeding', 'fingers', 'formula', 'games', 'gift',
        'gifts', 'giggle', 'girl', 'growth', 'guess', 'gums', 'hiccup', 'hug', 'hugs',
        'infant', 'kick', 'kicks', 'kiss', 'kisses', 'little', 'lullaby', 'milk', 'mitten',
        'mobile', 'mommy', 'mother', 'mummy', 'name', 'nana', 'nap', 'nappies', 'nappy',
        'naps', 'newborn', 'nursery', 'onesie', 'ounce', 'papa', 'parent', 'playpen',
        'pound', 'powder', 'pram', 'punch', 'rattle', 'romper', 'shower', 'sleep',
        'sleeper', 'sleepy', 'small', 'smile', 'sock', 'socks', 'spoon', 'stork',
        'stroller', 'swaddle', 'teeth', 'teether', 'tiny', 'toddler', 'toes', 'tooth',
        'twins', 'uncle', 'weight', 'wipes', 'womb'
      ]
    },
    christmas: {
      name: 'Christmas', emoji: '\uD83C\uDF84',
      blurb: 'Christmas words score double.',
      /* Evergreen and gold, with the red kept for the things that are already
       * red — a bounced word and the last ten seconds. Red as the accent would
       * have put Christmas on the clock running out. */
      palette: {
        glow: '#1d4d33', bg1: '#10331f', bg2: '#0c2a19',
        panel: '#19402a', line: '#2b6340',
        text: '#f2f8ee', muted: '#9dc0a6',
        accent: '#f6c854', accentLit: '#fff0bd',
        good: '#76dd9a', bad: '#ff6f6f',
        tile: '#f7efdd', tileInk: '#10331f',
        spark: '#ff6f6f'
      },
      words: [
        'advent', 'angel', 'angels', 'bauble', 'bells', 'blitzen', 'bow', 'bows', 'candle',
        'candles', 'candy', 'cane', 'canes', 'card', 'cards', 'carol', 'carols', 'cheer',
        'chestnut', 'chill', 'chimney', 'cider', 'cocoa', 'comet', 'cookie', 'cookies',
        'cupid', 'dasher', 'donner', 'eggnog', 'elf', 'elves', 'family', 'feast', 'festive',
        'fir', 'frost', 'frosty', 'garland', 'gift', 'gifts', 'glitter', 'gold', 'goose',
        'gravy', 'ham', 'hearth', 'holly', 'home', 'icicle', 'ivy', 'jingle', 'joy',
        'kringle', 'lights', 'log', 'manger', 'merry', 'mince', 'mitten', 'mittens',
        'myrrh', 'noel', 'nutmeg', 'peace', 'pie', 'pies', 'pine', 'present', 'presents',
        'pudding', 'reindeer', 'ribbon', 'roast', 'rudolph', 'santa', 'scarf', 'season',
        'shepherd', 'sing', 'skate', 'sled', 'sleds', 'sleigh', 'snow', 'snowman', 'songs',
        'sparkle', 'spruce', 'star', 'stars', 'stocking', 'tag', 'tags', 'tidings',
        'tinsel', 'toy', 'toys', 'tree', 'trees', 'turkey', 'twinkle', 'vixen', 'winter',
        'wise', 'wrap', 'wrapped', 'wreath', 'yule', 'yuletide'
      ]
    }
  };

  var THEME_KEYS = Object.keys(THEMES);

  /* word -> true, per theme, built once. */
  var themeIndex = (function () {
    var out = {};
    for (var k in THEMES) {
      var set = {}, list = THEMES[k].words;
      for (var i = 0; i < list.length; i++) set[list[i]] = true;
      out[k] = set;
    }
    return out;
  })();

  function themeOf(key) { return THEMES[key] ? key : 'none'; }
  function isThemeWord(key, word) { return !!themeIndex[themeOf(key)][word]; }
  function themeWords(key) { return THEMES[themeOf(key)].words.slice(); }

  /** How many of a theme's words this grid can actually produce. */
  function themeHits(grid, key) {
    var list = THEMES[themeOf(key)].words, n = 0;
    for (var i = 0; i < list.length; i++) if (placeable(grid, list[i])) n++;
    return n;
  }

  /** What a word is worth on its own, before anyone else's sheet is looked at. */
  function score(word) { return POINTS[word.length] || 0; }

  /** What a finder actually collects for it. Bonuses multiply. */
  function value(word, shared, themed) {
    return score(word) * (shared ? 1 : UNIQUE) * (themed ? THEME_BONUS : 1);
  }

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
  function check(grid, word, theme) {
    if (!/^[a-z]+$/.test(word)) return 'letters';
    if (word.length < MIN || word.length > MAX) return 'length';
    if (!placeable(grid, word)) return 'grid';
    if (!known(word) && !isThemeWord(theme, word)) return 'word';
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
  function solve(grid, theme) {
    var sup = supply(grid);
    var out = [], seen = {};
    var extra = THEMES[themeOf(theme)].words;
    for (var e = 0; e < extra.length; e++) {
      if (!known(extra[e]) && placeable(grid, extra[e]) && !seen[extra[e]]) {
        seen[extra[e]] = true; out.push(extra[e]);
      }
    }
    for (var L = MIN; L <= MAX; L++) {
      var s = WORDS[L];
      if (!s) continue;
      for (var off = 0; off + L <= s.length; off += L) {
        var w = s.substr(off, L);
        if (!couldFit(w, sup)) continue;
        if (placeable(grid, w) && !seen[w]) { seen[w] = true; out.push(w); }
      }
    }
    out.sort(function (a, b) {
      return score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0);
    });
    return out;
  }

  /**
   * Score a round.
   *
   * Every word pays its finder. A word NOBODY else found pays double, which is
   * where the game is: the safe four-letter word everybody sees is worth having,
   * and the one only you saw is worth twice as much.
   *
   * The order is the running order of the reveal, and it is built to climb:
   * short shared words first (everyone scores, nobody moves), then long shared
   * ones, then the uniques from short to long — so the last word read out is the
   * longest thing one person saw alone, and the biggest single jump on the board
   * is the last one. Sorting by score would give that away in the first second.
   *
   * @param {Object} found  playerId -> [word]
   * @returns {Object} { rows, points }
   */
  function tally(found, theme) {
    var by = {}, ids = Object.keys(found).sort();
    for (var i = 0; i < ids.length; i++) {
      var list = found[ids[i]] || [];
      for (var j = 0; j < list.length; j++) {
        (by[list[j]] || (by[list[j]] = [])).push(ids[i]);
      }
    }

    var rows = Object.keys(by).sort().map(function (w) {
      var who = by[w];
      var shared = who.length > 1;
      var themed = isThemeWord(theme, w);
      return { w: w, pts: score(w), value: value(w, shared, themed),
               by: who, dup: shared, theme: themed };
    });
    rows.sort(function (a, b) {
      if (a.dup !== b.dup) return a.dup ? -1 : 1;        // shared first
      return a.w.length - b.w.length ||                  // then short to long
             (a.w < b.w ? -1 : a.w > b.w ? 1 : 0);
    });

    var points = {};
    for (i = 0; i < ids.length; i++) points[ids[i]] = 0;
    for (i = 0; i < rows.length; i++) {
      for (var k = 0; k < rows[i].by.length; k++) {
        points[rows[i].by[k]] += rows[i].value;
      }
    }
    return { rows: rows, points: points };
  }

  return {
    DICE: DICE, SIZE: SIZE, MIN: MIN, MAX: MAX, UNIQUE: UNIQUE, POINTS: POINTS,
    THEMES: THEMES, THEME_KEYS: THEME_KEYS, THEME_BONUS: THEME_BONUS,
    PALETTE_KEYS: PALETTE_KEYS,
    roll: roll, score: score, value: value, placeable: placeable, known: known,
    check: check, solve: solve, tally: tally,
    isThemeWord: isThemeWord, themeWords: themeWords, themeHits: themeHits, themeOf: themeOf
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SCRAMBLE_RULES;
