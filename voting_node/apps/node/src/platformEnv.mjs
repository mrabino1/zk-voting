// NOT FOR PROFIT — civic public good, not a commercial product.
//
// Fill settings a hosting platform already knows, so a person who deploys a fork does not
// have to type them. Explicit environment variables always win; this only fills blanks.
//
// Coolify (Docker Compose build pack) injects, into a service that has a domain:
//   COOLIFY_FQDN  host names, comma separated, no scheme or port   (vote.example.org)
//   COOLIFY_URL   the same with scheme                              (https://vote.example.org)
// and our docker-compose.coolify.yml passes the Postgres role, password and database that
// Coolify generated (SERVICE_USER_POSTGRES / SERVICE_PASSWORD_POSTGRES).

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

function firstOf(list) {
  return String(list || '')
    .split(',')
    .map((s) => s.trim())
    .find(Boolean) || '';
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{ env: Record<string, string|undefined>, derived: Record<string, string> }}
 *   derived[NAME] says where a filled value came from.
 */
export function platformEnv(env = process.env) {
  const out = { ...env };
  const derived = {};
  const fill = (name, value, from) => {
    if (isBlank(value) || !isBlank(out[name])) return;
    out[name] = String(value);
    derived[name] = from;
  };

  const coolifyUrl = firstOf(env.COOLIFY_URL);
  const coolifyHost = firstOf(env.COOLIFY_FQDN) || (coolifyUrl ? safeHost(coolifyUrl) : '');
  if (coolifyHost) {
    fill('VOTE_FQDN', coolifyHost, 'Coolify domain (COOLIFY_FQDN)');
    // Keep the scheme Coolify reports: an http:// test domain must not be advertised as https.
    fill('PUBLIC_BASE_URL', coolifyUrl || `https://${coolifyHost}`, 'Coolify domain (COOLIFY_URL)');
    // Coolify always routes through its reverse proxy (Traefik or Caddy): one hop.
    fill('TRUST_PROXY', '1', 'Coolify reverse proxy');
  }

  if (isBlank(env.DATABASE_URL) && !isBlank(env.POSTGRES_USER) && !isBlank(env.POSTGRES_PASSWORD) && !isBlank(env.POSTGRES_DB)) {
    const host = String(env.POSTGRES_HOST || 'db').trim();
    const port = String(env.POSTGRES_PORT || '5432').trim();
    const url =
      `postgres://${encodeURIComponent(env.POSTGRES_USER)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}` +
      `@${host}:${port}/${encodeURIComponent(env.POSTGRES_DB)}`;
    fill('DATABASE_URL', url, 'POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB');
  }
  return { env: out, derived };
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Is the public address plain http on a real host? Passkeys then cannot work. */
export function insecurePublicUrl(publicBaseUrl, voteFqdn) {
  const url = String(publicBaseUrl || '').trim();
  if (!url.startsWith('http://')) return false;
  const host = safeHost(url) || String(voteFqdn || '');
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
}

/** Apply to process.env in place, at start-up only. */
export function applyPlatformEnv(target = process.env) {
  const { env, derived } = platformEnv(target);
  for (const name of Object.keys(derived)) target[name] = env[name];
  return derived;
}

// Which settings were filled at boot, and from where ("platform" or "setup"), so /setup can
// tell a value it may change from one the operator fixed in the environment.
const filledAtBoot = new Map();

export function recordFilled(names, from) {
  for (const name of names) filledAtBoot.set(name, from);
}

/** "environment" (typed by the operator), "platform", "setup", or "unset". */
export function settingSource(name, env = process.env) {
  if (filledAtBoot.has(name)) return filledAtBoot.get(name);
  return isBlank(env[name]) ? 'unset' : 'environment';
}
