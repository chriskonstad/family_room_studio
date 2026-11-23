/*
 * make-dict.mjs — build SCRAMBLE's word list. AUTHORING ONLY; never shipped code,
 * never run by check.mjs or CI. It exists so `dict.js` is DERIVED rather than a
 * blob nobody can account for: if you want to know why a word is or is not
 * accepted, the answer is in here.
 *
 *   node make-dict.mjs                     # fetch ENABLE and rewrite dict.js
 *   node make-dict.mjs --source enable1.txt   # from a local copy, offline
 *   node make-dict.mjs --stats             # size and coverage, write nothing
 *
 * ONE SOURCE, AND WHY IT IS THIS ONE
 *
 * This used to union Webster's 1913 (`/usr/share/dict/words`) with the Mac's
 * spelling dictionary, and GENERATE inflections with hand-written English
 * morphology because Webster's has none. That over-generated, deliberately, on
 * the theory that being permissive is the forgiving direction for a party game.
 *
 * It isn't. Measured against a real word-game lexicon, 118,465 of the 186,080
 * words it shipped were not words anyone would accept — `aam`, `abb`, `abu`,
 * `ady`, `aed`, `aer`, `beauted`. Two thirds of the dictionary was noise. A
 * false ACCEPT is not harmless the way a false reject is loud: it quietly makes
 * the game pointless, because the winning move becomes typing plausible letter
 * soup at the grid, and anyone who plays actual English loses to it.
 *
 * So: ENABLE — the Enhanced North American Benchmark Lexicon, the public-domain
 * word-game list that Words With Friends uses, and the standard open substitute
 * for the tournament lists. 172k words, inflections included, nothing generated.
 *
 * WHY NOT THE ACTUAL SCRABBLE DICTIONARY. The official lists — OSPD, TWL/NWL
 * (Merriam-Webster and Hasbro) and Collins — are copyrighted. Shipping one
 * inside an App Store game needs a licence, and a repository hosting a copy
 * does not grant one. ENABLE is a superset of OSPD in spirit and free to
 * redistribute, so nothing a player would actually type is lost. If the real
 * tournament list is ever wanted, licence it and point `--source` at it: that
 * is the only line in this file that would change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 3, MAX = 8;        // Boggle's floor; a stated ceiling beats a silent rejection
const ENABLE_URL = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt';

/*
 * Words ENABLE is simply too old to know — it was assembled in 1997.
 *
 * Every one of these is common enough that somebody WILL play it and being told
 * "not a word" would be the memorable part of the evening. This list is short,
 * hand-checked and deliberate, which is the opposite of how the old dictionary
 * got big: nothing here is generated, and nothing is here because a rule
 * produced it.
 *
 * Deliberately NOT here: acronyms (`suv`), things that are two words or
 * hyphenated (`tshirt`, `snackbar`), and anything I could not say with a
 * straight face to somebody who had just lost a point to it.
 */
const MODERN = `
email emails blog blogs blogger app apps website websites
online offline internet selfie selfies emoji emojis podcast podcasts
wifi inbox spam login logout babysit pilates
texted texting hashtag hashtags
`.trim().split(/\s+/);

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
};

async function source() {
  const local = arg('source');
  if (local) {
    console.log(`reading ${local}`);
    return readFileSync(local, 'utf8');
  }
  console.log(`fetching ${ENABLE_URL}`);
  const res = await fetch(ENABLE_URL);
  if (!res.ok) throw new Error(`could not fetch ENABLE: HTTP ${res.status}`);
  return res.text();
}

const raw = await source();
const words = new Set();
let seen = 0, tooShort = 0, tooLong = 0, notLetters = 0;

for (const line of raw.split('\n')) {
  const w = line.trim().toLowerCase();
  if (!w) continue;
  seen++;
  if (!/^[a-z]+$/.test(w)) { notLetters++; continue; }
  if (w.length < MIN) { tooShort++; continue; }
  if (w.length > MAX) { tooLong++; continue; }
  words.add(w);
}
const fromLexicon = words.size;

let added = 0;
for (const w of MODERN) {
  if (!/^[a-z]+$/.test(w) || w.length < MIN || w.length > MAX) {
    throw new Error(`MODERN word "${w}" is outside ${MIN}-${MAX} letters`);
  }
  if (!words.has(w)) { words.add(w); added++; }
}

console.log(`  lexicon: ${seen} entries -> ${fromLexicon} at ${MIN}-${MAX} letters`);
console.log(`           (${tooShort} too short, ${tooLong} too long, ${notLetters} not plain letters)`);
console.log(`  modern:  ${added} added of ${MODERN.length} listed (the rest ENABLE already knew)`);

const sorted = [...words].sort();
const byLen = {};
for (const w of sorted) (byLen[w.length] || (byLen[w.length] = [])).push(w);

const stats = Object.keys(byLen).sort().map(L => `${L}:${byLen[L].length}`).join('  ');
const bytes = sorted.reduce((a, w) => a + w.length, 0);
console.log(`${sorted.length} words, ${(bytes / 1048576).toFixed(2)}MB of letters`);
console.log(`  ${stats}`);

if (process.argv.includes('--stats')) process.exit(0);

/* The shipped shape: one concatenated string per word length, no separators.
 * Fixed-width means `known()` is a binary search with substr and index
 * arithmetic — no splitting a megabyte into 80k JS strings on a phone at the
 * start of every round. */
const chunks = [];
for (const L of Object.keys(byLen).map(Number).sort((a, b) => a - b)) {
  const all = byLen[L];
  const lines = [];
  for (let i = 0; i < all.length; i += 40) lines.push(JSON.stringify(all.slice(i, i + 40).join('')));
  chunks.push(`  ${L}: [\n    ${lines.join(',\n    ')}\n  ].join('')`);
}

const out = `/* GENERATED by make-dict.mjs — do not edit by hand.
 *
 * SCRAMBLE's word list, as one sorted, separator-free string per word length.
 * Every word of length L sits at offset i*L, so membership is a binary search
 * over s.substr(mid * L, L) — see known() in rules.js.
 *
 * SOURCE: ENABLE (Enhanced North American Benchmark Lexicon), the public-domain
 * word-game list Words With Friends is built on, filtered to ${MIN}-${MAX} letters,
 * plus ${added} modern words ENABLE predates (see MODERN in make-dict.mjs).
 * Nothing here is generated from a morphology rule — that is what filled the
 * previous version with 118,465 words that were not words.
 *
 * ${sorted.length} words (${stats}).
 */
var SCRAMBLE_WORDS = {
${chunks.join(',\n')}
};
if (typeof module !== 'undefined' && module.exports) module.exports = SCRAMBLE_WORDS;
`;

writeFileSync(join(HERE, 'dict.js'), out);
console.log(`wrote dict.js  ${(out.length / 1048576).toFixed(2)}MB`);
