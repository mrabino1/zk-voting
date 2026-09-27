// NOT FOR PROFIT — civic public good, not a commercial product.
// 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied
// Public acceptedBallots is the last hourly snapshot, never a live tick.

import { presentAspects, presentTally, withQuestionMethods } from './ballot.mjs';
import { disclosurePublicView, withDisclosedCount } from './disclosure.mjs';
import { publicIdFields } from './electionIds.mjs';

export const STATE_NAMES = ['Created', 'RollFrozen', 'Open', 'Closed', 'Tallied'];

export function electionState(election, now = Math.floor(Date.now() / 1000)) {
  if (election.tally) return 4;
  if (now >= election.cutoffTime) return 3;
  if (now >= election.startTime && election.rollFrozen) return 2;
  if (election.rollFrozen) return 1;
  return 0;
}

/** Demo still allocates a uint256 circuit id; onchain means factory mapping exists. */
export function electionChainMode(election) {
  if (election?.createTxHash || election?.onChainElectionAddress) return 'onchain';
  return 'demo';
}

/**
 * @param {object} election
 * @param {number} [now]
 * @param {{ intervalSeconds?: number, publishedAcceptedBallots?: number }} [disclosure]
 */
export function publicElection(election, now = Math.floor(Date.now() / 1000), disclosure = {}) {
  if (!election) return null;
  const state = electionState(election, now);
  const interval = Number(disclosure.intervalSeconds ?? 0);
  let acceptedBallots = election.acceptedBallots;
  if (interval > 0) {
    acceptedBallots =
      typeof disclosure.publishedAcceptedBallots === 'number'
        ? disclosure.publishedAcceptedBallots
        : 0;
  }
  return {
    ...publicIdFields(election),
    title: election.title,
    metadataURI: election.metadataURI,
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    maxParticipants: election.maxParticipants,
    treeDepth: election.treeDepth,
    ballotSpecHash: election.ballotSpecHash,
    ballotMethod: election.ballotMethod || 'plurality',
    questionCount: election.questionCount ?? (election.questions || []).length,
    questions: withQuestionMethods(election.questions, election.ballotMethod || 'plurality'),
    aspects: presentAspects(election),
    jurisdictionId: election.jurisdictionId,
    clerk: election.clerk,
    registrar: election.registrar,
    disqualificationOfficer: election.disqualificationOfficer,
    tallyOperator: election.tallyOperator,
    verifier: election.verifier,
    tallyScheme: election.tallyScheme || 'sum_only',
    tallyPubKey: election.tallyPubKey || null,
    tallyPubKeyX: election.tallyPubKeyX || null,
    tallyPubKeyY: election.tallyPubKeyY || null,
    tallyCeremony: election.tallyCeremony
      ? {
          scheme: election.tallyCeremony.scheme,
          threshold: election.tallyCeremony.threshold,
          guardians: election.tallyCeremony.guardians,
          production: false,
          status: election.tallyCeremony.status || null,
          aggregation: election.tallyCeremony.aggregation || null,
          warning: election.tallyCeremony.warning,
          publicKey: election.tallyCeremony.publicKey || election.tallyPubKey || null,
          verificationKeys: election.tallyCeremony.verificationKeys || null,
          roster: Array.isArray(election.tallyCeremony.roster)
            ? election.tallyCeremony.roster.map((g) => ({
                index: g.index,
                guardianId: g.guardianId,
                label: g.label || '',
                transportPublicKey: g.transportPublicKey || null,
                commitments: g.commitments || null,
              }))
            : [],
        }
      : null,
    lateUpdateAllowed: election.lateUpdateAllowed,
    onChainElectionId: election.onChainElectionId != null ? String(election.onChainElectionId) : null,
    onChainElectionAddress: election.onChainElectionAddress || null,
    factoryAddress: election.factoryAddress || null,
    createTxHash: election.createTxHash || null,
    chainId: election.chainId ?? null,
    chainMode: electionChainMode(election),
    rollFrozen: election.rollFrozen,
    frozenAt: election.frozenAt,
    frozenEligibleRoot: election.frozenEligibleRoot || null,
    frozenDisqualificationRoot: election.frozenDisqualificationRoot || null,
    participantCount: election.participantCount,
    eligibleCount:
      typeof election.eligibleCount === 'number'
        ? election.eligibleCount
        : election.participantCount,
    acceptedBallots,
    eligibleRoot: election.eligibleRoot,
    disqualificationRoot: election.disqualificationRoot,
    state,
    stateName: STATE_NAMES[state],
    tally: presentTally(election, election.acceptedBallots)
      ? {
          ...presentTally(election, election.acceptedBallots),
          source: election.tally.source || 'sum_only',
          production: false,
          aggregation: election.tally.aggregation || null,
          openedBallots: election.tally.openedBallots ?? null,
        }
      : null,
    createdAt: election.createdAt,
    disclosure: disclosurePublicView(now, interval, {
      acceptedBallotsDisclosed: acceptedBallots,
    }),
    nfp: true,
  };
}

export async function publishDue(deps) {
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  if (deps.explorer?.disclose) await deps.explorer.disclose(now, interval);
  const view = deps.explorer?.publicDisclosure
    ? deps.explorer.publicDisclosure(now, interval)
    : disclosurePublicView(now, interval);
  return { now, interval, view };
}

export function electionDisclosure(election, deps, view) {
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const acceptedBallotsDisclosed = deps.store.publishedAcceptedBallots(
    election.id,
    now,
    interval,
  );
  const base = view || disclosurePublicView(now, interval);
  return withDisclosedCount(base, acceptedBallotsDisclosed);
}

export function presentElection(election, deps, opts = {}) {
  if (!election) return null;
  const now = opts.now ?? deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const publishedAcceptedBallots = deps.store.publishedAcceptedBallots(
    election.id,
    now,
    interval,
  );
  const dto = publicElection(election, now, {
    intervalSeconds: interval,
    publishedAcceptedBallots,
  });
  dto.disclosure = withDisclosedCount(dto.disclosure, publishedAcceptedBallots);
  if (
    opts.user &&
    deps.store.userHasJurisdictionRole(opts.user, 'tally_operator', election.jurisdictionId) &&
    electionState(election, now) >= 3
  ) {
    dto.operatorInbox = { acceptedBallots: election.acceptedBallots };
  }
  return dto;
}

export function presentResults(election, deps, opts = {}) {
  const dto = presentElection(election, deps, opts);
  return {
    nfp: true,
    electionId: String(election.id),
    title: election.title,
    jurisdictionId: election.jurisdictionId,
    state: dto.state,
    stateName: dto.stateName,
    acceptedBallots: dto.acceptedBallots,
    questionCount: dto.questionCount,
    aspects: dto.aspects,
    questions: dto.questions,
    tally: presentTally(election, election.acceptedBallots),
    ballotSpecHash: election.ballotSpecHash,
    cutoffTime: election.cutoffTime,
    ballotMethod: election.ballotMethod || 'plurality',
  };
}
