// NOT FOR PROFIT — civic public good, not a commercial product.
// Choice-free vote receipts: hashes + a holder token. Email body + PDF prove
// that a ballot was accepted, never which option was marked. Public dashboards
// still wait for hourly disclosure; the holder token can confirm a count
// before that hour closes without listing pending turnout.

import { createHash, randomBytes } from 'node:crypto';

import { isDisclosed, nextPublishAt, hourBucket, disclosurePublicView, withDisclosedCount } from './disclosure.mjs';
import { HttpError } from './http.mjs';
import { emailHint, normalizeEmail, userEmail } from './identity.mjs';
import { toBytes32 } from './merkle.mjs';
import { buildDeterministicPdf } from './pdf.mjs';
import { publicVoteRecord } from './store.mjs';
import { sha256Hex } from './terms.mjs';

export const RECEIPT_SCHEMA = 'republic.receipt.v1';
export const RECEIPT_PDF_FILENAME = 'republic-vote-receipt.pdf';
export const RECEIPT_BEGIN = '-----BEGIN REPUBLIC VOTE RECEIPT-----';
export const RECEIPT_END = '-----END REPUBLIC VOTE RECEIPT-----';

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
    if (CHOICE_KEYS.has(String(k).toLowerCase())) continue;
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
    } else if (/BEGIN REPUBLIC VOTE RECEIPT/.test(text)) {
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
  };
  if (!merged.token && !merged.nullifier && !merged.ballotHash) {
    throw new HttpError(400, 'paste a receipt (token, nullifier, or ballot hash)', { code: 'RECEIPT_PROOF' });
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

export function receiptLines({ election, vote, receipt, token, published, nextPublishAt: nextAt, includeToken = true }) {
  const bits = electionPublicBits(election);
  const acceptedAt = vote?.acceptedAt ?? receipt?.acceptedAt;
  const userOp = receipt?.userOpHash || vote?.userOpHash || null;
  const lines = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'This is evidence that a ballot was accepted. It does not list which option or candidate was marked. If a copy of this receipt names a choice, it is invalid.',
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
    published
      ? 'Public explorer rows for this ballot are disclosed.'
      : `Public explorer rows wait until the hour that contained this ballot closes${
          nextAt ? ` (next disclosure ${isoUtc(nextAt)}).` : '.'
        }`,
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
    }),
  ];
  return lines.filter((line) => line != null);
}

export function buildReceiptPdf(input) {
  const lines = receiptLines(input);
  const pdf = buildDeterministicPdf({
    title: 'Republic vote receipt',
    lines,
    created: pdfCreatedDay(input.vote?.acceptedAt ?? input.receipt?.acceptedAt),
  });
  return {
    filename: RECEIPT_PDF_FILENAME,
    pdf,
    pdfSha256: sha256Hex(pdf),
    lines,
  };
}

export function receiptEmailBodies({ election, vote, receipt, token, published, nextPublishAt: nextAt, pdfSha256 }) {
  const bits = electionPublicBits(election);
  const proof = formatReceiptProof({
    electionId: bits.electionId || vote?.electionId,
    nullifier: vote?.nullifier || receipt?.nullifier,
    ballotHash: vote?.ballotHash || receipt?.ballotHash,
    userOpHash: receipt?.userOpHash || vote?.userOpHash,
    token,
    acceptedAt: vote?.acceptedAt ?? receipt?.acceptedAt,
  });
  const subject = 'Republic vote receipt (not your choices)';
  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'A ballot was accepted. This message is evidence of voting, not of how you voted. It does not list a candidate or an option. If a copy of this receipt names a choice, it is invalid.',
    '',
    `Election: ${bits.electionTitle || '—'}`,
    `Election id: ${bits.electionId || vote?.electionId || '—'}`,
    `Accepted (UTC): ${isoUtc(vote?.acceptedAt ?? receipt?.acceptedAt) || '—'}`,
    `Ballot hash: ${vote?.ballotHash || receipt?.ballotHash || '—'}`,
    `Nullifier: ${vote?.nullifier || receipt?.nullifier || '—'}`,
    `UserOp hash: ${receipt?.userOpHash || vote?.userOpHash || '—'}`,
    pdfSha256 ? `PDF SHA-256: ${pdfSha256}` : null,
    '',
    published
      ? 'Public explorer rows for this ballot are disclosed.'
      : `Public explorer rows wait until the hour that contained this ballot closes${
          nextAt ? ` (next disclosure ${isoUtc(nextAt)}).` : '.'
        }`,
    '',
    'Paste the proof below at /receipt to confirm this ballot was counted. That portal also shows how many ballots have been disclosed and when each hour closed — never which option anyone marked.',
    '',
    proof,
    '',
    'A PDF of the same text is attached. Keep this message if you need to show that you participated.',
  ]
    .filter((line) => line != null)
    .join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>A ballot was accepted. This message is <strong>evidence of voting</strong>, not of how you voted. It does not list a candidate or an option.</p>
