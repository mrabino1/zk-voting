// NOT FOR PROFIT — civic public good, not a commercial product.
// Response guard for the platform super-admin API. Ballot secrecy, voter
// identity, credentials, and operator secrets must not appear in any field
// or string this surface returns.

export const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'ballot',
  'ballots',
  'encryptedballot',
  'choice',
  'choices',
  'optionid',
  'optionids',
  'ranking',
  'ranks',
  'rankingpayload',
  'answers',
  'selected',
  'plaintext',
  'votefor',
  'vote',
  'votes',
  'nullifier',
  'nullifiers',
  'identitycommitment',
  'identitycommitments',
  'identity_commitment',
  'voterid',
  'voterids',
  'votermap',
  'registrationlist',
  'registrations',
  'identitylinks',
  'proof',
  'proofs',
  'witness',
  'witnesses',
  'snarkproof',
  'guardiankey',
  'guardianshare',
  'guardianshares',
  'ceremonykey',
  'ceremony',
  'shares',
  'privatekey',
  'secretkey',
  'sessioncookie',
  'sessionid',
  'sessions',
  'credentialid',
  'credentials',
  'passkey',
  'passkeys',
  'apikey',
  'apikeys',
  'secret',
  'secrethash',
  'pepper',
  'awssecretaccesskey',
  'aws_secret_access_key',
  'secretaccesskey',
  'sessecret',
  'contactemail',
  'superadminemail',
  'email',
  'pin',
  'pinhash',
  'otp',
  'cookies',
  'authorization',
  'relayerprivatekey',
  'l1publisherprivatekey',
  'receiptpdfsecret',
  'credentialprovidersecret',
  'exploreringestsecret',
]);

const FORBIDDEN = new Set(FORBIDDEN_FIELD_NAMES);

const SECRET_TEXT = [
  /zksa_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/i,
  /rk_[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ASIA[0-9A-Z]{16}/,
];

export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  out = out.replace(/zksa_[0-9a-f]{16}_[A-Za-z0-9_-]+/gi, 'zksa_[redacted]');
  out = out.replace(/rk_[A-Za-z0-9_-]{10,}/g, 'rk_[redacted]');
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/AKIA[0-9A-Z]{16}/g, '[redacted]');
  out = out.replace(/ASIA[0-9A-Z]{16}/g, '[redacted]');
  out = out.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]');
  for (const secret of secrets) {
    const needle = String(secret || '');
    if (needle.length < 4) continue;
    out = out.split(needle).join('[redacted]');
  }
  return out;
}

function walk(value, visit, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    visit(key, child, next);
    walk(child, visit, next);
  }
}

export function forbiddenFieldPaths(value) {
  const found = [];
  walk(value, (key, _child, path) => {
    if (FORBIDDEN.has(String(key).toLowerCase())) found.push(path);
  });
  return found;
}

/**
 * @param {unknown} value
 * @param {{ superAdminEmail?: string, pepper?: string, extraSecrets?: string[] }} [ctx]
 * @param {{ allowToken?: boolean }} [opts]
 * @returns {string[]} problem paths
 */
export function redactionProblems(value, ctx = {}, opts = {}) {
  const problems = [];
  const email = String(ctx.superAdminEmail || '').trim().toLowerCase();
  const secrets = [ctx.pepper, ...(ctx.extraSecrets || [])].filter((item) => String(item || '').length >= 4);
  walk(value, (key, child, path) => {
    if (FORBIDDEN.has(String(key).toLowerCase())) problems.push(path);
    if (typeof child !== 'string') return;
    if (opts.allowToken && path === 'token') return;
    if (SECRET_TEXT.some((re) => re.test(child))) problems.push(path);
    const lower = child.toLowerCase();
    if (email && lower.includes(email)) problems.push(path);
    for (const secret of secrets) {
      if (child.includes(String(secret))) problems.push(path);
    }
  });
  return [...new Set(problems)];
}

export function assertSafeSaPayload(value, ctx = {}, opts = {}) {
  const problems = redactionProblems(value, ctx, opts);
  if (problems.length === 0) return value;
  const err = new Error('response failed redaction');
  err.code = 'REDACTION';
  err.paths = problems;
  throw err;
}
