/*
 * make-dict.mjs — build SCRAMBLE's word list. AUTHORING ONLY; never shipped code,
 * never run by check.mjs or CI. It exists so `dict.js` is DERIVED rather than a
 * 2MB blob nobody can account for: if you want to know why a word is or isn't
 * accepted, the answer is in here.
 *
 *   node make-dict.mjs            # rewrite dict.js
 *   node make-dict.mjs --stats    # size and coverage, write nothing
 *
 * TWO SOURCES, UNIONED. Being big and permissive is the RIGHT direction for a
 * party game: a weird word slipping through is a funny story, a real word being
 * refused while the whole table watches is a bad night.
 *
 *   1. /usr/share/dict/words — Webster's 1913, the only word list at a known
 *      path on a Mac. Enormous and deeply strange. It has no inflections at all
 *      (`cat` yes, `cats` no, nor `played`, `playing`, `runs`), so this generates
 *      those with ordinary English morphology. That over-generates — `beauted` is
 *      in here somewhere — which is the forgiving direction.
 *
 *   2. The Mac's own spelling dictionary, via harvest-system-words.swift. This is
 *      the one that knows `began`, `epiphany`, `cauldron`, `cilantro`, `funniest`
 *      and `hashtags`. Webster's knows none of them, and neither did the first
 *      version of this file: measured against the system list it was refusing
 *      4,490 words a Mac considers perfectly ordinary. `BEGAN` being rejected in
 *      front of everyone is exactly the failure this game cannot afford.
 *
 * The union is not pruned against the spell checker. It would tidy up the
 * generated junk, and it would also throw away real-but-obscure words that
 * someone will one day find on a grid — and a false refusal costs far more here
 * than an odd word nobody will ever type.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = '/usr/share/dict/words';
const MIN = 3, MAX = 8;         // Boggle's floor; a stated ceiling beats a silent rejection

/* Words Webster's 1913 could not have known. Everything here is common enough that
 * someone WILL play it, and being told "not a word" would be the memorable part. */
const MODERN = `
email emails blog blogs blogger vlog taco tacos burger burgers teenager teenagers
teen teens app apps laptop laptops website websites online offline internet web
download upload upgrade selfie selfies emoji emojis podcast podcasts
wifi modem router inbox outbox spam scan scanner printout login logout
jeep van suv truck minivan scooter skateboard snowboard
pizza pizzas pasta sushi bagel bagels donut donuts muffin muffins waffle waffles
burrito nacho nachos salsa taco guacamole hummus smoothie latte mocha espresso
granola yogurt ketchup mayo brunch snackbar popcorn
tshirt hoodie hoodies sneaker sneakers legging leggings denim
soccer hockey karate yoga pilates jogging workout treadmill
robot robots android drone drones gadget gadgets
movie movies video videos videogame gamer gamers console remote
mom moms dad dads kid kids grandma grandpa babysit babysitter
okay yep nope wow ugh yay oops hey
recycle recycling plastic microwave freezer blender toaster dishwasher
weekend weekends birthday birthdays holiday vacation playdate sleepover
`.trim().split(/\s+/);

const VOWELS = 'aeiou';
const isVowel = (c) => VOWELS.indexOf(c) !== -1;

/** Consonant-vowel-consonant ending that English doubles: stop -> stopped. */
function doubles(w) {
  const n = w.length;
  if (n < 3) return false;
  const a = w[n - 3], b = w[n - 2], c = w[n - 1];
  if ('wxy'.indexOf(c) !== -1) return false;
  return !isVowel(a) && isVowel(b) && !isVowel(c);
}

