// NOT FOR PROFIT — civic public good, not a commercial product.
// Choice-free vote receipts: hashes + a holder token. Email body + PDF prove
// that a ballot was accepted, never which option was marked. Public dashboards
// still wait for hourly disclosure; the holder token can confirm a count
// before that hour closes without listing pending turnout.

import { brandName } from './branding.mjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isDisclosed, nextPublishAt, hourBucket, publicDisclosureView, withDisclosedCount } from './disclosure.mjs';
import { HttpError } from './http.mjs';
import { isUnsafeObjectKey } from './safeKeys.mjs';
import { emailHint, normalizeEmail } from './identity.mjs';
import { toBytes32 } from './merkle.mjs';
import {
  buildDeterministicPdf,
  pdfAllowsModify,
  PDF_RECEIPT_PERMISSIONS,
  readPdfEncryption,
} from './pdf.mjs';
import { publicVoteRecord } from './store.mjs';
import { sha256Hex } from './terms.mjs';
import { migrate, putSecretIfAbsent, readSecret, usingPostgres } from './db.mjs';

export const RECEIPT_SCHEMA = 'zk-voting.receipt.v1';
export const RECEIPT_PDF_FILENAME = 'zk-voting-vote-receipt.pdf';
export const RECEIPT_BEGIN = '-----BEGIN ZK-VOTING VOTE RECEIPT-----';
export const RECEIPT_END = '-----END ZK-VOTING VOTE RECEIPT-----';

const CHOICE_KEYS = new Set([
  'choice',
  'optionid',
  'option_id',
  'optionids',
  'answers',
  'selected',
  'plaintext',
  'votefor',
  'vote_for',
  'ranking',
  'ranks',
  'rankingpayload',
  'candidate',
  'candidates',
  'encryptedballot',
]);

export function hashReceiptToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function mintReceiptToken() {
  return randomBytes(32).toString('base64url');
}

export async function loadReceiptPdfSecret(config, { mint = true } = {}) {
  const fromConfig = String(config?.receiptPdfSecret || '').trim();
  if (fromConfig) return fromConfig;
  const fromEnv = String(process.env.RECEIPT_PDF_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  if (usingPostgres(config)) {
    await migrate(config, { quiet: config.quiet });
    const stored = await readSecret(config, RECEIPT_SECRET_NAME);
    if (stored) return stored;
    // One-time import of the secret a JSON-era node minted in DATA_DIR, so
    // receipt PDFs issued before the move still verify.
    let secret = '';
    if (config?.dataDir) {
      try {
        secret = (await fs.readFile(path.join(config.dataDir, 'receipt-pdf.secret'), 'utf8')).trim();
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (!secret && !mint) return '';
    if (!secret) secret = randomBytes(32).toString('base64url');
    return putSecretIfAbsent(config, RECEIPT_SECRET_NAME, secret);
  }
  const dir = config?.dataDir;
  if (!dir) throw new Error('receipt PDF secret: dataDir or RECEIPT_PDF_SECRET required');
  const file = path.join(dir, 'receipt-pdf.secret');
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!mint) return '';
  const secret = randomBytes(32).toString('base64url');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

const RECEIPT_SECRET_NAME = 'receipt-pdf';

export function receiptPdfOwnerPassword(secret, tokenHash) {
  return createHmac('sha256', String(secret || ''))
    .update(`receipt-pdf-owner:${tokenHash || ''}`)
    .digest('base64url');
}

export function receiptPdfIntegrity(secret, fields) {
  const canonical = [
    RECEIPT_SCHEMA,
    fields.electionId || '',
    fields.nullifier || '',
    fields.ballotHash || '',
    fields.userOpHash || '',
    fields.acceptedAt == null ? '' : String(fields.acceptedAt),
    fields.tokenHash || '',
  ].join('\n');
  return createHmac('sha256', String(secret || '')).update(canonical).digest('hex');
}

export function fingerprintFromPdfBody(body = {}) {
  const listed = body.pdfSha256 || body.pdf_sha256 || body.sha256;
  if (listed && /^[0-9a-fA-F]{64}$/.test(String(listed).trim())) {
    return String(listed).trim().toLowerCase();
  }
  const raw = body.pdf || body.pdfBase64 || body.file;
  if (!raw) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'pdf must be base64', { code: 'RECEIPT_PDF' });
  }
  const s = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(400, 'file is not a PDF', { code: 'RECEIPT_PDF' });
  }
  return sha256Hex(buf);
}

