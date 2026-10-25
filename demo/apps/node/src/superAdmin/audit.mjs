// NOT FOR PROFIT — civic public good, not a commercial product.
// Append-only hash-chained audit log for the platform super-admin API.

import { createHash } from 'node:crypto';

export const AUDIT_GENESIS = '0'.repeat(64);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function auditBody(entry) {
  return {
    seq: entry.seq,
    timestamp: entry.timestamp,
    keyId: entry.keyId || null,
    sessionUser: entry.sessionUser || null,
    method: entry.method,
    path: entry.path,
    scope: entry.scope || null,
    result: entry.result,
    reason: entry.reason || null,
    ip: entry.ip || null,
    userAgent: entry.userAgent || null,
    requestId: entry.requestId || null,
    dryRun: Boolean(entry.dryRun),
    before: entry.before ?? null,
    after: entry.after ?? null,
  };
}

export function hashAuditEntry(prevHash, body) {
  return createHash('sha256')
    .update(`${prevHash}\n${canonicalJson(body)}`)
    .digest('hex');
}

export function nextAuditEntry(prev, fields) {
  const seq = prev ? Number(prev.seq) + 1 : 1;
  const prevHash = prev?.hash || AUDIT_GENESIS;
  const body = auditBody({ ...fields, seq });
  const hash = hashAuditEntry(prevHash, body);
  return { ...body, prevHash, hash };
}

/**
 * @param {object[]} entries
 * @returns {{ ok: true, entries: number, headHash: string } | { ok: false, seq: number, reason: string }}
 */
export function verifyAuditChain(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let prevHash = AUDIT_GENESIS;
  let prevSeq = 0;
  for (const entry of rows) {
    const seq = Number(entry?.seq);
    if (!Number.isInteger(seq) || seq !== prevSeq + 1) {
      return { ok: false, seq: seq || prevSeq + 1, reason: 'seq_gap' };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, seq, reason: 'prev_mismatch' };
    }
    const body = auditBody(entry);
    const want = hashAuditEntry(prevHash, body);
    if (want !== entry.hash) {
      return { ok: false, seq, reason: 'hash_mismatch' };
    }
    prevHash = entry.hash;
    prevSeq = seq;
  }
  return { ok: true, entries: rows.length, headHash: prevHash };
}

export function filterAuditEntries(entries, query = {}) {
  let rows = Array.isArray(entries) ? entries.slice() : [];
  if (query.keyId) rows = rows.filter((row) => row.keyId === String(query.keyId));
  if (query.sessionUser) rows = rows.filter((row) => row.sessionUser === String(query.sessionUser));
  if (query.from) {
    const from = Date.parse(String(query.from));
    if (Number.isFinite(from)) rows = rows.filter((row) => Date.parse(row.timestamp) >= from);
  }
  if (query.to) {
    const to = Date.parse(String(query.to));
    if (Number.isFinite(to)) rows = rows.filter((row) => Date.parse(row.timestamp) <= to);
  }
  if (query.result != null && query.result !== '') {
    const raw = String(query.result);
    if (raw === 'success') rows = rows.filter((row) => Number(row.result) >= 200 && Number(row.result) < 300);
    else if (raw === 'failure') rows = rows.filter((row) => Number(row.result) >= 400);
    else {
      const code = Number(raw);
      if (Number.isFinite(code)) rows = rows.filter((row) => Number(row.result) === code);
    }
  }
  const after = Number(query.after || 0);
  if (Number.isFinite(after) && after > 0) rows = rows.filter((row) => Number(row.seq) > after);
  const limit = Math.min(200, Math.max(1, Number(query.limit || 50) || 50));
  const page = rows.slice(0, limit);
  const next = page.length === limit && rows.length > limit ? page[page.length - 1].seq : null;
  return { entries: page, next, limit };
}