/** Every inflected form of a base word. Over-generates on purpose. */
function forms(w) {
  const out = [];
  const last = w[w.length - 1], prev = w[w.length - 2] || '';
  const sibilant = /(s|x|z|ch|sh)$/.test(w);
  const consY = last === 'y' && prev && !isVowel(prev);
  const dbl = doubles(w) ? w + last : null;

  // plural / third person
  if (sibilant) out.push(w + 'es');
  else if (consY) out.push(w.slice(0, -1) + 'ies');
  else out.push(w + 's');

  // past tense
  if (last === 'e') out.push(w + 'd');
  else if (consY) out.push(w.slice(0, -1) + 'ied');
  else out.push((dbl || w) + 'ed');

  // gerund
  if (last === 'e' && prev !== 'e' && prev !== 'o' && prev !== 'y') out.push(w.slice(0, -1) + 'ing');
  else out.push((dbl || w) + 'ing');

  // agent / comparative
  if (last === 'e') out.push(w + 'r');
  else if (consY) out.push(w.slice(0, -1) + 'ier');
  else out.push((dbl || w) + 'er');

  return out;
}

/* The system harvest takes a couple of minutes, so it is cached between runs.
 * `--refresh` throws the cache away; a machine with no Swift or no spell checker
 * still builds, just without the modern half, and says so. */
function systemWords() {
  const cacheDir = join(tmpdir(), 'scramble-dict');
  const cache = join(cacheDir, 'system-words.txt');
  if (!process.argv.includes('--refresh') && existsSync(cache)) {
    const words = readFileSync(cache, 'utf8').trim().split('\n').filter(Boolean);
    console.log(`  system dictionary: ${words.length} words (cached — --refresh to redo)`);
    return words;
  }
  mkdirSync(cacheDir, { recursive: true });
  const bin = join(cacheDir, 'harvest');
  try {
    console.log('  asking the system spelling dictionary (about two minutes)…');
    execFileSync('swiftc', ['-O', join(HERE, 'harvest-system-words.swift'), '-o', bin],
                 { stdio: ['ignore', 'ignore', 'inherit'] });
    const out = execFileSync(bin, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
    writeFileSync(cache, out);
    return out.toString().trim().split('\n').filter(Boolean);
  } catch (e) {
    console.log('  no system dictionary on this machine — Webster\'s only.');
    return [];
  }
}

if (!existsSync(SOURCE)) {
  console.error(`No ${SOURCE} on this machine. dict.js is committed, so you only need\n` +
                `this script to CHANGE the word list — install a words file first.`);
  process.exit(1);
}

const raw = readFileSync(SOURCE, 'utf8').split('\n');
const words = new Set();
const keep = (w) => { if (w.length >= MIN && w.length <= MAX) words.add(w); };

const bases = [];
for (const line of raw) {
  const w = line.trim();
  /* Case-SENSITIVE, which is the whole point: Webster's lists proper nouns too, and
   * lowercasing first quietly let them in. `Micah` became `micah`, which the doubling
   * rule below turned into `micahher` — an eight-letter word worth 11 points that
   * nobody has ever heard of, offered up by the solver as the grid's best find. */
  if (!/^[a-z]+$/.test(w)) continue;
  if (w.length > MAX) continue;
  bases.push(w);
  keep(w);
}
for (const w of MODERN) { bases.push(w); keep(w); }
for (const w of bases) for (const f of forms(w)) keep(f);

/* The system's words go in whole. They are already inflected (`funniest`,
 * `hashtags`, `began`) so they are NOT run through forms() — it would only
 * manufacture `beganed` and friends. */
const fromSystem = systemWords();
let added = 0;
for (const w of fromSystem) if (!words.has(w)) { keep(w); added++; }
if (fromSystem.length) console.log(`  system dictionary added ${added} words Webster's had never heard of`);

const sorted = [...words].sort();
const byLen = {};
for (const w of sorted) (byLen[w.length] || (byLen[w.length] = [])).push(w);

const stats = Object.keys(byLen).sort()
  .map(L => `${L}:${byLen[L].length}`).join('  ');
const bytes = sorted.reduce((a, w) => a + w.length, 0);
console.log(`${sorted.length} words, ${(bytes / 1048576).toFixed(2)}MB of letters`);
console.log(`  ${stats}`);

if (process.argv.includes('--stats')) process.exit(0);

/* The shipped shape: one concatenated string per word length, no separators.
 * Fixed-width means `has()` is a binary search with substr and index arithmetic —
 * no splitting a megabyte into 300k JS strings on a phone at round start. */
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
 * over s.substr(mid * L, L) — see dictOf() in game.js.
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
