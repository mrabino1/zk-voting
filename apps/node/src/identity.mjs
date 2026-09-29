// NOT FOR PROFIT — civic public good, not a commercial product.
// One person. Many internally verified authenticators and ETH addresses.
// Exactly one active Ethereum address. The vote Merkle leaf is never that
// address.

import { randomBytes, randomUUID } from 'node:crypto';

import { getAddress, isAddress, keccak256, toHex, verifyMessage } from 'viem';

import {
  MAX_CIVIC_IDS_PER_PERSON,
  MAX_SMART_CARDS_PER_PERSON,
  assertCredentialUsable,
  ensureCredentialFields,
  isCredentialMethodType,
  liveCredentialCount,
  publicCredential,
} from './credentials.mjs';
import { HttpError } from './http.mjs';
import { pinPublicFields } from './pin.mjs';

/** Product caps: per Person, not per Node. */
export const MAX_PASSKEYS_PER_PERSON = 5;
export const MAX_EMAILS_PER_PERSON = 5;
export { MAX_CIVIC_IDS_PER_PERSON, MAX_SMART_CARDS_PER_PERSON };

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
    summary:
      'Up to 5 addresses. Exactly one is primary (MFA and SES default). Sign-in always completes with a one-time code (AWS SES).',
  },
  {
    type: 'web3',
    label: 'Web3 wallet',
    summary: 'Browser wallet (MetaMask and peers) signs a SIWE-like message, then email MFA.',
  },
  {
    type: 'smart_card',
    label: 'Smart card reader',
    summary:
      'PIV, CAC, or national eID. A person may bind up to 5. Civil officers can inspect each card and revoke it when the civil registration has expired. Then email MFA.',
  },
  {
    type: 'civic_id',
    label: 'Driver’s license or passport',
    summary:
      'Socially certified photo ID. A person may bind up to 5 licenses or passports. The Node stores a hash, never the document image or full number. Civil officers revoke an expired registration by hand until a third-party DMV connector is wired. Then email MFA.',
  },
  {
    type: 'passkey',
    label: 'Passkey',
    summary:
      'Up to 5 device WebAuthn credentials (Touch ID, Windows Hello, hardware key). Any of them can sign in, then email MFA when SES is on.',
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
  syncPersonEmails(user);
  if (!Object.prototype.hasOwnProperty.call(user, 'termsHash')) {
    user.termsHash = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'termsVersion')) {
    user.termsVersion = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'termsMarkdownSha256')) {
    user.termsMarkdownSha256 = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'termsAcceptedAt')) {
    user.termsAcceptedAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'termsEmailSentAt')) {
    user.termsEmailSentAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'termsEmailHash')) {
    user.termsEmailHash = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'pinHash')) {
    user.pinHash = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'pinSetAt')) {
    user.pinSetAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(user, 'pinResetUntil')) {
    user.pinResetUntil = null;
  }
  for (const method of user.authMethods) {
    if (isCredentialMethodType(method.type)) ensureCredentialFields(method);
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

export function sameEmail(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export function personEmailMethods(user) {
  if (!user) return [];
  if (!Array.isArray(user.authMethods)) user.authMethods = [];
  return user.authMethods.filter((m) => m.type === 'email' && m.email);
}

export function countEmails(user) {
  return personEmailMethods(user).length;
}

export function personPasskeys(user) {
  if (!user) return [];
  if (!Array.isArray(user.credentials)) user.credentials = [];
  return user.credentials;
}

export function countPasskeys(user) {
  const ids = new Set();
  for (const cred of personPasskeys(user)) {
    if (cred?.id) ids.add(String(cred.id));
  }
  for (const method of user?.authMethods || []) {
    if (method.type === 'passkey' && method.credentialId) ids.add(String(method.credentialId));
  }
  return ids.size;
}

/**
 * Keep `user.email` as the primary address. When ≥1 email exists, exactly one
 * auth method is `primary`. Legacy rows that only had `user.email` get a method.
 */
export function syncPersonEmails(user) {
  if (!user) return user;
  if (!Array.isArray(user.authMethods)) user.authMethods = [];
  let email;
  if (user.email) {
    try {
      email = normalizeEmail(user.email);
      user.email = email;
    } catch {
      user.email = null;
      email = null;
    }
  }
  const methods = personEmailMethods(user);
  if (email && !methods.some((m) => sameEmail(m.email, email))) {
    const method = {
      id: randomUUID(),
      type: 'email',
      verified: true,
      verifiedBy: 'self',
      verifiedAt: user.createdAt || new Date().toISOString(),
      label: 'Email',
      credentialId: null,
      address: null,
      fingerprint: null,
      subject: null,
      issuer: null,
      email,
      kind: null,
      civicIdHash: null,
      primary: methods.length === 0,
    };
    user.authMethods.push(method);
    methods.push(method);
  }
  if (!methods.length) {
    user.email = email || null;
    return user;
  }
  let chosen = methods.find((m) => m.primary);
  if (!chosen && email) chosen = methods.find((m) => sameEmail(m.email, email));
  if (!chosen) chosen = methods[0];
  for (const method of methods) {
    method.primary = method.id === chosen.id;
  }
  try {
    user.email = normalizeEmail(chosen.email);
  } catch {
    user.email = String(chosen.email || '').trim().toLowerCase() || null;
  }
  return user;
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
  const marked = personEmailMethods(user).find((m) => m.primary && m.email);
  const method = marked || personEmailMethods(user).find((m) => m.email);
  if (!method) return null;
  try {
    return normalizeEmail(method.email);
  } catch {
    return null;
  }
}

/**
 * MFA / SES destination. Email-as-username and “bind this address” send to the
 * address given. Every other factor uses the primary email by default.
 */
export function mfaDestinationEmail({ user, factor, email, bindEmail } = {}) {
  const existing = userEmail(user);
  const provided = email || null;
  if (bindEmail && provided) return provided;
  if (String(factor || '') === 'email' && provided) return provided;
  return existing || provided;
}

export function assertEmailRoom(user, addingEmail) {
  if (!user) return;
  let next = null;
  if (addingEmail) {
    try {
      next = normalizeEmail(addingEmail);
    } catch {
      next = null;
    }
  }
  const methods = personEmailMethods(user);
  if (next && methods.some((m) => sameEmail(m.email, next))) return;
  if (methods.length >= MAX_EMAILS_PER_PERSON) {
    throw new HttpError(
      409,
      `A person may bind at most ${MAX_EMAILS_PER_PERSON} email addresses`,
      {
        code: 'EMAIL_CAP',
        limit: MAX_EMAILS_PER_PERSON,
        count: methods.length,
      },
    );
  }
}

export function assertPasskeyRoom(user) {
  if (!user) return;
  const count = countPasskeys(user);
  if (count >= MAX_PASSKEYS_PER_PERSON) {
    throw new HttpError(
      409,
      `A person may register at most ${MAX_PASSKEYS_PER_PERSON} passkeys`,
      {
        code: 'PASSKEY_CAP',
        limit: MAX_PASSKEYS_PER_PERSON,
        count,
      },
    );
  }
}

export function publicEmail(method, primaryAddress) {
  if (!method) return null;
  const email = method.email || null;
  return {
    id: method.id,
    email,
    primary: Boolean(method.primary) || sameEmail(email, primaryAddress),
    verified: Boolean(method.verified),
    verifiedAt: method.verifiedAt || null,
    label: method.label || 'Email',
  };
}

export function publicPasskey(credential, method) {
  if (!credential) return null;
  return {
    id: credential.id,
    credentialId: credential.id,
    label: method?.label || credential.label || 'Passkey',
    createdAt: credential.createdAt || null,
    deviceType: credential.deviceType || null,
    backedUp: Boolean(credential.backedUp),
    transports: credential.transports || [],
  };
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
  if (method.type === 'email') {
    out.email = method.email;
    out.primary = Boolean(method.primary);
  }
  if (method.type === 'smart_card') {
    out.fingerprint = method.fingerprint;
    out.subject = method.subject || null;
    out.issuer = method.issuer || null;
    Object.assign(out, publicCredential(method, { owner: true }));
  }
  if (method.type === 'civic_id') {
    out.kind = method.kind || null;
    out.issuer = method.issuer || null;
    Object.assign(out, publicCredential(method, { owner: true }));
  }
  return out;
}

export function publicEthAccount(account, activeEthAddress) {
  if (!account) return null;
  return {
    address: account.address,
    source: account.source,
    verified: Boolean(account.verified),
    verifiedBy: account.verifiedBy || (account.verified ? 'self' : null),
    active: sameEthAddress(account.address, activeEthAddress),
    verifiedAt: account.verifiedAt || null,
  };
}

export function identityCaps() {
  return {
    emails: MAX_EMAILS_PER_PERSON,
    passkeys: MAX_PASSKEYS_PER_PERSON,
    smartCards: MAX_SMART_CARDS_PER_PERSON,
    civicIds: MAX_CIVIC_IDS_PER_PERSON,
    ethAccounts: null,
  };
}

export function publicIdentity(user) {
  if (!user) return null;
  ensurePersonFields(user);
  const primary = userEmail(user);
  const emailMethods = personEmailMethods(user);
  const passkeys = personPasskeys(user).map((cred) =>
    publicPasskey(
      cred,
      user.authMethods.find((m) => m.type === 'passkey' && m.credentialId === cred.id),
    ),
  );
  return {
    personId: user.id,
    personKeyBound: Boolean(user.personKeyHash),
    emailBound: Boolean(primary),
    emailHint: primary ? emailHint(primary) : null,
    primaryEmail: primary,
    emails: emailMethods.map((m) => publicEmail(m, primary)),
    emailCount: emailMethods.length,
    passkeys,
    passkeyCount: countPasskeys(user),
    caps: identityCaps(),
    authMethods: user.authMethods.map((m) => {
      const out = publicAuthMethod(m);
      if (out && out.type === 'email') out.primary = Boolean(m.primary) || sameEmail(m.email, primary);
      return out;
    }),
    ethAccounts: user.ethAccounts.map((a) => publicEthAccount(a, user.activeEthAddress)),
    activeEthAddress: user.activeEthAddress,
    verifiedEthAddressCount: user.ethAccounts.filter((a) => a.verified).length,
    credentials: user.authMethods
      .filter((m) => isCredentialMethodType(m.type))
      .map((m) => publicCredential(m, { owner: true })),
    smartCardCount: liveCredentialCount(user, 'smart_card'),
    civicIdCount: liveCredentialCount(user, 'civic_id'),
    ...pinPublicFields(user),
    note: 'Many methods and addresses may be verified internally. Only one Ethereum address is active. Up to 5 passkeys, 5 emails, 5 smart cards, and 5 driver’s licenses or passports; exactly one email is primary when any email exists. Each person sets a vote PIN (4–8 digits) used on a scrambled phone keypad at ballot submit. Civil officers may revoke an expired card or license. Sign-in completes with email MFA when SES is configured.',
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
  const found = store.findUserByAuthMethod({ type: 'smart_card', fingerprint: fp });
  if (!found?.user) return null;
  assertCredentialUsable(found.method, { kind: 'smart card' });
  return found.user;
}

export function resolveCivicIdLoginPerson(store, { kind, issuer, documentNumber }) {
  const hash = civicIdHash({ kind, issuer, documentNumber });
  const found = store.findUserByAuthMethod({
    type: 'civic_id',
    fingerprint: hash,
    civicIdHash: hash,
  });
  if (!found?.user) return null;
  assertCredentialUsable(found.method, { kind: civicIdLabel(found.method.kind) });
  return found.user;
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
