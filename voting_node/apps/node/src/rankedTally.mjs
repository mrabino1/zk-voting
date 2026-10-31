// NOT FOR PROFIT — civic public good, not a commercial product.
// Sealed ranked-choice (IRV) tally.
//
// Each sealed ranked ballot carries an "RK" ranking envelope next to its
// one-hot first-choice AG ciphertext. The AG tag (the proven ballot hash)
// commits to the ranking envelope hash, so the ranking is bound at cast time;
// the relayer also carries the sorted ranking hashes in the hourly inbox batch
// (BallotInbox.submitVoteBatchRanked). After the deadline, guardians post a
// threshold partial on each envelope's C1, tagged `ranking:<rankingId>` where
// rankingId is random per ballot and is not derived from the nullifier. The
// node opens each ranking, runs IRV, and publishes the rounds plus the opened
// ranking set in canonical sorted order (no ids, no hashes, no nullifiers).
//
// Sealed VOTES need the per-election opt-in `sealedRankedChoice` (bound into
// ballotSpecHash). Polls do not.
//
// Verification level: RECOMPUTABLE, not ZK-proven. There is no verified
// shuffle yet, so guardians see each individual ranking (not who cast it).

import { createHash, randomBytes } from 'node:crypto';

import { aggregateTag, parseAggregateEnvelope } from '../public/aggregate-ballot.js';
import { openRankingEnvelope, parseRankingEnvelope } from '../public/ranked-envelope.js';
import { electionHasRanked, isRankedQuestion, tallyBallots, validateBallotAnswers } from './ballot.mjs';
import { isVoteElection } from './electionType.mjs';
import { combinePartialPoints, verifyPartial } from './guardians/threshold.mjs';
import { HttpError } from './http.mjs';
import { ciphertextForTally } from './tallyOpen.mjs';

export const RANKED_VERIFICATION =
  'recomputable, not ZK proof-verified; no verified shuffle (rankings opened per ballot by guardian threshold)';

/** Shown to the admin (acknowledged at creation) and to voters on the ballot. */
export const SEALED_RANKED_DISCLOSURE =
  'Ranked choice on a sealed vote: until a verified shuffle exists, guardians can see each individual ranking ' +
  '(not who cast it). The instant-runoff result is recomputable from the published rankings but is not ' +
  'ZK-proven. A distinctive ranking pattern could be used to prove how someone voted (coercion risk).';

/** Polls allow sealed rankings; sealed votes only with the opt-in setting. */
export function sealedRankingAllowed(election) {
  return !isVoteElection(election) || election?.sealedRankedChoice === true;
}

export function assertSealedRankingAllowed(election) {
  if (electionHasRanked(election) && !sealedRankingAllowed(election)) {
    throw new HttpError(
      409,
      'ranked tally is disabled for this sealed vote; enable sealedRankedChoice at creation to allow it',
      { code: 'RANKED_TALLY_DISABLED' },
    );
  }
}

/**
 * Parse the opt-in from a create body. Only meaningful for votes. Turning it
 * on requires an explicit disclosure acknowledgment.
 */
export function sealedRankedChoiceFromCreateBody(body, electionType) {
  const on = body?.sealedRankedChoice === true || body?.sealedRankedChoice === 'true';
  if (!on) return false;
  if (!isVoteElection({ electionType })) return false;
  const ack = body?.sealedRankedDisclosureAck === true || body?.sealedRankedDisclosureAck === 'true';
  if (!ack) {
    throw new HttpError(400, 'acknowledge the sealed ranked-choice disclosure to enable it', {
      code: 'DISCLOSURE_ACK_REQUIRED',
      disclosure: SEALED_RANKED_DISCLOSURE,
    });
  }
  return true;
}

/** Random per-ballot ranking id. Not derived from, and not stored next to, any public nullifier list. */
export function newRankingId() {
  return `0x${randomBytes(16).toString('hex')}`;
}

export function rankingTag(rankingId) {
  return `ranking:${String(rankingId).toLowerCase()}`;
}

