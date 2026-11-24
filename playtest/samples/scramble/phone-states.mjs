/*
 * Phone screens a played game reaches only on a good day, drawn and held to the same
 * layout rules as every played screen (see harness/phone.mjs).
 *
 * A strong player finds far more words than a bot does in a test round, and nothing
 * on a phone may scroll — so the list has to keep its newest words in view and fold
 * the rest away. This is that round.
 */
const STATE = {"t": "state", "s": {"phase": "round", "round": 0, "rounds": 3, "names": {"p0": "Ava", "p1": "Ben", "p2": "Cal"}, "emojis": {"p0": "\ud83e\udd8a", "p1": "\ud83d\udc19", "p2": "\ud83d\udc38"}, "seats": ["p0", "p1", "p2"], "counts": {"p0": 3, "p1": 3, "p2": 2}, "done": {"p0": false, "p1": false, "p2": false}, "grid": ["l", "i", "c", "s", "e", "k", "o", "y", "s", "g", "o", "c", "e", "n", "a", "t"], "possible": 216, "theme": "christmas", "themeOnGrid": 10, "themeName": "Christmas", "themeEmoji": "\ud83c\udf84", "palette": {"glow": "#1d4d33", "bg1": "#10331f", "bg2": "#0c2a19", "panel": "#19402a", "line": "#2b6340", "text": "#f2f8ee", "muted": "#9dc0a6", "accent": "#f6c854", "accentLit": "#fff0bd", "good": "#76dd9a", "bad": "#ff6f6f", "tile": "#f7efdd", "tileInk": "#10331f", "spark": "#ff6f6f"}, "themeBonus": 2, "themeChoices": null, "secondsLeft": 90, "totals": null, "rows": null, "points": null, "revealed": 0, "totalRows": 0, "unique": 2}};

export default [
  {
    name: 'eighteen words found',
    as: 'p1', players: 3,
    messages: [STATE, {"t": "mine", "words": ["angel", "cookie", "agones", "glossy", "cogs", "lies", "silk", "coils", "logos", "yogis", "goose", "loose", "slick", "sole", "cell", "kilos", "goes", "lice"], "ack": null}]
  }
];
