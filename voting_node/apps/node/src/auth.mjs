// NOT FOR PROFIT — civic public good, not a commercial product.

import { publicApiKey } from './apiKeys.mjs';
import { apiKeyAllowsOperation, matchBotOperation } from './botApiCatalog.mjs';
import { parseCookies, setSessionCookie, clearSessionCookie, clearMfaCookie, HttpError } from './http.mjs';
import { isPlatformOperator, isSuperAdmin, publicUser } from './roles.mjs';

function presentedApiKey(req) {
  const header = String(req.get('x-api-key') || '').trim();
  if (header) return header;
  const auth = String(req.get('authorization') || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (match && match[1].startsWith('rk_')) return match[1];
  return '';
}

export function attachAuth(store, config) {
  return function authMiddleware(req, _res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[config.sessionCookie];
    const mfaName = config.mfaCookie || 'zk-voting.mfa';
    req.sessionId = sid || null;
    req.session = sid ? store.getSession(sid) : null;
    req.mfaNonce = cookies[mfaName] || null;
    req.apiKey = null;
    req.apiKeyError = null;
    req.authVia = req.session ? 'session' : null;

    const token = presentedApiKey(req);
    if (token) {
      const found = store.authenticateApiKey(token);
      if (found.error) {
        req.apiKeyError = found.error;
        req.user = null;
        req.publicUser = null;
        req.authVia = 'api_key';
        next();
        return;
      }
      if (found.user?.suspendedAt) {
        req.user = null;
        req.publicUser = null;
        req.apiKey = null;
        req.apiKeyError = 'revoked';
        req.authVia = 'api_key';
        next();
        return;
      }
      req.user = found.user;
      req.publicUser = publicUser(req.user);
      req.apiKey = publicApiKey(found.key);
      req.authVia = 'api_key';
      // Never write a timestamp for the key that cast a ballot: lastUsedAt at
      // the second of a vote would join that key's owner to the ballot row.
      if (!isBallotRequest(req)) store.touchApiKey(found.key.id).catch(() => {});
      next();
      return;
    }

    req.user = req.session ? store.getUser(req.session.userId) : null;
    if (req.user?.suspendedAt) {
      req.user = null;
      req.session = null;
    }
    req.publicUser = publicUser(req.user);
    next();
  };
}

/** POST /api/elections/:id/vote — the ballot request itself. */
export function isBallotRequest(req) {
  if (req.method !== 'POST') return false;
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  return /^\/api\/elections\/[^/]+\/vote\/?$/.test(p);
}

const API_KEY_ERROR = Object.freeze({
  invalid: 'invalid api key',
  revoked: 'api key revoked',
  expired: 'api key expired',
});

/** Personal API keys may call only the published bot catalog, and only up to their level. */
export function enforceApiKeyAccess(req, _res, next) {
  if (String(req.path || '').startsWith('/api/_sa')) {
    next();
    return;
  }
  if (req.apiKeyError) {
    const code = String(req.apiKeyError).toUpperCase();
    next(
      new HttpError(401, API_KEY_ERROR[req.apiKeyError] || 'invalid api key', {
        code: `API_KEY_${code}`,
      }),
    );
    return;
  }
  if (!req.apiKey) {
    next();
    return;
  }
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const operation = matchBotOperation(method, req.path);
  if (!apiKeyAllowsOperation(req.apiKey.level, operation)) {
    next(
      new HttpError(403, 'api key cannot call this route', {
        code: 'API_KEY_SCOPE',
        level: req.apiKey.level,
        required: operation?.minLevel || null,
      }),
    );
    return;
  }
  next();
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
    if (isPlatformOperator(req.user) || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(new HttpError(403, 'forbidden', { role: req.user.role }));
  };
}

export function requireSuperAdmin(req, _res, next) {
  if (!req.user) {
    next(new HttpError(401, 'unauthenticated'));
    return;
  }
  if (req.apiKey) {
    next(new HttpError(403, 'api key cannot call this route', { code: 'API_KEY_SCOPE' }));
    return;
  }
  if (isSuperAdmin(req.user)) {
    next();
    return;
  }
  next(new HttpError(403, 'forbidden', { role: req.user.role, required: 'platform_super_admin' }));
}

export function requirePlatformOperator(req, _res, next) {
  if (!req.user) {
    next(new HttpError(401, 'unauthenticated'));
    return;
  }
  if (isPlatformOperator(req.user)) {
    next();
    return;
  }
  next(new HttpError(403, 'forbidden', { role: req.user.role }));
}

/** Clerk / registrar / tally / disqualification officer on a jurisdiction, or platform operator. */
export function requireJurisdictionRoleFromBody(store, ...roles) {
  return function jurisdictionRoleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    if (isPlatformOperator(req.user)) {
      next();
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

/** Officer on the election's jurisdiction, or platform operator. */
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
    if (isPlatformOperator(req.user)) {
      next();
      return;
    }
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

/** Officer on any jurisdiction, or platform operator (person-level registrar tools). */
export function requireAnyJurisdictionRole(store, ...roles) {
  return function anyJurisdictionRoleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated'));
      return;
    }
    if (isPlatformOperator(req.user)) {
      next();
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
  if (user?.suspendedAt) {
    throw new HttpError(403, 'account suspended', { code: 'SUSPENDED' });
  }
  const session = await store.createSession(user.id, config.sessionTtlMs);
  setSessionCookie(res, config, session.id);
  return session;
}

export async function destroySession(req, res, store, config) {
  if (req.sessionId) await store.deleteSession(req.sessionId);
  clearSessionCookie(res, config);
  clearMfaCookie(res, config);
}

export { publicUser, isSuperAdmin, isPlatformOperator };
