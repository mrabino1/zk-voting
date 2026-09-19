// NOT FOR PROFIT — civic public good, not a commercial product.
// DealPunchList-shaped email OTP: first factor, then a 6-digit code via SES.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { establishSession } from './auth.mjs';
import { HttpError, setMfaCookie, clearMfaCookie } from './http.mjs';
import { emailHint, mfaDestinationEmail, normalizeEmail, publicIdentity, userEmail, assertEmailRoom } from './identity.mjs';
import { publicUser } from './roles.mjs';

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

function hashOtp(nonce, code) {
  return createHash('sha256').update(`${nonce}:${code}`, 'utf8').digest('hex');
}

function hashesEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function mintCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function mfaRequiredFor(config, factor) {
  const kind = String(factor || '');
  if (kind === 'dev') return false;
  if (kind === 'email') return true;
  return Boolean(config.requireEmailMfa);
}

export function sessionPayload(user) {
  return {
    ok: true,
    verified: true,
    mfaRequired: false,
    user: publicUser(user),
    identity: publicIdentity(user),
    nfp: true,
  };
}

export function mfaPayload(rec) {
  return {
    ok: true,
    verified: false,
    mfaRequired: true,
    needsEmail: Boolean(rec.needsEmail) && !rec.email,
    factor: rec.factor,
    emailHint: rec.email ? emailHint(rec.email) : null,
    purpose: rec.purpose || 'mfa',
    pinReset: rec.purpose === 'pin-reset',
    nfp: true,
    message:
      rec.needsEmail && !rec.email
        ? rec.purpose === 'pin-reset'
          ? 'Enter the email that will receive your vote PIN reset code.'
          : 'Enter the email that will receive your sign-in code.'
        : rec.purpose === 'pin-reset'
          ? 'Enter the 6-digit code sent to your email to set a new vote PIN.'
          : 'Enter the 6-digit code sent to your email.',
  };
}

