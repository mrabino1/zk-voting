// NOT FOR PROFIT — civic public good, not a commercial product.
// App-side hook for a ballot the hourly batch dead-lettered.
// Sealed-vote contracts that force a pre-cutoff receipt into a supplementary
// batch are not on this branch. This module does not call a contract and does
// not change an ABI.

/**
 * When a tally may be posted. This stays the election cutoff: the hourly
 * batch is already due at cutoff, and holding every tally for another hour
 * would wait on contracts this branch does not have. The hook runs at the
 * start of the tally request, before that request is accepted.
 * @param {{ cutoffTime?: number }} election
 */
export function tallyAllowedAt(election) {
  const cutoff = Number(election?.cutoffTime);
  return Number.isFinite(cutoff) ? cutoff : 0;
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