export function tryBytes32(value) {
  if (value == null || value === '') return null;
  try {
    return toBytes32(value);
  } catch {
    return null;
  }
}

export function optionalUserOpHash(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^(0x)?[0-9a-fA-F]{8,128}$/.test(s)) return null;
  return s.startsWith('0x') || s.startsWith('0X') ? s.toLowerCase() : `0x${s.toLowerCase()}`;
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isoUtc(unix) {
  const n = Number(unix);
  if (!Number.isFinite(n)) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function pdfCreatedDay(unix) {
  const iso = isoUtc(unix) || '2026-09-19T00:00:00.000Z';
  return iso.slice(0, 10);
}

function disclosureHourClosedAt(acceptedAt, intervalSeconds) {
  const interval = Number(intervalSeconds) || 0;
  const ts = Number(acceptedAt);
  if (!Number.isFinite(ts)) return null;
  if (!interval || interval <= 0) return ts;
  return hourBucket(ts, interval) + interval;
}

export function stripReceiptChoice(value) {
  if (Array.isArray(value)) return value.map(stripReceiptChoice);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (CHOICE_KEYS.has(String(k).toLowerCase()) || isUnsafeObjectKey(k)) continue;
    out[k] = stripReceiptChoice(v);
  }
  return out;
}

export function formatReceiptProof(fields) {
  const lines = [
    RECEIPT_BEGIN,
    `schema: ${RECEIPT_SCHEMA}`,
    fields.electionId ? `electionId: ${fields.electionId}` : null,
    fields.nullifier ? `nullifier: ${fields.nullifier}` : null,
    fields.ballotHash ? `ballotHash: ${fields.ballotHash}` : null,
    fields.userOpHash ? `userOpHash: ${fields.userOpHash}` : null,
    fields.token ? `token: ${fields.token}` : null,
    fields.acceptedAt != null ? `acceptedAt: ${isoUtc(fields.acceptedAt) || fields.acceptedAt}` : null,
    fields.pdfSha256 ? `pdfSha256: ${fields.pdfSha256}` : null,
    fields.integrity ? `integrity: hmac-sha256:${fields.integrity}` : null,
    RECEIPT_END,
  ];
  return lines.filter((line) => line != null && line !== '').join('\n');
}

function normalizeProofFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const token = obj.token || obj.receiptToken || null;
  return {
    schema: obj.schema || RECEIPT_SCHEMA,
    electionId:
      obj.electionId != null
        ? String(obj.electionId)
        : obj.election_id != null
          ? String(obj.election_id)
          : null,
    nullifier: obj.nullifier != null ? String(obj.nullifier) : null,
    ballotHash: obj.ballotHash != null ? String(obj.ballotHash) : obj.ballot_hash != null ? String(obj.ballot_hash) : null,
    userOpHash: optionalUserOpHash(obj.userOpHash || obj.user_op_hash),
    token: token ? String(token).trim() : null,
    acceptedAt: obj.acceptedAt ?? null,
    pdfSha256: obj.pdfSha256 || obj.pdf_sha256 || null,
    integrity: String(obj.integrity || '')
      .replace(/^hmac-sha256:/i, '')
      .trim() || null,
  };
}

