// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election-outcomes monitor. Separate from /elections results and
// /receipt. Phases follow chain / election state: before, during, after.
// Verification reuses the auditor pack. During never publishes unofficial
// option counts.

import { brandName } from './branding.mjs';
import { presentAspects } from './ballot.mjs';
import { publicIdFields, publicIdMatchesScope, l1IdentityOf } from './electionIds.mjs';
import {
  STATE_NAMES,
  electionChainMode,
  electionState,
  presentElection,
} from './electionState.mjs';
import { buildAuditorPack } from './auditorPack.mjs';
import { sealedResultsBody, voteResultsSealed } from './electionType.mjs';
import { buildResults } from './results.mjs';
import { verifyAuditorBundle } from '../../../tools/auditor/verify.mjs';
import { OUTCOME_VERIFY_PATH } from './outcomeReports.mjs';

export const OUTCOMES_SCHEMA = 'zk-voting.outcomes.v1';

export const PHASE_BEFORE = 'before';
export const PHASE_DURING = 'during';
export const PHASE_AFTER = 'after';

export const PHASE_LABELS = {
  before: 'Before voting',
  during: 'During voting',
  after: 'After voting',
};

export const PHASE_NOTES = {
  before:
    'The roll is still forming, or it is frozen and polls have not opened. Verification covers the published window, Merkle roots, and whether this contest is mapped on chain.',
  during:
    'Voting is open. Public turnout is the last closed hour, not a live precinct tick. Option counts are not published until a certified tally is posted.',
  after:
    'Polls are closed. Certified option counts appear only after a tally is posted. When L1 is configured, the tally hash may be mirrored on Ethereum.',
};

/**
 * Map election state (0–4) onto the public monitor phases.
 * 0 Created / 1 RollFrozen → before; 2 Open → during; 3 Closed / 4 Tallied → after.
 * @param {number} state
 */
export function outcomePhase(state) {
  const n = Number(state);
  if (n >= 3) return PHASE_AFTER;
  if (n === 2) return PHASE_DURING;
  return PHASE_BEFORE;
}

export function hexNorm(value) {
  if (value == null || value === '') return '';
  return String(value)
    .toLowerCase()
    .replace(/^0x/, '')
    .padStart(64, '0');
}

export function hexEq(a, b) {
  const na = hexNorm(a);
  const nb = hexNorm(b);
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  return na === nb;
}

function checkBag() {
  const errors = [];
  const checks = {};
  function check(name, cond, message) {
    checks[name] = Boolean(cond);
    if (!cond) errors.push(message || name);
  }
  return { errors, checks, check };
}

function l1IsPosted(l1) {
  if (!l1 || typeof l1 !== 'object') return false;
  return Boolean(
    l1.posted ||
      l1.alreadyPosted ||
      l1.status === 'posted' ||
      l1.status === 'already_posted',
  );
}

function l1StatusOf(election) {
  if (!election?.tally) return null;
  const l1 = election.tally.l1;
  if (!l1) return 'not_posted';
  return l1.status || (l1IsPosted(l1) ? 'posted' : l1.skipped ? 'skipped' : 'unknown');
}

/**
 * Chain-clock and freeze/L1 invariants for the outcomes monitor.
 * Independent of the auditor pack (unique nullifiers / tally sum).
 */
