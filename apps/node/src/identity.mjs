// NOT FOR PROFIT — civic public good, not a commercial product.
// One person. Many internally verified authenticators and ETH addresses.
// Exactly one active Ethereum address. The vote Merkle leaf is never that
// address.

import { randomBytes } from 'node:crypto';

import { getAddress, isAddress, keccak256, toHex, verifyMessage } from 'viem';

import { HttpError } from './http.mjs';

export const AUTH_METHOD_TYPES = Object.freeze([
  'email',
  'web3',
  'smart_card',
  'civic_id',
  'passkey',
]);

export const CIVIC_ID_KINDS = Object.freeze(['drivers_license', 'passport']);

export const AUTH_METHOD_CATALOG = Object.freeze([
  {
    type: 'email',
    label: 'Email',
    summary: 'Username is an email address. Sign-in always completes with a one-time code (AWS SES).',
  },
  {
    type: 'web3',
    label: 'Web3 wallet',
    summary: 'Browser wallet (MetaMask and peers) signs a SIWE-like message, then email MFA.',
  },
  {
    type: 'smart_card',
    label: 'Smart card reader',
    summary: 'PIV, CAC, or national eID presented at a kiosk reader, then email MFA.',
  },
  {
    type: 'civic_id',
    label: 'Driver’s license or passport',
    summary:
      'Socially certified photo ID. The Node stores a hash, never the document image or full number. Then email MFA.',
  },
  {
    type: 'passkey',
    label: 'Passkey',
    summary: 'Device WebAuthn credential (Touch ID, Windows Hello, hardware key), then email MFA when SES is on.',
  },
]);

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function isAuthMethodType(type) {
  return AUTH_METHOD_TYPES.includes(String(type || ''));
}

export function ensurePersonFields(user) {
  if (!user) return user;
  if (!Array.isArray(user.credentials)) user.credentials = [];
  if (!Array.isArray(user.authMethods)) user.authMethods = [];
  if (!Array.isArray(user.ethAccounts)) user.ethAccounts = [];
  if (!Object.prototype.hasOwnProperty.call(user, 'activeEthAddress')) {
    user.activeEthAddress = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'personKeyHash')) {
    user.personKeyHash = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'email')) {
    user.email = null;
  }
  return user;
}

export function normalizeEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    throw new HttpError(400, 'invalid email');
  }
  return raw;
}

export function emailHint(value) {
  try {
    const email = String(value || '').trim().toLowerCase();
    const at = email.indexOf('@');
    if (at < 1) return '***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const shown = local.slice(0, 1);
    return `${shown}***@${domain}`;
  } catch {
    return '***';
  }
}

export function userEmail(user) {
  if (!user) return null;
  ensurePersonFields(user);
  if (user.email) {
    try {
      return normalizeEmail(user.email);
    } catch {
      /* ignore */
    }
  }
  const method = user.authMethods.find((m) => m.type === 'email' && m.email);
  if (!method) return null;
  try {
    return normalizeEmail(method.email);
  } catch {
    return null;
  }
}

export function isCivicIdKind(kind) {
  return CIVIC_ID_KINDS.includes(String(kind || ''));
}

export function normalizeIssuer(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  if (raw.length < 2 || raw.length > 16) {
    throw new HttpError(400, 'issuing jurisdiction required');
  }
  return raw;
}

export function normalizeDocumentNumber(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '');
  if (raw.length < 4) throw new HttpError(400, 'document number too short');
  if (raw.length > 64) throw new HttpError(400, 'document number too long');
  return raw;
}

/**
 * Hash only. Callers must drop the document number after this returns.
 * Not a court-ready identity-verification product.
 */
export function civicIdHash({ kind, issuer, documentNumber }) {
  const k = String(kind || '');
  if (!isCivicIdKind(k)) throw new HttpError(400, 'invalid civic id kind');
  const issuerN = normalizeIssuer(issuer);
  const doc = normalizeDocumentNumber(documentNumber);
  return keccak256(toHex(Buffer.from(`republic:civic_id:v1|${k}|${issuerN}|${doc}`, 'utf8')));
}

export function civicIdLabel(kind) {
  return kind === 'passport' ? 'Passport' : 'Driver’s license';
}

export function normalizeEthAddress(value) {
  const raw = String(value || '').trim();
  if (!raw || !isAddress(raw)) {
    throw new HttpError(400, 'invalid Ethereum address');
  }
  return getAddress(raw);
}

