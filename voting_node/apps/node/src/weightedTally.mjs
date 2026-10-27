// NOT FOR PROFIT — civic public good, not a commercial product.
// Weighted plurality and weighted IRV. Weights are uint256 base units.
// Tie breaks match irv.mjs: lexicographically first id wins a first-place
// tie; lexicographically last id is eliminated from a last-place tie.

import { ABSTAIN_ID } from './pollTypedData.mjs';
import { firstPlaceTieWinner, lastPlaceTieEliminated } from './irv.mjs';

function asBig(value) {
  if (typeof value === 'bigint') return value;
  return BigInt(value);
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
 */
export function evaluateWeightedPoll({ pollType, optionIds, ballots, quorum, passThresholdBps, totalSupply }) {
  const counted = (ballots || []).filter((b) => asBig(b.weight) > 0n);
  let participation = 0n;
  for (const ballot of counted) participation += asBig(ballot.weight);
  const supply = asBig(totalSupply);
  const turnoutBps = supply === 0n ? 0n : (participation * 10000n) / supply;
  const flags = [];
  if (!quorumMet(quorum, participation, supply)) flags.push('QUORUM_NOT_MET');

  if (participation === 0n) {
    return {
      participation,
      turnoutBps,
      counts: Object.fromEntries((optionIds || []).map((id) => [id, 0n])),
      irv: null,
      winner: null,
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
      irv,
      winner: irv.winner,
      tie: irv.tieBroken,
      flags,
      outcome,
    };
  }

  const plurality = tallyWeightedPlurality(optionIds, counted);
  if (plurality.tie) flags.push('TIE');
  const winnerWeight = plurality.winner ? plurality.counts[plurality.winner] : 0n;
  if (plurality.winner && !thresholdMet(passThresholdBps, winnerWeight, plurality.nonAbstain)) {
    flags.push('THRESHOLD_NOT_MET');
  }
  let outcome = 'WINNER';
  if (flags.includes('QUORUM_NOT_MET')) outcome = 'QUORUM_NOT_MET';
  else if (!plurality.winner) outcome = 'NO_BALLOTS';
  else if (flags.includes('TIE')) outcome = 'TIE';
  else if (flags.includes('THRESHOLD_NOT_MET')) outcome = 'THRESHOLD_NOT_MET';
  return {
    participation,
    turnoutBps,
    counts: plurality.counts,
    irv: null,
    winner: plurality.winner,
    tie: plurality.tie,
    flags,
    outcome,
  };
}