export function createMfaService({ config, store, mailer, terms }) {
  const pending = new Map();
  const byUser = new Map();
  const byEmail = new Map();

  function sweep() {
    const now = Date.now();
    for (const [k, rec] of pending) {
      if (!rec || rec.expiresAt < now) {
        pending.delete(k);
        if (rec?.userId) byUser.delete(rec.userId);
        if (rec?.email) byEmail.delete(rec.email);
      }
    }
  }

  function drop(rec) {
    if (!rec) return;
    pending.delete(rec.nonce);
    if (rec.userId) byUser.delete(rec.userId);
    if (rec.email) byEmail.delete(rec.email);
  }

  function put(rec) {
    sweep();
    if (rec.userId && byUser.has(rec.userId)) drop(pending.get(byUser.get(rec.userId)));
    if (rec.email && byEmail.has(rec.email)) drop(pending.get(byEmail.get(rec.email)));
    pending.set(rec.nonce, rec);
    if (rec.userId) byUser.set(rec.userId, rec.nonce);
    if (rec.email) byEmail.set(rec.email, rec.nonce);
    return rec;
  }

  function get(nonce) {
    sweep();
    if (!nonce) return null;
    const rec = pending.get(nonce);
    if (!rec || rec.expiresAt < Date.now()) {
      if (rec) drop(rec);
      return null;
    }
    return rec;
  }

  function pendingFromReq(req) {
    return get(req.mfaNonce);
  }

  async function dispatchOtp(rec) {
    if (!rec.email) {
      throw new HttpError(400, 'email required for MFA');
    }
    if (!mailer) {
      throw new HttpError(503, 'email MFA is not configured — set SES_FROM_ADDRESS and AWS_REGION (AWS SES)');
    }
    const now = Date.now();
    if (rec.sentAt && now - rec.sentAt < RESEND_MS) {
      throw new HttpError(429, 'wait before requesting another code', { code: 'OTP_COOLDOWN' });
    }
    const code = mintCode();
    rec.codeHash = hashOtp(rec.nonce, code);
    rec.sentAt = now;
    rec.attempts = 0;
    rec.expiresAt = now + OTP_TTL_MS;
    rec.needsEmail = false;
    await mailer.sendOtp({
      to: rec.email,
      code,
      purpose: rec.purpose,
      factor: rec.factor,
    });
    return rec;
  }

  function newRecord({ user, factor, email, bindEmail, handle, purpose, acceptedTerms }) {
    const nonce = randomBytes(18).toString('hex');
    const now = Date.now();
    const existing = userEmail(user);
    const nextEmail = mfaDestinationEmail({
      user,
      factor,
      email: email ? normalizeEmail(email) : null,
      bindEmail,
    });
    return {
      type: 'email_otp',
      nonce,
      userId: user?.id || null,
      email: nextEmail,
      bindEmail: Boolean(bindEmail) || Boolean(!existing && nextEmail),
      handle: handle || user?.handle || null,
      purpose: purpose || 'mfa',
      factor: factor || 'email',
      acceptedTerms: Boolean(acceptedTerms),
      needsEmail: false,
      codeHash: null,
      attempts: 0,
      sentAt: 0,
      expiresAt: now + OTP_TTL_MS,
      createdAt: now,
    };
  }

  async function startMfa(res, { user, factor, bindEmail, handle, purpose, email, acceptedTerms } = {}) {
    const rec = newRecord({
      user,
      factor,
      email: email ? normalizeEmail(email) : null,
      bindEmail,
      handle,
      purpose,
      acceptedTerms,
    });
    if (!rec.email) {
      rec.needsEmail = true;
      put(rec);
      setMfaCookie(res, config, rec.nonce);
      return mfaPayload(rec);
    }
    put(rec);
    await dispatchOtp(rec);
    setMfaCookie(res, config, rec.nonce);
    return mfaPayload(rec);
  }

  /**
   * First factor succeeded. Either set the session or start email OTP.
   */
  async function completeFactor(res, { user, factor, bindEmail, handle, purpose, email, acceptedTerms } = {}) {
    if (!mfaRequiredFor(config, factor)) {
      if (!user) throw new HttpError(500, 'session user missing');
      await establishSession(res, store, config, user);
      clearMfaCookie(res, config);
      if (terms && acceptedTerms) {
        await terms.maybeAcceptNewPerson(store.getUser(user.id) || user, {
          acceptedTerms,
          email,
          source: factor || purpose || 'register',
        });
      }
      return sessionPayload(store.getUser(user.id) || user);
    }
    return startMfa(res, { user, factor, bindEmail, handle, purpose, email, acceptedTerms });
  }

  async function provideEmail(req, res, rawEmail) {
    const rec = pendingFromReq(req);
    if (!rec) throw new HttpError(400, 'no MFA challenge', { code: 'NO_MFA' });
    const email = normalizeEmail(rawEmail);
    const owner = store.findUserByEmail(email);
    if (rec.email && !rec.needsEmail) {
      throw new HttpError(400, 'MFA email is already set');
    }
    if (owner && rec.userId && owner.id !== rec.userId) {
      throw new HttpError(409, 'email already bound to another person', { code: 'METHOD_OWNED' });
    }
    if (owner && !rec.userId && rec.purpose === 'register') {
      throw new HttpError(409, 'email already bound to another person', { code: 'METHOD_OWNED' });
    }
    if (rec.userId) {
      const account = store.getUser(rec.userId);
      if (account) assertEmailRoom(account, email);
    }
    rec.email = email;
    rec.bindEmail = true;
    rec.needsEmail = false;
    put(rec);
    await dispatchOtp(rec);
    setMfaCookie(res, config, rec.nonce);
    return mfaPayload(rec);
  }

  async function resend(req, res) {
    const rec = pendingFromReq(req);
    if (!rec) throw new HttpError(400, 'no MFA challenge', { code: 'NO_MFA' });
    if (!rec.email) {
      throw new HttpError(400, 'email required for MFA', { code: 'NEEDS_EMAIL' });
    }
    await dispatchOtp(rec);
    setMfaCookie(res, config, rec.nonce);
    return mfaPayload(rec);
  }

  async function verify(req, res, rawCode) {
    const rec = pendingFromReq(req);
    const code = String(rawCode || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      throw new HttpError(400, 'invalid or expired code', { code: 'OTP_INVALID' });
    }
    if (!rec || !rec.codeHash) {
      throw new HttpError(400, 'invalid or expired code', { code: 'OTP_INVALID' });
    }
    rec.attempts += 1;
    if (rec.attempts > MAX_ATTEMPTS) {
      drop(rec);
      clearMfaCookie(res, config);
      throw new HttpError(400, 'invalid or expired code', { code: 'OTP_LOCKED' });
    }
    if (!hashesEqual(rec.codeHash, hashOtp(rec.nonce, code))) {
      throw new HttpError(400, 'invalid or expired code', { code: 'OTP_INVALID' });
    }

    const isPinReset = rec.purpose === 'pin-reset';
    let user = rec.userId ? store.getUser(rec.userId) : null;
    if (!user && rec.purpose === 'register' && rec.email) {
      user = store.createUser({
        handle: uniqueHandle(store, rec.handle, rec.email),
        role: 'voter',
        email: rec.email,
      });
    }
    if (!user) {
      drop(rec);
      throw new HttpError(400, 'invalid or expired code', { code: 'OTP_INVALID' });
    }

    if (
      !isPinReset &&
      rec.email &&
      (rec.bindEmail || rec.purpose === 'register' || rec.factor === 'email')
    ) {
      await store.addAuthMethod(user.id, {
        type: 'email',
        email: rec.email,
        label: 'Email',
        verifiedBy: 'self',
      });
    }

    drop(rec);
    await establishSession(res, store, config, store.getUser(user.id));
    clearMfaCookie(res, config);
    if (isPinReset) {
      await store.grantPinReset(user.id);
    }
    if (terms && rec.acceptedTerms) {
      await terms.maybeAcceptNewPerson(store.getUser(user.id), {
        acceptedTerms: rec.acceptedTerms,
        email: rec.email,
        source: rec.purpose || rec.factor || 'register',
      });
    }
    const payload = sessionPayload(store.getUser(user.id));
    if (isPinReset) {
      payload.pinResetGranted = true;
      payload.pinReset = true;
    }
    return payload;
  }

  function status(req) {
    const rec = pendingFromReq(req);
    if (!rec) return { ok: true, mfaRequired: false, nfp: true };
    return mfaPayload(rec);
  }

  return {
    completeFactor,
    startMfa,
    provideEmail,
    resend,
    verify,
    status,
    pendingFromReq,
    pending,
    OTP_TTL_MS,
  };
}

function uniqueHandle(store, handle, email) {
  const raw = String(handle || '').trim();
  if (raw && !store.getUserByHandle(raw)) return raw;
  const local = String(email || '')
    .split('@')[0]
    .replace(/[^a-z0-9._-]/gi, '')
    .slice(0, 24);
  const base = local || `person-${randomBytes(3).toString('hex')}`;
  if (!store.getUserByHandle(base)) return base;
  for (let i = 0; i < 8; i += 1) {
    const candidate = `${base}-${randomBytes(2).toString('hex')}`;
    if (!store.getUserByHandle(candidate)) return candidate;
  }
  return `person-${randomBytes(6).toString('hex')}`;
}
