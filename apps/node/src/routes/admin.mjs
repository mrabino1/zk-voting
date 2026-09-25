// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { requireAuth, requireRole, requireSuperAdmin, publicUser } from '../auth.mjs';
import { REASON_CODES } from '../reasonCodes.mjs';
import { APPROVAL_CHAIN, isPlatformOperator, isSuperAdmin, OFFICER_ROLES, ROLES } from '../roles.mjs';

function publicJurisdiction(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    metadataURI: row.metadataURI || '',
  };
}

function canSeeOfficers(store, user) {
  if (!user) return false;
  if (isPlatformOperator(user)) return true;
  return store.userHasAnyJurisdictionRole(user, OFFICER_ROLES);
}

function presentJurisdiction(store, user, row) {
  const pub = publicJurisdiction(row);
  if (!pub) return null;
  if (!canSeeOfficers(store, user)) return pub;
  return {
    ...pub,
    officers: row.officers || [],
    createdAt: row.createdAt || null,
  };
}

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
    res.json({
      nfp: true,
      roles: ROLES,
      officerRoles: OFFICER_ROLES,
      approvalChain: APPROVAL_CHAIN,
    });
  });

  router.get(
    '/jurisdictions',
    asyncHandler(async (req, res) => {
      res.json({
        nfp: true,
        jurisdictions: store.listJurisdictions().map((row) => presentJurisdiction(store, req.user, row)),
      });
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
      res.json({ nfp: true, jurisdiction: presentJurisdiction(store, req.user, jurisdiction) });
    }),
  );

  router.get(
    '/jurisdictions/:id/roles',
    requireAuth,
    asyncHandler(async (req, res) => {
      const jurisdiction = store.getJurisdiction(req.params.id);
      if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
      if (!canSeeOfficers(store, req.user)) {
        throw new HttpError(403, 'forbidden', { role: req.user.role });
      }
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

  router.get(
    '/admin/admins',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (_req, res) => {
      res.json({
        nfp: true,
        admins: store.listAdmins().map((user) => publicUser(user)),
      });
    }),
  );

  router.post(
    '/admin/admins',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const user = await store.approveAdmin({
        userId: req.body?.userId,
        handle: req.body?.handle,
      });
      res.status(201).json({ ok: true, nfp: true, user: publicUser(user) });
    }),
  );

  router.delete(
    '/admin/admins',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const user = await store.revokeAdmin({
        userId: req.body?.userId || req.query?.userId,
        handle: req.body?.handle || req.query?.handle,
      });
      res.json({ ok: true, nfp: true, user: publicUser(user) });
    }),
  );

  router.patch(
    '/users/:id',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const role = req.body?.role;
      if (!role) throw new HttpError(400, 'role required');
      const target = store.getUser(req.params.id);
      if (!target) throw new HttpError(404, 'user not found');
      const elevating =
        role === 'platform_admin' ||
        role === 'platform_super_admin' ||
        target.role === 'platform_super_admin';
      if (elevating && !isSuperAdmin(req.user)) {
        throw new HttpError(403, 'only a platform super admin may approve admins', {
          role: req.user.role,
        });
      }
      if (target.role === 'platform_super_admin' && role !== 'platform_super_admin') {
        const supers = store.listAdmins().filter((u) => u.role === 'platform_super_admin');
        if (supers.length <= 1) {
          throw new HttpError(400, 'cannot demote the last platform super admin');
        }
      }
      const user = await store.updateUserRole(req.params.id, role);
      res.json({ ok: true, user: publicUser(user), nfp: true });
    }),
  );

  return router;
}
