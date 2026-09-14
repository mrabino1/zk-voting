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
