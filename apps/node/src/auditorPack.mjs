// NOT FOR PROFIT — civic public good, not a commercial product.
// Public auditor pack: roots, disclosed ballot hashes, tally, contract
// addresses. Never reads clerk identity files or choice plaintext.

import { electionState, presentElection } from './electionState.mjs';
import { publicVoteRecord } from './store.mjs';

export const AUDITOR_SCHEMA = 'republic.auditor.v1';

/**
 * Build a JSON bundle an independent verifier can check without the Node
 * private DB. Uses only public election fields and already-disclosed votes.
 */
export function buildAuditorPack(election, deps) {
  const dto = presentElection(election, deps);
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const tallied = electionState(election, now) >= 4;
  const disclosed = deps.store.listPublishedVotes(election.id, now, interval).map((vote) => {
    const row = publicVoteRecord(vote);
    const superseded = Array.isArray(vote.supersededHashes) ? vote.supersededHashes : [];
    return {
      ...row,
      supersededHashes: dto.state >= 3 || interval === 0 ? superseded : [],
    };
  });
  return {
    schema: AUDITOR_SCHEMA,
    nfp: true,
    product: 'Republic',
    chainId: deps.config.chainId,
    electionId: String(election.id),
    title: election.title,
    contracts: {
      factory: deps.config.electionFactoryAddress || null,
      ballotInbox: deps.config.ballotInboxAddress || election.inbox || null,
      verifier: election.verifier || null,
      voterRegistry: election.voterRegistry || null,
      disqualificationRegistry: election.disqualificationRegistry || null,
      tallyVerifier: election.tallyVerifier || null,
      election: election.contractAddress || null,
    },
    roots: {
      eligibleRoot: election.eligibleRoot,
      disqualificationRoot: election.disqualificationRoot,
      ballotSpecHash: election.ballotSpecHash,
    },
    window: {
      startTime: election.startTime,
      cutoffTime: election.cutoffTime,
    },
    rollFrozen: Boolean(election.rollFrozen),
    participantCount: election.participantCount,
    publicAcceptedBallots: dto.acceptedBallots,
    acceptedBallots: tallied ? election.acceptedBallots : dto.acceptedBallots,
    disclosedBallots: disclosed,
    tally: dto.tally,
    disclosure: dto.disclosure,
    coercion: {
      policy: 'last-ballot-counts',
      receiptsProveChoice: false,
      note:
        'Each nullifier counts once. A later ballotHash supersedes earlier ones for that nullifier. A receipt lists hashes only; it cannot prove which option was marked. This is not MACI.',
    },
  };
}
