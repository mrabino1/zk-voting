// NOT FOR PROFIT — civic public good, not a commercial product.
// App-side hook for a ballot the hourly batch dead-lettered.
// Sealed-vote contracts that force a pre-cutoff receipt into a supplementary
// batch are not on this branch. This module does not call a contract and does
// not change an ABI.

/**
 * Shortest challenge window after cutoff before a tally may be posted.
 * Test and development use this 1-second floor. Production uses
 * PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS. A configured 0 is raised.
 * TODO(#113): align this floor with the sealed-vote contracts challenge window.
 */
export const MIN_TALLY_CHALLENGE_SECONDS = 1;

/** Production minimum. A shorter configured value is raised to this and logged. */
export const PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS = 60 * 60;

/** Production default: 24 hours. Tests use the 1-second floor unless a window is set. */
export const DEFAULT_TALLY_CHALLENGE_SECONDS = 24 * 60 * 60;

/** One warning per configured value and floor, so getConfig does not repeat it. */
const warnedChallengeFloors = new Set();

/**
 * @param {unknown} value
 * @param {{ isTest?: boolean, isProduction?: boolean }} [opts]
 */
export function resolveTallyChallengeSeconds(value, { isTest = false, isProduction = false } = {}) {
  const floor = isProduction ? PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS : MIN_TALLY_CHALLENGE_SECONDS;
  if (value == null || value === '') {
    return isTest ? MIN_TALLY_CHALLENGE_SECONDS : DEFAULT_TALLY_CHALLENGE_SECONDS;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < floor) {
    const key = `${String(value)}|${floor}`;
    if (!warnedChallengeFloors.has(key)) {
      warnedChallengeFloors.add(key);
      console.warn(
        `TALLY_CHALLENGE_SECONDS value ${value} is below the minimum of ${floor} seconds; using ${floor}`,
      );
    }
    return floor;
  }
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
