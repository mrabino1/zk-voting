// NOT FOR PROFIT — civic public good, not a commercial product.
// WebAuthn/passkey registration and login. Challenges live in memory only.
// Credential public keys are stored in the JSON store (not a vote record).

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { HttpError } from './http.mjs';
import { assertPasskeyRoom, isClaimedPerson } from './identity.mjs';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function b64urlFromBytes(value) {
  if (typeof value === 'string') return value;
  return Buffer.from(value).toString('base64url');
}

function bytesFromB64url(value) {
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function challengeFromClientData(body) {
  const b64 = body?.response?.clientDataJSON;
  if (typeof b64 === 'string' && b64.length) {
    try {
      const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (json.challenge) return json.challenge;
    } catch {
      // ignore malformed clientData — verification will fail later
    }
  }
  return body?.challenge || null;
}

export function createPasskeyService(config, store, hooks = {}) {
  const generateReg = hooks.generateRegistrationOptions || generateRegistrationOptions;
  const generateAuth = hooks.generateAuthenticationOptions || generateAuthenticationOptions;
  const verifyReg = hooks.verifyRegistrationResponse || verifyRegistrationResponse;
  const verifyAuth = hooks.verifyAuthenticationResponse || verifyAuthenticationResponse;
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
    if (entry.challenge) challenges.set(entry.challenge, rec);
    if (entry.key) challenges.set(entry.key, rec);
  }

  function take(key) {
    sweep();
    if (!key) return null;
    const rec = challenges.get(key);
    if (!rec) return null;
    challenges.delete(key);
    if (rec.challenge) challenges.delete(rec.challenge);
    if (rec.key) challenges.delete(rec.key);
    if (rec.expiresAt < Date.now()) return null;
    return rec;
  }

  function existingCredentials(user) {
    return (user?.credentials || []).map((c) => ({
      id: c.id,
      transports: c.transports,
    }));
  }

  function ceremonyBinding(webauthn) {
    const rpID = webauthn?.rpID || config.rpID;
    const origins =
      Array.isArray(webauthn?.origins) && webauthn.origins.length ? webauthn.origins.slice() : config.origins;
    return { rpID, origins };
  }

  async function beginRegister({ user, handle, acceptedTerms, webauthn }) {
    if (!user && !handle) throw new HttpError(400, 'handle required');
    const userName = user?.handle || String(handle).trim();
    if (!userName) throw new HttpError(400, 'handle required');
    if (user) assertPasskeyRoom(user);
    const binding = ceremonyBinding(webauthn);
    const options = await generateReg({
      rpName: config.rpName,
      rpID: binding.rpID,
      userName,
      userDisplayName: userName,
      userID: user ? new TextEncoder().encode(user.id) : undefined,
      attestationType: 'none',
      excludeCredentials: existingCredentials(user),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      extensions: { prf: {} },
    });
    options.extensions = { ...(options.extensions || {}), prf: {} };
    put({
      type: 'register',
      challenge: options.challenge,
      key: `reg:${userName.toLowerCase()}`,
      userId: user?.id || null,
      handle: userName,
      acceptedTerms: Boolean(acceptedTerms),
      rpID: binding.rpID,
      origins: binding.origins,
    });
    return options;
  }

  async function finishRegister({ body, user, handle, claimSeedOnly = null }) {
    const userName = (user?.handle || handle || body?.handle || '').trim();
    const chal = challengeFromClientData(body);
    const pending = take(chal) || (userName ? take(`reg:${userName.toLowerCase()}`) : null);
    if (!pending || pending.type !== 'register') {
      throw new HttpError(400, 'no registration challenge');
    }
    let verification;
    try {
      verification = await verifyReg({
        response: body,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origins || config.origins,
        expectedRPID: pending.rpID || config.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpError(400, `passkey registration failed: ${err.message || err}`);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpError(400, 'passkey registration not verified');
    }
    const info = verification.registrationInfo;
    const cred = info.credential || {
      id: info.credentialID,
      publicKey: info.credentialPublicKey,
      counter: info.counter,
      transports: info.transports,
    };
    const account = await resolveRegisterAccount({ sessionUser: user, pending });
    assertPasskeyRoom(account);
    if (!user) {
      // Claim guard, checked synchronously right before the write: two
      // session-less finishes for the same unclaimed row (e.g. the first-run
      // super admin) both pass resolveRegisterAccount, but only the first to
      // reach this line may attach a credential.
      if (isClaimedPerson(account)) {
        throw new HttpError(409, 'this account was claimed by another registration', {
          code: 'ALREADY_CLAIMED',
        });
      }
      if (claimSeedOnly && account.id !== claimSeedOnly) {
        throw new HttpError(409, 'registration does not match the setup account', {
          code: 'SETUP_ADMIN_EXISTS',
        });
      }
      if (!claimSeedOnly && config.setupToken && account.role === 'platform_super_admin') {
        // With SETUP_TOKEN set, the super admin row is claimed only through
        // /api/setup (which checks the token), never by a bare handle.
        throw new HttpError(403, 'use the first-run setup screen to create the super admin', {
          code: 'SETUP_TOKEN_REQUIRED',
        });
      }
    }
    store.addCredential(account.id, {
      id: b64urlFromBytes(cred.id),
      publicKey: b64urlFromBytes(cred.publicKey),
      counter: cred.counter || 0,
      transports: body?.response?.transports || cred.transports || [],
      deviceType: info.credentialDeviceType || null,
      backedUp: Boolean(info.credentialBackedUp),
      createdAt: new Date().toISOString(),
    });
    await store.persist();
    return { verified: true, user: account, acceptedTerms: Boolean(pending.acceptedTerms) };
  }

  /**
   * Brand-new handles (or the unclaimed ADMIN_HANDLE seed) may finish without
   * a session. A claimed person requires the session user to be that person.
   */
  async function resolveRegisterAccount({ sessionUser, pending }) {
    if (sessionUser) {
      if (pending.userId && pending.userId !== sessionUser.id) {
        throw new HttpError(403, 'passkey registration is for a different account', {
          code: 'HANDLE_MISMATCH',
        });
      }
      if (
        pending.handle &&
        String(sessionUser.handle || '').toLowerCase() !== String(pending.handle).toLowerCase()
      ) {
        throw new HttpError(403, 'passkey registration is for a different account', {
          code: 'HANDLE_MISMATCH',
        });
      }
      return sessionUser;
    }

    let account = pending.userId ? store.getUser(pending.userId) : null;
    if (!account && pending.handle) {
      account = store.getUserByHandle(pending.handle);
    }
    if (account) {
      if (isClaimedPerson(account)) {
        throw new HttpError(401, 'authentication required to add a passkey', {
          code: 'AUTH_REQUIRED',
        });
      }
      return account;
    }
    return await store.ensureUser({ handle: pending.handle, role: 'voter' });
  }

  async function beginLogin({ user, handle, webauthn } = {}) {
    const trimmedHandle = handle != null && String(handle).trim() ? String(handle).trim() : '';
    const account = user || (trimmedHandle ? store.getUserByHandle(trimmedHandle) : null);
    if (trimmedHandle && !account) throw new HttpError(404, 'unknown handle');
    const creds = account ? existingCredentials(account) : [];
    const binding = ceremonyBinding(webauthn);
    // Discoverable / resident-key login: omit allowCredentials so
    // the authenticator can present the passkey. Handle-scoped login only
    // lists that person's credentials when they already exist.
    const options = await generateAuth({
      rpID: binding.rpID,
      userVerification: 'required',
      ...(creds.length ? { allowCredentials: creds } : {}),
      extensions: { prf: {} },
    });
    options.extensions = { ...(options.extensions || {}), prf: {} };
    put({
      type: 'login',
      challenge: options.challenge,
      key: account ? `auth:${account.id}` : `auth:${options.challenge}`,
      userId: account?.id || null,
      rpID: binding.rpID,
      origins: binding.origins,
    });
    return options;
  }

  async function finishLogin({ body }) {
    const chal = challengeFromClientData(body);
    const pending = take(chal) || (body?.id ? take(`auth:${body.id}`) : null);
    if (!pending || pending.type !== 'login') {
      throw new HttpError(400, 'no login challenge');
    }
    const credId = body?.id || body?.rawId;
    const found = credId ? store.findCredential(credId) : null;
    if (!found) throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
    const { user: account, credential } = found;
    if (pending.userId && pending.userId !== account.id) {
      throw new HttpError(403, 'credential does not belong to this person', { code: 'CREDENTIAL_MISMATCH' });
    }
    let verification;
    try {
      verification = await verifyAuth({
        response: body,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origins || config.origins,
        expectedRPID: pending.rpID || config.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: bytesFromB64url(credential.publicKey),
          counter: credential.counter || 0,
          transports: credential.transports,
        },
      });
    } catch (err) {
      throw new HttpError(400, `passkey login failed: ${err.message || err}`);
    }
    if (!verification.verified) {
      throw new HttpError(400, 'passkey login not verified');
    }
    const newCounter = verification.authenticationInfo?.newCounter;
    if (typeof newCounter === 'number') {
      await store.updateCredentialCounter(credential.id, newCounter);
    } else {
      await store.persist();
    }
    return { verified: true, user: account };
  }

  return { beginRegister, finishRegister, beginLogin, finishLogin, challenges };
}
