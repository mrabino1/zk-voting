// NOT FOR PROFIT — civic public good, not a commercial product.
// Sealed ranked-choice (IRV) tally.
//
// Each sealed ranked ballot carries an "RK" ranking envelope next to its
// one-hot first-choice AG ciphertext. After the deadline, guardians post a
// threshold partial on the envelope's C1 tagged `ranking:<nullifier>`. The node
// combines them, opens each ranking, runs IRV, and publishes the rounds plus
// a hash of the decrypted ranking set.
//
// Verification level: RECOMPUTABLE, not ZK-proven. Anyone holding the opened
// ranking set can rerun IRV and match the hashes, and every ranking hash is
// bound on chain (BallotInbox.commitRanking). There is no verified shuffle
// yet, so rankings are opened per ballot rather than after mixing.

import { createHash } from 'node:crypto';

import { decryptRankingEnvelope, parseRankingEnvelope } from '../public/ranked-envelope.js';
import { isRankedQuestion, tallyBallots, validateBallotAnswers } from './ballot.mjs';
import { combinePartialPoints, verifyPartial } from './guardians/threshold.mjs';
import { HttpError } from './http.mjs';

export const RANKED_VERIFICATION =
  'recomputable, not ZK proof-verified; no verified shuffle (rankings opened per ballot by guardian threshold)';

export function rankingTag(nullifier) {
  return `ranking:${String(nullifier).toLowerCase()}`;
}

/** The ranking a tally counts: the replacement when the voter re-voted. */
export function rankingForTally(env) {
  if (!env) return null;
  if (env.tallyRankingEnvelope) return { envelope: env.tallyRankingEnvelope, hash: env.tallyRankingHash };
  if (env.rankingEnvelope) return { envelope: env.rankingEnvelope, hash: env.rankingHash };
  return null;
}

function sha256Hex(text) {
  return `0x${createHash('sha256').update(text).digest('hex')}`;
}

/** Order-independent hash of the opened rankings (each canonicalized JSON). */
export function rankingSetHash(ballots) {
  const lines = ballots
    .map((answers) =>
      JSON.stringify(
        [...answers]
          .map((a) => ({ questionId: String(a.questionId), ranking: (a.ranking || []).map(String) }))
          .sort((x, y) => (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0)),
      ),
    )
    .sort();
  return sha256Hex(lines.join('\n'));
}

export function roundsHash(questions) {
  return sha256Hex(JSON.stringify(questions || []));
}

/**
 * Check one guardian partial against a ranking envelope.
 * @returns {boolean}
 */
export function verifyRankingPartial({ election, index, partial, envelope }) {
  const ceremony = election.tallyCeremony;
  let c1Hex;
  try {
    c1Hex = parseRankingEnvelope(envelope).c1Hex;
  } catch {
    return false;
  }
  return verifyPartial({
    partial,
    electionId: election.id,
    index,
    jointPublicKey: ceremony.publicKey,
    expectedY: ceremony.verificationKeys[String(index)],
    ephemeral: c1Hex,
  });
}

/**
 * Open every counted ranking and run IRV.
 *
 * @param {object} election
 * @param {object[]} envelopes live, non-excluded envelope rows
 * @param {{index:number, partials:object[]}[]} partialGroups guardian ranking partials
 */
export async function openRankedTally(election, envelopes, partialGroups) {
  const ceremony = election?.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready' || !ceremony.publicKey || !ceremony.verificationKeys) {
    throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
  }
  const byTag = new Map();
  for (const group of partialGroups || []) {
    for (const row of group.partials || []) {
      const list = byTag.get(String(row.ballotHash).toLowerCase()) || [];
      list.push({ index: Number(group.index), row });
      byTag.set(String(row.ballotHash).toLowerCase(), list);
    }
  }
  const ballots = [];
  const commitments = [];
  let invalid = 0;
  let missing = 0;
  for (const env of envelopes) {
    const ranking = rankingForTally(env);
    if (!ranking) {
      missing += 1;
      continue;
    }
    const tag = rankingTag(env.nullifier);
    const rows = (byTag.get(tag) || []).filter(({ index, row }) =>
      verifyRankingPartial({ election, index, partial: row, envelope: ranking.envelope }),
    );
    let shared;
    try {
      shared = combinePartialPoints(
        rows.map(({ index, row }) => ({ index, point: row.point })),
        ceremony.threshold,
      );
    } catch (err) {
      throw new HttpError(409, `ranking partials below threshold for ${tag}`, {
        code: err.code || 'THRESHOLD_NOT_MET',
        nullifier: String(env.nullifier),
      });
    }
    let answers;
    try {
      answers = await decryptRankingEnvelope({
        envelope: ranking.envelope,
        electionId: election.id,
        sharedPoint: shared.toRawBytes(false),
      });
      answers = validateBallotAnswers(election, answers);
    } catch {
      // A ranking that does not open or does not match the ballot counts as
      // exhausted from round one; it is not silently dropped from the total.
      invalid += 1;
      answers = [];
    }
    ballots.push(answers);
    commitments.push({ nullifier: String(env.nullifier), rankingHash: ranking.hash });
  }
  if (missing > 0) {
    throw new HttpError(409, 'some counted ballots have no sealed ranking', { code: 'RANKING_MISSING', missing });
  }
  const tallied = tallyBallots(election, ballots);
  const rankedQuestions = (tallied.questions || []).filter((q) => q.ballotMethod === 'ranked_choice');
  return {
    ...tallied,
    rankedBallots: ballots.length,
    invalidRankings: invalid,
    rankingSetHash: rankingSetHash(ballots),
    rankedQuestions,
    roundsHash: roundsHash(rankedQuestions),
    commitments,
    verification: RANKED_VERIFICATION,
  };
}

/**
 * Do the IRV first-round counts match the homomorphic first-choice sums for
 * every ranked question? A mismatch (e.g. a voter whose ranking disagrees with
 * the one-hot first choice) is reported, not fatal, so one bad ballot cannot
 * block a tally.
 */
export function firstChoiceMatches(election, aggregateCounts, irvCounts) {
  if (!Array.isArray(aggregateCounts) || !Array.isArray(irvCounts)) return false;
  if (aggregateCounts.length !== irvCounts.length) return false;
  let offset = 0;
  for (const q of election.questions || []) {
    const n = (q.options || []).length;
    const ranked = isRankedQuestion(q, election.ballotMethod || 'plurality');
    if (ranked) {
      for (let i = offset; i < offset + n; i++) {
        if (Number(aggregateCounts[i]) !== Number(irvCounts[i])) return false;
      }
    }
    offset += n;
  }
  return true;
}
