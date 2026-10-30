// NOT FOR PROFIT — civic public good, not a commercial product.
// App-side hook for a ballot the hourly batch dead-lettered.
// Sealed-vote contracts that force a pre-cutoff receipt into a supplementary
// batch are not on this branch. This module does not call a contract and does
// not change an ABI.

/**
 * Shortest challenge window after cutoff before a tally may be posted.
 * A configured 0 is raised to this floor so the window cannot ship as 0.
 * TODO(#113): align this floor with the sealed-vote contracts challenge window.
 */
export const MIN_TALLY_CHALLENGE_SECONDS = 1;

/** Production default. Tests use the floor unless a window is set. */
export const DEFAULT_TALLY_CHALLENGE_SECONDS = 60;

/**
 * @param {unknown} value
 * @param {{ isTest?: boolean }} [opts]
 */
export function resolveTallyChallengeSeconds(value, { isTest = false } = {}) {
  if (value == null || value === '') {
    return isTest ? MIN_TALLY_CHALLENGE_SECONDS : DEFAULT_TALLY_CHALLENGE_SECONDS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_TALLY_CHALLENGE_SECONDS) return MIN_TALLY_CHALLENGE_SECONDS;
  return Math.floor(n);
}

/**
 * When a tally may be posted: cutoff plus the challenge window.
 * TODO(#113): align the window with the sealed-vote contracts once that PR lands.
 * The supplementary hook runs at the start of the tally request.
 * @param {{ cutoffTime?: number }} election
 * @param {number} [challengeSeconds]
 */
export function tallyAllowedAt(election, challengeSeconds = MIN_TALLY_CHALLENGE_SECONDS) {
  const cutoff = Number(election?.cutoffTime);
  const base = Number.isFinite(cutoff) ? cutoff : 0;
  return base + resolveTallyChallengeSeconds(challengeSeconds);
}

/**
 * Offer dead-lettered ballots to the forced-in supplementary batch.
 *
 * TODO: call the sealed-vote supplementary inbox once that contract is on
 * this branch. Until then the hook refuses. Callers must leave the dead
 * letter in place on a refusal. This function does not delete a ballot.
 *
 * @param {{ election: object, rows: object[], now: number, tallyAllowedAt: number }} _input
 * @returns {Promise<{ accepted: boolean, nullifiers: string[], reason: string }>}
 */
export async function submitSupplementaryBatch(_input) {
  return {
    accepted: false,
    nullifiers: [],
    reason: 'SUPPLEMENTARY_BATCH_UNAVAILABLE',
  };
}
