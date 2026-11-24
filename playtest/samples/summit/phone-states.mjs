/*
 * Phone screens a played game reaches only now and then, drawn and held to the same
 * layout rules as every played screen (see harness/phone.mjs).
 *
 * A hand that is all one route is legal and happens: eight cards in one column is
 * taller than an iPhone SE has room for, and nothing on a phone may scroll. The
 * column has to fan.
 */
const STATE = {"t": "state", "s": {"phase": "playing", "round": 1, "banner": "Round 1 \u2014 Ava starts", "turn": "p0", "sub": "play", "deckCount": 44, "lastPlay": null, "totals": {"p0": 0, "p1": 0}, "lastRound": null, "names": {"p0": "Ava", "p1": "Ben"}, "emojis": {"p0": "\ud83e\udd8a", "p1": "\ud83d\udc19"}, "order": ["p0", "p1"], "routes": {"p0": {"glacier": [], "volcano": [], "jungle": [], "desert": [], "reef": []}, "p1": {"glacier": [], "volcano": [], "jungle": [], "desert": [], "reef": []}}, "discards": {"glacier": {"top": null, "count": 0}, "volcano": {"top": null, "count": 0}, "jungle": {"top": null, "count": 0}, "desert": {"top": null, "count": 0}, "reef": {"top": null, "count": 0}}, "blocked": null, "handCounts": {"p0": 8, "p1": 8}}};

export default [
  {
    name: 'eight cards, all one route',
    as: 'p1', players: 2,
    messages: [STATE, {"t": "hand", "hand": [{"c": "reef", "v": 0}, {"c": "reef", "v": 0}, {"c": "reef", "v": 2}, {"c": "reef", "v": 3}, {"c": "reef", "v": 5}, {"c": "reef", "v": 7}, {"c": "reef", "v": 9}, {"c": "reef", "v": 10}]}]
  }
];