export function parseReceiptProof(raw, extras = {}) {
  const fromExtras = normalizeProofFields(extras);
  const text = String(raw || '').trim();
  let parsed = {};
  if (text) {
    if (text.startsWith('{')) {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'receipt proof JSON is invalid', { code: 'RECEIPT_PROOF' });
      }
      parsed = normalizeProofFields(obj.receipt || obj);
    } else if (/BEGIN ZK-VOTING VOTE RECEIPT/.test(text)) {
      const fields = {};
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
        if (m) fields[m[1]] = m[2].trim();
      }
      parsed = normalizeProofFields(fields);
    } else if (/^[A-Za-z0-9_-]{32,64}$/.test(text) && !/\s/.test(text)) {
      parsed = { token: text };
    } else {
      throw new HttpError(400, 'unrecognized receipt proof', { code: 'RECEIPT_PROOF' });
    }
  }
  const merged = {
    schema: RECEIPT_SCHEMA,
    electionId: parsed.electionId || fromExtras.electionId,
    nullifier: parsed.nullifier || fromExtras.nullifier,
    ballotHash: parsed.ballotHash || fromExtras.ballotHash,
    userOpHash: parsed.userOpHash || fromExtras.userOpHash,
    token: parsed.token || fromExtras.token,
    acceptedAt: parsed.acceptedAt || fromExtras.acceptedAt,
    pdfSha256: parsed.pdfSha256 || fromExtras.pdfSha256 || null,
    integrity: parsed.integrity || fromExtras.integrity || null,
  };
  if (!merged.token && !merged.nullifier && !merged.ballotHash && !merged.pdfSha256) {
    throw new HttpError(400, 'paste a receipt (token, nullifier, ballot hash, or PDF)', { code: 'RECEIPT_PROOF' });
  }
  return merged;
}

function electionPublicBits(election) {
  if (!election) return { electionId: null, electionTitle: null, jurisdictionId: null, shortCode: null };
  return {
    electionId: String(election.id),
    electionTitle: election.title || null,
    jurisdictionId: election.jurisdictionId || null,
    shortCode: election.shortCode || null,
  };
}

export function receiptLines({ election, vote, receipt, token, includeToken = true, integrity = null }) {
  const bits = electionPublicBits(election);
  const acceptedAt = vote?.acceptedAt ?? receipt?.acceptedAt;
  const userOp = receipt?.userOpHash || vote?.userOpHash || null;
  const lines = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'This is evidence that a ballot was accepted. It does not list which option or candidate was marked. If a copy of this receipt names a choice, it is invalid.',
    '',
    'This PDF is encrypted and locked against modification. Printing and copying the proof text are allowed. Editing, assembling pages, and filling forms are not. If a copy can be edited, it is not authentic. Drop the file at /receipt; a modified PDF will not match the SHA-256 the Node recorded.',
    integrity ? `Integrity (HMAC-SHA256): ${integrity}` : null,
    '',
    `Election: ${bits.electionTitle || '—'}`,
    `Election id: ${bits.electionId || vote?.electionId || '—'}`,
    bits.shortCode ? `Short code: ${bits.shortCode}` : null,
    bits.jurisdictionId ? `Jurisdiction: ${bits.jurisdictionId}` : null,
    `Accepted (UTC): ${isoUtc(acceptedAt) || '—'}`,
    `Ballot hash: ${vote?.ballotHash || receipt?.ballotHash || '—'}`,
    `Nullifier: ${vote?.nullifier || receipt?.nullifier || '—'}`,
    `UserOp hash: ${userOp || '—'}`,
    `Relayer: ${vote?.relayer || 'node'}`,
    includeToken && token ? `Receipt token: ${token}` : null,
    '',
    'Paste this proof at /receipt to confirm the ballot was counted. Turnout metrics on that page are hourly snapshots and never include a candidate or option.',
    '',
    formatReceiptProof({
      electionId: bits.electionId || vote?.electionId,
      nullifier: vote?.nullifier || receipt?.nullifier,
      ballotHash: vote?.ballotHash || receipt?.ballotHash,
      userOpHash: userOp,
      token: includeToken ? token : null,
      acceptedAt,
      integrity,
    }),
  ];
  return lines.filter((line) => line != null);
}

