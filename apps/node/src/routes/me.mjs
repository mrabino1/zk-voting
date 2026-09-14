// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { requireAuth } from '../auth.mjs';
import { publicIdentity } from '../identity.mjs';

function expandedRoles(role) {
  if (role === 'platform_admin') {
    return [
      'platform_admin',
      'CLERK',
      'REGISTRAR',
      'DISQUALIFICATION_OFFICER',
      'TALLY_OPERATOR',
    ];
  }
  return [String(role || '').toUpperCase()];
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
    const roles = user ? expandedRoles(user.role) : [];
    const elections = electionsMap(store, req.user);
    const me = user
      ? {
          ...user,
          name: user.handle,
          roles,
          elections,
          identity: publicIdentity(req.user),
        }
      : null;
    return {
      nfp: true,
      user,
      me,
      roles,
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
