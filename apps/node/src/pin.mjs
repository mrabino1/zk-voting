// NOT FOR PROFIT — civic public good, not a commercial product.
// Vote PIN: scrypt hash on the person, phone keypad, scramble at the ballot.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { HttpError } from './http.mjs';

const scrypt = promisify(scryptCb);

export const PIN_MIN_LEN = 4;
export const PIN_MAX_LEN = 8;
export const PIN_RESET_MS = 15 * 60 * 1000;
export const PIN_TOKEN_MS = 5 * 60 * 1000;
export const KEYPAD_TTL_MS = 5 * 60 * 1000;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MS = 30 * 1000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** Phone layout: 3×3 then 0. Positions stay; digits may shuffle. */
export const STANDARD_PAD = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);

export function pinResetGranted(user, now = Date.now()) {
  if (!user?.pinResetUntil) return false;
  const until = Date.parse(user.pinResetUntil);
  return Number.isFinite(until) && until > now;
}

export function pinPublicFields(user) {
  return {
    pinBound: Boolean(user?.pinHash),
    pinResetGranted: pinResetGranted(user),
    pinSetAt: user?.pinSetAt || null,
  };
}

export function normalizePin(value) {
  const pin = String(value || '').replace(/\D/g, '');
  if (pin.length < PIN_MIN_LEN || pin.length > PIN_MAX_LEN) {
    throw new HttpError(400, `PIN must be ${PIN_MIN_LEN}–${PIN_MAX_LEN} digits`, {
      code: 'PIN_LENGTH',
      min: PIN_MIN_LEN,
      max: PIN_MAX_LEN,
    });
  }
  return pin;
}

export function assertPinStrength(pin) {
  const digits = String(pin);
  if ([...digits].every((d) => d === digits[0])) {
    throw new HttpError(400, 'PIN is too easy to guess', { code: 'PIN_WEAK' });
  }
  let seq = true;
  let rev = true;
  for (let i = 1; i < digits.length; i += 1) {
    if (Number(digits[i]) !== Number(digits[i - 1]) + 1) seq = false;
    if (Number(digits[i]) !== Number(digits[i - 1]) - 1) rev = false;
  }
  if (seq || rev) {
    throw new HttpError(400, 'PIN is too easy to guess', { code: 'PIN_WEAK' });
  }
}