export function verifyChainStatus(election, deps, now, state, phase) {
  const { errors, checks, check } = checkBag();
  const start = Number(election.startTime);
  const cutoff = Number(election.cutoffTime);
  const expected = outcomePhase(state);

  check('phaseMatchesState', phase === expected, `phase ${phase} does not match election state ${state}`);
  check(
    'windowOrder',
    Number.isFinite(start) && Number.isFinite(cutoff) && start < cutoff,
    'startTime must be before cutoffTime',
  );

  if (state === 0) {
    check('createdNotFrozen', !election.rollFrozen, 'Created elections must not be frozen');
    check('createdNotTallied', !election.tally, 'Created elections have no tally');
  } else if (state === 1) {
    check('rollFrozen', election.rollFrozen === true, 'RollFrozen requires freeze');
    check('beforeStart', now < start, 'RollFrozen requires now < startTime');
    check('frozenNotTallied', !election.tally, 'RollFrozen elections have no tally');
  } else if (state === 2) {
    check('openFrozen', election.rollFrozen === true, 'Open requires a frozen roll');
    check('inWindow', now >= start && now < cutoff, 'Open requires now in [startTime, cutoffTime)');
    check('openNotTallied', !election.tally, 'Open elections have no tally');
  } else if (state === 3) {
    check('closedPastCutoff', now >= cutoff, 'Closed requires cutoffTime to have passed');
    check('closedNoTally', !election.tally, 'Closed (awaiting tally) has no posted tally');
  } else if (state === 4) {
    check('talliedHasTally', Boolean(election.tally), 'Tallied requires a posted tally');
  }

  const mode = electionChainMode(election);
  const onchainEvidence = Boolean(election.createTxHash || election.onChainElectionAddress);
  check(
    'chainModeConsistent',
    (mode === 'onchain') === onchainEvidence,
    'chainMode must match createTxHash / onChainElectionAddress',
  );
  if (mode === 'onchain') {
    check(
      'onChainElectionId',
      election.onChainElectionId != null && String(election.onChainElectionId) !== '',
      'on-chain contests need onChainElectionId',
    );
  } else {
    checks.onChainElectionId = true;
  }

  if (election.rollFrozen && !election.lateUpdateAllowed) {
    check(
      'frozenEligibleRoot',
      Boolean(election.frozenEligibleRoot) && hexEq(election.frozenEligibleRoot, election.eligibleRoot),
      'frozen eligible root must match the live eligible root',
    );
    check(
      'frozenDisqualificationRoot',
      election.frozenDisqualificationRoot != null &&
        hexEq(election.frozenDisqualificationRoot, election.disqualificationRoot),
      'frozen disqualification root must match the live disqualification root',
    );
  } else {
    checks.frozenEligibleRoot = true;
    checks.frozenDisqualificationRoot = true;
  }

  const l1 = election.tally?.l1 || null;
  const countsHash = election.tally?.countsHash || null;
  if (l1IsPosted(l1)) {
    check(
      'l1HashMatchesTally',
      Boolean(l1.resultHash) && Boolean(countsHash) && hexEq(l1.resultHash, countsHash),
      'L1 resultHash must match the posted tally countsHash',
    );
  } else {
    checks.l1HashMatchesTally = true;
  }

  const identity = l1IdentityOf(election, deps.config || {});
  const pinned = String(deps.config?.electionFactoryAddress || '').trim();
  const scope = {
    factoryAddress: election.factoryAddress || pinned || null,
    onChainElectionId: election.onChainElectionId,
    jurisdictionId: election.jurisdictionId,
    chainId: election.chainId ?? deps.config?.chainId,
    nodeId: deps.store?.data?.meta?.nodeId || '',
  };
  check(
    'publicIdMatchesScope',
    publicIdMatchesScope(election.id, scope),
    'public UUID must be bound to factory, on-chain id, and jurisdiction (a copied UUID fails)',
  );

  if (l1IsPosted(l1)) {
    check(
      'l1CertificationIdMatches',
      !l1.certificationId || hexEq(l1.certificationId, identity.certificationId),
      'L1 certificationId must be keccak(factory, electionId, jurisdictionId), not the public UUID',
    );
    check(
      'l1PublicIdHashMatches',
      !l1.publicIdHash || hexEq(l1.publicIdHash, identity.publicIdHash),
      'L1 publicIdHash must match this contest’s UUID',
    );
    const postedFactory = l1.factory || identity.factory;
    if (pinned) {
      check(
        'l1FactoryMatchesPinned',
        Boolean(postedFactory) &&
          String(postedFactory).toLowerCase() === String(pinned).toLowerCase(),
        'on-chain factory must be the pinned shared ElectionFactory',
      );
    } else {
      checks.l1FactoryMatchesPinned = true;
    }
  } else {
    checks.l1CertificationIdMatches = true;
    checks.l1PublicIdHashMatches = true;
    checks.l1FactoryMatchesPinned = true;
  }

  return { ok: errors.length === 0, errors, checks };
}

