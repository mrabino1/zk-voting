// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { requireAuth, requireElectionRole, requireJurisdictionRoleFromBody, requirePlatformOperator } from '../auth.mjs';
import {
  electionHasRanked,
  normalizeBallotMethod,
  parseTallyCounts,
  payloadsFromEnvelopes,
  pluralityQuestions,
  tallyBallots,
  withQuestionMethods,
} from '../ballot.mjs';
import {
  normalizeQuestions,
  presentPublicBallotInfo,
  presentPublicOptionInfo,
  resolveBallotSpecHash,
} from '../ballotSpec.mjs';
import { presentElection, electionState, electionChainMode, publishDue, electionDisclosure } from '../electionState.mjs';
import { asyncHandler, HttpError, sanitizeVoteBody } from '../http.mjs';
import { emptyTree } from '../merkle.mjs';
import { presentResults } from '../results.mjs';
import { reasonName } from '../reasonCodes.mjs';
import { relayVote } from '../relay.mjs';
import { publicVoteRecord } from '../store.mjs';
import { acceptDeal, acceptPartials, enrollGuardian } from '../guardianFlow.mjs';
import { isOpensBallots, openBallots, rejectInventedCounts } from '../tallyOpen.mjs';
import { publicCeremonyView } from '../tallyCrypto.mjs';
import { buildAuditorPack } from '../auditorPack.mjs';
import { computeTallyHash, certifyArgsForElection } from '../l1Certify.mjs';
import {
  dispatchOfficialOutcomeReports,
  resolveVoterForOutcomeSubscribe,
  subscribeVoterToOutcome,
} from '../outcomeReports.mjs';
import { partiesRouter } from './parties.mjs';
import { publicUser } from '../roles.mjs';
import { deliverRolePromotion } from '../promotionMail.mjs';
import { assertExternalClearance } from '../voteGate.mjs';

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
  const { store, explorer, chain, config, l1, pin } = deps;
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      await publishDue(deps);
      res.json({
        nfp: true,
        elections: store.listElections().map((e) => presentElection(e, deps)),
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
      const questions = withQuestionMethods(questionsFromCreateBody(body), ballotMethod);
      const ballotSpecHash = resolveBallotSpecHash({
        title,
        questions,
        ballotSpecHash: body.ballotSpecHash,
      });
      const jurisdictionId = String(body.jurisdictionId || 'demo');
      if (!store.getJurisdiction(jurisdictionId)) {
        throw new HttpError(400, 'unknown jurisdictionId');
      }
      let chainResult = null;
      if (chain.isConfigured()) {
        const jurisdiction = store.getJurisdiction(jurisdictionId);
        const officers = jurisdiction?.officers || [];
        const roleAddr = (role) => officers.find((o) => o.role === role && o.address)?.address;
        chainResult = await chain.createElection({
          title,
          metadataURI: String(body.metadataURI || ''),
          startTime,
          cutoffTime,
          maxParticipants,
          treeDepth,
          ballotSpecHash,
          questions,
          questionCount: questions.length,
          jurisdictionId,
          clerk: body.clerk || roleAddr('clerk'),
          registrar: body.registrar || roleAddr('registrar'),
          disqualificationOfficer: body.disqualificationOfficer || roleAddr('disqualification_officer'),
          tallyOperator: body.tallyOperator || roleAddr('tally_operator'),
          verifier: body.verifier,
          tallyScheme: body.tallyScheme,
          tallyPubKeyX: body.tallyPubKeyX,
          tallyPubKeyY: body.tallyPubKeyY,
        });
        if (!chainResult?.onChainElectionId) {
          throw new HttpError(502, 'ElectionFactory did not return an election id', {
            code: 'CHAIN_CREATE_FAILED',
          });
        }
      }
      let requestedOnChainId = chainResult?.onChainElectionId ?? null;
      const pinnedFactory = String(config?.electionFactoryAddress || '').trim();
      const chainFactory = chainResult?.factoryAddress || null;
      if (
        chainFactory &&
        pinnedFactory &&
        chainFactory.toLowerCase() !== pinnedFactory.toLowerCase()
      ) {
        throw new HttpError(409, 'ElectionFactory is not the pinned shared factory', {
          code: 'FACTORY_MISMATCH',
        });
      }
      const factoryAddress = chainFactory || pinnedFactory || null;
      const election = await store.createElection({
        title,
        metadataURI: String(body.metadataURI || ''),
        startTime,
        cutoffTime,
        maxParticipants,
        treeDepth,
        ballotSpecHash,
        ballotMethod,
        questions,
        jurisdictionId,
        clerk: chainResult?.params?.clerk || body.clerk || '',
        registrar: chainResult?.params?.registrar || body.registrar || '',
        disqualificationOfficer:
          chainResult?.params?.disqualificationOfficer || body.disqualificationOfficer || '',
        tallyOperator: chainResult?.params?.tallyOperator || body.tallyOperator || '',
        verifier: chainResult?.params?.verifier || body.verifier || '',
        lateUpdateAllowed: Boolean(body.lateUpdateAllowed),
        tallyScheme: body.tallyScheme,
        opensBallots: body.opensBallots,
        threshold: body.threshold,
        guardianCount: body.guardianCount,
        aggregation: body.aggregation,
        createdBy: req.user.id,
        onChainElectionId: requestedOnChainId,
        onChainElectionAddress: chainResult?.onChainElectionAddress ?? null,
        factoryAddress,
        createTxHash: chainResult?.createTxHash ?? null,
        chainId: chainResult?.chainId ?? (factoryAddress ? config.chainId : null),
      });
      await explorer.append('election_created', {
        electionId: String(election.id),
        shortCode: election.shortCode,
        onChainElectionId: String(election.onChainElectionId),
        onChainElectionAddress: election.onChainElectionAddress,
        createTxHash: election.createTxHash,
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
        onChainElectionId: election.onChainElectionId,
        onChainElectionAddress: election.onChainElectionAddress,
        createTxHash: election.createTxHash,
        chainMode: electionChainMode(election),
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
    const ballotSpecHash = resolveBallotSpecHash({
      title,
      questions,
      ballotSpecHash: body.ballotSpecHash,
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
      const tallied = Boolean(election.tally);
      res.json({
        nfp: true,
        electionId: String(election.id),
        title: election.title,
        jurisdictionId: election.jurisdictionId,
        state: dto.state,
        stateName: dto.stateName,
        startTime: election.startTime,
        cutoffTime: election.cutoffTime,
        participantCount: election.participantCount,
        acceptedBallots: dto.acceptedBallots,
        disclosure: electionDisclosure(election, deps, view),
        explorerUrl: `/explorer#/election/${encodeURIComponent(String(election.id))}`,
        resultsUrl: tallied ? `/elections/${election.id}/results` : null,
      });
    }),
  );

  router.get(
    '/:id/ballots',
    asyncHandler(async (req, res) => {
      const { now, interval, view } = await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const published = store.listPublishedVotes(election.id, now, interval);
      res.json({
        electionId: String(election.id),
        acceptedBallots: published.length,
        ballots: published.map(publicVoteRecord),
        disclosure: electionDisclosure(election, deps, view),
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
      const envelopes = store.listEnvelopes(election.id);
      for (const env of envelopes) {
        if ('userId' in env || 'choice' in env) {
          throw new HttpError(500, 'privacy invariant violated');
        }
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

  router.post(
    '/:id/vote',
    asyncHandler(async (req, res) => {
      const electionForGate = store.getElection(req.params.id);
      if (electionForGate && store.listActiveExternalParties(electionForGate.id).length) {
        const rawCommitment = req.body?.identityCommitment;
        if (rawCommitment == null || rawCommitment === '') {
          throw new HttpError(400, 'identityCommitment required for external party clearance', {
            code: 'IDENTITY_COMMITMENT_REQUIRED',
          });
        }
        await assertExternalClearance(store, electionForGate.id, rawCommitment, {
          now: config.nowFn(),
        });
      }
      const body = sanitizeVoteBody(req.body);
      if (req.user && pin) {
        pin.assertVoteAllowed(req.user, body?.pinToken);
      }
      const result = await relayVote({
        store,
        explorer,
        chain,
        config,
        electionId: req.params.id,
        body,
        now: config.nowFn(),
        intervalSeconds: config.disclosureIntervalSeconds,
      });
      const election = store.getElection(req.params.id);
      const voterId = resolveVoterForOutcomeSubscribe(store, {
        userId: req.user?.id,
        electionId: election?.id || req.params.id,
      });
      if (voterId && election) {
        await subscribeVoterToOutcome(store, {
          userId: voterId,
          electionId: election.id,
          source: 'vote-default',
        });
      }
      res.status(201).json({
        ok: true,
        accepted: true,
        published: result.published,
        nextPublishAt: result.nextPublishAt,
        vote: result.vote,
        receipt: result.receipt,
        message: result.published
          ? 'Ballot accepted. Choice is not stored in the clear. You may vote only once; a second ballot for this nullifier is rejected. Email or paste the receipt at /receipt — it cannot prove how you voted.'
          : 'Ballot accepted for relay. Public proof is published after this hour closes so a person leaving a voting office cannot be matched to a live jurisdiction tick. Choice is not stored in the clear. You may vote only once; a second ballot for this nullifier is rejected. Email or paste the receipt at /receipt — it cannot prove how you voted.',
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
    '/:id/tally',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const now = Math.floor(Date.now() / 1000);
      const state = electionState(election, now);
      if (now < election.cutoffTime) {
        throw new HttpError(400, 'election still open', { code: 'NOT_CLOSED', state });
      }

      let nums;
      let source = 'sum_only';
      let openedBallots = null;
      let opened = null;
      let irv = null;

      if (isOpensBallots(election)) {
        const bucket = store.guardianMaterial(election.id);
        const envelopes = store.listEnvelopes(election.id);
        opened = await openBallots(election, envelopes, bucket?.partials || [], election.questions);
        if (Array.isArray(req.body?.counts) && req.body.counts.length > 0) {
          const submitted = req.body.counts.map((n) => Number(n));
          if (submitted.some((n) => !Number.isInteger(n) || n < 0)) {
            throw new HttpError(400, 'counts must be non-negative integers');
          }
          rejectInventedCounts(submitted, opened.counts);
        }
        nums = opened.counts;
        source = 'opens_ballots';
        openedBallots = opened.openings.length;
      } else {
        const ranked = electionHasRanked(election);
        const plurality = pluralityQuestions(election.questions || [], election.ballotMethod);
        if (ranked) {
          const envelopes = store.listEnvelopes(election.id);
          const ballots = payloadsFromEnvelopes(envelopes);
          while (ballots.length < election.acceptedBallots) ballots.push([]);
          irv = tallyBallots(election, ballots);
        }
        if (plurality.length) {
          nums = parseTallyCounts(
            req.body || {},
            election.questions || [],
            election.acceptedBallots,
            election.ballotMethod,
          );
        } else if (ranked && irv) {
          const posted = req.body?.counts;
          if (Array.isArray(posted) && posted.length) {
            nums = posted.map((n) => Number(n));
            if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
              throw new HttpError(400, 'counts must be non-negative integers');
            }
            if (nums.length !== irv.counts.length) {
              throw new HttpError(400, `counts length must be ${irv.counts.length}`, {
                code: 'TALLY_LENGTH',
                expected: irv.counts.length,
                actual: nums.length,
              });
            }
            if (nums.some((n, i) => n !== irv.counts[i])) {
              throw new HttpError(400, 'counts must match first-round ranked preferences', {
                code: 'TALLY_MISMATCH',
                expected: irv.counts,
              });
            }
          } else {
            nums = irv.counts;
          }
          if (!nums.length) throw new HttpError(400, 'counts[] required');
        } else {
          nums = parseTallyCounts(
            req.body || {},
            election.questions || [],
            election.acceptedBallots,
            election.ballotMethod,
          );
        }
      }

      const countsHash = computeTallyHash(nums);
      const extras = {
        countsHash,
        ballotMethod: irv?.ballotMethod || (source === 'opens_ballots' ? 'plurality' : election.ballotMethod || 'plurality'),
        source,
        openedBallots,
        aggregation: opened?.aggregation || null,
        guardianThreshold: election.tallyCeremony?.threshold ?? null,
      };
      if (irv?.questions?.length) extras.questions = irv.questions;
      const tallied = await store.setTally(election.id, nums, extras);
      await explorer.append('tally', {
        electionId: String(tallied.id),
        counts: nums,
        acceptedBallots: tallied.acceptedBallots,
        source,
        production: false,
        countsHash,
        ballotMethod: tallied.tally?.ballotMethod,
        winners: (tallied.tally?.questions || []).map((q) => q.winner).filter(Boolean),
      });
      let l1Certification = {
        status: 'skipped',
        posted: false,
        skipped: true,
        reason: 'L1 certifier not wired',
        resultHash: countsHash,
      };
      if (l1 && typeof l1.certifyTally === 'function') {
        l1Certification = await l1.certifyTally({
          ...certifyArgsForElection(tallied, {}, config),
          counts: nums,
          totalBallots: tallied.acceptedBallots,
          resultHash: countsHash,
        });
        await store.setTallyL1(tallied.id, l1Certification);
        const recorded = store.requireElection(tallied.id).tally?.l1 || l1Certification;
        l1Certification = recorded;
        if (l1Certification.posted || l1Certification.alreadyPosted) {
          await explorer.append('l1_certify', {
            electionId: String(tallied.id),
            onChainElectionId: String(tallied.onChainElectionId),
            certificationId: l1Certification.certificationId,
            factory: l1Certification.factory,
            jurisdictionId: l1Certification.jurisdictionId,
            publicIdHash: l1Certification.publicIdHash,
            resultHash: l1Certification.resultHash,
            txHash: l1Certification.txHash,
            chainId: l1Certification.chainId,
            mirror: l1Certification.mirror,
          });
        }
      }
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
        l1Certification,
        nfp: true,
      });
    }),
  );

  router.get(
    '/:id/l1',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const configured = Boolean(l1 && typeof l1.isConfigured === 'function' && l1.isConfigured());
      res.json({
        nfp: true,
        electionId: String(election.id),
        onChainElectionId: election.onChainElectionId != null ? String(election.onChainElectionId) : null,
        identity: certifyArgsForElection(election, {}, config).identity,
        tallied: Boolean(election.tally),
        countsHash: election.tally?.countsHash || null,
        l1Certification: election.tally?.l1 || null,
        l1Configured: configured,
        skipReason: configured ? null : l1?.skipReason?.() || 'L1 env unset',
      });
    }),
  );

  router.post(
    '/:id/certify-l1',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      if (!election.tally) {
        throw new HttpError(409, 'tally first (POST /api/elections/:id/tally)', { code: 'NOT_TALLIED' });
      }
      if (!l1 || typeof l1.certifyTally !== 'function') {
        res.json({
          ok: true,
          skipped: true,
          l1Certification: { status: 'skipped', reason: 'L1 certifier not wired' },
          nfp: true,
        });
        return;
      }
      const counts = election.tally.counts;
      let l1Certification = await l1.certifyTally({
        ...certifyArgsForElection(election, {}, config),
        counts,
        totalBallots: election.acceptedBallots,
        resultHash: election.tally.countsHash || computeTallyHash(counts),
        l2StateRoot: req.body?.l2StateRoot,
      });
      await store.setTallyL1(election.id, l1Certification);
      l1Certification = store.requireElection(election.id).tally?.l1 || l1Certification;
      if (l1Certification.posted || l1Certification.alreadyPosted) {
        await explorer.append('l1_certify', {
          electionId: String(election.id),
          onChainElectionId: String(election.onChainElectionId),
          certificationId: l1Certification.certificationId,
          factory: l1Certification.factory,
          jurisdictionId: l1Certification.jurisdictionId,
          publicIdHash: l1Certification.publicIdHash,
          resultHash: l1Certification.resultHash,
          txHash: l1Certification.txHash,
          chainId: l1Certification.chainId,
          mirror: l1Certification.mirror,
        });
      }
      const status = l1Certification.status === 'failed' ? 502 : 200;
      res.status(status).json({
        ok: l1Certification.status !== 'failed',
        election: presentElection(store.requireElection(election.id), deps),
        l1Certification,
        nfp: true,
      });
    }),
  );

  return router;
}
