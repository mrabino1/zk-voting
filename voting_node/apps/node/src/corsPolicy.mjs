// NOT FOR PROFIT — civic public good, not a commercial product.
// CORS: the public JSON API stays readable from any origin, but a browser only
// sends the session cookie cross-origin to origins this host trusts.

function originOf(value) {
  try {
    const url = new URL(String(value));
    return url.origin === 'null' ? '' : url.origin;
  } catch {
    return '';
  }
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',');
}

/**
 * Origins allowed to make credentialed (cookie) cross-origin requests:
 * the WebAuthn origins, the public base URL, and any operator extras from
 * `config.corsOrigins` or `CORS_ALLOWED_ORIGINS` (comma-separated).
 * @param {Record<string, any>} config
 */
export function credentialedOrigins(config = {}) {
  const extras = config.corsOrigins !== undefined ? config.corsOrigins : process.env.CORS_ALLOWED_ORIGINS;
  const raw = [...listOf(config.origins), config.publicBaseUrl || '', ...listOf(extras)];
  const out = new Set();
  for (const item of raw) {
    const origin = originOf(String(item || '').trim());
    if (origin) out.add(origin);
  }
  return out;
}

/**
 * Options delegate for the `cors` middleware. Every origin is still echoed in
 * `Access-Control-Allow-Origin` (public data, API-key callers, local tools),
 * but `Access-Control-Allow-Credentials` is only sent for trusted origins, so
 * another site cannot read a signed-in user's responses.
 * @param {Record<string, any>} config
 */
export function corsOptionsDelegate(config) {
  const trusted = credentialedOrigins(config);
  return function delegate(req, callback) {
    const origin = req.header('origin') || '';
    callback(null, {
      origin: true,
      credentials: Boolean(origin) && trusted.has(origin),
      maxAge: 86400,
    });
  };
}
