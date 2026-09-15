// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { requireAuth, requireRole, publicUser } from '../auth.mjs';
import { REASON_CODES } from '../reasonCodes.mjs';
import { OFFICER_ROLES, ROLES } from '../roles.mjs';

function officerPayload(req) {
  return {
    address: req.body?.address || req.query?.address,
    role: req.body?.role || req.query?.role,
    handle: req.body?.handle || req.query?.handle,
    userId: req.body?.userId || req.query?.userId,
  };
}

export function adminRouter(deps) {
  const { store } = deps;
  const router = Router();

  router.get('/reason-codes', (_req, res) => {
    res.json({ nfp: true, reasonCodes: REASON_CODES });
  });

  router.get('/roles', (_req, res) => {
    res.json({ nfp: true, roles: ROLES, officerRoles: OFFICER_ROLES });
  });

  router.get(
    '/jurisdictions',
    asyncHandler(async (_req, res) => {
      res.json({ nfp: true, jurisdictions: store.listJurisdictions() });
    }),
  );

  router.post(
    '/jurisdictions',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const jurisdiction = await store.createJurisdiction({
        id: req.body?.id || req.body?.code,
        name: req.body?.name,
        metadataURI: req.body?.metadataURI,
      });
      res.status(201).json({
        ok: true,
        id: jurisdiction.id,
        jurisdiction,
        nfp: true,
      });
    }),
  );

  router.get(
    '/jurisdictions/:id',
    asyncHandler(async (req, res) => {
      const jurisdiction = store.getJurisdiction(req.params.id);
      if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
      res.json({ nfp: true, jurisdiction });
    }),
  );

  router.get(
    '/jurisdictions/:id/roles',
    asyncHandler(async (req, res) => {
      const jurisdiction = store.getJurisdiction(req.params.id);
      if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
      res.json({
        nfp: true,
        jurisdictionId: jurisdiction.id,
        officers: jurisdiction.officers || [],
      });
    }),
  );

  router.post(
    '/jurisdictions/:id/roles',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const result = await store.grantJurisdictionRole(req.params.id, officerPayload(req));
      res.json({ ok: true, ...result, user: publicUser(result.user), nfp: true });
    }),
  );

  router.delete(
    '/jurisdictions/:id/roles',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const result = await store.revokeJurisdictionRole(req.params.id, officerPayload(req));
      res.json({ ok: true, ...result, user: publicUser(result.user), nfp: true });
    }),
  );

  router.post(
    '/admin/roles',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const jurisdictionId = req.body?.jurisdictionId;
      if (!jurisdictionId) throw new HttpError(400, 'jurisdictionId required');
      const result = await store.grantJurisdictionRole(jurisdictionId, officerPayload(req));
      res.json({ ok: true, ...result, user: publicUser(result.user), nfp: true });
    }),
  );

  router.post(
    '/admin/grant',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const jurisdictionId = req.body?.jurisdictionId;
      if (!jurisdictionId) throw new HttpError(400, 'jurisdictionId required');
      const result = await store.grantJurisdictionRole(jurisdictionId, officerPayload(req));
      res.json({ ok: true, ...result, user: publicUser(result.user), nfp: true });
    }),
  );

  router.get(
    '/users',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (_req, res) => {
      res.json({
        nfp: true,
        users: store.listUsers().map((user) => ({
          ...publicUser(user),
          jurisdictionRoles: store.listJurisdictionRolesForUser(user),
        })),
      });
    }),
  );

  router.patch(
    '/users/:id',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const role = req.body?.role;
      if (!role) throw new HttpError(400, 'role required');
      const user = await store.updateUserRole(req.params.id, role);
      res.json({ ok: true, user: publicUser(user), nfp: true });
    }),
  );

  return router;
}
