// NOT FOR PROFIT — civic public good, not a commercial product.
// Guards shared by the site-admin API and the plugin API.

import { timingSafeEqual } from 'node:crypto';

import { HttpError } from './http.mjs';

function tokensEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Signed-in browser session only (no API keys). */
export function requireSession(req, _res, next) {
  if (!req.user || !req.session) {
    next(new HttpError(401, 'unauthenticated'));
    return;
  }
  if (req.apiKey) {
    next(new HttpError(403, 'api key cannot use site admin', { code: 'API_KEY_SCOPE' }));
    return;
  }
  next();
}

/**
 * Double-submit CSRF check for state-changing requests: `x-csrf-token` must
 * equal the session token, and cross-site fetches are refused.
 */
export function requireCsrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site' || !tokensEqual(req.session?.csrfToken, req.get('x-csrf-token'))) {
    next(new HttpError(403, 'csrf check failed', { code: 'CSRF' }));
    return;
  }
  next();
}

/** Seconds since the session's last real sign-in (not step-up). */
export function loginAgeMs(session, nowMs = Date.now()) {
  const at = Number(session?.authenticatedAt || session?.createdAt || 0);
  return at ? nowMs - at : Infinity;
}

/**
 * Re-auth gate: the session must come from a sign-in within `windowMs`.
 * The super-admin "step-up" marker does not count, because it only proves a
 * CSRF token, not a fresh credential.
 */
export function requireRecentLogin(windowMs) {
  return function recentLogin(req, _res, next) {
    if (loginAgeMs(req.session) > windowMs) {
      next(
        new HttpError(401, 'sign in again to continue', {
          code: 'REAUTH_REQUIRED',
          reauthWindowSeconds: Math.round(windowMs / 1000),
        }),
      );
      return;
    }
    next();
  };
}
