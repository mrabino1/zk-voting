// NOT FOR PROFIT — civic public good, not a commercial product.

import { parseCookies, setSessionCookie, clearSessionCookie, HttpError } from './http.mjs';
import { publicUser } from './roles.mjs';

export function attachAuth(store, config) {
  return function authMiddleware(req, _res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[config.sessionCookie];
    req.sessionId = sid || null;
    req.session = sid ? store.getSession(sid) : null;
    req.user = req.session ? store.getUser(req.session.userId) : null;
    req.publicUser = publicUser(req.user);
    next();
  };
}

export function requireAuth(req, _res, next) {
  if (!req.user) {
    next(new HttpError(401, 'unauthenticated'));
    return;
  }
  next();
}

export function requireRole(...roles) {
  return function roleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    if (req.user.role === 'platform_admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', { role: req.user.role }));
  };
}

/** Clerk / registrar / tally / disqualification officer on a jurisdiction, or platform_admin. */
export function requireJurisdictionRoleFromBody(store, ...roles) {
  return function jurisdictionRoleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    const jurisdictionId = String(req.body?.jurisdictionId || 'demo');
    if (!store.getJurisdiction(jurisdictionId)) {
      next(new HttpError(400, 'unknown jurisdictionId'));
      return;
    }
    if (store.userHasJurisdictionRole(req.user, roles, jurisdictionId)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', { role: req.user.role, jurisdictionId }));
  };
}

/** Officer on the election's jurisdiction, or platform_admin. */
export function requireElectionRole(store, ...roles) {
  return function electionRoleMiddleware(req, _res, next) {
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
    if (store.userHasJurisdictionRole(req.user, roles, election.jurisdictionId)) {
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

/** Officer on any jurisdiction, or platform_admin (person-level registrar tools). */
export function requireAnyJurisdictionRole(store, ...roles) {
  return function anyJurisdictionRoleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    if (store.userHasAnyJurisdictionRole(req.user, roles)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', { role: req.user.role }));
  };
}

export async function establishSession(res, store, config, user) {
  const session = await store.createSession(user.id, config.sessionTtlMs);
  setSessionCookie(res, config, session.id);
  return session;
}

export async function destroySession(req, res, store, config) {
  if (req.sessionId) await store.deleteSession(req.sessionId);
  clearSessionCookie(res, config);
}

export { publicUser };
