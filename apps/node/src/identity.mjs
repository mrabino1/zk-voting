// NOT FOR PROFIT — civic public good, not a commercial product.
// One person. Many internally verified authenticators and ETH addresses.
// Exactly one active Ethereum address. The vote Merkle leaf is never that
// address.

import { randomBytes } from 'node:crypto';

import { getAddress, isAddress, keccak256, toHex, verifyMessage } from 'viem';

import { HttpError } from './http.mjs';

export const AUTH_METHOD_TYPES = Object.freeze(['passkey', 'web3', 'smart_card']);

export const AUTH_METHOD_CATALOG = Object.freeze([
  {
    type: 'passkey',
    label: 'Passkey',
    summary: 'Device WebAuthn credential (Touch ID, Windows Hello, hardware key).',
  },
  {
    type: 'web3',
    label: 'Web3 wallet',
    summary: 'Browser wallet (MetaMask and peers) signs a binding message.',
  },
  {
    type: 'smart_card',
    label: 'Smart card digital ID',
    summary: 'PIV, CAC, or national eID certificate presented at a kiosk or clerk desk.',
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
  if (!Object.prototype.hasOwnProperty.call(user, 'contactEmail')) {
    user.contactEmail = '';
  }
  return user;
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
  if (method.type === 'smart_card') {
    out.fingerprint = method.fingerprint;
    out.subject = method.subject || null;
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
    authMethods: user.authMethods.map(publicAuthMethod),
    ethAccounts: user.ethAccounts.map((a) => publicEthAccount(a, user.activeEthAddress)),
    activeEthAddress: user.activeEthAddress,
    verifiedEthAddressCount: user.ethAccounts.length,
    note: 'Many methods and addresses may be verified internally. Only one Ethereum address is active.',
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

  function issueSmartCard({ fingerprint }) {
    const fp = fingerprint ? normalizeFingerprint(fingerprint) : null;
    const nonce = `0x${randomBytes(16).toString('hex')}`;
    put({
      type: 'smart_card',
      nonce,
      key: fp ? `card:${fp}` : `card:${nonce}`,
      fingerprint: fp,
    });
    return { nonce, fingerprint: fp, expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
  }

  return { issueWeb3, issueWeb3Login, issueSmartCard, take, put, challenges };
}