export function buildReceiptPdf(input) {
  const secret = input.hmacSecret;
  if (!secret) {
    throw new HttpError(500, 'receipt PDF HMAC secret is not configured', { code: 'RECEIPT_PDF_SECRET' });
  }
  const token = input.token || null;
  const tokenHash = token ? hashReceiptToken(token) : input.tokenHash || input.receipt?.tokenHash || '';
  const acceptedAt = input.vote?.acceptedAt ?? input.receipt?.acceptedAt;
  const integrity =
    input.integrity ||
    receiptPdfIntegrity(secret, {
      electionId: input.election?.id || input.vote?.electionId || input.receipt?.electionId,
      nullifier: input.vote?.nullifier || input.receipt?.nullifier,
      ballotHash: input.vote?.ballotHash || input.receipt?.ballotHash,
      userOpHash: input.receipt?.userOpHash || input.vote?.userOpHash,
      acceptedAt,
      tokenHash,
    });
  const lines = receiptLines({ ...input, integrity });
  const ownerPassword = input.ownerPassword || receiptPdfOwnerPassword(secret, tokenHash);
  const pdf = buildDeterministicPdf({
    title: `${brandName()} vote receipt`,
    lines,
    created: pdfCreatedDay(acceptedAt),
    protect: {
      ownerPassword,
      userPassword: '',
      permissions: PDF_RECEIPT_PERMISSIONS,
    },
  });
  const enc = readPdfEncryption(pdf);
  if (!enc || pdfAllowsModify(enc.permissions)) {
    throw new HttpError(500, 'receipt PDF was not locked against modification', { code: 'RECEIPT_PDF_LOCK' });
  }
  return {
    filename: RECEIPT_PDF_FILENAME,
    pdf,
    pdfSha256: sha256Hex(pdf),
    pdfProtected: true,
    pdfModify: false,
    integrity,
    lines,
    permissions: enc.permissions,
  };
}

export async function issueAndStoreReceiptPdf(deps, { election, vote, receiptRow, token }) {
  const secret = deps.config.receiptPdfSecret;
  const artifact = buildReceiptPdf({
    election,
    vote: { ...vote, userOpHash: receiptRow?.userOpHash || vote?.userOpHash },
    receipt: receiptRow,
    token,
    hmacSecret: secret,
  });
  if (receiptRow?.id && typeof deps.store.markReceiptPdfIssued === 'function') {
    await deps.store.markReceiptPdfIssued(receiptRow.id, {
      pdfSha256: artifact.pdfSha256,
      pdfProtected: true,
      pdfIntegrity: artifact.integrity,
    });
  }
  return artifact;
}

/**
 * Opt-in emailed receipt. Deliberately thin: election title, the holder token
 * and where to verify / download the locked PDF. No nullifier, no ballot hash,
 * no userOp hash, no acceptance time and no PDF attachment — an inbox (or the
 * mail provider) should not hold the public handle of the ballot.
 */
