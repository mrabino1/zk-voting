// NOT FOR PROFIT — civic public good, not a commercial product.
// 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied
// Public acceptedBallots is the last hourly snapshot, never a live tick.

import { disclosurePublicView, withDisclosedCount } from './disclosure.mjs';

export const STATE_NAMES = ['Created', 'RollFrozen', 'Open', 'Closed', 'Tallied'];

export function electionState(election, now = Math.floor(Date.now() / 1000)) {
  if (election.tally) return 4;
  if (now >= election.cutoffTime) return 3;
  if (now >= election.startTime && election.rollFrozen) return 2;
  if (election.rollFrozen) return 1;
  return 0;
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
    id: election.id,
    title: election.title,
    metadataURI: election.metadataURI,
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    maxParticipants: election.maxParticipants,
    treeDepth: election.treeDepth,
    ballotSpecHash: election.ballotSpecHash,
    questionCount: election.questionCount,
    questions: election.questions,
    jurisdictionId: election.jurisdictionId,
    clerk: election.clerk,
    registrar: election.registrar,
    disqualificationOfficer: election.disqualificationOfficer,
    tallyOperator: election.tallyOperator,
    verifier: election.verifier,
    lateUpdateAllowed: election.lateUpdateAllowed,
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
    tally: election.tally
      ? { counts: election.tally.counts, postedAt: election.tally.postedAt }
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
  const role = opts.user?.role;
  if (
    opts.user &&
    (role === 'tally_operator' || role === 'platform_admin') &&
    electionState(election, now) >= 3
  ) {
    dto.operatorInbox = { acceptedBallots: election.acceptedBallots };
  }
  return dto;
}
