// NOT FOR PROFIT — civic public good, not a commercial product.
// Weighted plurality and weighted IRV. Weights are uint256 base units.
// Tie breaks match irv.mjs: lexicographically first id wins a first-place
// tie; lexicographically last id is eliminated from a last-place tie.

import { ABSTAIN_ID, SIGNAL_LABEL } from './pollTypedData.mjs';
import { firstPlaceTieWinner, lastPlaceTieEliminated } from './irv.mjs';

function asBig(value) {
  if (typeof value === 'bigint') return value;
  if (value == null) return 0n;
  return BigInt(value);
}

function decStr(value) {
  return asBig(value).toString();
}

/**
 * Floor of the square root. Quadratic counting uses this on the gross
 * token weight so a larger holding still counts for more, but not in
 * proportion to the full balance. No floating point.
 */
export function integerSquareRoot(value) {
  const n = asBig(value);
  if (n < 0n) throw new Error('square root of a negative weight');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Quadratic count is the square root of the whole tokens, rounded down.
 * `decimals` 0 means the gross value is already in whole tokens.
 * Dust below one token counts as zero.
 */
export function quadraticVotes(gross, decimals = 0) {
  const scale = 10n ** BigInt(decimals || 0);
  const whole = asBig(gross) / scale;
  return integerSquareRoot(whole);
}

export function countedWeight(gross, weighting, decimals = 0) {
  const n = asBig(gross);
  return weighting === 'quadratic' ? quadraticVotes(n, decimals) : n;
}

export function hasWeightedMajority(votes, continuing) {
  return continuing > 0n && votes * 2n > continuing;
}

function sortIds(ids) {
  return [...ids].sort((a, b) => String(a).localeCompare(String(b)));
}

/**
 * @param {string[]} optionIds continuing candidates (abstain excluded)
 * @param {Array<{ choices: string[], weight: bigint }>} ballots
 */
export function computeWeightedIrv(optionIds, ballots) {
  const ids = sortIds((optionIds || []).map(String).filter((id) => id !== ABSTAIN_ID));
  const lists = [];
  for (const ballot of ballots || []) {
    const weight = asBig(ballot.weight);
    if (weight <= 0n) continue;
    const choices = (ballot.choices || []).map(String).filter((id) => id !== ABSTAIN_ID && ids.includes(id));
    if (!choices.length) continue;
    lists.push({ choices, weight });
  }
  const remaining = new Set(ids);
  const rounds = [];
  let tieBroken = false;
  let lastExhausted = 0n;
  if (!ids.length) {
    return { winner: null, tieBroken: false, exhausted: 0n, rounds };
  }
  const limit = ids.length + 2;
  for (let n = 1; n <= limit && remaining.size > 0; n += 1) {
    const counts = {};
    for (const id of remaining) counts[id] = 0n;
    let exhausted = 0n;
    for (const ballot of lists) {
      const pick = ballot.choices.find((id) => remaining.has(id));
      if (pick) counts[pick] += ballot.weight;
      else exhausted += ballot.weight;
    }
    lastExhausted = exhausted;
    let continuing = 0n;
    for (const id of remaining) continuing += counts[id];
    const remainingIds = sortIds([...remaining]);
    const byVotesDesc = [...remainingIds].sort((a, b) => {
      if (counts[a] === counts[b]) return String(a).localeCompare(String(b));
      return counts[a] > counts[b] ? -1 : 1;
    });
    const top = byVotesDesc[0];
    const second = byVotesDesc[1];
    const topVotes = top ? counts[top] : 0n;
    const majority = top ? hasWeightedMajority(topVotes, continuing) : false;
    const firstPlaceTie = Boolean(top && second && counts[top] === counts[second]);
    const done =
      remaining.size === 1 || continuing === 0n || majority || (remaining.size === 2 && firstPlaceTie);
    if (done) {
      let winner = null;
      let roundTie = false;
      if (continuing === 0n) {
        winner = null;
      } else if (remaining.size === 1) {
        winner = remainingIds[0];
      } else if (firstPlaceTie) {
        winner = firstPlaceTieWinner(top, second);
        roundTie = true;
        tieBroken = true;
      } else {
        winner = top;
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
    const byVotesAsc = [...remainingIds].sort((a, b) => {
      if (counts[a] === counts[b]) return String(b).localeCompare(String(a));
      return counts[a] < counts[b] ? -1 : 1;
    });
    const low = byVotesAsc[0];
    const lowTie = byVotesAsc.find((id) => id !== low && counts[id] === counts[low]);
    const eliminated = lowTie ? lastPlaceTieEliminated(low, lowTie) : low;
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

export function tallyWeightedPlurality(optionIds, ballots) {
  const ids = (optionIds || []).map(String);
  const counts = {};
  for (const id of ids) counts[id] = 0n;
  for (const ballot of ballots || []) {
    const weight = asBig(ballot.weight);
    if (weight <= 0n) continue;
    const choice = String((ballot.choices || [])[0] || '');
    if (!Object.prototype.hasOwnProperty.call(counts, choice)) continue;
    counts[choice] += weight;
  }
  const contenders = ids.filter((id) => id !== ABSTAIN_ID);
  let top = null;
  let topWeight = null;
  let tie = false;
  for (const id of contenders) {
    const weight = counts[id];
    if (top == null || weight > topWeight) {
      top = id;
      topWeight = weight;
      tie = false;
    } else if (weight === topWeight) {
      tie = true;
      top = firstPlaceTieWinner(top, id);
    }
  }
  let nonAbstain = 0n;
  for (const id of contenders) nonAbstain += counts[id];
  if (nonAbstain === 0n) {
    return { counts, winner: null, tie: false, nonAbstain };
  }
  return { counts, winner: top, tie, nonAbstain };
}

export function quorumMet(quorum, participation, totalSupply) {
  if (!quorum) return true;
  const value = asBig(quorum.value);
  const part = asBig(participation);
  if (quorum.mode === 'absolute') return part >= value;
  const supply = asBig(totalSupply);
  return part * 10000n >= value * supply;
}

export function thresholdMet(passThresholdBps, winnerWeight, denominator) {
  if (passThresholdBps == null) return true;
  const bps = asBig(passThresholdBps);
  const num = asBig(winnerWeight);
  const den = asBig(denominator);
  if (den === 0n) return false;
  return num * 10000n >= bps * den;
}

/**
 * Counted ballots only. Weights are bigints. Abstain counts in participation.
 * `weighting` `quadratic` replaces each ballot weight with the square root of
 * the whole tokens before the count. Participation stays the gross sum, so turnout is
 * still a share of token supply. `decisionRule` `simple_majority` (plurality
 * polls) elects an option only when its counted weight is more than half of
 * the non-abstain counted weight. Omitted, plurality keeps most-votes.
 */
export function evaluateWeightedPoll({
  pollType,
  optionIds,
  ballots,
  quorum,
  passThresholdBps,
  totalSupply,
  weighting = 'gross',
  decisionRule = 'plurality',
  decimals = 0,
}) {
  const mode = weighting === 'quadratic' ? 'quadratic' : 'gross';
  const raw = (ballots || []).filter((b) => asBig(b.weight) > 0n);
  let participation = 0n;
  for (const ballot of raw) participation += asBig(ballot.weight);
  const grossCounts = tallyWeightedPlurality(optionIds, raw).counts;
  const counted = raw.map((ballot) => ({
    choices: ballot.choices,
    weight: countedWeight(ballot.weight, mode, decimals),
  }));
  const supply = asBig(totalSupply);
  const turnoutBps = supply === 0n ? 0n : (participation * 10000n) / supply;
  const flags = [];
  if (!quorumMet(quorum, participation, supply)) flags.push('QUORUM_NOT_MET');

  if (participation === 0n) {
    return {
      participation,
      turnoutBps,
      counts: Object.fromEntries((optionIds || []).map((id) => [id, 0n])),
      grossCounts,
      irv: null,
      winner: null,
      leader: null,
      tie: false,
      flags,
      outcome: 'NO_BALLOTS',
    };
  }

  if (pollType === 'ranked_irv') {
    const irv = computeWeightedIrv(optionIds, counted);
    const last = irv.rounds[irv.rounds.length - 1];
    const counts = {};
    for (const id of optionIds) counts[id] = 0n;
    if (last) {
      for (const [id, weight] of Object.entries(last.counts)) counts[id] = weight;
    }
    let abstain = 0n;
    for (const ballot of counted) {
      const prefs = (ballot.choices || []).map(String).filter((id) => id !== ABSTAIN_ID);
      if (!prefs.length) abstain += asBig(ballot.weight);
    }
    counts[ABSTAIN_ID] = abstain;
    if (irv.tieBroken) flags.push('TIE');
    const winnerWeight = irv.winner && last ? last.counts[irv.winner] || 0n : 0n;
    const denominator = last ? last.continuing : 0n;
    if (irv.winner && !thresholdMet(passThresholdBps, winnerWeight, denominator)) {
      flags.push('THRESHOLD_NOT_MET');
    }
    let outcome = 'WINNER';
    if (flags.includes('QUORUM_NOT_MET')) outcome = 'QUORUM_NOT_MET';
    else if (!irv.winner) outcome = 'NO_BALLOTS';
    else if (flags.includes('TIE')) outcome = 'TIE';
    else if (flags.includes('THRESHOLD_NOT_MET')) outcome = 'THRESHOLD_NOT_MET';
    return {
      participation,
      turnoutBps,
      counts,
      grossCounts,
      irv,
      winner: irv.winner,
      leader: irv.winner,
      tie: irv.tieBroken,
      flags,
      outcome,
    };
  }

  const plurality = tallyWeightedPlurality(optionIds, counted);
  if (plurality.tie) flags.push('TIE');
  let winner = plurality.winner;
  let leader = plurality.tie ? null : plurality.winner;
  if (decisionRule === 'simple_majority') {
    if (plurality.tie) {
      winner = null;
    } else if (
      plurality.winner &&
      plurality.nonAbstain > 0n &&
      plurality.counts[plurality.winner] * 2n <= plurality.nonAbstain
    ) {
      flags.push('NO_MAJORITY');
      leader = plurality.winner;
      winner = null;
    }
  }
  const winnerWeight = winner ? plurality.counts[winner] : 0n;
  if (winner && !thresholdMet(passThresholdBps, winnerWeight, plurality.nonAbstain)) {
    flags.push('THRESHOLD_NOT_MET');
  }
  let outcome = 'WINNER';
  if (flags.includes('QUORUM_NOT_MET')) outcome = 'QUORUM_NOT_MET';
  else if (plurality.tie) outcome = 'TIE';
  else if (flags.includes('NO_MAJORITY')) outcome = 'NO_MAJORITY';
  else if (!winner) outcome = 'NO_BALLOTS';
  else if (flags.includes('THRESHOLD_NOT_MET')) outcome = 'THRESHOLD_NOT_MET';
  return {
    participation,
    turnoutBps,
    counts: plurality.counts,
    grossCounts,
    irv: null,
    winner,
    leader,
    tie: plurality.tie,
    flags,
    outcome,
  };
}

function mapDec(counts) {
  return Object.fromEntries(Object.entries(counts || {}).map(([key, value]) => [key, decStr(value)]));
}

function serializeRounds(irv) {
  if (!irv) return null;
  return irv.rounds.map((round) => ({
    round: round.round,
    counts: mapDec(round.counts),
    continuing: decStr(round.continuing),
    exhausted: decStr(round.exhausted),
    remaining: round.remaining,
    eliminated: round.eliminated,
    winner: round.winner,
    ...(round.tieBroken ? { tieBroken: true } : {}),
  }));
}

/** Public tally body. Caller sets resultHash. Omit tally metadata. */
export function publicPollTally({
  pollId,
  closeBlock,
  math,
  withdrawnWeight,
  ballotsRoot,
  weighting = 'gross',
  decisionRule = 'plurality',
  snapshotRoot = null,
  snapshotBlock = null,
}) {
  const mode = weighting === 'quadratic' ? 'quadratic' : 'gross';
  const body = {
    pollId,
    closeBlock,
    participation: decStr(math.participation),
    withdrawnWeight: decStr(withdrawnWeight),
    turnoutBps: decStr(math.turnoutBps),
    weighting: mode,
    decisionRule,
    counts: mapDec(math.counts),
    irvRounds: serializeRounds(math.irv),
    outcome: math.outcome,
    flags: math.flags || [],
    winner: math.winner ?? null,
    ballotsRoot,
    binding: false,
    nfp: true,
    signal: SIGNAL_LABEL,
  };
  if (mode === 'quadratic') body.grossCounts = mapDec(math.grossCounts);
  if (math.outcome === 'NO_MAJORITY' && math.leader) body.leader = math.leader;
  if (snapshotRoot) {
    body.snapshotRoot = snapshotRoot;
    body.snapshotBlock = Number(snapshotBlock);
  }
  return body;
}
