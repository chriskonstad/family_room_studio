/*
 * rules.js — the poker, with no game around it.
 *
 * Everything here is pure: a deck, a hand evaluator, and the pot arithmetic. No
 * Table, no DOM, no timers. That is what lets the same code be the authority in
 * four places that must never disagree:
 *
 *   game.js        the host, deciding who actually won the money
 *   index.html     your phone, telling YOU what you're holding
 *   invariants.mjs the fuzzer, checking the chips add up
 *   node           its own test suite (`node rules.test.mjs`)
 *
 * A second implementation of "what beats what" is the worst bug this game could
 * ship: it would agree with itself for a thousand hands and then hand the pot to
 * the wrong person at a real table, which is the one moment nobody forgets.
 *
 * CARDS ARE NUMBERS. A card is `{ r: 2..14, s: 0..3 }` — rank 11..14 are J/Q/K/A,
 * suit 0..3 are spades/hearts/diamonds/clubs. Not strings, for two reasons: it
 * keeps the wire small, and a hole card on the wire carries no readable text at
 * all, so a private deal cannot be rendered into something meaningful by accident.
 * Display mapping lives with whoever is drawing.
 */
var HOLDEM_RULES = (function () {
  'use strict';

  var RANK_NAME = { 2:'Two', 3:'Three', 4:'Four', 5:'Five', 6:'Six', 7:'Seven', 8:'Eight',
                    9:'Nine', 10:'Ten', 11:'Jack', 12:'Queen', 13:'King', 14:'Ace' };
  var RANK_PLURAL = { 2:'Twos', 3:'Threes', 4:'Fours', 5:'Fives', 6:'Sixes', 7:'Sevens',
                      8:'Eights', 9:'Nines', 10:'Tens', 11:'Jacks', 12:'Queens',
                      13:'Kings', 14:'Aces' };
  var RANK_SHORT = { 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10',
                     11:'J', 12:'Q', 13:'K', 14:'A' };

  /* Categories, worst to best. The index IS the comparison. */
  var CAT = { HIGH:0, PAIR:1, TWO_PAIR:2, TRIPS:3, STRAIGHT:4, FLUSH:5,
              FULL_HOUSE:6, QUADS:7, STRAIGHT_FLUSH:8 };
  var CAT_NAME = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
                  'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  /** A fresh 52. Shuffle it with FR.rng so the deal replays. */
  function deck() {
    var out = [];
    for (var s = 0; s < 4; s++) for (var r = 2; r <= 14; r++) out.push({ r: r, s: s });
    return out;
  }

  function rankShort(c) { return RANK_SHORT[c.r] || '?'; }

  /* ------------------------------------------------------------ evaluate --- */

  /**
   * Score exactly five cards.
   * @returns {{cat:number, tb:Array<number>}} `tb` is a fixed-length tiebreak
   *   list for the category, so two hands in the same category always compare
   *   element by element with no missing entries.
   */
  function evaluate5(cards) {
    var ranks = cards.map(function (c) { return c.r; }).sort(function (a, b) { return b - a; });
    var suit = cards[0].s;
    var flush = cards.every(function (c) { return c.s === suit; });

    // Distinct ranks, high first, with the ace repeated as a 1 so A-2-3-4-5 is
    // found by the same scan as every other straight rather than as a special case
    // bolted on afterwards (which is where the wheel is usually got wrong).
    var uniq = [];
    for (var i = 0; i < ranks.length; i++) if (uniq.indexOf(ranks[i]) === -1) uniq.push(ranks[i]);
    var scan = uniq.slice();
    if (scan[0] === 14) scan.push(1);
    var straightHigh = 0;
    if (scan.length >= 5) {
      for (var j = 0; j + 4 < scan.length; j++) {
        if (scan[j] - scan[j + 4] === 4) { straightHigh = scan[j]; break; }
      }
    }

    if (flush && straightHigh) return { cat: CAT.STRAIGHT_FLUSH, tb: [straightHigh] };

    // Rank multiplicities, sorted by count then by rank — so [count, rank] pairs
    // read straight off as quads/trips/pairs without further sorting.
    var counts = {};
    ranks.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
    var groups = Object.keys(counts).map(function (r) { return [counts[r], Number(r)]; })
      .sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });

    if (groups[0][0] === 4) return { cat: CAT.QUADS, tb: [groups[0][1], groups[1][1]] };
    if (groups[0][0] === 3 && groups[1][0] === 2) {
      return { cat: CAT.FULL_HOUSE, tb: [groups[0][1], groups[1][1]] };
    }
    if (flush) return { cat: CAT.FLUSH, tb: ranks.slice() };
    if (straightHigh) return { cat: CAT.STRAIGHT, tb: [straightHigh] };
    if (groups[0][0] === 3) {
      return { cat: CAT.TRIPS, tb: [groups[0][1], groups[1][1], groups[2][1]] };
    }
    if (groups[0][0] === 2 && groups[1][0] === 2) {
      return { cat: CAT.TWO_PAIR, tb: [groups[0][1], groups[1][1], groups[2][1]] };
    }
    if (groups[0][0] === 2) {
      return { cat: CAT.PAIR, tb: [groups[0][1], groups[1][1], groups[2][1], groups[3][1]] };
    }
    return { cat: CAT.HIGH, tb: ranks.slice() };
  }

  /** Compare two scores. Positive when `a` wins, 0 for a genuine tie. */
  function compare(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    for (var i = 0; i < a.tb.length; i++) {
      if (a.tb[i] !== b.tb[i]) return a.tb[i] - b.tb[i];
    }
    return 0;
  }

  /**
   * The best five of five, six or seven cards.
   *
   * Brute force over all 21 five-card subsets, deliberately. The clever way is to
   * pick the five cards category by category, and the clever way is where the bugs
   * live — "the kicker for a full house" and "which flush cards" are each a small
   * decision that is easy to get subtly wrong and nearly impossible to spot. A
   * showdown happens a handful of times a hand, so there is nothing to optimise.
   *
   * @returns {{cat, tb, cards, name}} `cards` are the five that made the hand, so
   *   a screen can show the table exactly what won.
   */
  function evaluate(cards) {
    if (!cards || cards.length < 5) throw new Error('evaluate needs at least five cards');
    var best = null;
    var n = cards.length;
    for (var a = 0; a < n - 4; a++)
      for (var b = a + 1; b < n - 3; b++)
        for (var c = b + 1; c < n - 2; c++)
          for (var d = c + 1; d < n - 1; d++)
            for (var e = d + 1; e < n; e++) {
              var five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              var score = evaluate5(five);
              if (!best || compare(score, best) > 0) { best = score; best.cards = five; }
            }
    best.name = name(best);
    return best;
  }

  /** How a person would say it out loud. */
  function name(score) {
    var t = score.tb;
    switch (score.cat) {
      case CAT.STRAIGHT_FLUSH:
        return t[0] === 14 ? 'Royal flush' : ('Straight flush, ' + RANK_NAME[t[0]] + ' high');
      case CAT.QUADS:       return 'Four ' + RANK_PLURAL[t[0]];
      case CAT.FULL_HOUSE:  return 'Full house, ' + RANK_PLURAL[t[0]] + ' over ' + RANK_PLURAL[t[1]];
      case CAT.FLUSH:       return 'Flush, ' + RANK_NAME[t[0]] + ' high';
      case CAT.STRAIGHT:    return 'Straight, ' + RANK_NAME[t[0] === 5 ? 5 : t[0]] + ' high';
      case CAT.TRIPS:       return 'Three ' + RANK_PLURAL[t[0]];
      case CAT.TWO_PAIR:    return 'Two pair, ' + RANK_PLURAL[t[0]] + ' and ' + RANK_PLURAL[t[1]];
      case CAT.PAIR:        return 'Pair of ' + RANK_PLURAL[t[0]];
      default:              return RANK_NAME[t[0]] + ' high';
    }
  }

  /**
   * What to tell a player on their own phone, with however many cards exist.
   *
   * This is the one piece of poker that is genuinely PRIVATE information rather
   * than merely hidden: the board is on the television, but what the board means
   * depends on the two cards only you can see. Preflop there is no five-card hand
   * to score, so say the true thing a player would say themselves.
   */
  function describe(hole, board) {
    var cards = (hole || []).concat(board || []);
    if (cards.length >= 5) return evaluate(cards).name;
    if (!hole || hole.length < 2) return '';
    if (hole[0].r === hole[1].r) return 'Pair of ' + RANK_PLURAL[hole[0].r];
    var hi = hole[0].r > hole[1].r ? hole[0] : hole[1];
    var lo = hole[0].r > hole[1].r ? hole[1] : hole[0];
    var suited = hole[0].s === hole[1].s;
    return RANK_NAME[hi.r] + '-' + RANK_NAME[lo.r] + (suited ? ' suited' : '');
  }

  /* ---------------------------------------------------------------- pots --- */

  /**
   * Split what everyone has committed into a main pot and any side pots.
   *
   * This is the arithmetic that family poker gets wrong. When somebody is all-in
   * for less than the others, they can only win the part of the pot they actually
   * matched — the rest is a side pot the bigger stacks play for. Paying the whole
   * pot to a short all-in is a real money bug, and it is also the single most
   * likely thing to happen at a table of five with uneven stacks.
   *
   * Layer by layer: each distinct commitment level is a layer, every player
   * contributes what they put into that layer (folded players included — their
   * chips are in the pot and they simply cannot win it), and the layer is played
   * for by the players still in who reached that level.
   *
   * @param {Array<{id, committed, folded}>} players
   * @returns {Array<{amount:number, eligible:Array<string>}>}
   */
  function buildPots(players) {
    var levels = [];
    players.forEach(function (p) {
      var c = p.committed || 0;
      if (c > 0 && levels.indexOf(c) === -1) levels.push(c);
    });
    levels.sort(function (a, b) { return a - b; });

    var pots = [];
    var prev = 0;
    levels.forEach(function (level) {
      var amount = 0;
      players.forEach(function (p) {
        var c = p.committed || 0;
        amount += Math.max(0, Math.min(c, level) - Math.min(c, prev));
      });
      var eligible = players.filter(function (p) {
        return !p.folded && (p.committed || 0) >= level;
      }).map(function (p) { return p.id; });
      if (amount > 0) pots.push({ amount: amount, eligible: eligible });
      prev = level;
    });

    // Consecutive layers with the same contenders are one pot as far as anyone in
    // the room is concerned, and showing "main pot 40, side pot 0" is just noise.
    var merged = [];
    pots.forEach(function (p) {
      var last = merged[merged.length - 1];
      if (last && last.eligible.length === p.eligible.length &&
          last.eligible.every(function (id, i) { return p.eligible[i] === id; })) {
        last.amount += p.amount;
      } else merged.push({ amount: p.amount, eligible: p.eligible.slice() });
    });
    return merged;
  }

  /**
   * Hand each pot to whoever wins it.
   *
   * @param {Array} pots from buildPots
   * @param {Object} scores id -> evaluate() result, for everyone still in
   * @param {Array<string>} seatOrder ids in betting order from the dealer's left;
   *        an indivisible chip goes to the first of them, which is the rule a real
   *        table uses and the only way splitting is deterministic.
   * @returns {{won:Object, detail:Array}} won is id -> chips
   */
  function awardPots(pots, scores, seatOrder) {
    var won = {}, detail = [];
    pots.forEach(function (pot, idx) {
      var live = pot.eligible.filter(function (id) { return scores[id]; });
      if (!live.length) return;
      var best = null;
      live.forEach(function (id) {
        if (!best || compare(scores[id], scores[best]) > 0) best = id;
      });
      var winners = live.filter(function (id) { return compare(scores[id], scores[best]) === 0; });
      // Order the winners by seat so the odd chip is handed out predictably.
      winners.sort(function (a, b) { return seatOrder.indexOf(a) - seatOrder.indexOf(b); });
      var share = Math.floor(pot.amount / winners.length);
      var odd = pot.amount - share * winners.length;
      winners.forEach(function (id, i) {
        var got = share + (i < odd ? 1 : 0);
        won[id] = (won[id] || 0) + got;
      });
      detail.push({ pot: idx, amount: pot.amount, winners: winners.slice(),
                    name: scores[winners[0]].name });
    });
    return { won: won, detail: detail };
  }

  return {
    CAT: CAT, CAT_NAME: CAT_NAME,
    RANK_NAME: RANK_NAME, RANK_PLURAL: RANK_PLURAL, RANK_SHORT: RANK_SHORT,
    deck: deck, rankShort: rankShort,
    evaluate5: evaluate5, evaluate: evaluate, compare: compare, name: name,
    describe: describe, buildPots: buildPots, awardPots: awardPots
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HOLDEM_RULES;
