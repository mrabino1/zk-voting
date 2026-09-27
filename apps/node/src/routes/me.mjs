// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler } from '../http.mjs';
import { requireAuth } from '../auth.mjs';
import { publicIdentity } from '../identity.mjs';
import { normalizeEmail } from '../identity.mjs';
import { audienceOfUser, isPlatformOperator, isSuperAdmin, userIsOfficer } from '../roles.mjs';

function expandedRoles(store, user) {
  if (!user) return [];
  if (isSuperAdmin(user)) {
    return [
      'platform_super_admin',
      'platform_admin',
      'CLERK',
      'REGISTRAR',
      'DISQUALIFICATION_OFFICER',
      'TALLY_OPERATOR',
      'ELECTION_STAFF',
    ];
  }
  if (isPlatformOperator(user)) {
    return [
      'platform_admin',
      'CLERK',
      'REGISTRAR',
      'DISQUALIFICATION_OFFICER',
      'TALLY_OPERATOR',
      'ELECTION_STAFF',
    ];
  }
  const set = new Set();
  if (user.role) set.add(String(user.role).toUpperCase());
  for (const grant of store.listJurisdictionRolesForUser(user)) {
    set.add(String(grant.role).toUpperCase());
  }
  for (const grant of store.listElectionRolesForUser(user)) {
    set.add(String(grant.role).toUpperCase());
  }
  return [...set];
}

function electionsMap(store, user) {
  if (!user) return {};
    const out = {};
    for (const election of store.listElections()) {
      const status = store.voterStatus(election.id, user.id);
      if (status.pending) {
        out[String(election.id)] = {
          status: 'pending',
          requestId: status.requestId,
          reasonCode: null,
        };
        continue;
      }
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
    const electionRoles = req.user ? store.listElectionRolesForUser(req.user) : [];
    const roles = user ? expandedRoles(store, req.user) : [];
    const elections = electionsMap(store, req.user);
    const officer = userIsOfficer(req.user, jurisdictionRoles);
    const audience = audienceOfUser(req.user, jurisdictionRoles);
    const me = user
      ? {
          ...user,
          contactEmail: req.user.contactEmail || '',
          name: user.handle,
          roles,
          jurisdictionRoles,
          electionRoles,
          elections,
          identity: publicIdentity(req.user),
          officer,
          audience,
        }
      : null;
    return {
      nfp: true,
      user,
      me,
      roles,
      jurisdictionRoles,
      electionRoles,
      elections,
      officer,
      audience,
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

  router.patch(
    '/me/contact-email',
    requireAuth,
    asyncHandler(async (req, res) => {
      const raw = req.body?.contactEmail;
      if (raw == null || String(raw).trim() === '') {
        req.user.contactEmail = '';
        await store.persist();
        res.json({ ok: true, nfp: true, contactEmail: '' });
        return;
      }
      const contactEmail = normalizeEmail(raw);
      req.user.contactEmail = contactEmail;
      await store.persist();
      res.json({ ok: true, nfp: true, contactEmail });
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