function chainStatusView(election, deps) {
  const mode = electionChainMode(election);
  const l1 = election.tally?.l1 || null;
  return {
    mode,
    chainId: election.chainId ?? deps.config.chainId ?? null,
    configured: Boolean(deps.chain?.isConfigured?.()),
    l1Configured: Boolean(deps.l1?.isConfigured?.()),
    l1SkipReason: deps.l1?.isConfigured?.() ? null : deps.l1?.skipReason?.() || 'L1 env unset',
    createTxHash: election.createTxHash || null,
    onChainElectionAddress: election.onChainElectionAddress || null,
    factoryAddress: election.factoryAddress || deps.config.electionFactoryAddress || null,
    onChainElectionId: election.onChainElectionId != null ? String(election.onChainElectionId) : null,
    l1Status: l1StatusOf(election),
    l1Posted: l1IsPosted(l1),
    l1TxHash: l1?.txHash || null,
    l1ResultHash: l1?.resultHash || null,
    certificationId: l1?.certificationId || null,
    publicIdHash: l1?.publicIdHash || null,
    l1Factory: l1?.factory || election.factoryAddress || deps.config.electionFactoryAddress || null,
    l1JurisdictionId: l1?.jurisdictionId || null,
  };
}

function freezeView(election) {
  return {
    rollFrozen: Boolean(election.rollFrozen),
    frozenAt: election.frozenAt || null,
    lateUpdateAllowed: Boolean(election.lateUpdateAllowed),
    frozenEligibleRoot: election.frozenEligibleRoot || null,
    frozenDisqualificationRoot: election.frozenDisqualificationRoot || null,
  };
}

function rootsView(election) {
  return {
    eligibleRoot: election.eligibleRoot || null,
    disqualificationRoot: election.disqualificationRoot || null,
    ballotSpecHash: election.ballotSpecHash || null,
  };
}

function verifyOutcome(election, deps, now, state, phase) {
  const pack = buildAuditorPack(election, deps);
  const auditor = verifyAuditorBundle(pack);
  if (pack.resultsSealed && auditor.summary) {
    delete auditor.summary.acceptedBallots;
    delete auditor.summary.uniqueNullifiers;
    auditor.summary.resultsSealed = true;
  }
  const chain = verifyChainStatus(election, deps, now, state, phase);
  const errors = [...auditor.errors, ...chain.errors];
  return {
    ok: auditor.ok && chain.ok,
    errors,
    auditor: {
      ok: auditor.ok,
      errors: auditor.errors,
      checks: auditor.checks,
      summary: auditor.summary,
    },
    chain: {
      ok: chain.ok,
      errors: chain.errors,
      checks: chain.checks,
    },
  };
}

function linksFor(election, { tallied } = {}) {
  const id = String(election.id);
  const enc = encodeURIComponent(id);
  return {
    portal: `/outcomes/${enc}`,
    artifacts: `/api/elections/${enc}/artifacts`,
    explorer: `/explorer#/election/${enc}`,
    results: tallied ? `/elections/${enc}/results` : null,
    l1: `/api/elections/${enc}/l1`,
    receipt: '/receipt',
    vote: `/vote/${enc}`,
    officialReport: `/api/outcomes/reports/${enc}`,
    officialPdf: `/api/outcomes/reports/${enc}/pdf`,
    verify: OUTCOME_VERIFY_PATH,
  };
}

/**
 * Compact public card for the before/during/after board.
 * Never includes option counts.
 */
export function presentOutcomeSummary(election, deps, opts = {}) {
  const now = opts.now ?? deps.config.nowFn();
  const dto = presentElection(election, deps, { now });
  const state = dto.state;
  const phase = outcomePhase(state);
  const verification = verifyOutcome(election, deps, now, state, phase);
  const tallied = Boolean(election.tally);
  const official = deps.store.getOutcomeReportForElection?.(election.id) || null;
  return {
    nfp: true,
    ...publicIdFields(election),
    title: election.title,
    jurisdictionId: election.jurisdictionId,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    state,
    stateName: dto.stateName || STATE_NAMES[state],
    chainMode: dto.chainMode,
    chainId: dto.chainId,
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    rollFrozen: Boolean(election.rollFrozen),
    tallied: dto.resultsSealed ? false : tallied,
    electionType: dto.electionType,
    electionTypeName: dto.electionTypeName,
    resultsSealed: Boolean(dto.resultsSealed),
    sealedUntil: dto.sealedUntil,
    resultsMessage: dto.resultsMessage,
    acceptedBallots: dto.resultsSealed ? null : dto.acceptedBallots,
    participantCount: election.participantCount,
    eligibleCount:
      typeof election.eligibleCount === 'number' ? election.eligibleCount : election.participantCount,
    verificationOk: verification.ok,
    l1Status: l1StatusOf(election),
    officialReport: official
      ? {
          id: official.id,
          pdfSha256: official.pdfSha256,
          issuedAt: official.issuedAt,
          verifyPath: OUTCOME_VERIFY_PATH,
        }
      : null,
    href: `/outcomes/${encodeURIComponent(String(election.id))}`,
  };
}