/** The ranking a tally counts: the replacement when the voter re-voted. */
export function rankingForTally(env) {
  if (!env) return null;
  if (env.tallyRankingEnvelope) {
    return { envelope: env.tallyRankingEnvelope, hash: env.tallyRankingHash, id: env.tallyRankingId || null };
  }
  if (env.rankingEnvelope) return { envelope: env.rankingEnvelope, hash: env.rankingHash, id: env.rankingId || null };
  return null;
}

/**
 * Envelope rows for guardians with ranking fields stripped, plus the counted
 * rankings as a separate list sorted by random rankingId. Nothing in the
 * response links a ranking to a nullifier or to submission order.
 */
export function splitRankingsForGuardians(envelopes) {
  const rows = [];
  const rankings = [];
  for (const env of envelopes || []) {
    const ranking = rankingForTally(env);
    const {
      rankingEnvelope: _a,
      rankingHash: _b,
      rankingId: _c,
      tallyRankingEnvelope: _d,
      tallyRankingHash: _e,
      tallyRankingId: _f,
      ...rest
    } = env;
    rows.push(rest);
    if (ranking && ranking.id && env.is_deleted !== true) {
      rankings.push({ rankingId: ranking.id, rankingEnvelope: ranking.envelope });
    }
  }
  rankings.sort((x, y) => (x.rankingId < y.rankingId ? -1 : x.rankingId > y.rankingId ? 1 : 0));
  return { envelopes: rows, rankings };
}

function sha256Hex(text) {
  return `0x${createHash('sha256').update(text).digest('hex')}`;
}

/** Canonical JSON line per opened ranking, sorted (no ids, no submission order). */
export function canonicalRankingLines(ballots) {
  return ballots
    .map((answers) =>
      JSON.stringify(
        [...answers]
          .map((a) => ({ questionId: String(a.questionId), ranking: (a.ranking || []).map(String) }))
          .sort((x, y) => (x.questionId < y.questionId ? -1 : x.questionId > y.questionId ? 1 : 0)),
      ),
    )
    .sort();
}

