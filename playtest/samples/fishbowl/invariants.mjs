/*
 * FISHBOWL's own rules, checked by the fuzzer after every turn and at game end.
 * The load-bearing one is phrase accounting: every point is one phrase pulled
 * from the bowl, and the bowl refills with the SAME phrases each round — so
 * scores, bowl size and the phrase count must always reconcile.
 */
export default function fishbowlInvariants({ table, players, done, result }) {
  const seenScores = table._fbScores || (table._fbScores = {});
  for (const id of players) {
    const s = table.view(id)?.s;
    if (!s || !s.teams) continue;

    if (s.round < 0 || s.round > 2) return `round ${s.round} is outside the game's three rounds`;
    if (s.bowlLeft < 0 || s.bowlLeft > s.totalPhrases) {
      return `${s.bowlLeft} phrases left in a bowl of ${s.totalPhrases}`;
    }
    if (s.secondsLeft != null && (s.secondsLeft < 0 || s.secondsLeft > 60)) {
      return `turn clock shows ${s.secondsLeft}s`;
    }
    // Everything in the bowl was written by someone at this table.
    const written = Object.values(s.counts).reduce((a, b) => a + b, 0);
    if (written !== s.totalPhrases) {
      return `players wrote ${written} phrases but the bowl holds ${s.totalPhrases}`;
    }
    if (Object.values(s.counts).some(n => n < 0 || n > 25)) {
      return `a player's phrase count is outside 0..25`;
    }

    // A team's score is phrases guessed; phrases guessed can't exceed the bowl's
    // capacity across the rounds played so far, and scores never go down.
    const maxGuessable = s.totalPhrases * (s.round + 1);
    const mine = seenScores[id] || (seenScores[id] = {});
    let sum = 0;
    for (const t of s.teams) {
      if (t.score < 0) return `team ${t.id} has a negative score`;
      if (mine[t.id] !== undefined && t.score < mine[t.id]) {
        return `team ${t.id}'s score fell from ${mine[t.id]} to ${t.score}`;
      }
      mine[t.id] = t.score;
      sum += t.score;
    }
    if (s.phase !== 'entry' && sum > maxGuessable) {
      return `teams scored ${sum} but only ${maxGuessable} guesses were possible by round ${s.round + 1}`;
    }

    if ((s.phase === 'turnReady' || s.phase === 'turn')) {
      if (!s.giver || !s.names[s.giver]) return `the giver "${s.giver}" isn't at this table`;
      if (!s.teams.some(t => t.id === s.activeTeamId)) {
        return `active team "${s.activeTeamId}" doesn't exist`;
      }
    }
  }
  // PRIVACY, checked on the wire rather than trusted.
  //
  // The phrase being acted out is the one secret in this game: it goes to the
  // giver's phone with `sendTo` and nowhere else. The shared screen is fed the
  // broadcast stream, so the ONE way a phrase could reach a TV is the host
  // putting it in a broadcast — which is exactly what this looks for. It is
  // checked here rather than in the screen harness because it is true whether or
  // not anybody has a screen: a broadcast phrase is visible on every phone too.
  const priv = table._fbPrivate || (table._fbPrivate = { phrases: new Set(), seen: 0 });
  for (const e of table.wire('sendTo')) {
    if (e.payload && typeof e.payload.phrase === 'string') priv.phrases.add(e.payload.phrase);
  }
  const broadcasts = table.wire('broadcast');
  for (; priv.seen < broadcasts.length; priv.seen++) {
    const text = JSON.stringify(broadcasts[priv.seen].payload);
    for (const phrase of priv.phrases) {
      if (phrase.length > 2 && text.includes(phrase)) {
        return `the phrase "${phrase}" was broadcast to the whole table`;
      }
    }
  }

  if (done && result && Array.isArray(result.standings) && result.standings.length) {
    const top = Math.max(...result.standings.map(r => r.score));
    const winner = result.standings.find(r => r.teamId === result.winnerId);
    if (winner && winner.score !== top) {
      return `winning team ${result.winnerId} has ${winner.score} but ${top} was the best score`;
    }
  }
  return null;
}