export function receiptEmailBodies({ election, vote, receipt, token }) {
  const bits = electionPublicBits(election);
  const electionId = bits.electionId || vote?.electionId || receipt?.electionId || null;
  const proof = formatReceiptProof({ electionId, token });
  const subject = `${brandName()} vote receipt (not your choices)`;
  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'You asked for a copy of your vote receipt by email. This message is evidence of voting, not of how you voted. It does not list a candidate, an option, or the ballot nullifier.',
    '',
    `Election: ${bits.electionTitle || '—'}`,
    `Election id: ${electionId || '—'}`,
    '',
    'Paste the receipt below at /receipt to confirm the ballot was counted, or to download the locked PDF. Anyone holding this token can do the same, so delete this message if you do not need it.',
    '',
    proof,
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>You asked for a copy of your vote receipt by email. This message is <strong>evidence of voting</strong>, not of how you voted. It does not list a candidate, an option, or the ballot nullifier.</p>
<p>Election: ${htmlEscape(bits.electionTitle || '—')}<br/>
Election id: <code>${htmlEscape(electionId || '—')}</code></p>
<p>Paste the receipt below at <code>/receipt</code> to confirm the ballot was counted, or to download the locked PDF. Anyone holding this token can do the same, so delete this message if you do not need it.</p>
<pre style="font-family:ui-monospace,monospace;font-size:0.85rem;white-space:pre-wrap;word-break:break-all;background:#f6f4ef;padding:0.85rem;border:1px solid #ccc">${htmlEscape(proof)}</pre>
<p style="color:#444">Civic public good. Not a commercial product.</p>
</body></html>`;
  return { subject, text, html };
}

export function presentHolderReceipt({
  election,
  vote,
  token,
  published,
  nextPublishAt: nextAt,
  pdfSha256 = null,
  integrity = null,
  pdfProtected = true,
}) {
  const bits = electionPublicBits(election);
  const proofText = formatReceiptProof({
    electionId: bits.electionId || vote?.electionId,
    nullifier: vote?.nullifier,
    ballotHash: vote?.ballotHash,
    userOpHash: vote?.userOpHash,
    token,
    acceptedAt: vote?.acceptedAt,
    pdfSha256,
    integrity,
  });
  return stripReceiptChoice({
    schema: RECEIPT_SCHEMA,
    receiptsProveChoice: false,
    electionId: bits.electionId || String(vote?.electionId || ''),
    electionTitle: bits.electionTitle,
    jurisdictionId: bits.jurisdictionId,
    shortCode: bits.shortCode,
    nullifier: vote?.nullifier || null,
    ballotHash: vote?.ballotHash || null,
    userOpHash: vote?.userOpHash || null,
    relayer: vote?.relayer || 'node',
    acceptedAt: vote?.acceptedAt ?? null,
    acceptedAtIso: isoUtc(vote?.acceptedAt),
    token,
    proofText,
    published: Boolean(published),
    nextPublishAt: nextAt ?? null,
    pdfSha256,
    pdfProtected: Boolean(pdfProtected),
    pdfModify: false,
    integrity,
    verifyPath: '/receipt',
    filename: RECEIPT_PDF_FILENAME,
    nfp: true,
  });
}

export function disclosedHourBuckets(votes, now, intervalSeconds) {
  const interval = Number(intervalSeconds) || 0;
  const published = (votes || []).filter((v) => isDisclosed(v.acceptedAt, now, interval));
  const counts = new Map();
  for (const vote of published) {
    const closedAt =
      interval > 0 ? disclosureHourClosedAt(vote.acceptedAt, interval) : Number(now) || Number(vote.acceptedAt);
    const key = String(closedAt);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([hourClosedAt, ballots]) => ({
      hourClosedAt: Number(hourClosedAt),
      hourClosedAtIso: isoUtc(hourClosedAt),
      ballots,
    }))
    .sort((a, b) => a.hourClosedAt - b.hourClosedAt);
}

export function publicReceiptMetrics(election, deps, { now, interval, view } = {}) {
  const ts = now ?? deps.config.nowFn();
  const secs = interval ?? deps.config.disclosureIntervalSeconds;
  const votes = election ? deps.store.listVotes(election.id) : deps.store.data.votes || [];
  const hours = disclosedHourBuckets(votes, ts, secs);
  const acceptedBallotsDisclosed = hours.reduce((n, row) => n + row.ballots, 0);
  const base = view || publicDisclosureView(ts, secs);
  const disclosure = withDisclosedCount(base, acceptedBallotsDisclosed);
  return stripReceiptChoice({
    nfp: true,
    receiptsProveChoice: false,
    electionId: election ? String(election.id) : null,
    electionTitle: election?.title || null,
    jurisdictionId: election?.jurisdictionId || null,
    participantCount: election ? election.participantCount : null,
    acceptedBallotsDisclosed,
    hours,
    disclosure,
    note:
      'Hourly snapshots of how many ballots were accepted. Original intra-hour times are not published. This is not a count by candidate or option.',
  });
}

function matchingPublishedVotes(store, proof, now, interval) {
  let rows = store.data.votes || [];
  if (proof.electionId) {
    const election = store.getElection(proof.electionId);
    if (!election) return [];
    rows = rows.filter((v) => String(v.electionId) === String(election.id));
  }
  const nullifier = tryBytes32(proof.nullifier);
  const ballotHash = tryBytes32(proof.ballotHash);
  if (nullifier) rows = rows.filter((v) => tryBytes32(v.nullifier) === nullifier);
  if (ballotHash) rows = rows.filter((v) => tryBytes32(v.ballotHash) === ballotHash);
  return rows.filter((v) => isDisclosed(v.acceptedAt, now, interval));
}

export function lookupReceipt(deps, rawProof, extras = {}) {
  const submittedPdfHash = fingerprintFromPdfBody(extras);
  const mergedExtras = submittedPdfHash ? { ...extras, pdfSha256: submittedPdfHash } : extras;
  const text = String(rawProof || '').trim();
  const hasProofText = Boolean(
    text || mergedExtras.token || mergedExtras.nullifier || mergedExtras.ballotHash || mergedExtras.pdfSha256,
  );
  if (!hasProofText) {
    throw new HttpError(400, 'paste a receipt (token, nullifier, ballot hash, or PDF)', { code: 'RECEIPT_PROOF' });
  }
  const proof = parseReceiptProof(rawProof, mergedExtras);
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  let receiptRow = null;
  let vote = null;
  let holder = false;
  let fromIssuedPdf = false;
  if (proof.token) {
    receiptRow = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
    if (!receiptRow) {
      throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND', counted: false });
    }
    vote = deps.store.findVote(receiptRow.electionId, receiptRow.nullifier);
    holder = true;
  } else if (submittedPdfHash && !proof.nullifier && !proof.ballotHash) {
    receiptRow = deps.store.findReceiptByPdfSha256?.(submittedPdfHash) || null;
    if (!receiptRow) {
      throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND', counted: false, pdfUnmodified: false });
    }
    vote = deps.store.findVote(receiptRow.electionId, receiptRow.nullifier);
    fromIssuedPdf = true;
    holder = true;
  } else {
    const published = matchingPublishedVotes(deps.store, proof, now, interval);
    if (published.length !== 1) {
      throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND', counted: false });
    }
    vote = published[0];
    receiptRow = deps.store.findReceiptForVote(vote.electionId, vote.nullifier);
  }
  if (!vote) {
    throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND', counted: false });
  }
  const election = deps.store.getElection(vote.electionId);
  const published = isDisclosed(vote.acceptedAt, now, interval);
  const nextAt = published ? null : nextPublishAt(now, interval);
  const metrics = publicReceiptMetrics(election, deps, { now, interval });
  const publicVote = publicVoteRecord(vote);
  const hourClosed = published ? disclosureHourClosedAt(vote.acceptedAt, interval) : null;
  const storedPdfSha256 = receiptRow?.pdfSha256 || null;
  let pdfUnmodified = null;
  if (submittedPdfHash) {
    pdfUnmodified = Boolean(storedPdfSha256 && storedPdfSha256 === submittedPdfHash);
  } else if (proof.pdfSha256 && storedPdfSha256) {
    pdfUnmodified = storedPdfSha256 === String(proof.pdfSha256).toLowerCase();
  }
  const showPdfSeal = holder || fromIssuedPdf || pdfUnmodified === true;
  return stripReceiptChoice({
    ok: true,
    nfp: true,
    counted: true,
    accepted: true,
    published,
    receiptsProveChoice: false,
    electionId: String(vote.electionId),
    electionTitle: election?.title || null,
    jurisdictionId: election?.jurisdictionId || null,
    shortCode: election?.shortCode || null,
    nullifier: publicVote.nullifier,
    ballotHash: publicVote.ballotHash,
    relayer: publicVote.relayer,
    userOpHash: holder ? receiptRow?.userOpHash || null : null,
    acceptedAt: holder ? vote.acceptedAt : null,
    acceptedAtIso: holder ? isoUtc(vote.acceptedAt) : null,
    disclosureHourClosedAt: hourClosed,
    disclosureHourClosedAtIso: isoUtc(hourClosed),
    nextPublishAt: nextAt,
    nextPublishAtIso: isoUtc(nextAt),
    metrics,
    pdfProtected: showPdfSeal ? true : null,
    pdfModify: showPdfSeal ? false : null,
    pdfSha256: showPdfSeal ? storedPdfSha256 : null,
    pdfUnmodified,
    integrity: showPdfSeal ? receiptRow?.pdfIntegrity || null : null,
    explorerUrl: `/explorer#/nullifier/${encodeURIComponent(publicVote.nullifier)}`,
    note: published
      ? 'This ballot is in the public record. The receipt still cannot prove which option was marked.'
      : 'This ballot is in the inbox. Public explorer rows and turnout ticks wait until this hour closes so a person leaving a voting office cannot be matched to a live jurisdiction increase.',
  });
}