export async function hashPin(pin) {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${Buffer.from(key).toString('hex')}`;
}

export async function verifyPinHash(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!salt.length || !expected.length || !Number.isInteger(N) || N < 2) return false;
  let key;
  try {
    key = await scrypt(String(pin), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  const got = Buffer.from(key);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/**
 * Same 3×3+0 geometry for everyone. When scramble is on, Fisher–Yates the
 * digits with HMAC(personId, nonce) so each person (and each challenge)
 * gets a different map. Watchers see taps on shuffled labels.
 */
export function keypadLayoutFor(personId, nonce, { scramble = false } = {}) {
  const digits = [...STANDARD_PAD];
  if (!scramble) return digits;
  const key = String(personId || '');
  const msg = String(nonce || '');
  for (let i = digits.length - 1; i > 0; i -= 1) {
    const digest = createHmac('sha256', key).update(`${msg}:fy:${i}`).digest();
    const j = digest.readUInt32BE(0) % (i + 1);
    [digits[i], digits[j]] = [digits[j], digits[i]];
  }
  return digits;
}

function purposeScrambles(purpose) {
  const kind = String(purpose || '');
  return kind === 'vote' || kind === 'verify';
}

export function createPinService({ store }) {
  const keypads = new Map();
  const tokens = new Map();
  const locks = new Map();

  function sweep() {
    const now = Date.now();
    for (const [k, rec] of keypads) {
      if (!rec || rec.expiresAt < now) keypads.delete(k);
    }
    for (const [k, rec] of tokens) {
      if (!rec || rec.expiresAt < now) tokens.delete(k);
    }
    for (const [k, rec] of locks) {
      if (!rec || (rec.lockedUntil && rec.lockedUntil < now && rec.fails < PIN_MAX_ATTEMPTS)) {
        locks.delete(k);
      }
    }
  }

  function assertNotLocked(userId) {
    sweep();
    const rec = locks.get(userId);
    if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
      throw new HttpError(429, 'too many PIN attempts — wait and try again', {
        code: 'PIN_LOCKED',
      });
    }
  }

  function recordFailure(userId) {
    const rec = locks.get(userId) || { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= PIN_MAX_ATTEMPTS) {
      rec.lockedUntil = Date.now() + PIN_LOCK_MS;
      rec.fails = 0;
    }
    locks.set(userId, rec);
  }

  function recordSuccess(userId) {
    locks.delete(userId);
  }

  function issueKeypad({ userId, purpose = 'setup' }) {
    sweep();
    const scramble = purposeScrambles(purpose);
    const nonce = randomBytes(16).toString('hex');
    const layout = keypadLayoutFor(userId, nonce, { scramble });
    const id = randomBytes(16).toString('hex');
    const rec = {
      id,
      userId,
      purpose: String(purpose || 'setup'),
      nonce,
      layout,
      scramble,
      expiresAt: Date.now() + KEYPAD_TTL_MS,
    };
    keypads.set(id, rec);
    return {
      keypadId: id,
      layout,
      scramble,
      geometry: 'phone-3x3-zero',
      keyboardEntry: false,
      expiresInSeconds: KEYPAD_TTL_MS / 1000,
    };
  }

  async function assertCurrentPin(user, rawPin) {
    assertNotLocked(user.id);
    if (!user.pinHash) {
      throw new HttpError(403, 'vote PIN required', { code: 'PIN_REQUIRED' });
    }
    let pin;
    try {
      pin = normalizePin(rawPin);
    } catch (err) {
      recordFailure(user.id);
      throw err;
    }
    const ok = await verifyPinHash(pin, user.pinHash);
    if (!ok) {
      recordFailure(user.id);
      throw new HttpError(403, 'PIN is incorrect', { code: 'PIN_INVALID' });
    }
    recordSuccess(user.id);
    return pin;
  }

  async function setPersonPin(user, { pin, currentPin, confirmPin } = {}) {
    const next = normalizePin(pin);
    assertPinStrength(next);
    if (confirmPin != null && String(confirmPin) !== '') {
      if (normalizePin(confirmPin) !== next) {
        throw new HttpError(400, 'PIN confirmation does not match', { code: 'PIN_MISMATCH' });
      }
    }
    const grant = pinResetGranted(user);
    if (user.pinHash && !grant) {
      if (currentPin == null || currentPin === '') {
        throw new HttpError(400, 'current PIN required', { code: 'CURRENT_PIN_REQUIRED' });
      }
      await assertCurrentPin(user, currentPin);
    }
    const hash = await hashPin(next);
    return store.setPinHash(user.id, hash);
  }

  async function verifyPersonPin(user, { pin, purpose = 'verify' } = {}) {
    await assertCurrentPin(user, pin);
    if (purpose === 'vote') {
      sweep();
      const token = randomBytes(24).toString('hex');
      tokens.set(token, { userId: user.id, expiresAt: Date.now() + PIN_TOKEN_MS });
      return { pinToken: token, expiresInSeconds: PIN_TOKEN_MS / 1000 };
    }
    return { ok: true };
  }

  function assertVoteAllowed(user, pinToken) {
    if (!user) return;
    if (!user.pinHash) {
      throw new HttpError(403, 'Set a vote PIN on your profile before casting a ballot', {
        code: 'PIN_REQUIRED',
      });
    }
    if (!pinToken) {
      throw new HttpError(403, 'Enter your vote PIN to finalize this ballot', {
        code: 'PIN_TOKEN_REQUIRED',
      });
    }
    sweep();
    const rec = tokens.get(String(pinToken));
    tokens.delete(String(pinToken));
    if (!rec || rec.userId !== user.id || rec.expiresAt < Date.now()) {
      throw new HttpError(403, 'vote PIN invalid or expired', { code: 'PIN_TOKEN_INVALID' });
    }
  }

  return {
    issueKeypad,
    setPersonPin,
    verifyPersonPin,
    assertVoteAllowed,
    keypads,
    tokens,
  };
}