/** Order-independent hash of the opened rankings (each canonicalized JSON). */
export function rankingSetHash(ballots) {
  return sha256Hex(canonicalRankingLines(ballots).join('\n'));
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

/** Which question and local option an election-wide one-hot index points at. */
export function questionForIndex(questions, index) {
  let offset = 0;
  for (const q of questions || []) {
    const opts = Array.isArray(q.options) ? q.options : [];
    const width = Math.max(opts.length, 1);
    if (index >= offset && index < offset + width) return { question: q, local: index - offset };
    offset += width;
  }
  return null;
}

/**
 * Per-ballot binding and first-choice check for one opened ranking.
 * Returns null when the ranking is consistent, or a reason code.
 */
export function rankingBindingProblem(election, env, ranking, opened) {
  const first = opened?.first;
  if (!first) return 'UNBOUND';
  let tag;
  try {
    tag = parseAggregateEnvelope(ciphertextForTally(env)).tag;
  } catch {
    return 'UNBOUND';
  }
  let expected;
  try {
    expected = aggregateTag(first.index, BigInt(first.r), ranking.hash).tag;
  } catch {
    return 'UNBOUND';
  }
  // A swapped envelope has a different hash, so it cannot match the proven tag.
  if (BigInt(expected) !== BigInt(tag)) return 'RANKING_SWAPPED';
  // The one-hot index points at ONE question. Only that question's ranking is
  // compared, so other questions on a multi-question ballot never mismatch.
  const hit = questionForIndex(election.questions, Number(first.index));
  if (!hit) return 'FIRST_CHOICE_MISMATCH';
  if (!isRankedQuestion(hit.question, election.ballotMethod || 'plurality')) return null;
  const answer = (opened.answers || []).find((a) => String(a.questionId) === String(hit.question.id));
  const top = answer?.ranking?.[0];
  const opt = (hit.question.options || [])[hit.local];
  const optId = String(opt?.id ?? opt?.label ?? opt);
  if (top == null || String(top) !== optId) return 'FIRST_CHOICE_MISMATCH';
  return null;
}

/**
 * Open every counted ranking and run IRV.
 *
 * A ranking that does not open, is not bound to its ballot's proven tag, or
 * whose first choice disagrees with the one-hot first choice counts as
 * invalid (exhausted from round one) and is reported; it is never dropped
 * silently and never blocks the tally.
 *
 * @param {object} election
 * @param {object[]} envelopes live, non-excluded, non-deleted envelope rows
 * @param {{index:number, partials:object[]}[]} partialGroups guardian ranking partials
 */
export async function openRankedTally(election, envelopes, partialGroups) {
  assertSealedRankingAllowed(election);
  const ceremony = election?.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready' || !ceremony.publicKey || !ceremony.verificationKeys) {
    throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
  }
  const byTag = new Map();
  for (const group of partialGroups || []) {
    for (const row of group.partials || []) {
      const key = String(row.ballotHash).toLowerCase();
      const list = byTag.get(key) || [];
      list.push({ index: Number(group.index), row });
      byTag.set(key, list);
    }
  }
  const ballots = [];
  const rankingHashes = [];
  let invalid = 0;
  let missing = 0;
  let swapped = 0;
  let firstChoiceMismatches = 0;
  let unbound = 0;
  for (const env of envelopes) {
    if (env?.is_deleted === true) continue;
    const ranking = rankingForTally(env);
    if (!ranking || !ranking.id) {
      missing += 1;
      continue;
    }
    const tag = rankingTag(ranking.id);
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
      throw new HttpError(409, 'ranking partials below threshold', {
        code: err.code || 'THRESHOLD_NOT_MET',
        rankingId: ranking.id,
      });
    }
    let answers = [];
    let ok = false;
    try {
      const opened = await openRankingEnvelope({
        envelope: ranking.envelope,
        electionId: election.id,
        sharedPoint: shared.toRawBytes(false),
      });
      const problem = rankingBindingProblem(election, env, ranking, opened);
      if (problem === 'RANKING_SWAPPED') swapped += 1;
      else if (problem === 'FIRST_CHOICE_MISMATCH') firstChoiceMismatches += 1;
      else if (problem === 'UNBOUND') unbound += 1;
      if (!problem) {
        answers = validateBallotAnswers(election, opened.answers);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      invalid += 1;
      answers = [];
    }
    ballots.push(answers);
    rankingHashes.push(String(ranking.hash).toLowerCase());
  }
  if (missing > 0) {
    throw new HttpError(409, 'some counted ballots have no sealed ranking', { code: 'RANKING_MISSING', missing });
  }
  rankingHashes.sort();
  const tallied = tallyBallots(election, ballots);
  const rankedQuestions = (tallied.questions || []).filter((q) => q.ballotMethod === 'ranked_choice');
  return {
    ...tallied,
    rankedBallots: ballots.length,
    invalidRankings: invalid,
    swappedRankings: swapped,
    firstChoiceMismatches,
    unboundRankings: unbound,
    firstChoiceConsistent: invalid === 0,
    openedRankings: canonicalRankingLines(ballots),
    rankingSetHash: rankingSetHash(ballots),
    rankedQuestions,
    roundsHash: roundsHash(rankedQuestions),
    rankingHashes,
    verification: RANKED_VERIFICATION,
  };
}

/**
 * Do the IRV first-round counts match the homomorphic first-choice sums?
 * Only meaningful on single-question ballots: the one-hot ciphertext covers
 * one question per ballot, so on multi-question ballots this returns null
 * (not applicable) instead of a false mismatch. Per-ballot checks in
 * openRankedTally are the authoritative ones.
 */
export function firstChoiceMatches(election, aggregateCounts, irvCounts) {
  const questions = election.questions || [];
  if (questions.length !== 1) return null;
  if (!Array.isArray(aggregateCounts) || !Array.isArray(irvCounts)) return false;
  if (aggregateCounts.length !== irvCounts.length) return false;
  if (!isRankedQuestion(questions[0], election.ballotMethod || 'plurality')) return true;
  return aggregateCounts.every((n, i) => Number(n) === Number(irvCounts[i]));
}
