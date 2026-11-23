// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { requireAuth, requireElectionRole, requireJurisdictionRoleFromBody, requirePlatformOperator } from '../auth.mjs';
import { assertExternalClearance } from '../voteGate.mjs';
import {
  electionHasRanked,
  payloadsFromEnvelopes,
  tallyBallots,
  normalizeBallotMethod,
  parseTallyCounts,
  withQuestionMethods,
} from '../ballot.mjs';
import {
  normalizeQuestions,
  presentPublicBallotInfo,
  presentPublicOptionInfo,
  resolveBallotSpecHash,
} from '../ballotSpec.mjs';
import { presentElection, electionState, publishDue, electionDisclosure } from '../electionState.mjs';
import { asyncHandler, HttpError, sanitizeVoteBody } from '../http.mjs';
import { emptyTree } from '../merkle.mjs';
import { presentResults } from '../results.mjs';
import { reasonName } from '../reasonCodes.mjs';
import { relayVote } from '../relay.mjs';
import { tallyAllowedAt } from '../supplementaryBatch.mjs';
import { uuidParam } from '../recordIds.mjs';
import { electionDisclosurePolicy, publicVoteRecord } from '../store.mjs';
import {
  ELECTION_TYPE_VOTE,
  electionTypeOf,
  normalizeElectionType,
  sealedResultsBody,
  sealedResultsMessage,
} from '../electionType.mjs';
import { acceptChoiceBlockPartials, acceptDeal, acceptPartials, enrollGuardian } from '../guardianFlow.mjs';
import {
  RANKED_VERIFICATION,
  assertSealedRankingAllowed,
  firstChoiceMatches,
  openRankedTally,
  rankingSetHash,
  roundsHash,
  sealedRankedChoiceFromCreateBody,
  splitRankingsForGuardians,
} from '../rankedTally.mjs';
import { isOpensBallots, openBallots, rejectInventedCounts, withoutExcludedEnvelopes } from '../tallyOpen.mjs';
import { publicCeremonyView } from '../tallyCrypto.mjs';
import { buildAuditorPack } from '../auditorPack.mjs';
import { dispatchOfficialOutcomeReports } from '../outcomeReports.mjs';
import { createVotePassService } from '../votePass.mjs';
import { partiesRouter } from './parties.mjs';
import { tallyCountsHash } from '../results.mjs';
import { isRollupElection } from '../rollup/service.mjs';
import { publicUser } from '../roles.mjs';
import { deliverRolePromotion } from '../promotionMail.mjs';

const RECEIPT_TAIL = 'Download the receipt or paste it at /receipt — it cannot prove how you voted.';
const REVOTE_SENTENCE = 'A later ballot before the deadline updates the final tally only. A published block keeps the first ballot.';
const ONCE_SENTENCE = 'You may vote only once; a second ballot for this nullifier is rejected.';

function ballotAcceptedMessage({ published, allowRevote }) {
  const base = published
    ? 'Ballot accepted. Choice is not stored in the clear.'
    : 'Ballot accepted for relay. Public proof is published after this hour closes so a person leaving a voting office cannot be matched to a live jurisdiction tick. Choice is not stored in the clear.';
  return `${base} ${allowRevote ? REVOTE_SENTENCE : ONCE_SENTENCE} ${RECEIPT_TAIL}`;
}

function bodyNullifier(body) {
  const inputs = body?.publicInputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs) && inputs.nullifier != null) {
    return inputs.nullifier;
  }
  return body?.nullifier;
}

function unixSeconds(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new HttpError(400, 'invalid timestamp');
  return Math.floor(ms / 1000);
}

function questionsFromCreateBody(body) {
  return normalizeQuestions(body?.questions ?? body?.aspects ?? body?.ballot?.questions);
}

async function revokeHandler(req, store, explorer) {
  const { identityCommitment, evidenceHash } = req.body || {};
  if (identityCommitment == null || identityCommitment === '') {
    throw new HttpError(400, 'identityCommitment required');
  }
  const { election, record } = await store.revokeDisqualification(req.params.id, {
    identityCommitment,
    evidenceHash,
    issuer: req.user.handle,
  });
  await explorer.append('revoke', {
    electionId: String(election.id),
    identityCommitment: record.identityCommitment,
    evidenceHash: record.revokeEvidenceHash,
    eligibleRoot: election.eligibleRoot,
    disqualificationRoot: election.disqualificationRoot,
    eligibleCount: election.eligibleCount,
  });
  return election;
}