<p>Election: ${htmlEscape(bits.electionTitle || '—')}<br/>
Election id: <code>${htmlEscape(bits.electionId || vote?.electionId || '—')}</code><br/>
Accepted (UTC): ${htmlEscape(isoUtc(vote?.acceptedAt ?? receipt?.acceptedAt) || '—')}<br/>
Ballot hash: <code style="word-break:break-all">${htmlEscape(vote?.ballotHash || receipt?.ballotHash || '—')}</code><br/>
Nullifier: <code style="word-break:break-all">${htmlEscape(vote?.nullifier || receipt?.nullifier || '—')}</code></p>
${pdfSha256 ? `<p>PDF SHA-256: <code style="word-break:break-all">${htmlEscape(pdfSha256)}</code></p>` : ''}
<p>Paste this proof at <code>/receipt</code> to confirm the ballot was counted. Turnout on that page is an hourly snapshot and never includes a candidate or option.</p>
<pre style="font-family:ui-monospace,monospace;font-size:0.85rem;white-space:pre-wrap;word-break:break-all;background:#f6f4ef;padding:0.85rem;border:1px solid #ccc">${htmlEscape(proof)}</pre>
<p style="color:#444">A PDF of the same text is attached. Civic public good. Not a commercial product.</p>
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
}) {
  const bits = electionPublicBits(election);
  const proofText = formatReceiptProof({
    electionId: bits.electionId || vote?.electionId,
    nullifier: vote?.nullifier,
    ballotHash: vote?.ballotHash,
    userOpHash: vote?.userOpHash,
    token,
    acceptedAt: vote?.acceptedAt,
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
  const base = view || disclosurePublicView(ts, secs);
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
  const proof = parseReceiptProof(rawProof, extras);
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  let receiptRow = null;
  let vote = null;
  let holder = false;
  if (proof.token) {
    receiptRow = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
    if (!receiptRow) {
      throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND', counted: false });
    }
    vote = deps.store.findVote(receiptRow.electionId, receiptRow.nullifier);
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
    explorerUrl: `/explorer#/nullifier/${encodeURIComponent(publicVote.nullifier)}`,
    note: published
      ? 'This ballot is in the public record. The receipt still cannot prove which option was marked.'
      : 'This ballot is in the inbox. Public explorer rows and turnout ticks wait until this hour closes so a person leaving a voting office cannot be matched to a live jurisdiction increase.',
  });
}

function resolveEmail(req, body) {
  const raw = body?.email;
  if (raw) return normalizeEmail(raw);
  const fromUser = userEmail(req.user);
  if (fromUser) return fromUser;
  throw new HttpError(400, 'email required to send a receipt', { code: 'EMAIL_REQUIRED' });
}

export async function emailReceipt(deps, req, body = {}) {
  const proof = parseReceiptProof(body.proof, body);
  if (!proof.token) {
    throw new HttpError(401, 'a receipt token is required to email a copy', { code: 'RECEIPT_TOKEN_REQUIRED' });
  }
  const row = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
  if (!row) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const vote = deps.store.findVote(row.electionId, row.nullifier);
  if (!vote) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const election = deps.store.requireElection(vote.electionId);
  const to = resolveEmail(req, body);
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const published = isDisclosed(vote.acceptedAt, now, interval);
  const nextAt = published ? null : nextPublishAt(now, interval);
  const artifact = buildReceiptPdf({
    election,
    vote: { ...vote, userOpHash: row.userOpHash },
    receipt: row,
    token: proof.token,
    published,
    nextPublishAt: nextAt,
    includeToken: true,
  });
  const bodies = receiptEmailBodies({
    election,
    vote,
    receipt: row,
    token: proof.token,
    published,
    nextPublishAt: nextAt,
    pdfSha256: artifact.pdfSha256,
  });
  await deps.mailer.send({
    to,
    ...bodies,
    attachments: [
      {
        filename: artifact.filename,
        contentType: 'application/pdf',
        content: artifact.pdf,
      },
    ],
    meta: {
      purpose: 'vote-receipt',
      electionId: String(election.id),
      nullifier: vote.nullifier,
      ballotHash: vote.ballotHash,
      pdfSha256: artifact.pdfSha256,
    },
  });
  await deps.store.markReceiptEmailed(row.id, { emailHint: emailHint(to) });
  return {
    ok: true,
    nfp: true,
    emailed: true,
    toHint: emailHint(to),
    pdfSha256: artifact.pdfSha256,
    filename: artifact.filename,
    receiptsProveChoice: false,
  };
}

export function receiptPdfForToken(deps, rawProof, extras = {}) {
  const proof = parseReceiptProof(rawProof, extras);
  if (!proof.token) {
    throw new HttpError(401, 'a receipt token is required to download the PDF', { code: 'RECEIPT_TOKEN_REQUIRED' });
  }
  const row = deps.store.findReceiptByTokenHash(hashReceiptToken(proof.token));
  if (!row) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const vote = deps.store.findVote(row.electionId, row.nullifier);
  if (!vote) throw new HttpError(404, 'receipt not found', { code: 'RECEIPT_NOT_FOUND' });
  const election = deps.store.requireElection(vote.electionId);
  const now = deps.config.nowFn();
  const interval = deps.config.disclosureIntervalSeconds;
  const published = isDisclosed(vote.acceptedAt, now, interval);
  return buildReceiptPdf({
    election,
    vote: { ...vote, userOpHash: row.userOpHash },
    receipt: row,
    token: proof.token,
    published,
    nextPublishAt: published ? null : nextPublishAt(now, interval),
    includeToken: true,
  });
}

/**
 * Mint a holder token and the hash to persist. Token is returned only to the voter.
 */
export function mintHolderToken() {
  const token = mintReceiptToken();
  return { token, receiptTokenHash: hashReceiptToken(token) };
}
