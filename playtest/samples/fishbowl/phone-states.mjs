/*
 * Phone screens a played game doesn't reach, drawn and held to the same layout rules as
 * every played screen (see harness/phone.mjs).
 *
 * FISHBOWL seats TEN, and the played layouts stop at eight. The entry screen is the one
 * that grows with the table — everybody still writing is named on it — and a giver's
 * card is the one that grows with what people type (forty characters is the cap).
 */
const NAMES = ['Alexandra', 'Christopher', 'Emmanuelle', 'Bartholomew', 'Georgina',
               'Maximilian', 'Anastasia', 'Hal', 'Josephine', 'Sebastian'];
const EMOJIS = ['🦊', '🐙', '🐸', '🦉', '🐝', '🦄', '🐳', '🦁', '🦩', '🐢'];
const ids = NAMES.map((_, i) => 'p' + i);
const each = (f) => Object.fromEntries(ids.map((id, i) => [id, f(id, i)]));

const base = {
  round: 0, roundName: 'Describe it!', roundHint: 'Say anything except the words on the card.',
  names: each((id, i) => NAMES[i]), emojis: each((id, i) => EMOJIS[i]),
  teams: [{ id: 't1', name: 'Red', color: '#e0574a', score: 0 }, { id: 't2', name: 'Blue', color: '#4a86e0', score: 0 }],
  now: 0, turnEnds: null, secondsLeft: null
};
const entry = (counts, dones) => ({ t: 'state', s: { ...base, phase: 'entry',
  totalPhrases: Object.values(counts).reduce((a, b) => a + b, 0), counts, dones,
  writing: ids.filter(id => !dones[id]), activeTeamId: null, giver: null, bowlLeft: 0, canSkip: false } });

export default [
  {
    name: 'ten at the table, nobody done writing',
    as: 'p1', players: 8,
    messages: [entry(each(() => 0), each(() => false))]
  },
  {
    name: 'ten at the table, done, the rest still writing',
    as: 'p1', players: 8,
    messages: [entry(each((id) => id === 'p1' ? 6 : 2), each((id) => id === 'p1'))]
  },
  {
    name: 'the giver, with a forty-character phrase',
    as: 'p1', players: 8,
    messages: [
      { t: 'state', s: { ...base, phase: 'turn', totalPhrases: 40, counts: each(() => 4), dones: each(() => true),
        writing: [], activeTeamId: 't2', giver: 'p1', bowlLeft: 40, now: 0, turnEnds: 60000, secondsLeft: 60, canSkip: true } },
      { t: 'phrase', phrase: 'Supercalifragilisticexpialidocious song', secondsLeft: 60, turnEnds: 60000 }
    ]
  }
];