function resolveEmail(_req, body) {
  // Never fall back to the signed-in account's address: the voter types it.
  const raw = body?.email;
  if (raw) return normalizeEmail(raw);
  throw new HttpError(400, 'type the address to send this receipt to', { code: 'EMAIL_REQUIRED' });
}

/**
 * Opt-in only (download is the default). Requires the holder token, an
 * explicitly typed address and `optIn: true`. Stores nothing about the send.
 */
export async function emailReceipt(deps, req, body = {}) {
  const proof = parseReceiptProof(body.proof, body);
  if (!proof.token) {
    throw new HttpError(401, 'a receipt token is required to email a copy', { code: 'RECEIPT_TOKEN_REQUIRED' });
  }
  if (body.optIn !== true) {
    throw new HttpError(400, 'emailing a receipt is opt-in: send optIn: true', { code: 'EMAIL_OPT_IN_REQUIRED' });
  }
  const row = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
  if (!row) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const vote = deps.store.findVote(row.electionId, row.nullifier);
  if (!vote) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const election = deps.store.requireElection(vote.electionId);
  const to = resolveEmail(req, body);
  const bodies = receiptEmailBodies({ election, vote, receipt: row, token: proof.token });
  await deps.mailer.send({
    to,
    ...bodies,
    meta: { purpose: 'vote-receipt', electionId: String(election.id) },
  });
  return {
    ok: true,
    nfp: true,
    emailed: true,
    toHint: emailHint(to),
    attachments: 0,
    receiptsProveChoice: false,
  };
}

