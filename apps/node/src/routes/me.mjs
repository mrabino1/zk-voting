// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { requireAuth } from '../auth.mjs';
import { publicIdentity } from '../identity.mjs';

function expandedRoles(store, user) {
  if (!user) return [];
  if (user.role === 'platform_admin') {
    return [
      'platform_admin',
      'CLERK',
      'REGISTRAR',
      'DISQUALIFICATION_OFFICER',
      'TALLY_OPERATOR',
    ];
  }
  const set = new Set();
  if (user.role) set.add(String(user.role).toUpperCase());
  for (const grant of store.listJurisdictionRolesForUser(user)) {
    set.add(String(grant.role).toUpperCase());
  }
  return [...set];
}

function electionsMap(store, user) {
  if (!user) return {};
  const out = {};
  for (const election of store.listElections()) {
    const status = store.voterStatus(election.id, user.id);
    if (!status.registered) continue;
    out[String(election.id)] = {
      status: status.disqualified ? 'disqualified' : 'registered',
      reasonCode: status.reasonCode,
    };
  }
  return out;
}

export function meRouter(deps) {
  const { store } = deps;
  const router = Router();

  function mePayload(req) {
    const notifications = req.user ? store.listNotifications(req.user.id) : [];
    const user = req.publicUser;
    const jurisdictionRoles = req.user ? store.listJurisdictionRolesForUser(req.user) : [];
    const roles = user ? expandedRoles(store, req.user) : [];
    const elections = electionsMap(store, req.user);
    const me = user
      ? {
          ...user,
          name: user.handle,
          roles,
          jurisdictionRoles,
          elections,
          identity: publicIdentity(req.user),
        }
      : null;
    return {
      nfp: true,
      user,
      me,
      roles,
      jurisdictionRoles,
      elections,
      identity: req.user ? publicIdentity(req.user) : null,
      unreadCount: notifications.filter((n) => !n.read).length,
    };
  }

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      res.json(mePayload(req));
    }),
  );

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      res.json(mePayload(req));
    }),
  );

  router.get(
    '/notifications',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ nfp: true, notifications: store.listNotifications(req.user.id) });
    }),
  );

  router.post(
    '/notifications/:id/read',
    requireAuth,
    asyncHandler(async (req, res) => {
      const n = await store.markNotificationRead(req.user.id, req.params.id);
      res.json({ ok: true, notification: n, nfp: true });
    }),
  );

  return router;
}