export function sameEthAddress(a, b) {
  if (!a || !b) return false;
  try {
    return normalizeEthAddress(a) === normalizeEthAddress(b);
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

export function normalizeFingerprint(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new HttpError(400, 'smart-card fingerprint required');
  if (raw.startsWith('0x') || raw.startsWith('0X')) {
    const body = raw.slice(2).toLowerCase();
    if (!/^[0-9a-f]+$/.test(body) || body.length < 16) {
      throw new HttpError(400, 'invalid smart-card fingerprint');
    }
    return `0x${body}`;
  }
  return keccak256(toHex(Buffer.from(raw, 'utf8')));
}

export function fingerprintFromCertificate(certificate) {
  const pem = String(certificate || '').trim();
  if (!pem) throw new HttpError(400, 'certificate required');
  return keccak256(toHex(Buffer.from(pem, 'utf8')));
}

export function publicAuthMethod(method) {
  if (!method) return null;
  const out = {
    id: method.id,
    type: method.type,
    verified: Boolean(method.verified),
    verifiedBy: method.verifiedBy || 'self',
    verifiedAt: method.verifiedAt || null,
    label: method.label || null,
  };
  if (method.type === 'web3') out.address = method.address;
  if (method.type === 'passkey') out.credentialId = method.credentialId;
  if (method.type === 'email') out.email = method.email;
  if (method.type === 'smart_card') {
    out.fingerprint = method.fingerprint;
    out.subject = method.subject || null;
    out.issuer = method.issuer || null;
  }
  if (method.type === 'civic_id') {
    out.kind = method.kind || null;
    out.issuer = method.issuer || null;
  }
  return out;
}

export function publicEthAccount(account, activeEthAddress) {
  if (!account) return null;
  return {
    address: account.address,
    source: account.source,
    verified: Boolean(account.verified),
    active: sameEthAddress(account.address, activeEthAddress),
    verifiedAt: account.verifiedAt || null,
  };
}

export function publicIdentity(user) {
  if (!user) return null;
  ensurePersonFields(user);
  return {
    personId: user.id,
    personKeyBound: Boolean(user.personKeyHash),
    emailBound: Boolean(userEmail(user)),
    emailHint: userEmail(user) ? emailHint(userEmail(user)) : null,
    authMethods: user.authMethods.map(publicAuthMethod),
    ethAccounts: user.ethAccounts.map((a) => publicEthAccount(a, user.activeEthAddress)),
    activeEthAddress: user.activeEthAddress,
    verifiedEthAddressCount: user.ethAccounts.length,
    note: 'Many methods and addresses may be verified internally. Only one Ethereum address is active. Sign-in completes with email MFA when SES is configured.',
  };
}

/**
 * Session user wins if they already own the authenticator / address.
 * A second person cannot absorb someone else's method or ETH address.
 */
export function resolveBoundPerson({ sessionUser, methodOwner, addressOwner }) {
  if (methodOwner && addressOwner && methodOwner.id !== addressOwner.id) {
    throw new HttpError(409, 'authenticator and address belong to different people', {
      code: 'IDENTITY_CONFLICT',
    });
  }
  if (sessionUser) {
    if (methodOwner && methodOwner.id !== sessionUser.id) {
      throw new HttpError(409, 'authenticator already bound to another person', {
        code: 'METHOD_OWNED',
      });
    }
    if (addressOwner && addressOwner.id !== sessionUser.id) {
      throw new HttpError(409, 'Ethereum address already bound to another person', {
        code: 'ADDRESS_OWNED',
      });
    }
    return sessionUser;
  }
  return methodOwner || addressOwner || null;
}

export function buildWeb3BindMessage({ address, nonce, chainId, origin }) {
  const addr = normalizeEthAddress(address);
  return [
    'Republic wants you to uniquely identify this Ethereum address to your person.',
    '',
    `URI: ${origin || 'republic'}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Address: ${addr}`,
    '',
    'You may verify several wallets internally. Only one active Ethereum address is registered at a time.',
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
  ].join('\n');
}

export function buildWeb3LoginMessage({ address, nonce, chainId, origin }) {
  const addr = normalizeEthAddress(address);
  return [
    'Republic wants you to sign in with this Ethereum wallet.',
    '',
    `URI: ${origin || 'republic'}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Address: ${addr}`,
    '',
    'This proves you control a wallet already bound to your person. It does not register a new person.',
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
  ].join('\n');
}

/**
 * Returning-user wallet login. A web3 auth method wins; otherwise a verified
 * ETH account already mapped to a Person. Unknown addresses are not created.
 */
export function resolveWeb3LoginPerson(store, address) {
  const addr = normalizeEthAddress(address);
  const foundMethod = store.findUserByAuthMethod({ type: 'web3', address: addr });
  if (foundMethod?.user) return foundMethod.user;
  return store.findUserByEthAddress(addr);
}

export function resolveEmailLoginPerson(store, email) {
  return store.findUserByEmail(email);
}

export function resolveSmartCardLoginPerson(store, fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  return store.findUserByAuthMethod({ type: 'smart_card', fingerprint: fp })?.user || null;
}

export function resolveCivicIdLoginPerson(store, { kind, issuer, documentNumber }) {
  const hash = civicIdHash({ kind, issuer, documentNumber });
  return (
    store.findUserByAuthMethod({ type: 'civic_id', fingerprint: hash, civicIdHash: hash })?.user ||
    null
  );
}

export function buildSmartCardBindMessage({ fingerprint, nonce }) {
  return [
    'Republic smart-card digital ID binding',
    `Nonce: ${nonce}`,
    `Fingerprint: ${fingerprint}`,
    'NOT FOR PROFIT — civic public good.',
  ].join('\n');
}

export async function verifyWeb3Bind({ address, message, signature }) {
  const addr = normalizeEthAddress(address);
  let ok = false;
  try {
    ok = await verifyMessage({ address: addr, message, signature });
  } catch (err) {
    throw new HttpError(400, `web3 signature invalid: ${err.message || err}`);
  }
  if (!ok) throw new HttpError(400, 'web3 signature invalid');
  return addr;
}

export function createIdentityChallenges() {
  const challenges = new Map();

  function sweep() {
    const now = Date.now();
    for (const [k, v] of challenges) {
      if (!v || v.expiresAt < now) challenges.delete(k);
    }
  }

  function put(entry) {
    sweep();
    const rec = { ...entry, expiresAt: Date.now() + CHALLENGE_TTL_MS };
    challenges.set(entry.nonce, rec);
    if (entry.key) challenges.set(entry.key, rec);
    return rec;
  }

  function take(key) {
    sweep();
    if (!key) return null;
    const rec = challenges.get(key);
    if (!rec) return null;
    challenges.delete(key);
    if (rec.nonce) challenges.delete(rec.nonce);
    if (rec.key) challenges.delete(rec.key);
    if (rec.expiresAt < Date.now()) return null;
    return rec;
  }

  function issueWeb3({ address, chainId, origin, purpose = 'bind' }) {
    const addr = normalizeEthAddress(address);
    const nonce = `0x${randomBytes(16).toString('hex')}`;
    const isLogin = purpose === 'login';
    const message = isLogin
      ? buildWeb3LoginMessage({
          address: addr,
          nonce,
          chainId,
          origin,
        })
      : buildWeb3BindMessage({
          address: addr,
          nonce,
          chainId,
          origin,
        });
    put({
      type: isLogin ? 'web3_login' : 'web3',
      nonce,
      key: isLogin ? `web3-login:${addr.toLowerCase()}` : `web3:${addr.toLowerCase()}`,
      address: addr,
      message,
    });
    return { nonce, message, address: addr, expiresInSeconds: CHALLENGE_TTL_MS / 1000, purpose: isLogin ? 'login' : 'bind' };
  }

  function issueWeb3Login({ address, chainId, origin }) {
    return issueWeb3({ address, chainId, origin, purpose: 'login' });
  }

  function issueSmartCard({ fingerprint, purpose = 'bind' }) {
    const fp = fingerprint ? normalizeFingerprint(fingerprint) : null;
    const nonce = `0x${randomBytes(16).toString('hex')}`;
    const isLogin = purpose === 'login';
    put({
      type: isLogin ? 'smart_card_login' : 'smart_card',
      nonce,
      key: fp ? `${isLogin ? 'card-login' : 'card'}:${fp}` : `${isLogin ? 'card-login' : 'card'}:${nonce}`,
      fingerprint: fp,
    });
    return {
      nonce,
      fingerprint: fp,
      expiresInSeconds: CHALLENGE_TTL_MS / 1000,
      purpose: isLogin ? 'login' : 'bind',
    };
  }

  function issueSmartCardLogin({ fingerprint }) {
    return issueSmartCard({ fingerprint, purpose: 'login' });
  }

  return {
    issueWeb3,
    issueWeb3Login,
    issueSmartCard,
    issueSmartCardLogin,
    take,
    put,
    challenges,
  };
}
