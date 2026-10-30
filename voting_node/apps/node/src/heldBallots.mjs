// NOT FOR PROFIT — civic public good, not a commercial product.
// VOTE ballots stay on this Node until cutoff. The on-chain batch call is a
// later wiring: contracts work for that batch is not final, so this module
// does not call BallotInbox. POLL ballots never enter here.

import { isVoteElection, voteResultsSealed } from './electionType.mjs';

/** Rows saved for one election. Callers must not publish the length. */
export function heldChainBallotsFor(store, electionId) {
  const id = String(electionId);
  const rows = Array.isArray(store?.data?.heldChainBallots) ? store.data.heldChainBallots : [];
  return rows.filter((row) => row && row.is_deleted !== true && String(row.electionId) === id);
}

/**
 * Isolated submit-at-cutoff hook. This is the only function that will send a
 * VOTE's held ballots, and it will send them in one shot. It does not call
 * submitVote or submitVoteBatch. The return value has no ballot count.
 */
export function submitHeldBallotsAtCutoff({ store, election, now }) {
  if (!isVoteElection(election) || voteResultsSealed(election, now)) {
    return { submitted: false, reason: 'not-due' };
  }
  const ballots = heldChainBallotsFor(store, election.id);
  if (!Array.isArray(ballots)) {
    return { submitted: false, reason: 'chain-batch-abi-not-final' };
  }
  return { submitted: false, reason: 'chain-batch-abi-not-final' };
}