export async function receiptPdfForToken(deps, rawProof, extras = {}) {
  const proof = parseReceiptProof(rawProof, extras);
  if (!proof.token) {
    throw new HttpError(401, 'a receipt token is required to download the PDF', { code: 'RECEIPT_TOKEN_REQUIRED' });
  }
  const row = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
  if (!row) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const vote = deps.store.findVote(row.electionId, row.nullifier);
  if (!vote) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const election = deps.store.requireElection(vote.electionId);
  return issueAndStoreReceiptPdf(deps, {
    election,
    vote,
    receiptRow: row,
    token: proof.token,
  });
}

/**
 * Mint a holder token and the hash to persist. Token is returned only to the voter.
 */
export function mintHolderToken() {
  const token = mintReceiptToken();
  return { token, receiptTokenHash: hashReceiptToken(token) };
}

/** Hash-only token-poll receipt. No choice, no userId. */
export function buildPollReceipt(ballot) {
  return {
    schema: 'zk-voting.receipt.poll.v1',
    nfp: true,
    binding: false,
    signal: 'Signal only · non-binding · NOT FOR PROFIT',
    pollId: ballot.pollId,
    voter: ballot.voter,
    voteBlock: ballot.voteBlock,
    provisionalWeight: String(ballot.provisionalWeight),
    ballotDigest: ballot.ballotDigest,
    acceptedHour: ballot.disclosureHour,
    note: 'final weight = min balance until close',
  };
}
