// NOT FOR PROFIT — civic public good, not a commercial product.
// 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied
// Public acceptedBallots is the last hourly snapshot, never a live tick.

import { presentAspects, presentTally, withQuestionMethods } from './ballot.mjs';
import { disclosureSettings, publicDisclosureView, sealDisclosureView, withDisclosedCount } from './disclosure.mjs';
import { electionDisclosurePolicy } from './store.mjs';
import { publicIdFields } from './electionIds.mjs';
import {
  electionTypeName,
  electionTypeOf,
  sealedResultsMessage,
  voteResultsSealed,
} from './electionType.mjs';

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
  const delay = Number(disclosure.delaySeconds) || 0;
  const sealed = Boolean(disclosure.resultsSealed) || voteResultsSealed(election, now);
  let acceptedBallots = election.acceptedBallots;
  if (typeof disclosure.publishedAcceptedBallots === 'number') {
    acceptedBallots = disclosure.publishedAcceptedBallots;
  } else if (sealed || interval > 0) {
    // Disclosed snapshot only. Never the live accept counter.
    acceptedBallots = 0;
  }
  const type = electionTypeOf(election);
  const disclosureView = publicDisclosureView(now, interval, {
    delaySeconds: delay,
    resultsMinVotes: sealed && type === 1 ? undefined : disclosure.resultsMinVotes,
    minBlockVotes: disclosure.minBlockVotes,
    acceptedBallotsDisclosed: acceptedBallots,
  });
  if (sealed) {
    disclosureView.resultsSealed = true;
    disclosureView.sealedUntil = Number.isFinite(Number(election?.cutoffTime)) ? Number(election.cutoffTime) : null;
    disclosureView.note = sealedResultsMessage(election);
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
    electionType: type,
    electionTypeName: electionTypeName(election),
    resultsSealed: sealed,
    sealedUntil: sealed ? election.cutoffTime ?? null : null,
    resultsMessage: sealed ? sealedResultsMessage(election) : null,
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
    tally: sealed
      ? null
      : presentTally(election, election.acceptedBallots)
        ? {
            ...presentTally(election, election.acceptedBallots),
            source: election.tally.source || 'sum_only',
            production: false,
            aggregation: election.tally.aggregation || null,
            openedBallots: election.tally.openedBallots ?? null,
          }
        : null,
    createdAt: election.createdAt,
    disclosure: disclosureView,
    nfp: true,
  };
}

export async function publishDue(deps) {
  const now = deps.config.nowFn();
  const settings = disclosureSettings(deps.config);
  const interval = settings.intervalSeconds;
  const standby = deps.writer && deps.writer.enabled !== false && !deps.writer.acceptingWrites();
  if (!standby && deps.explorer?.disclose) await deps.explorer.disclose(now, interval);
  const view = deps.explorer?.publicDisclosure
    ? deps.explorer.publicDisclosure(now, interval)
    : publicDisclosureView(now, interval, {
        delaySeconds: settings.delaySeconds,
        resultsMinVotes: settings.minVotes,
        minBlockVotes: settings.minBlockVotes,
      });
  return { now, interval, view, settings };
}

export function electionDisclosure(election, deps, view) {
  const now = deps.config.nowFn();
  const policy = electionDisclosurePolicy(election, deps.config, now);
  const acceptedBallotsDisclosed = deps.store.publishedAcceptedBallots(
    election.id,
    now,
    policy.intervalSeconds,
    policy,
  );
  if (policy.resultsSealed) {
    const base =
      view ||
      publicDisclosureView(now, policy.intervalSeconds, {
        delaySeconds: policy.delaySeconds,
        minBlockVotes: policy.minBlockVotes,
        acceptedBallotsDisclosed,
      });
    return withDisclosedCount(sealDisclosureView(base, election), acceptedBallotsDisclosed);
  }
  const base =
    view ||
    publicDisclosureView(now, policy.intervalSeconds, {
      delaySeconds: policy.delaySeconds,
      resultsMinVotes: policy.minVotes,
      minBlockVotes: policy.minBlockVotes,
    });
  return withDisclosedCount(base, acceptedBallotsDisclosed);
}

export function presentElection(election, deps, opts = {}) {
  if (!election) return null;
  const now = opts.now ?? deps.config.nowFn();
  const policy = electionDisclosurePolicy(election, deps.config, now);
  const publishedAcceptedBallots = deps.store.publishedAcceptedBallots(
    election.id,
    now,
    policy.intervalSeconds,
    policy,
  );
  const dto = publicElection(election, now, {
    intervalSeconds: policy.intervalSeconds,
    delaySeconds: policy.delaySeconds,
    resultsMinVotes: policy.minVotes,
    minBlockVotes: policy.minBlockVotes,
    publishedAcceptedBallots,
    resultsSealed: policy.resultsSealed,
  });
  dto.disclosure = withDisclosedCount(dto.disclosure, publishedAcceptedBallots);
  if (
    !dto.resultsSealed &&
    opts.user &&
    deps.store.userHasJurisdictionRole(opts.user, 'tally_operator', election.jurisdictionId) &&
    electionState(election, now) >= 3
  ) {
    dto.operatorInbox = { acceptedBallots: deps.store.visibleAcceptedBallots(election) };
  }
  return dto;
}

export function presentResults(election, deps, opts = {}) {
  const dto = presentElection(election, deps, opts);
  if (dto?.resultsSealed) {
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
      tally: null,
      ballotSpecHash: election.ballotSpecHash,
      cutoffTime: election.cutoffTime,
      ballotMethod: election.ballotMethod || 'plurality',
      electionType: dto.electionType,
      electionTypeName: dto.electionTypeName,
      resultsSealed: true,
      sealed: true,
      sealedUntil: dto.sealedUntil,
      code: 'RESULTS_SEALED',
      message: dto.resultsMessage,
    };
  }
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
    electionType: dto.electionType,
    electionTypeName: dto.electionTypeName,
    resultsSealed: false,
  };
}
