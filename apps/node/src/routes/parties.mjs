// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { requireAuth } from '../auth.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { isPlatformOperator } from '../roles.mjs';
import { assertExternalClearance } from '../voteGate.mjs';

function requirePartyManager(store) {
  return function partyManager(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    const election = store.getElection(req.params.id);
    if (!election) {
      next(new HttpError(404, 'election not found'));
      return;
    }
    req.election = election;
    if (store.userIsElectionStaff(req.user, election)) {
      next();
      return;
    }
    next(
      new HttpError(403, 'forbidden', {
        role: req.user.role,
        jurisdictionId: election.jurisdictionId,
      }),
    );
  };
}

function requirePartyOperatorOrStaff(store) {
  return function partyOperator(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    const election = store.getElection(req.params.id);
    if (!election) {
      next(new HttpError(404, 'election not found'));
      return;
    }
    req.election = election;
    const party = store.getExternalParty(election.id, req.params.partyId);
    if (!party) {
      next(new HttpError(404, 'external party not found'));
      return;
    }
    req.party = party;
    if (store.userIsElectionStaff(req.user, election) || store.userOperatesParty(req.user, party)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', { role: req.user.role, partyId: party.id }));
  };
}

export function partiesRouter(deps) {
  const { store, explorer } = deps;
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const election = store.requireElection(req.params.id);
      const includeEndpoint = Boolean(
        req.user && (store.userIsElectionStaff(req.user, election) || isPlatformOperator(req.user)),
      );
      res.json({
        nfp: true,
        electionId: String(election.id),
        parties: store.listExternalParties(election.id, { includeEndpoint }),
      });
    }),
  );

  router.post(
    '/check',
    requireAuth,
    requirePartyManager(store),
    asyncHandler(async (req, res) => {
      const identityCommitment = req.body?.identityCommitment;
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const result = await assertExternalClearance(store, req.params.id, identityCommitment, {
        now: deps.config?.nowFn?.() || Math.floor(Date.now() / 1000),
      });
      res.json({ ok: true, nfp: true, ...result });
    }),
  );

  router.post(
    '/',
    requireAuth,
    requirePartyManager(store),
    asyncHandler(async (req, res) => {
      const { election, party } = await store.addExternalParty(req.params.id, {
        ...req.body,
        createdBy: req.user.id,
      });
      await explorer.append('party_add', {
        electionId: String(election.id),
        partyId: party.id,
        partyName: party.name,
        mode: party.mode,
        operatorHandle: party.operatorHandle,
      });
      res.status(201).json({
        ok: true,
        nfp: true,
        party: store.presentExternalParty(party, { includeEndpoint: true }),
      });
    }),
  );

  router.patch(
    '/:partyId',
    requireAuth,
    requirePartyManager(store),
    asyncHandler(async (req, res) => {
      const status = req.body?.status;
      if (!status) throw new HttpError(400, 'status required');
      const party = await store.setExternalPartyStatus(req.params.id, req.params.partyId, status);
      res.json({
        ok: true,
        nfp: true,
        party: store.presentExternalParty(party, { includeEndpoint: true }),
      });
    }),
  );

  router.get(
    '/:partyId/rejections',
    requireAuth,
    requirePartyManager(store),
    asyncHandler(async (req, res) => {
      res.json({
        nfp: true,
        rejections: store.listPartyRejections(req.params.id, req.params.partyId),
      });
    }),
  );

  router.post(
    '/:partyId/reject',
    requireAuth,
    requirePartyOperatorOrStaff(store),
    asyncHandler(async (req, res) => {
      const { identityCommitment, reasonCode, evidenceHash } = req.body || {};
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const { election, party, record } = await store.recordPartyRejection(req.params.id, req.params.partyId, {
        identityCommitment,
        reasonCode,
        evidenceHash,
        issuer: req.user.handle,
      });
      await explorer.append('party_reject', {
        electionId: String(election.id),
        partyId: party.id,
        identityCommitment: record.identityCommitment,
        reasonCode: record.reasonCode,
        evidenceHash: record.evidenceHash,
      });
      res.status(201).json({ ok: true, nfp: true, rejection: record });
    }),
  );

  router.post(
    '/:partyId/clear',
    requireAuth,
    requirePartyOperatorOrStaff(store),
    asyncHandler(async (req, res) => {
      const { identityCommitment, evidenceHash } = req.body || {};
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const { record } = await store.clearPartyRejection(req.params.id, req.params.partyId, {
        identityCommitment,
        evidenceHash,
        issuer: req.user.handle,
      });
      res.json({ ok: true, nfp: true, rejection: record });
    }),
  );

  router.post(
    '/:partyId/attest',
    requireAuth,
    requirePartyOperatorOrStaff(store),
    asyncHandler(async (req, res) => {
      const { identityCommitment, expiresAt, evidenceHash } = req.body || {};
      if (identityCommitment == null || identityCommitment === '') {
        throw new HttpError(400, 'identityCommitment required');
      }
      const { election, party, record } = await store.recordPartyAttestation(req.params.id, req.params.partyId, {
        identityCommitment,
        expiresAt,
        evidenceHash,
        issuer: req.user.handle,
      });
      await explorer.append('party_attest', {
        electionId: String(election.id),
        partyId: party.id,
        identityCommitment: record.identityCommitment,
        expiresAt: record.expiresAt,
      });
      res.status(201).json({ ok: true, nfp: true, attestation: record });
    }),
  );

  return router;
}
