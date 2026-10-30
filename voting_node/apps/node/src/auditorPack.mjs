// NOT FOR PROFIT — civic public good, not a commercial product.
// Public auditor pack: roots, disclosed ballot hashes, tally, contract
// addresses. Never reads clerk identity files or choice plaintext.

import { brandName } from './branding.mjs';
import { electionState, presentElection } from './electionState.mjs';
import { sealedResultsBody } from './electionType.mjs';
import { electionDisclosurePolicy, publicVoteRecord } from './store.mjs';

export const AUDITOR_SCHEMA = 'zk-voting.auditor.v1';
export const POLL_AUDITOR_SCHEMA = 'zk-voting.auditor.poll.v1';

/**
 * Build a JSON bundle an independent verifier can check without the Node
 * private DB. Uses only public election fields and already-disclosed votes.
 */
export function buildAuditorPack(election, deps) {
  const dto = presentElection(election, deps);
  const now = deps.config.nowFn();
  const policy = electionDisclosurePolicy(election, deps.config, now);
  if (policy.resultsSealed || dto?.resultsSealed) {
    const seal = sealedResultsBody(election, now);
    return {
      schema: AUDITOR_SCHEMA,
      nfp: true,
      product: brandName(),
      chainId: deps.config.chainId,
      electionId: String(election.id),
      title: election.title,
      electionType: dto.electionType,
      electionTypeName: dto.electionTypeName,
      ...seal,
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
      publicAcceptedBallots: null,
      acceptedBallots: null,
      disclosedBallots: [],
      tally: null,
      disclosure: dto.disclosure,
    };
  }
  const tallied = electionState(election, now) >= 4;
  const disclosed = deps.store
    .listPublishedVotes(election.id, now, policy.intervalSeconds, policy)
    .map((vote) => publicVoteRecord(vote));
  return {
    schema: AUDITOR_SCHEMA,
    nfp: true,
    product: brandName(),
    chainId: deps.config.chainId,
    electionId: String(election.id),
    title: election.title,
    electionType: dto.electionType,
    electionTypeName: dto.electionTypeName,
    resultsSealed: false,
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
      policy: 'one-ballot-per-nullifier',
      receiptsProveChoice: false,
      note:
        'Each nullifier is accepted once. A second ballot, including a new ciphertext, is rejected. Double voting is impossible. A receipt lists hashes only; it cannot prove which option was marked. Voters may change their mind on the ballot form before submit. This is not MACI.',
    },
  };
}

/** Public token-poll bundle. Choices are included because phase 1 is public weighted. No userId. */
export function assemblePollAuditorPack({ pollView, params, pollParamsHash, closeBlock, ballots, result }) {
  return {
    schema: POLL_AUDITOR_SCHEMA,
    nfp: true,
    binding: false,
    signal: 'Signal only · non-binding · NOT FOR PROFIT',
    product: brandName(),
    zkVotingChainId: 27427,
    poll: pollView,
    params,
    pollParamsHash: pollParamsHash || null,
    closeBlock: closeBlock ?? null,
    ballots,
    result: result || null,
  };
}
