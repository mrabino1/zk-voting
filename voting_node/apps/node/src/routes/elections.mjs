// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { requireAuth, requireElectionRole, requireJurisdictionRoleFromBody, requirePlatformOperator } from '../auth.mjs';
import { assertExternalClearance } from '../voteGate.mjs';
import {
  electionHasRanked,
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
import { presentElection, electionState, electionChainMode, publishDue, electionDisclosure } from '../electionState.mjs';
import { asyncHandler, HttpError, sanitizeVoteBody } from '../http.mjs';
import { emptyTree } from '../merkle.mjs';
import { presentResults } from '../results.mjs';
import { reasonName } from '../reasonCodes.mjs';
import { expireRepairAttempts, relayVote } from '../relay.mjs';
import { chainElectionId } from '../electionIds.mjs';
import { submitSupplementaryBatch, tallyAllowedAt } from '../supplementaryBatch.mjs';
import { uuidParam } from '../recordIds.mjs';
import { electionDisclosurePolicy, EXCLUSION_REASON_CODE, publicExclusion, publicVoteRecord } from '../store.mjs';
import {
  electionTypeOf,
  normalizeElectionType,
  sealedResultsBody,
  sealedResultsMessage,
} from '../electionType.mjs';
import { acceptDeal, acceptPartials, enrollGuardian } from '../guardianFlow.mjs';
import { isOpensBallots, openBallots, rejectInventedCounts, withoutExcludedEnvelopes } from '../tallyOpen.mjs';
import { publicCeremonyView } from '../tallyCrypto.mjs';
import { buildAuditorPack } from '../auditorPack.mjs';
import { computeTallyHash, certifyArgsForElection } from '../l1Certify.mjs';
import { dispatchOfficialOutcomeReports } from '../outcomeReports.mjs';
import { createVotePassService } from '../votePass.mjs';
import { openElectionOnL2, readL2IdentityConfig } from '../l2Identity.mjs';
import { partiesRouter } from './parties.mjs';
import { publicUser } from '../roles.mjs';
import { deliverRolePromotion } from '../promotionMail.mjs';

function l2OpenFingerprint(fields) {
  return JSON.stringify([
    String(fields.title || ''),
    Number(fields.startTime),
    Number(fields.cutoffTime),
    String(fields.jurisdictionId || ''),
    Number(fields.electionType) || 0,
    String(fields.ballotSpecHash || ''),
    String(fields.createdBy || ''),
  ]);
}

/** Open on the sequencer, or skip when L2_CIVIC_RPC is unset. Throws on a failed open. */
async function recordElectionOnL2(config, election) {
  const civicRpc = String(config?.l2CivicRpc || '').trim();
  if (!civicRpc) {
    if (!config?.quiet) {
      console.warn('L2_CIVIC_RPC is unset; this election was not opened on the sequencer');
    }
    return 'unconfigured';
  }
  const hooked = typeof config.openElectionOnL2 === 'function';
  const opener = hooked ? config.openElectionOnL2 : openElectionOnL2;
  const cfg = hooked ? { civicRpc } : await readL2IdentityConfig();
  if (!hooked) cfg.civicRpc = civicRpc;
  await opener(cfg, {
    electionUuid: String(election.id),
    electionType: election.electionType,
    cutoffTime: election.cutoffTime,
  });
  return 'open';
}

function sameNullifier(left, right) {
  try {
    return BigInt(left).toString() === BigInt(right).toString();
  } catch {
    return String(left) === String(right);
  }
}

function receiptBeforeCutoff(store, election, nullifier) {
  const vote = store.findVote(election.id, nullifier);
  const at = Number(vote?.acceptedAt);
  const cutoff = Number(election.cutoffTime);
  return Number.isFinite(at) && Number.isFinite(cutoff) && at < cutoff;
}

function notExcluded(store, election, nullifier) {
  const listed = typeof store.excludedNullifiers === 'function' ? store.excludedNullifiers(election.id) : [];
  return !listed.some((item) => sameNullifier(item, nullifier));
}

/** Try again to drop a dead letter that was already recorded as excluded. */
async function retryPendingExclusionReleases({ store, chain, election }) {
  if (typeof chain?.releaseExcluded !== 'function') return;
  const key = chainElectionId(election);
  const rows = (election.excludedBallots || []).filter((row) => row && row.releasePending === true);
  for (const row of rows) {
    let released = false;
    try {
      released = await chain.releaseExcluded(key, row.nullifier);
    } catch {
      released = false;
    }
    if (released) await store.setExclusionReleasePending(election.id, row.nullifier, false);
  }
}

/**
 * Offer pre-cutoff dead letters to the supplementary hook before the tally
 * is accepted. A refusal leaves the dead letter in place.
 */
async function offerSupplementaryBatch({ store, chain, election, now, config }) {
  if (typeof chain?.deadLettersFor !== 'function' || typeof chain?.holdSupplementary !== 'function') return;
  const dead = chain.deadLettersFor(chainElectionId(election)) || [];
  const rows = [];
  for (const item of dead) {
    if (!receiptBeforeCutoff(store, election, item.nullifier)) continue;
    const vote = store.findVote(election.id, item.nullifier);
    rows.push({
      nullifier: item.nullifier,
      receiptAcceptedAt: Number(vote?.acceptedAt),
      cutoffTime: Number(election.cutoffTime),
    });
  }
  if (!rows.length) return;
  const hook = typeof config?.supplementaryBatch === 'function' ? config.supplementaryBatch : submitSupplementaryBatch;
  let result;
  try {
    result = await hook({
      election,
      rows,
      now,
      tallyAllowedAt: tallyAllowedAt(election, config?.tallyChallengeSeconds),
    });
  } catch {
    return;
  }
  if (!result?.accepted || !Array.isArray(result.nullifiers) || !result.nullifiers.length) return;
  await chain.holdSupplementary(chainElectionId(election), result.nullifiers);
}

function rejectPendingL2(election) {
  if (election && election.l2OpenStatus === 'pending') {
    throw new HttpError(409, 'election is not open on the sequencer', {
      code: 'L2_OPEN_PENDING',
      electionId: String(election.id),
    });
  }
}

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
  const { store, explorer, chain, config, l1, pin } = deps;
  const votePass = deps.votePass || createVotePassService(config);
  const router = Router();
  router.param('id', uuidParam('id'));
  router.param('requestId', uuidParam('requestId'));

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
      const ballotSpecHash = resolveBallotSpecHash({
        title,
        questions,
        ballotSpecHash: body.ballotSpecHash,
      });
      const jurisdiction = store.getJurisdiction(String(body.jurisdictionId || 'demo'));
      if (!jurisdiction) {
        throw new HttpError(400, 'unknown jurisdictionId');
      }
      const jurisdictionId = jurisdiction.id;
      const civicRpc = String(config?.l2CivicRpc || '').trim();
      const fingerprint = l2OpenFingerprint({
        title,
        startTime,
        cutoffTime,
        jurisdictionId,
        electionType,
        ballotSpecHash,
        createdBy: req.user.id,
      });
      // A failed sequencer open leaves one pending row. The retry reopens it
      // and does not call the factory again.
      let election = store.findPendingL2Open(fingerprint);
      if (!election) {
        let chainResult = null;
        if (chain.isConfigured()) {
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
            // Read by factoryElectionParams. Omitted from the encoded tuple.
            electionType,
          });
          if (!chainResult?.onChainElectionId) {
            throw new HttpError(502, 'ElectionFactory did not return an election id', {
              code: 'CHAIN_CREATE_FAILED',
            });
          }
        }
        const requestedOnChainId = chainResult?.onChainElectionId ?? null;
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
        election = await store.createElection({
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
          l2OpenStatus: civicRpc ? 'pending' : 'unconfigured',
          l2OpenFingerprint: fingerprint,
        });
      }
      let l2Open;
      try {
        l2Open = await recordElectionOnL2(config, election);
      } catch (err) {
        throw new HttpError(502, `Could not record the election on the sequencer: ${err.message || err}`, {
          code: 'L2_OPEN_FAILED',
          electionId: String(election.id),
        });
      }
      const nextStatus = l2Open === 'open' ? 'open' : 'unconfigured';
      if (election.l2OpenStatus !== nextStatus) {
        election = await store.setL2OpenStatus(election.id, nextStatus);
      }
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
        l2Open,
        election: dto,
        links: dto.links,
        nfp: true,
      });
    }),
  );

  router.post(
    '/:id/l2-open',
    requireAuth,
    requireElectionRole(store, 'clerk'),
    asyncHandler(async (req, res) => {
      let election = store.requireElection(req.params.id);
      if (election.l2OpenStatus === 'open') {
        res.json({ ok: true, id: election.id, l2Open: 'open', nfp: true });
        return;
      }
      const civicRpc = String(config?.l2CivicRpc || '').trim();
      if (!civicRpc) {
        if (election.l2OpenStatus !== 'unconfigured') {
          election = await store.setL2OpenStatus(election.id, 'unconfigured');
        }
        res.json({ ok: true, id: election.id, l2Open: 'unconfigured', nfp: true });
        return;
      }
      let l2Open;
      try {
        l2Open = await recordElectionOnL2(config, election);
      } catch (err) {
        throw new HttpError(502, `Could not record the election on the sequencer: ${err.message || err}`, {
          code: 'L2_OPEN_FAILED',
          electionId: String(election.id),
        });
      }
      const nextStatus = l2Open === 'open' ? 'open' : 'unconfigured';
      if (election.l2OpenStatus !== nextStatus) {
        election = await store.setL2OpenStatus(election.id, nextStatus);
      }
      if (nextStatus === 'open') {
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
      }
      res.json({ ok: true, id: election.id, l2Open, election: presentElection(election, deps), nfp: true });
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
      rejectPendingL2(election);
      res.json(presentPublicBallotInfo(election, deps.config.nowFn()));
    }),
  );

  router.get(
    '/:id/info/:questionId/:optionId',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      rejectPendingL2(election);
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
      rejectPendingL2(election);
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
      rejectPendingL2(election);
      res.json(presentResults(election, deps));
    }),
  );

  router.get(
    '/:id/summary',
    asyncHandler(async (req, res) => {
      const { view } = await publishDue(deps);
      const election = store.requireElection(req.params.id);
      rejectPendingL2(election);
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
      rejectPendingL2(election);
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
      rejectPendingL2(election);
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
      rejectPendingL2(election);
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
      rejectPendingL2(election);
      if (election.votingPaused) {
        throw new HttpError(409, 'election paused', { code: 'ELECTION_PAUSED' });
      }
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
      rejectPendingL2(electionForGate);
      if (electionForGate?.votingPaused) {
        throw new HttpError(409, 'election paused', { code: 'ELECTION_PAUSED' });
      }
      const rawBody = req.body || {};
      let spentPassHash = null;
      if (rawBody.votePass && electionForGate) {
        spentPassHash = await votePass.verify(electionForGate.id, rawBody.votePass);
        // A spent pass may replace a stored ballot only while re-vote is on.
        // The pass stays an unlinked hash: any already-spent pass qualifies,
        // and nothing records which pass belongs to this nullifier.
        const storedBallot = config.allowRevote === true
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
      const body = sanitizeVoteBody(rawBody);
      const result = await relayVote({
        store,
        explorer,
        chain,
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
    '/:id/chain-dead-letter/replay',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      if (deps.writer?.enabled && deps.writer.acceptingWrites() === false) {
        throw new HttpError(409, 'this node is not the writer', { code: 'NOT_WRITER' });
      }
      if (typeof chain?.replayDeadLetter !== 'function') {
        throw new HttpError(409, 'no ballot queue on this node', { code: 'CHAIN_NOT_READY' });
      }
      const election = store.requireElection(req.params.id);
      const restored = await chain.replayDeadLetter(chainElectionId(election), req.body?.nullifier, {
        now: config.nowFn(),
        cutoffTime: election.cutoffTime,
      });
      res.json({ ok: true, nfp: true, ...restored });
    }),
  );

  router.post(
    '/:id/chain-dead-letter/exclude',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      if (deps.writer?.enabled && deps.writer.acceptingWrites() === false) {
        throw new HttpError(409, 'this node is not the writer', { code: 'NOT_WRITER' });
      }
      const election = store.requireElection(req.params.id);
      if (election.tally) throw new HttpError(409, 'already tallied', { code: 'ALREADY_TALLIED' });
      const now = config.nowFn();
      if (now < Number(election.cutoffTime)) {
        throw new HttpError(409, 'election still open', { code: 'NOT_CLOSED' });
      }
      const reason = String(req.body?.reason || '').trim();
      if (!reason) throw new HttpError(400, 'a reason is required', { code: 'EXCLUSION_REASON' });
      const nullifier = req.body?.nullifier;
      if (nullifier == null || String(nullifier).trim() === '') {
        throw new HttpError(400, 'nullifier is required', { code: 'NULLIFIER_REQUIRED' });
      }
      const key = chainElectionId(election);
      const dead = typeof chain?.deadLettersFor === 'function' ? chain.deadLettersFor(key) : [];
      const held = typeof chain?.supplementaryFor === 'function' ? chain.supplementaryFor(key) : [];
      const deadItem = dead.find((row) => sameNullifier(row.nullifier, nullifier));
      const heldItem = held.find((row) => sameNullifier(row.nullifier, nullifier));
      const item = deadItem || heldItem;
      const already = (election.excludedBallots || []).some((row) => sameNullifier(row.nullifier, nullifier));
      if (!item && !already) {
        throw new HttpError(404, 'ballot is not dead-lettered', { code: 'NOT_DEAD_LETTER' });
      }
      // A supplementary hold has no replay. After the deadline it can be excluded.
      const supplementaryOnly = Boolean(heldItem) && !deadItem;
      if (!already && !supplementaryOnly && !(Number(item?.replayFailedAt) > 0)) {
        throw new HttpError(409, 'replay the ballot after the deadline before excluding it', {
          code: 'REPLAY_REQUIRED',
        });
      }
      let approverIds = [];
      let firstReason = '';
      if (!already) {
        const approval = await store.noteExclusionApproval(election.id, {
          nullifier,
          userId: req.user?.id,
          reason,
          at: now,
        });
        if (approval.status === 'pending') {
          throw new HttpError(409, 'a second tally operator must approve this exclusion', {
            code: 'SECOND_APPROVAL_REQUIRED',
            reason: approval.reason,
            reasonCode: approval.reasonCode,
          });
        }
        approverIds = approval.approverIds || [];
        firstReason = String(approval.reason || '');
        const recorded = await store.recordBallotExclusion(election.id, {
          nullifier,
          notes: [
            { userId: approverIds[0], reason: firstReason },
            { userId: req.user?.id, reason },
          ],
          at: now,
          approverIds,
        });
        const fresh = store.requireElection(election.id);
        await explorer.append('ballot_excluded', {
          electionId: String(fresh.id),
          reason: EXCLUSION_REASON_CODE,
          count: recorded.count,
        });
      }
      if (item && typeof chain?.releaseExcluded === 'function') {
        let released = false;
        let releaseError = null;
        try {
          released = await chain.releaseExcluded(key, nullifier);
        } catch (err) {
          releaseError = err;
          released = false;
        }
        if (!released) {
          const message = releaseError?.message || 'the dead letter was not released';
          await store.setExclusionReleasePending(election.id, nullifier, true);
          console.warn(`ballot exclusion release failed for election ${election.id}: ${message}`);
          if (typeof chain.noteAlert === 'function') {
            await chain.noteAlert({
              kind: 'exclusion_release_failed',
              electionKey: String(election.id),
              error: message,
              at: now,
            });
          }
          throw new HttpError(502, 'could not release the excluded ballot', { code: 'EXCLUSION_FAILED' });
        }
        await store.setExclusionReleasePending(election.id, nullifier, false);
      }
      const excluded = publicExclusion(store.requireElection(election.id));
      res.json({
        ok: true,
        nfp: true,
        excluded,
        ...(firstReason ? { firstReason } : {}),
      });
    }),
  );

  router.post(
    '/:id/tally',
    requireAuth,
    requireElectionRole(store, 'tally_operator'),
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const now = config.nowFn();
      expireRepairAttempts(now, election.id);
      const state = electionState(election, now);
      if (now < tallyAllowedAt(election, config.tallyChallengeSeconds)) {
        throw new HttpError(400, 'election still open', { code: 'NOT_CLOSED', state });
      }
      await offerSupplementaryBatch({ store, chain, election, now, config });
      await retryPendingExclusionReleases({ store, chain, election });
      const pendingReleases = (store.requireElection(election.id).excludedBallots || []).filter(
        (row) => row && row.releasePending === true,
      ).length;
      if (pendingReleases) {
        throw new HttpError(409, 'an excluded ballot is still waiting to leave the hold list', {
          code: 'EXCLUSION_RELEASE_PENDING',
          pending: pendingReleases,
        });
      }
      if (typeof chain?.deadLettersFor === 'function') {
        const dead = (chain.deadLettersFor(chainElectionId(election)) || []).filter((item) =>
          notExcluded(store, election, item.nullifier),
        );
        if (dead.length) {
          throw new HttpError(409, 'dead-lettered ballots must be replayed or excluded before the tally', {
            code: 'CHAIN_DEAD_LETTER',
            deadLetter: dead.length,
          });
        }
      }
      if (typeof chain?.pendingFor === 'function') {
        const pending = chain.pendingFor(chainElectionId(election));
        const queued = (pending?.queued || []).filter((id) => notExcluded(store, election, id));
        const inFlight = (pending?.inFlight || []).filter((id) => notExcluded(store, election, id));
        if (queued.length || inFlight.length) {
          throw new HttpError(409, 'ballots are still queued for the chain', {
            code: 'CHAIN_QUEUE_PENDING',
            queued: queued.length,
            inFlight: inFlight.length,
          });
        }
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

      if (electionHasRanked(election)) {
        throw new HttpError(
          409,
          'ranked tally is disabled until a verified shuffle exists; individual envelopes are not opened',
          { code: 'RANKED_TALLY_DISABLED' },
        );
      }

      if (isOpensBallots(election)) {
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
      } else {
        nums = parseTallyCounts(
          req.body || {},
          election.questions || [],
          countedBallots,
          election.ballotMethod,
        );
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
        countedBallots,
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
          totalBallots: countedBallots,
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
      const countedBallots = Math.max(
        0,
        Number(election.acceptedBallots) - store.hiddenVoteCount(election.id) - store.liveExcludedCount(election.id),
      );
      let l1Certification = await l1.certifyTally({
        ...certifyArgsForElection(election, {}, config),
        counts,
        totalBallots: countedBallots,
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