export function electionsRouter(deps) {
  const { store, explorer, config, pin, rollup } = deps;
  const votePass = deps.votePass || createVotePassService(config);
  const router = Router();
  router.param('id', uuidParam('id'));
  router.param('requestId', uuidParam('requestId'));

  // On a node connected to the rollup, a civic vote takes ballots only once it is on L1.
  // It is never counted on the node instead. (A node without the rollup keeps the demo path.)
  function assertCivicVoteOnL1(election) {
    if (!rollup?.enabled || electionTypeOf(election) !== ELECTION_TYPE_VOTE) return;
    if (!election.rollup?.electionId) {
      throw new HttpError(409, 'this civic vote is not published to L1 yet', { code: 'VOTE_NOT_ON_L1' });
    }
  }

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      await publishDue(deps);
      res.json({
        nfp: true,
        elections: store.listPublicElections().map((e) => presentElection(e, deps)),
      });
    }),
  );

  router.post(
    '/',
    requireAuth,
    requireJurisdictionRoleFromBody(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const title = String(body.title || '').trim();
      if (!title) throw new HttpError(400, 'title required');
      const now = Math.floor(Date.now() / 1000);
      const startTime = unixSeconds(body.startTime, now);
      const cutoffTime = unixSeconds(body.cutoffTime, now + 7 * 24 * 3600);
      if (!(startTime < cutoffTime)) throw new HttpError(400, 'startTime must be before cutoffTime');
      const treeDepth = Number(body.treeDepth || 20);
      if (!Number.isInteger(treeDepth) || treeDepth < 16 || treeDepth > 32) {
        throw new HttpError(400, 'treeDepth must be 16..32');
      }
      try {
        emptyTree(treeDepth);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      const maxParticipants = Number(body.maxParticipants ?? 0);
      if (!Number.isInteger(maxParticipants) || maxParticipants < 0) {
        throw new HttpError(400, 'maxParticipants must be >= 0 (0 = unlimited)');
      }
      const ballotMethod = normalizeBallotMethod(body.ballotMethod);
      let electionType;
      try {
        electionType = normalizeElectionType(body.electionType);
      } catch (err) {
        throw new HttpError(400, err.message, { code: err.code || 'INVALID_ELECTION_TYPE' });
      }
      const questions = withQuestionMethods(questionsFromCreateBody(body), ballotMethod);
      const sealedRankedChoice = sealedRankedChoiceFromCreateBody(body, electionType);
      const ballotSpecHash = resolveBallotSpecHash({
        title,
        questions,
        ballotSpecHash: body.ballotSpecHash,
        sealedRankedChoice,
      });
      const jurisdiction = store.getJurisdiction(String(body.jurisdictionId || 'demo'));
      if (!jurisdiction) {
        throw new HttpError(400, 'unknown jurisdictionId');
      }
      const jurisdictionId = jurisdiction.id;
      // The node record is the draft. A civic vote reaches L1 only through
      // POST /api/elections/:id/rollup/publish, once its guardians are enrolled.
      const election = await store.createElection({
        title,
        metadataURI: String(body.metadataURI || ''),
        startTime,
        cutoffTime,
        maxParticipants,
        treeDepth,
        ballotSpecHash,
        ballotMethod,
        electionType,
        questions,
        jurisdictionId,
        clerk: body.clerk || '',
        registrar: body.registrar || '',
        disqualificationOfficer: body.disqualificationOfficer || '',
        tallyOperator: body.tallyOperator || '',
        verifier: body.verifier || '',
        lateUpdateAllowed: Boolean(body.lateUpdateAllowed),
        sealedRankedChoice,
        tallyScheme: body.tallyScheme,
        opensBallots: body.opensBallots,
        threshold: body.threshold,
        guardianCount: body.guardianCount,
        aggregation: body.aggregation,
        createdBy: req.user.id,
      });
      await explorer.append('election_created', {
        electionId: String(election.id),
        shortCode: election.shortCode,
        title: election.title,
        jurisdictionId: election.jurisdictionId,
        startTime: election.startTime,
        cutoffTime: election.cutoffTime,
      });
      const dto = presentElection(election, deps);
      res.status(201).json({
        ok: true,
        id: election.id,
        electionId: election.id,
        shortCode: election.shortCode,
        election: dto,
        links: dto.links,
        nfp: true,
      });
    }),
  );

  router.use('/:id/parties', partiesRouter(deps));

  router.get(
    '/:id/staff',
    requireAuth,
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      if (!store.userIsElectionStaff(req.user, election)) {
        throw new HttpError(403, 'forbidden', {
          role: req.user.role,
          jurisdictionId: election.jurisdictionId,
        });
      }
      res.json({
        nfp: true,
        electionId: String(election.id),
        staff: store.listElectionStaff(election),
      });
    }),
  );

  router.post(
    '/:id/staff',
    requireAuth,
    requirePlatformOperator,
    asyncHandler(async (req, res) => {
      const result = await store.approveElectionStaff(req.params.id, req.body || {});
      const mail = await deliverRolePromotion(deps, {
        role: 'election_staff',
        user: result.user,
        created: Boolean(result.created && result.user),
        skipReason: result.user ? (result.created ? null : 'already_granted') : 'no_user',
        contactEmail: req.body?.contactEmail,
        jurisdictionId: result.election.jurisdictionId,
        electionId: result.election.id,
        electionTitle: result.election.title,
        grantedByHandle: req.user.handle,
      });
      res.status(201).json({
        ok: true,
        nfp: true,
        created: Boolean(result.created),
        staff: result.staff,
        user: publicUser(result.user),
        mail,
      });
    }),
  );

  router.delete(
    '/:id/staff',
    requireAuth,
    requirePlatformOperator,
    asyncHandler(async (req, res) => {
      const result = await store.revokeElectionStaff(req.params.id, {
        ...(req.body || {}),
        handle: req.body?.handle || req.query?.handle,
        userId: req.body?.userId || req.query?.userId,
        address: req.body?.address || req.query?.address,
      });
      res.json({ ok: true, nfp: true, user: publicUser(result.user) });
    }),
  );

  router.get(
    '/:id/info',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      res.json(presentPublicBallotInfo(election, deps.config.nowFn()));
    }),
  );

  router.get(
    '/:id/info/:questionId/:optionId',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const dto = presentPublicOptionInfo(
        election,
        req.params.questionId,
        req.params.optionId,
        deps.config.nowFn(),
      );
      if (!dto) throw new HttpError(404, 'option not found');
      res.json(dto);
    }),
  );

  const patchBallot = asyncHandler(async (req, res) => {
    const election = store.requireElection(req.params.id);
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'electionType')) {
      let nextType;
      try {
        nextType = normalizeElectionType(body.electionType, { required: true });
      } catch (err) {
        throw new HttpError(400, err.message, { code: err.code || 'INVALID_ELECTION_TYPE' });
      }
      if (nextType !== electionTypeOf(election)) {
        throw new HttpError(409, 'election type is immutable', { code: 'ELECTION_TYPE_IMMUTABLE' });
      }
    }
    const title = body.title != null ? String(body.title).trim() : election.title;
    if (!title) throw new HttpError(400, 'title required');
    const ballotMethod = normalizeBallotMethod(
      body.ballotMethod != null ? body.ballotMethod : election.ballotMethod,
    );
    const questions =
      body.questions != null || body.aspects != null
        ? withQuestionMethods(normalizeQuestions(body.questions ?? body.aspects), ballotMethod)
        : withQuestionMethods(election.questions, ballotMethod);
    const metadataURI =
      body.metadataURI != null ? String(body.metadataURI) : election.metadataURI;
    const startTime =
      body.startTime != null ? unixSeconds(body.startTime, election.startTime) : election.startTime;
    const cutoffTime =
      body.cutoffTime != null ? unixSeconds(body.cutoffTime, election.cutoffTime) : election.cutoffTime;
    if (!(startTime < cutoffTime)) throw new HttpError(400, 'startTime must be before cutoffTime');
    if (body.sealedRankedChoice != null && (body.sealedRankedChoice === true) !== (election.sealedRankedChoice === true)) {
      throw new HttpError(409, 'sealedRankedChoice is fixed at creation and bound into ballotSpecHash', {
        code: 'SETTING_LOCKED',
      });
    }
    const ballotSpecHash = resolveBallotSpecHash({
      title,
      questions,
      ballotSpecHash: body.ballotSpecHash,
      sealedRankedChoice: election.sealedRankedChoice === true,
    });
    const updated = await store.updateElectionBallot(req.params.id, {
      title,
      metadataURI,
      questions,
      ballotSpecHash,
      ballotMethod,
      startTime,
      cutoffTime,
    });
    res.json({
      ok: true,
      id: updated.id,
      electionId: updated.id,
      election: presentElection(updated, deps),
      nfp: true,
    });
  });

  router.patch('/:id', requireAuth, requireElectionRole(store, 'clerk'), patchBallot);
  router.put('/:id', requireAuth, requireElectionRole(store, 'clerk'), patchBallot);

  router.delete(
    '/:id',
    requireAuth,
    requireElectionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const deleted = await store.deleteUnusedElection(req.params.id, {
        confirmTitle: req.body?.confirmTitle,
      });
      res.json({ ok: true, nfp: true, deleted });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const dto = presentElection(election, deps, { user: req.user });
      if (req.user && req.user.role !== 'observer') {
        dto.me = store.voterStatus(election.id, req.user.id);
      }
      res.json(dto);
    }),
  );

  router.get(
    '/:id/results',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      res.json(presentResults(election, deps));
    }),
  );

  router.get(
    '/:id/summary',
    asyncHandler(async (req, res) => {
      const { view } = await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const dto = presentElection(election, deps);
      const tallied = Boolean(election.tally) && !dto.resultsSealed;
      const seal = dto.resultsSealed ? sealedResultsBody(election, deps.config.nowFn()) : null;
      res.json({
        nfp: true,
        electionId: String(election.id),
        title: election.title,
        jurisdictionId: election.jurisdictionId,
        electionType: dto.electionType,
        electionTypeName: dto.electionTypeName,
        state: dto.state,
        stateName: dto.stateName,
        startTime: election.startTime,
        cutoffTime: election.cutoffTime,
        participantCount: election.participantCount,
        acceptedBallots: dto.acceptedBallots,
        resultsSealed: Boolean(dto.resultsSealed),
        sealedUntil: seal?.sealedUntil ?? null,
        message: seal?.message ?? null,
        code: seal?.code ?? null,
        disclosure: electionDisclosure(election, deps, view),
        explorerUrl: `/explorer#/election/${encodeURIComponent(String(election.id))}`,
        resultsUrl: tallied ? `/elections/${election.id}/results` : null,
      });
    }),
  );

  router.get(
    '/:id/ballots',
    asyncHandler(async (req, res) => {
      const { now, view } = await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const policy = electionDisclosurePolicy(election, deps.config, now);
      const published = store.listPublishedVotes(election.id, now, policy.intervalSeconds, policy);
      const seal = policy.resultsSealed ? sealedResultsBody(election, now) : null;
      res.json({
        electionId: String(election.id),
        electionType: policy.electionType,
        electionTypeName: seal?.electionTypeName,
        acceptedBallots: published.length,
        ballots: published.map(publicVoteRecord),
        disclosure: electionDisclosure(election, deps, view),
        ...(seal || { resultsSealed: false }),
        ...(seal ? { message: sealedResultsMessage(election) } : {}),
        nfp: true,
      });
    }),
  );

  router.get(
    '/:id/artifacts',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      res.json(buildAuditorPack(election, deps));
    }),
  );

  router.get(
    '/:id/envelopes',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const now = config.nowFn();
      if (now < election.cutoffTime) {
        throw new HttpError(409, 'envelopes available after cutoff', { code: 'NOT_CLOSED' });
      }
      const listedEnvelopes = store.listEnvelopes(election.id);
      for (const env of listedEnvelopes) {
        if ('userId' in env || 'choice' in env) {
          throw new HttpError(500, 'privacy invariant violated');
        }
      }
      // Flag excluded rows so guardian tooling skips them (same set the node sums).
      const keptRows = new Set(
        withoutExcludedEnvelopes(listedEnvelopes, store.excludedNullifiers(election.id)).envelopes,
      );
      const envelopes = listedEnvelopes.map((env) => (keptRows.has(env) ? env : { ...env, excluded: true }));
      if (electionHasRanked(election)) {
        // Rankings go in a separate list sorted by random rankingId, with no
        // nullifier next to them. Excluded and deleted rows are dropped.
        const live = envelopes.filter((env) => env.excluded !== true && env.is_deleted !== true);
        const split = splitRankingsForGuardians(live);
        const rows = splitRankingsForGuardians(envelopes).envelopes;
        res.json({ electionId: String(election.id), envelopes: rows, rankings: split.rankings, nfp: true });
        return;
      }
      res.json({ electionId: String(election.id), envelopes, nfp: true });
    }),
  );

  router.get(
    '/:id/registrations',
    requireAuth,
    requireElectionRole(store, 'clerk', 'registrar', 'disqualification_officer'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      res.json({
        electionId: String(election.id),
        registrations: store.listRegistrations(election.id),
        requests: store.listRegistrationRequests(election.id),
        nfp: true,
      });
    }),
  );

  router.get(
    '/:id/registration-requests',
    requireAuth,
    requireElectionRole(store, 'clerk', 'registrar'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const status = req.query?.status ? String(req.query.status) : undefined;
      res.json({
        nfp: true,
        electionId: String(election.id),
        requests: store.listRegistrationRequests(election.id, { status }),
        provider: {
          mode: 'manual',
          note: 'Civil officers of this election’s jurisdiction approve each request by hand. A later connector can automate document checks; it does not skip this approval.',
        },
      });
    }),
  );

  router.post(
    '/:id/register',
    requireAuth,
    asyncHandler(async (req, res) => {
      if (req.user.role === 'observer') throw new HttpError(403, 'observers are read-only');
      const election = store.requireElection(req.params.id);
      const identityCommitment = req.body?.identityCommitment;
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const forUser = req.body?.userId;
      let userId = req.user.id;
      if (forUser && forUser !== req.user.id) {
        if (!store.userHasJurisdictionRole(req.user, 'registrar', election.jurisdictionId)) {
          throw new HttpError(403, 'only registrar may register another user');
        }
        userId = forUser;
      }
      const officerInsert = store.canApproveRegistration(req.user, election);
      if (!officerInsert) {
        const { request, created } = await store.createRegistrationRequest(election.id, {
          userId,
          identityCommitment,
          note: req.body?.note,
        });
        if (created) {
          await store.addNotification({
            userId,
            type: 'registration_pending',
            title: 'Registration pending civil review',
            body: `A registrar or clerk of this election must approve before you are on the roll for ${election.title}. Choice is never shown here.`,
            electionId: election.id,
          });
        }
        res.status(202).json({
          ok: true,
          nfp: true,
          status: 'pending',
          code: 'PENDING_REVIEW',
          electionId: String(election.id),
          request: store.publicRegistrationRequest(request),
          message:
            'Registration submitted for civil review. A registrar or clerk of this election’s jurisdiction must approve before you are on the roll.',
        });
        return;
      }
      const result = await store.registerCommitment(req.params.id, identityCommitment, { userId });
      const pending = store.findPendingRequestForCommitment(election.id, result.identityCommitment);
      if (pending && pending.status === 'pending') {
        pending.status = 'approved';
        pending.reviewedAt = new Date().toISOString();
        pending.reviewedBy = req.user.id;
        await store.persist();
      }
      await explorer.append('register', {
        electionId: String(result.election.id),
        identityCommitment: result.identityCommitment,
        leafIndex: result.leafIndex,
      });
      await store.addNotification({
        userId,
        type: 'registered',
        title: 'You are registered',
        body: `Registered for ${result.election.title}. Choice is never shown here.`,
        electionId: result.election.id,
      });
      res.status(201).json({
        ok: true,
        status: 'registered',
        electionId: String(result.election.id),
        identityCommitment: result.identityCommitment,
        leafIndex: result.leafIndex,
        eligibleRoot: result.eligibleRoot,
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/registration-requests/:requestId/approve',
    requireAuth,
    requireElectionRole(store, 'clerk', 'registrar'),
    asyncHandler(async (req, res) => {
      const result = await store.approveRegistrationRequest(req.params.id, req.params.requestId, {
        reviewer: req.user,
      });
      if (!result.alreadyApproved) {
        await explorer.append('register', {
          electionId: String(result.election.id),
          identityCommitment: result.identityCommitment,
          leafIndex: result.leafIndex,
        });
        await store.addNotification({
          userId: result.request.userId,
          type: 'registered',
          title: 'You are registered',
          body: `A civil officer approved your registration for ${result.election.title}. Choice is never shown here.`,
          electionId: result.election.id,
        });
      }
      res.json({
        ok: true,
        nfp: true,
        status: 'registered',
        electionId: String(result.election.id),
        identityCommitment: result.identityCommitment,
        leafIndex: result.leafIndex,
        eligibleRoot: result.eligibleRoot,
        request: store.publicRegistrationRequest(result.request),
      });
    }),
  );

  router.post(
    '/:id/registration-requests/:requestId/deny',
    requireAuth,
    requireElectionRole(store, 'clerk', 'registrar'),
    asyncHandler(async (req, res) => {
      const result = await store.denyRegistrationRequest(req.params.id, req.params.requestId, {
        reviewer: req.user,
        reason: req.body?.reason,
      });
      await store.addNotification({
        userId: result.request.userId,
        type: 'registration_denied',
        title: 'Registration not approved',
        body: `A civil officer declined your registration for ${result.election.title}. You may bind another credential and request again.`,
        electionId: result.election.id,
      });
      res.json({
        ok: true,
        nfp: true,
        status: 'denied',
        electionId: String(result.election.id),
        request: store.publicRegistrationRequest(result.request),
      });
    }),
  );

  router.post(
    '/:id/freeze',
    requireAuth,
    requireElectionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      const election = await store.freezeElection(req.params.id);
      await explorer.append('roll_frozen', {
        electionId: String(election.id),
        eligibleRoot: election.eligibleRoot,
        disqualificationRoot: election.disqualificationRoot,
        frozenEligibleRoot: election.frozenEligibleRoot,
        frozenDisqualificationRoot: election.frozenDisqualificationRoot,
        participantCount: election.participantCount,
        eligibleCount: election.eligibleCount,
      });
      res.json({ ok: true, election: presentElection(election, deps), nfp: true });
    }),
  );

  // Public key for session-less vote passes (RSA blind signatures).
  router.get(
    '/:id/vote-pass',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      res.json({ ...(await votePass.publicKey()), electionId: String(election.id), nfp: true });
    }),
  );

  // Eligibility step, separate from the ballot. This request may carry the
  // session, the vote PIN token and (for external-party elections) the
  // identity commitment. It returns a blind signature only; the Node never
  // sees the token it signs, so it cannot link this request to the ballot.
  router.post(
    '/:id/vote-pass',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      if (election.votingPaused) {
        throw new HttpError(409, 'election paused', { code: 'ELECTION_PAUSED' });
      }
      assertCivicVoteOnL1(election);
      const body = req.body || {};
      if (body.blinded == null || body.blinded === '') {
        throw new HttpError(400, 'blinded vote pass required', { code: 'VOTE_PASS_BAD' });
      }
      const hasParties = store.listActiveExternalParties(election.id).length > 0;
      let commitmentSubject = null;
      if (hasParties) {
        const rawCommitment = body.identityCommitment;
        if (rawCommitment == null || rawCommitment === '') {
          throw new HttpError(400, 'identityCommitment required for external party clearance', {
            code: 'IDENTITY_COMMITMENT_REQUIRED',
          });
        }
        await assertExternalClearance(store, election.id, rawCommitment, { now: config.nowFn() });
        commitmentSubject = `c:${String(rawCommitment)}`;
      }
      if (isRollupElection(election)) {
        // A civic vote's ballot reaches the L2 operator with no eligibility proof yet
        // (the batch circuit is not built), so the pass is the gate: only a signed-in
        // voter whose registered commitment is on the roll, and one pass each. The pass
        // stays blind, so the ballot still cannot be tied to this request.
        if (!req.user) throw new HttpError(401, 'sign in to get a vote pass', { code: 'SIGN_IN_REQUIRED' });
        const link = store.findLink(election.id, req.user.id);
        if (!link || !store.isEligible(election.id, link.identityCommitment)) {
          throw new HttpError(403, 'you are not on the roll for this vote', { code: 'NOT_ON_ROLL' });
        }
        commitmentSubject = commitmentSubject || `u:${req.user.id}`;
      }
      if (req.user && pin) {
        pin.assertVoteAllowed(req.user, body.pinToken);
      }
      const blindSignature = await votePass.signBlinded(body.blinded);
      // One pass per cleared commitment per process (in memory only).
      votePass.claimIssue(election.id, commitmentSubject);
      res.status(201).json({
        ok: true,
        nfp: true,
        blindSignature,
        message:
          'Vote pass signed blind. Unblind it in this browser and cast the ballot without your session; the Node cannot tie the pass to this request.',
      });
    }),
  );

  // Ballot submission. Session-less by design: identity fields in the body are
  // dropped (see relay.mjs), no outcome subscription is created here, and when
  // a vote pass is presented the session cookie is not consulted at all.
  router.post(
    '/:id/vote',
    asyncHandler(async (req, res) => {
      const electionForGate = store.getElection(req.params.id);
      if (electionForGate?.votingPaused) {
        throw new HttpError(409, 'election paused', { code: 'ELECTION_PAUSED' });
      }
      if (electionForGate) assertCivicVoteOnL1(electionForGate);
      const rawBody = req.body || {};
      let spentPassHash = null;
      if (rawBody.votePass && electionForGate) {
        spentPassHash = await votePass.verify(electionForGate.id, rawBody.votePass);
        // A spent pass may replace a stored ballot only while re-vote is on.
        // The pass stays an unlinked hash: any already-spent pass qualifies,
        // and nothing records which pass belongs to this nullifier.
        const storedBallot = config.allowRevote === true && !isRollupElection(electionForGate)
          ? store.findVote(electionForGate.id, bodyNullifier(rawBody))
          : null;
        if (store.votePassSpent(electionForGate.id, spentPassHash) && !storedBallot) {
          throw new HttpError(409, 'vote pass already used', { code: 'VOTE_PASS_SPENT' });
        }
      } else if (electionForGate && store.listActiveExternalParties(electionForGate.id).length) {
        // Clearance now happens on POST /vote-pass, never on the ballot request.
        throw new HttpError(403, 'a vote pass is required: external party clearance happens before the ballot', {
          code: 'VOTE_PASS_REQUIRED',
        });
      } else if (req.user && pin) {
        // Legacy signed-in path (API clients). Nothing about req.user is
        // persisted with the ballot. The shipped SPA uses a vote pass instead.
        pin.assertVoteAllowed(req.user, rawBody.pinToken);
      }
      if (isRollupElection(electionForGate)) {
        // Civic vote on the rollup: the encrypted vector goes to the L2 operator.
        // This node keeps the receipt only, never the ciphertexts.
        // The pass is the only eligibility gate until the batch circuit proves roll
        // membership, so it is required here (no signed-in PIN shortcut).
        if (!spentPassHash) {
          throw new HttpError(403, 'a vote pass is required', { code: 'VOTE_PASS_REQUIRED' });
        }
        // A second ballot under a nullifier is refused in castBallot (NULLIFIER_USED):
        // nullifiers are public in batch pubdata and nothing yet proves the sender owns
        // one, so a replacement could overwrite another voter's ballot.
        if (store.votePassSpent(electionForGate.id, spentPassHash)) {
          throw new HttpError(409, 'vote pass already used', { code: 'VOTE_PASS_SPENT' });
        }
        const receipt = await rollup.castBallot(electionForGate.id, rawBody);
        if (spentPassHash) await store.spendVotePass(electionForGate.id, spentPassHash);
        res.status(201).json({
          ok: true,
          accepted: true,
          rollup: true,
          receipt,
          message: 'Your encrypted ballot is with the operator. It is counted only in the final sum.',
          nfp: true,
        });
        return;
      }
      const body = sanitizeVoteBody(rawBody);
      const result = await relayVote({
        store,
        explorer,
        config,
        electionId: req.params.id,
        body,
        now: config.nowFn(),
        intervalSeconds: config.disclosureIntervalSeconds,
        spentPassHash,
      });
      res.status(201).json({
        ok: true,
        accepted: true,
        published: result.published,
        nextPublishAt: result.nextPublishAt,
        vote: result.vote,
        receipt: result.receipt,
        ...(result.rankingHash ? { rankingHash: result.rankingHash } : {}),
        message: ballotAcceptedMessage({ published: result.published, allowRevote: config.allowRevote === true }),
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/disqualify',
    requireAuth,
    requireElectionRole(store, 'disqualification_officer'),
    asyncHandler(async (req, res) => {
      const { identityCommitment, reasonCode, evidenceHash } = req.body || {};
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const { election, record } = await store.disqualify(req.params.id, {
        identityCommitment,
        reasonCode,
        evidenceHash,
        issuer: req.user.handle,
      });
      await explorer.append('disqualify', {
        electionId: String(election.id),
        identityCommitment: record.identityCommitment,
        reasonCode: record.reasonCode,
        evidenceHash: record.evidenceHash,
        eligibleRoot: election.eligibleRoot,
        disqualificationRoot: election.disqualificationRoot,
        eligibleCount: election.eligibleCount,
      });
      const linked = store.findUserIdForCommitment(election.id, record.identityCommitment);
      await store.addNotification({
        userId: linked,
        type: 'disqualified',
        title: 'Disqualified',
        body: `Reason code ${record.reasonCode} (${reasonName(record.reasonCode)}).`,
        electionId: election.id,
      });
      res.status(201).json({
        ok: true,
        disqualification: {
          electionId: record.electionId,
          identityCommitment: record.identityCommitment,
          reasonCode: record.reasonCode,
          evidenceHash: record.evidenceHash,
          issuedAt: record.issuedAt,
        },
        eligibleRoot: election.eligibleRoot,
        election: presentElection(election, deps),
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/disqualify/revoke',
    requireAuth,
    requireElectionRole(store, 'disqualification_officer'),
    asyncHandler(async (req, res) => {
      const election = await revokeHandler(req, store, explorer);
      res.json({ ok: true, election: presentElection(election, deps), nfp: true });
    }),
  );

  router.post(
    '/:id/revoke',
    requireAuth,
    requireElectionRole(store, 'disqualification_officer'),
    asyncHandler(async (req, res) => {
      const election = await revokeHandler(req, store, explorer);
      res.json({ ok: true, election: presentElection(election, deps), nfp: true });
    }),
  );

  router.get(
    '/:id/tally-key',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const fallback = {
        scheme: 'none',
        threshold: 0,
        guardians: 0,
        production: false,
        aggregation: null,
        warning:
          'No tally encryption key. Legacy sum-only demo: any counts that sum to acceptedBallots are accepted.',
      };
      const ceremony = publicCeremonyView(election.tallyCeremony) || fallback;
      res.json({
        electionId: String(election.id),
        tallyScheme: election.tallyScheme || 'sum_only',
        ceremony,
        production: false,
        warning: ceremony.warning || fallback.warning,
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/guardians',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const guardian = await enrollGuardian(store, req.params.id, req.body || {});
      const election = store.requireElection(req.params.id);
      res.status(201).json({
        ok: true,
        guardian,
        ceremony: publicCeremonyView(election.tallyCeremony),
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/guardians/deals',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = await acceptDeal(store, req.params.id, req.body || {});
      res.status(201).json({
        ok: true,
        status: election.tallyCeremony?.status,
        ceremony: publicCeremonyView(election.tallyCeremony),
        nfp: true,
      });
    }),
  );

  router.get(
    '/:id/guardians/:index/inbox',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const index = Number(req.params.index);
      const member = (election.tallyCeremony?.roster || []).find((g) => g.index === index);
      if (!member) throw new HttpError(404, 'guardian not enrolled', { code: 'UNKNOWN_GUARDIAN' });
      const bucket = store.guardianMaterial(election.id);
      const encryptedShares = {};
      const commitmentsByDealer = {};
      for (const deal of bucket?.deals || []) {
        if (deal.encryptedShares?.[String(index)]) encryptedShares[String(deal.index)] = deal.encryptedShares[String(index)];
        commitmentsByDealer[String(deal.index)] = deal.commitments;
      }
      res.json({
        electionId: String(election.id),
        index,
        guardianId: member.guardianId,
        threshold: election.tallyCeremony.threshold,
        guardians: election.tallyCeremony.guardians,
        status: election.tallyCeremony.status,
        transportPublicKey: member.transportPublicKey,
        encryptedShares,
        commitmentsByDealer,
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/guardians/partials',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const now = Math.floor(Date.now() / 1000);
      if (now < election.cutoffTime) {
        throw new HttpError(409, 'partial decryptions are accepted after cutoff', { code: 'NOT_CLOSED' });
      }
      const saved = await acceptPartials(store, election.id, req.body || {});
      res.status(201).json({ ok: true, ...saved, nfp: true });
    }),
  );

  router.post(
    '/:id/choice-blocks/partials',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const saved = await acceptChoiceBlockPartials(store, election.id, req.body || {}, deps);
      res.status(201).json({ ok: true, index: saved.index, blockId: saved.blockId, count: saved.count, nfp: true });
    }),
  );

  router.post(
    '/:id/tally',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      if (isRollupElection(election)) {
        throw new HttpError(409, 'this vote is tallied on L1: guardians open the final sum there', {
          code: 'ROLLUP_TALLY',
        });
      }
      const now = config.nowFn();
      const state = electionState(election, now);
      if (now < tallyAllowedAt(election, config.tallyChallengeSeconds)) {
        throw new HttpError(400, 'election still open', { code: 'NOT_CLOSED', state });
      }
      const pendingReleases = (store.requireElection(election.id).excludedBallots || []).filter(
        (row) => row && row.releasePending === true,
      ).length;
      if (pendingReleases) {
        throw new HttpError(409, 'an excluded ballot is still waiting to leave the hold list', {
          code: 'EXCLUSION_RELEASE_PENDING',
          pending: pendingReleases,
        });
      }
      let nums;
      let source = 'sum_only';
      let openedBallots = null;
      let opened = null;
      let irv = null;
      const countedBallots = Math.max(
        0,
        Number(election.acceptedBallots) - store.hiddenVoteCount(election.id) - store.liveExcludedCount(election.id),
      );


      if (isOpensBallots(election)) {
        assertSealedRankingAllowed(election);
        const bucket = store.guardianMaterial(election.id);
        const listed = store.listEnvelopes(election.id, { includeDeleted: true });
        const split = withoutExcludedEnvelopes(listed, store.excludedNullifiers(election.id));
        opened = await openBallots(
          election,
          split.envelopes,
          bucket?.partials || [],
          election.questions,
          split.excludedLive,
        );
        if (Array.isArray(req.body?.counts) && req.body.counts.length > 0) {
          const submitted = req.body.counts.map((n) => Number(n));
          if (submitted.some((n) => !Number.isInteger(n) || n < 0)) {
            throw new HttpError(400, 'counts must be non-negative integers');
          }
          rejectInventedCounts(submitted, opened.counts);
        }
        nums = opened.counts;
        source = 'opens_ballots';
        openedBallots = null;
        if (electionHasRanked(election)) {
          // Sealed ranked-choice: guardians opened each ranking envelope; IRV
          // runs here and is recomputable from the published ranking set.
          // Ranking hashes were already bound at cast time (AG tag) and on
          // chain in the inbox batch (submitVoteBatchRanked).
          irv = await openRankedTally(election, split.envelopes.filter((env) => env?.is_deleted !== true), bucket?.rankingPartials || []);
          irv.aggregateFirstRoundMatches = firstChoiceMatches(election, nums, irv.counts);
        }
      } else {
        if (!electionHasRanked(election)) {
          nums = parseTallyCounts(
            req.body || {},
            election.questions || [],
            countedBallots,
            election.ballotMethod,
          );
        } else {
          // Fixture / sum-only ranked elections: rankings were validated as
          // plaintext payloads at intake, so IRV runs on them directly.
          const listed = store.listEnvelopes(election.id);
          const live = withoutExcludedEnvelopes(listed, store.excludedNullifiers(election.id)).envelopes;
          const ballots = payloadsFromEnvelopes(live);
          const ran = tallyBallots(election, ballots);
          const rankedQuestions = ran.questions.filter((q) => q.ballotMethod === 'ranked_choice');
          irv = {
            ...ran,
            rankedBallots: ballots.length,
            invalidRankings: 0,
            rankingSetHash: rankingSetHash(ballots),
            roundsHash: roundsHash(rankedQuestions),
            verification: RANKED_VERIFICATION,
          };
          // Counts are derived from the rankings (first-round for ranked
          // questions), never typed in by the operator.
          nums = ran.counts;
        }
      }

      const countsHash = tallyCountsHash(nums);
      const extras = {
        countsHash,
        ballotMethod: irv?.ballotMethod || (source === 'opens_ballots' ? 'plurality' : election.ballotMethod || 'plurality'),
        source,
        openedBallots,
        aggregation: opened?.aggregation || null,
        guardianThreshold: election.tallyCeremony?.threshold ?? null,
      };
      if (irv?.questions?.length) extras.questions = irv.questions;
      if (irv?.rankingSetHash) {
        extras.ranked = {
          rankingSetHash: irv.rankingSetHash,
          roundsHash: irv.roundsHash,
          rankedBallots: irv.rankedBallots,
          invalidRankings: irv.invalidRankings,
          swappedRankings: irv.swappedRankings ?? 0,
          firstChoiceMismatches: irv.firstChoiceMismatches ?? 0,
          unboundRankings: irv.unboundRankings ?? 0,
          firstChoiceConsistent: irv.firstChoiceConsistent,
          aggregateFirstRoundMatches: irv.aggregateFirstRoundMatches ?? null,
          openedRankings: irv.openedRankings || null,
          rankingHashes: irv.rankingHashes || null,
          verification: irv.verification,
        };
      }
      const tallied = await store.setTally(election.id, nums, extras);
      await explorer.append('tally', {
        electionId: String(tallied.id),
        counts: nums,
        acceptedBallots: tallied.acceptedBallots,
        countedBallots,
        source,
        production: false,
        countsHash,
        ballotMethod: tallied.tally?.ballotMethod,
        winners: (tallied.tally?.questions || []).map((q) => q.winner).filter(Boolean),
        ...(extras.ranked ? { ranked: extras.ranked } : {}),
      });
      const fresh = store.requireElection(tallied.id);
      await dispatchOfficialOutcomeReports(deps, { electionId: fresh.id });
      res.json({
        ok: true,
        election: presentElection(fresh, deps),
        tally: {
          counts: nums,
          source,
          production: false,
          openedBallots,
        },
        nfp: true,
      });
    }),
  );

  return router;
}
