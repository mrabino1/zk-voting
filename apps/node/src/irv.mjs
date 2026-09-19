// NOT FOR PROFIT — civic public good, not a commercial product.
// Instant-runoff (IRV) for ranked-choice questions. Node-only demo path:
// round transcripts are aggregate counts, never individual ballots.

/**
 * Strict majority of continuing (non-exhausted) ballots.
 * @param {number} votes
 * @param {number} continuing
 */
export function hasMajority(votes, continuing) {
  return continuing > 0 && votes * 2 > continuing;
}

/**
 * Instant-runoff elimination.
 *
 * Each ballot is an ordered list of option ids (first = highest preference).
 * Unknown ids are ignored. Empty / exhausted ballots do not count toward
 * the majority denominator.
 *
 * Last-place ties: eliminate the lexicographically last option id so the
 * transcript is deterministic. First-place ties at the end of the
 * contest: the lexicographically first remaining id is the winner and
 * `tieBroken` is set.
 *
 * @param {string[]} optionIds
 * @param {string[][]} ballots
 * @returns {{
 *   winner: string | null,
 *   tieBroken: boolean,
 *   exhausted: number,
 *   rounds: Array<{
 *     round: number,
 *     counts: Record<string, number>,
 *     continuing: number,
 *     exhausted: number,
 *     remaining: string[],
 *     eliminated: string | null,
 *     winner: string | null,
 *     tieBroken?: boolean,
 *   }>,
 * }}
 */
export function computeIrv(optionIds, ballots) {
  const ids = [...new Set((optionIds || []).map((id) => String(id)))];
  const lists = Array.isArray(ballots) ? ballots.map((b) => (Array.isArray(b) ? b.map(String) : [])) : [];
  const remaining = new Set(ids);
  const rounds = [];
  let tieBroken = false;
  let lastExhausted = lists.length;

  if (ids.length === 0) {
    return { winner: null, tieBroken: false, exhausted: lists.length, rounds };
  }

  const limit = ids.length + 2;
  for (let n = 1; n <= limit && remaining.size > 0; n += 1) {
    const counts = {};
    for (const id of remaining) counts[id] = 0;
    let exhausted = 0;
    for (const ballot of lists) {
      const pick = ballot.find((id) => remaining.has(id));
      if (pick) counts[pick] += 1;
      else exhausted += 1;
    }
    lastExhausted = exhausted;
    const continuing = lists.length - exhausted;
    const remainingIds = [...remaining];
    const byVotesDesc = remainingIds
      .map((id) => ({ id, votes: counts[id] }))
      .sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));

    const top = byVotesDesc[0];
    const second = byVotesDesc[1];
    const majority = top ? hasMajority(top.votes, continuing) : false;
    const firstPlaceTie = Boolean(top && second && top.votes === second.votes);
    const done =
      remaining.size === 1 || continuing === 0 || majority || (remaining.size === 2 && firstPlaceTie);

    if (done) {
      let winner = null;
      let roundTie = false;
      if (continuing === 0) {
        winner = null;
      } else if (remaining.size === 1) {
        winner = remainingIds[0];
      } else if (firstPlaceTie && (majority === false || top.votes === second.votes)) {
        winner = top.id;
        roundTie = true;
        tieBroken = true;
      } else {
        winner = top.id;
      }
      rounds.push({
        round: n,
        counts,
        continuing,
        exhausted,
        remaining: remainingIds,
        eliminated: null,
        winner,
        ...(roundTie ? { tieBroken: true } : {}),
      });
      return { winner, tieBroken, exhausted, rounds };
    }

    const byVotesAsc = remainingIds
      .map((id) => ({ id, votes: counts[id] }))
      .sort((a, b) => a.votes - b.votes || b.id.localeCompare(a.id));
    const eliminated = byVotesAsc[0].id;
    remaining.delete(eliminated);
    rounds.push({
      round: n,
      counts,
      continuing,
      exhausted,
      remaining: remainingIds,
      eliminated,
      winner: null,
    });
  }

  return { winner: null, tieBroken, exhausted: lastExhausted, rounds };
}

/**
 * First-preference counts in `optionIds` order for one IRV round-1 vector.
 * @param {string[]} optionIds
 * @param {string[][]} ballots
 * @returns {{ counts: number[], exhausted: number }}
 */
export function firstRoundCounts(optionIds, ballots) {
  const ids = (optionIds || []).map((id) => String(id));
  const index = new Map(ids.map((id, i) => [id, i]));
  const counts = ids.map(() => 0);
  let exhausted = 0;
  for (const ballot of ballots || []) {
    const pick = (ballot || []).map(String).find((id) => index.has(id));
    if (pick == null) exhausted += 1;
    else counts[index.get(pick)] += 1;
  }
  return { counts, exhausted };
}
