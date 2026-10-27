// NOT FOR PROFIT — civic public good, not a commercial product.
// Store mutations for super-admin keys and the hash-chained audit log.
// Standby processes must not call the mutating functions.

import fs from 'node:fs';

import { HttpError } from '../http.mjs';
import { nextAuditEntry } from './audit.mjs';
import { ensureSuperAdminCollections } from './collections.mjs';
import {
  hashSuperAdminSecret,
  keyStatus,
  mintSuperAdminSecret,
  publicSuperAdminKey,
  secretsEqual,
} from './keys.mjs';
import { maskIp } from './net.mjs';

function keys(store) {
  ensureSuperAdminCollections(store.data);
  return store.data.superAdminKeys;
}

function auditRows(store) {
  ensureSuperAdminCollections(store.data);
  return store.data.superAdminAudit;
}

function chain(store) {
  store._saChain = store._saChain || Promise.resolve();
  return store._saChain;
}

async function locked(store, fn) {
  const previous = chain(store);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  store._saChain = previous.then(() => gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// A standby on the JSON backend re-reads the writer's file; on Postgres it
// uses the state it loaded at open (refreshed on promotion).
function readsFile(store) {
  return store.writerActive === false && store.backend !== 'postgres';
}

export function readSuperAdminKey(store, id) {
  if (readsFile(store)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
      const rows = Array.isArray(parsed.superAdminKeys) ? parsed.superAdminKeys : [];
      return rows.find((row) => row.id === id) || null;
    } catch {
      return null;
    }
  }
  return keys(store).find((row) => row.id === id) || null;
}

function visibleKeys(store) {
  if (!readsFile(store)) return keys(store);
  try {
    const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    return Array.isArray(parsed.superAdminKeys) ? parsed.superAdminKeys : [];
  } catch {
    return [];
  }
}

export function listSuperAdminKeys(store, nowMs = Date.now()) {
  return visibleKeys(store)
    .map((row) => publicSuperAdminKey(row, nowMs))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getPublicSuperAdminKey(store, id, nowMs = Date.now()) {
  const row = visibleKeys(store).find((item) => item.id === id);
  return row ? publicSuperAdminKey(row, nowMs) : null;
}

export async function createSuperAdminKey(store, fields, pepper) {
  return locked(store, async () => {
    store.refuseIfStandby();
    const minted = mintSuperAdminSecret(pepper);
    const row = {
      id: minted.keyId,
      name: fields.name,
      secretHash: minted.secretHash,
      hashAlg: minted.hashAlg,
      scopes: fields.scopes.slice(),
      ipAllowlist: fields.ipAllowlist.slice(),
      rateLimit: fields.rateLimit,
      createdAt: new Date(fields.nowMs).toISOString(),
      createdBy: fields.createdBy || null,
      expiresIn: fields.expiresIn,
      expiresAt: fields.expiresAt,
      revokedAt: null,
      rotatedFrom: fields.rotatedFrom || null,
      lastUsedAt: null,
      lastUsedIp: null,
      lastUsedIpMasked: null,
    };
    keys(store).push(row);
    await store.persist();
    return { token: minted.token, key: publicSuperAdminKey(row, fields.nowMs), id: row.id };
  });
}

export async function revokeSuperAdminKey(store, id, nowMs = Date.now()) {
  return locked(store, async () => {
    store.refuseIfStandby();
    const row = keys(store).find((item) => item.id === id);
    if (!row) return null;
    const before = keyStatus(row, nowMs);
    if (!row.revokedAt) {
      row.revokedAt = new Date(nowMs).toISOString();
      await store.persist();
    }
    return { before, key: publicSuperAdminKey(row, nowMs) };
  });
}

export async function rotateSuperAdminKey(store, id, pepper, nowMs = Date.now()) {
  return locked(store, async () => {
    store.refuseIfStandby();
    const row = keys(store).find((item) => item.id === id);
    if (!row) return null;
    if (row.revokedAt) return { conflict: 'revoked', key: publicSuperAdminKey(row, nowMs) };
    row.revokedAt = new Date(nowMs).toISOString();
    const minted = mintSuperAdminSecret(pepper);
    const next = {
      id: minted.keyId,
      name: row.name,
      secretHash: minted.secretHash,
      hashAlg: minted.hashAlg,
      scopes: row.scopes.slice(),
      ipAllowlist: row.ipAllowlist.slice(),
      rateLimit: row.rateLimit ? { ...row.rateLimit } : null,
      createdAt: new Date(nowMs).toISOString(),
      createdBy: row.createdBy || null,
      expiresIn: row.expiresIn,
      expiresAt:
        row.expiresIn === 'never'
          ? null
          : row.expiresAt && Date.parse(row.expiresAt) > nowMs
            ? row.expiresAt
            : new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
      rotatedFrom: row.id,
      lastUsedAt: null,
      lastUsedIp: null,
      lastUsedIpMasked: null,
    };
    keys(store).push(next);
    await store.persist();
    return {
      token: minted.token,
      revokedId: row.id,
      key: publicSuperAdminKey(next, nowMs),
    };
  });
}

/**
 * Authenticate from the current row. No cache. Standby reads the row from disk.
 * @returns {{ ok: true, key: object } | { ok: false, reason: string }}
 */
export function authenticateSuperAdminKey(store, parsed, pepper, nowMs = Date.now()) {
  const row = readSuperAdminKey(store, parsed.keyId);
  const computed = hashSuperAdminSecret(parsed.secret, pepper);
  const stored = row?.secretHash || hashSuperAdminSecret('missing-key', pepper);
  const match = secretsEqual(stored, computed);
  if (!row || !match) return { ok: false, reason: 'invalid' };
  if (row.revokedAt) return { ok: false, reason: 'revoked', keyId: row.id };
  if (keyStatus(row, nowMs) === 'expired') return { ok: false, reason: 'expired', keyId: row.id };
  return { ok: true, key: row };
}

export async function touchSuperAdminKey(store, id, ip, nowMs = Date.now()) {
  if (store.writerActive === false) return false;
  return locked(store, async () => {
    if (store.writerActive === false) return false;
    const row = keys(store).find((item) => item.id === id);
    if (!row || row.revokedAt) return false;
    row.lastUsedAt = new Date(nowMs).toISOString();
    row.lastUsedIp = ip || null;
    row.lastUsedIpMasked = ip ? maskIp(ip) : null;
    await store.persist();
    return true;
  });
}

export function persistedAudit(store) {
  if (readsFile(store)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
      return Array.isArray(parsed.superAdminAudit) ? parsed.superAdminAudit : [];
    } catch {
      return auditRows(store).slice();
    }
  }
  return auditRows(store).slice();
}

export async function appendSuperAdminAudit(store, fields) {
  if (store.writerActive === false) {
    store.standbyAudit = store.standbyAudit || [];
    store.standbyAudit.push({
      ...fields,
      persisted: false,
      reason: fields.reason || 'standby',
      at: new Date().toISOString(),
    });
    if (store.standbyAudit.length > 200) store.standbyAudit.splice(0, store.standbyAudit.length - 200);
    return { persisted: false };
  }
  return locked(store, async () => {
    store.refuseIfStandby();
    const rows = auditRows(store);
    const entry = nextAuditEntry(rows[rows.length - 1] || null, fields);
    rows.push(entry);
    await store.persist();
    return { persisted: true, entry };
  });
}

export function sessionStepUpFresh(session, windowMs, nowMs = Date.now()) {
  if (!session) return false;
  const at = Number(session.stepUpAt || session.authenticatedAt || session.createdAt || 0);
  if (!at) return false;
  return nowMs - at <= windowMs;
}

export async function markSessionStepUp(store, sessionId, nowMs = Date.now()) {
  store.refuseIfStandby();
  const session = store.getSession(sessionId);
  if (!session) throw new HttpError(404, 'not found');
  session.stepUpAt = nowMs;
  await store.persist();
  return session;
}
