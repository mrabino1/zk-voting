// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { requireAuth, requireElectionRole, requireJurisdictionRoleFromBody } from '../auth.mjs';
import {
  normalizeQuestions,
  presentPublicBallotInfo,
  presentPublicOptionInfo,
  resolveBallotSpecHash,
} from '../ballotSpec.mjs';
import { presentElection, electionState, publishDue, electionDisclosure } from '../electionState.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { emptyTree } from '../merkle.mjs';
import { reasonName } from '../reasonCodes.mjs';
import { relayVote } from '../relay.mjs';
import { publicVoteRecord } from '../store.mjs';

function unixSeconds(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new HttpError(400, 'invalid timestamp');
  return Math.floor(ms / 1000);
}

function expectedCountLength(questions) {
  if (!questions.length) return 0;
  return questions.reduce((n, q) => n + Math.max(q.options?.length || 0, 1), 0);
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
  const { store, explorer, chain, config } = deps;
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
      const questions = normalizeQuestions(body.questions);
      const ballotSpecHash = resolveBallotSpecHash({
        title,
        questions,
        ballotSpecHash: body.ballotSpecHash,
      });
      const jurisdictionId = String(body.jurisdictionId || 'demo');
      if (!store.getJurisdiction(jurisdictionId)) {
        throw new HttpError(400, 'unknown jurisdictionId');
      }
      const election = await store.createElection({
        title,
        metadataURI: String(body.metadataURI || ''),
        startTime,
        cutoffTime,
        maxParticipants,
        treeDepth,
        ballotSpecHash,
        questions,
        jurisdictionId,
        clerk: body.clerk || '',
        registrar: body.registrar || '',
        disqualificationOfficer: body.disqualificationOfficer || '',
        tallyOperator: body.tallyOperator || '',
        verifier: body.verifier || '',
        lateUpdateAllowed: Boolean(body.lateUpdateAllowed),
        createdBy: req.user.id,
      });
      await explorer.append('election_created', {
        electionId: String(election.id),
        title: election.title,
        jurisdictionId: election.jurisdictionId,
        startTime: election.startTime,
        cutoffTime: election.cutoffTime,
      });
      res.status(201).json({
        ok: true,
        id: election.id,
        electionId: election.id,
        election: presentElection(election, deps),
        nfp: true,
      });
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
    const questions =
      body.questions != null ? normalizeQuestions(body.questions) : election.questions;
    const metadataURI =
      body.metadataURI != null ? String(body.metadataURI) : election.metadataURI;
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
    '/:id/envelopes',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const now = config.nowFn();
      if (now < election.cutoffTime) {
        throw new HttpError(409, 'envelopes available after cutoff', { code: 'NOT_CLOSED' });
      }
      const envelopes = store.listEnvelopes(req.params.id);
      for (const env of envelopes) {
        if ('userId' in env || 'choice' in env) {
          throw new HttpError(500, 'privacy invariant violated');
        }
      }
      res.json({ electionId: String(req.params.id), envelopes, nfp: true });
    }),
  );

  router.get(
    '/:id/registrations',
    requireAuth,
    requireElectionRole(store, 'clerk', 'registrar', 'disqualification_officer'),
    asyncHandler(async (req, res) => {
      store.requireElection(req.params.id);
      res.json({
        electionId: String(req.params.id),
        registrations: store.listRegistrations(req.params.id),
        nfp: true,
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
      const result = await store.registerCommitment(req.params.id, identityCommitment, { userId });
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
        electionId: String(result.election.id),
        identityCommitment: result.identityCommitment,
        leafIndex: result.leafIndex,
        eligibleRoot: result.eligibleRoot,
        nfp: true,
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
      const result = await relayVote({
        store,
        explorer,
        chain,
        electionId: req.params.id,
        body: req.body,
        now: config.nowFn(),
        intervalSeconds: config.disclosureIntervalSeconds,
      });
      res.status(201).json({
        ok: true,
        accepted: true,
        published: result.published,
        nextPublishAt: result.nextPublishAt,
        vote: result.vote,
        message: result.published
          ? 'Ballot accepted. Choice is not stored in the clear.'
          : 'Ballot accepted for relay. Public proof is published after this hour closes so a person leaving a voting office cannot be matched to a live jurisdiction tick. Choice is not stored in the clear.',
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
      const counts = req.body?.counts;
      if (!Array.isArray(counts) || counts.length === 0) {
        throw new HttpError(400, 'counts[] required');
      }
      const nums = counts.map((n) => Number(n));
      if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
        throw new HttpError(400, 'counts must be non-negative integers');
      }
      const sum = nums.reduce((a, b) => a + b, 0);
      if (sum !== election.acceptedBallots) {
        throw new HttpError(400, 'sum(counts) must equal acceptedBallots', {
          code: 'TALLY_MISMATCH',
          sum,
          acceptedBallots: election.acceptedBallots,
        });
      }
      const expected = expectedCountLength(election.questions);
      if (expected && nums.length !== expected) {
        throw new HttpError(400, `counts length must be ${expected}`, { expected });
      }
      const tallied = await store.setTally(election.id, nums);
      await explorer.append('tally', {
        electionId: String(tallied.id),
        counts: nums,
        acceptedBallots: tallied.acceptedBallots,
      });
      res.json({ ok: true, election: presentElection(tallied, deps), nfp: true });
    }),
  );

  return router;
}
