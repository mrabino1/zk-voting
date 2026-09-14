// NOT FOR PROFIT — civic public good, not a commercial product.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function setSessionCookie(res, config, sessionId) {
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  const parts = [
    `${config.sessionCookie}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res, config) {
  res.append(
    'Set-Cookie',
    `${config.sessionCookie}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

export function errorHandler(err, req, res, _next) {
  const status = Number(err.status || err.statusCode || 500);
  if (status >= 500 && !req.app?.locals?.quiet) {
    console.error(err);
  }
  res.status(status).json({
    error: status >= 500 ? 'internal error' : err.message || 'request failed',
    nfp: true,
    ...(err.extra || {}),
  });
}

const BANNED_PRIVACY_KEYS = new Set([
  'userId',
  'user_id',
  'passkeyUserId',
  'passkey_user_id',
  'choice',
  'optionId',
  'option_id',
  'selected',
  'plaintext',
  'voteFor',
]);

/** Strip identity↔choice fields before persisting a ballot envelope. */
export function stripBallotPii(value) {
  if (Array.isArray(value)) return value.map(stripBallotPii);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (BANNED_PRIVACY_KEYS.has(k)) continue;
    out[k] = k === 'encryptedBallot' ? v : stripBallotPii(v);
  }
  return out;
}