/**
 * Full public monitor for one election. Certified option counts only after a
 * posted tally (phase after). During and before never include unofficial totals.
 */
export function presentOutcomeDetail(election, deps, opts = {}) {
  const now = opts.now ?? deps.config.nowFn();
  const dto = presentElection(election, deps, { now });
  const state = dto.state;
  const phase = outcomePhase(state);
  const verification = verifyOutcome(election, deps, now, state, phase);
  const tallied = Boolean(election.tally);
  const official = deps.store.getOutcomeReportForElection?.(election.id) || null;
  const sealed = Boolean(dto.resultsSealed) || voteResultsSealed(election, now);
  const publishedAcceptedBallots = sealed ? null : dto.acceptedBallots;
  const certified =
    !sealed && phase === PHASE_AFTER && tallied
      ? buildResults(election, { now, publishedAcceptedBallots })
      : null;
  const seal = sealed ? sealedResultsBody(election, now) : null;

  return {
    nfp: true,
    schema: OUTCOMES_SCHEMA,
    product: brandName(),
    electionId: String(election.id),
    ...publicIdFields(election),
    title: election.title,
    jurisdictionId: election.jurisdictionId,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    phaseNote: PHASE_NOTES[phase],
    state,
    stateName: dto.stateName || STATE_NAMES[state],
    electionType: dto.electionType,
    electionTypeName: dto.electionTypeName,
    resultsSealed: sealed,
    sealedUntil: seal?.sealedUntil ?? null,
    resultsMessage: seal?.message ?? null,
    code: seal?.code ?? null,
    window: {
      startTime: election.startTime,
      cutoffTime: election.cutoffTime,
    },
    chain: chainStatusView(election, deps),
    freeze: freezeView(election),
    roots: rootsView(election),
    turnout: sealed
      ? {
          sealed: true,
          acceptedBallots: null,
          participantCount: null,
          eligibleCount: null,
          disclosure: dto.disclosure,
        }
      : {
          acceptedBallots: publishedAcceptedBallots,
          participantCount: election.participantCount,
          eligibleCount:
            typeof election.eligibleCount === 'number' ? election.eligibleCount : election.participantCount,
          disclosure: dto.disclosure,
        },
    questions: presentAspects(election),
    verification,
    certified,
    tallyPostedAt: sealed ? null : election.tally?.postedAt || null,
    countsHash: sealed ? null : election.tally?.countsHash || null,
    officialReport: official
      ? {
          id: official.id,
          pdfSha256: official.pdfSha256,
          integrity: official.integrity,
          issuedAt: official.issuedAt,
          pdfProtected: true,
          pdfModify: false,
          verifyPath: OUTCOME_VERIFY_PATH,
        }
      : null,
    links: linksFor(election, { tallied }),
    coercion: {
      policy: 'one-ballot-per-nullifier',
      receiptsProveChoice: false,
      note:
        'This portal verifies process and certified outcomes. It never shows how any person voted. During voting it does not invent unofficial option counts.',
    },
  };
}

export function presentOutcomesIndex(deps, opts = {}) {
  const now = opts.now ?? deps.config.nowFn();
  const elections = deps.store.listElections().map((election) => presentOutcomeSummary(election, deps, { now }));
  const phases = {
    before: elections.filter((e) => e.phase === PHASE_BEFORE),
    during: elections.filter((e) => e.phase === PHASE_DURING),
    after: elections.filter((e) => e.phase === PHASE_AFTER),
  };
  return {
    nfp: true,
    schema: OUTCOMES_SCHEMA,
    product: brandName(),
    portal: '/outcomes',
    now,
    chain: {
      configured: Boolean(deps.chain?.isConfigured?.()),
      l1Configured: Boolean(deps.l1?.isConfigured?.()),
      chainId: deps.config.chainId,
    },
    disclosure: deps.explorer?.publicDisclosure
      ? deps.explorer.publicDisclosure(now, deps.config.disclosureIntervalSeconds)
      : undefined,
    phases,
    counts: {
      before: phases.before.length,
      during: phases.during.length,
      after: phases.after.length,
      total: elections.length,
    },
    elections,
    coercion: {
      policy: 'one-ballot-per-nullifier',
      receiptsProveChoice: false,
    },
  };
}
