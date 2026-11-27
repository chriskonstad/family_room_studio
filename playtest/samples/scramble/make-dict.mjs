/*
 * make-dict.mjs — build SCRAMBLE's word list. AUTHORING ONLY; never shipped code,
 * never run by check.mjs or CI. It exists so `dict.js` is DERIVED rather than a
 * blob nobody can account for: if you want to know why a word is or is not
 * accepted, the answer is in here.
 *
 *   node make-dict.mjs                     # fetch both lists and rewrite dict.js
 *   node make-dict.mjs --enable enable1.txt --scowl scowl-2020.12.07.tar.gz   # offline
 *   node make-dict.mjs --stats             # size and coverage, write nothing
 *
 * TWO LISTS, AND A WORD HAS TO BE IN BOTH
 *
 * 1.4 shipped ENABLE alone. ENABLE is a WORD-GAME list, and word-game lists are
 * built to be permissive: they exist so a Scrabble expert's `aas`, `eme`, `ait`,
 * `oes`, `kues` and `xu` are legal. At a family table that is the same failure
 * as the old generated list, only tidier — somebody drags across letter soup,
 * it scores, and the person who played real English loses to it. A playtest
 * found exactly that. (The official Scrabble lists, TWL and Collins, are LARGER
 * than ENABLE in this respect, not smaller, so licensing one would make it
 * worse.)
 *
 * So the second list is a COMMONNESS filter: SCOWL (Spell Checker Oriented
 * Word Lists, Kevin Atkinson), the list behind the aspell/hunspell English
 * dictionaries, graded into size levels by how common a word is. Level 55 is
 * one notch past the size the project calls "small": every everyday word and
 * its inflections, none of the crossword-only ones. Free to redistribute with
 * the notice it asks for (reproduced in dict.js).
 *
 *   ENABLE   says it is a real, uncapitalised, unabbreviated word a word game takes;
 *   SCOWL 55 says ordinary people know it.
 *
 * Neither alone is right. SCOWL alone takes `etc`-style abbreviations and
 * British-only oddities ENABLE refuses; ENABLE alone is what the playtest
 * caught. SCOWL_LEVEL is the knob: raise it and more rare words get in.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 3, MAX = 8;        // Boggle's floor; a stated ceiling beats a silent rejection
const SCOWL_LEVEL = 55;
const ENABLE_URL = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt';
const SCOWL_URL = 'https://downloads.sourceforge.net/project/wordlist/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz';
/* Which of SCOWL's word files count. Every spelling region, and variant level 1
 * (`grey`, `sabre`, `cheque` — spellings real people use), but not the rarer
 * variants, the abbreviations, the proper nouns or the hacker jargon. */
const SCOWL_KINDS = new Set([
  'english-words', 'american-words', 'british-words', 'british_z-words',
  'canadian-words', 'australian-words', 'variant_1-words'
]);

/*
 * Words neither list is new enough to know — ENABLE was assembled in 1997.
 *
 * Every one of these is common enough that somebody WILL play it and being told
 * "not a word" would be the memorable part of the evening. This list is short,
 * hand-checked and deliberate: nothing here is generated, and nothing is here
 * because a rule produced it.
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

async function load(flag, url) {
  const local = arg(flag);
  if (local) { console.log(`reading ${local}`); return readFileSync(local); }
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* Just enough tar to read SCOWL's `final/<kind>.<level>` files: 512-byte
 * headers, name at 0, octal size at 124, data padded to 512. No dependency. */
function scowlWords(gz) {
  const tar = gunzipSync(gz), out = new Set();
  let files = 0;
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar.toString('latin1', at, at + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('latin1', at + 124, at + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const body = at + 512;
    const m = /\/final\/([a-z_0-9-]+)\.(\d+)$/.exec(name);
    if (m && SCOWL_KINDS.has(m[1]) && Number(m[2]) <= SCOWL_LEVEL) {
      files++;
      for (const line of tar.toString('latin1', body, body + size).split('\n')) {
        const w = line.trim();
        if (/^[a-z]+$/.test(w)) out.add(w);   // lower-case only: no names, no acronyms
      }
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  if (!files) throw new Error('no SCOWL word files found in the tarball');
  console.log(`  scowl:   ${out.size} words from ${files} files at level <= ${SCOWL_LEVEL}`);
  return out;
}

const raw = (await load('enable', ENABLE_URL)).toString('utf8');
const common = scowlWords(await load('scowl', SCOWL_URL));
const words = new Set();
let seen = 0, tooShort = 0, tooLong = 0, notLetters = 0, rare = 0;

for (const line of raw.split('\n')) {
  const w = line.trim().toLowerCase();
  if (!w) continue;
  seen++;
  if (!/^[a-z]+$/.test(w)) { notLetters++; continue; }
  if (w.length < MIN) { tooShort++; continue; }
  if (w.length > MAX) { tooLong++; continue; }
  if (!common.has(w)) { rare++; continue; }
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
console.log(`           (${tooShort} too short, ${tooLong} too long, ${notLetters} not plain letters, ${rare} not common enough)`);
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
 * SOURCE: every ${MIN}-${MAX} letter word in BOTH ENABLE (the public-domain
 * word-game lexicon) and SCOWL at size ${SCOWL_LEVEL} (common English), plus
 * ${added} modern words both predate (see MODERN in make-dict.mjs). ENABLE alone
 * let letter soup like \`aas\` and \`eme\` score; the second list is why it doesn't.
 *
 * SCOWL is Copyright 2000-2018 by Kevin Atkinson. Permission to use, copy,
 * modify, distribute and sell these word lists, the associated scripts, the
 * output created from the scripts, and its documentation for any purpose is
 * hereby granted without fee, provided that the above copyright notice appears
 * in all copies and that both that copyright notice and this permission notice
 * appear in supporting documentation. Kevin Atkinson makes no representations
 * about the suitability of this array for any purpose. It is provided "as is"
 * without express or implied warranty.
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
