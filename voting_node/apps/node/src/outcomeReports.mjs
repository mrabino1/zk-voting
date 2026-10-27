// NOT FOR PROFIT — civic public good, not a commercial product.
// Official election-outcome PDFs. Issued only after cutoffTime has fully
// expired and a certified tally exists. Locked against modification. QR +
// HMAC/SHA-256 authenticity seals cannot be omitted by the admin template.

import { createHmac, randomUUID } from 'node:crypto';

import { sanitizeText } from './cms.mjs';
import { electionState } from './electionState.mjs';
import { HttpError } from './http.mjs';
import { emailHint, userEmail } from './identity.mjs';
import {
  buildDeterministicPdf,
  pdfAllowsModify,
  PDF_RECEIPT_PERMISSIONS,
  readPdfEncryption,
} from './pdf.mjs';
import { encodeQr, isQrAlphanumeric } from './qr.mjs';
import { isoUtc, pdfCreatedDay } from './receipts.mjs';
import { buildResults } from './results.mjs';
import { sha256Hex } from './terms.mjs';

export const OUTCOME_REPORT_SCHEMA = 'zk-voting.outcome-report.v1';
export const OUTCOME_REPORT_PDF_FILENAME = 'zk-voting-official-outcome.pdf';
export const OUTCOME_REPORT_BEGIN = '-----BEGIN ZK-VOTING OUTCOME REPORT-----';
export const OUTCOME_REPORT_END = '-----END ZK-VOTING OUTCOME REPORT-----';
export const OUTCOME_VERIFY_PATH = '/outcomes/verify';
export const OUTCOME_QR_PATH = '/o';

export const LOCKED_TEMPLATE_KEYS = Object.freeze(['qr', 'hash', 'integrity', 'authenticity']);

export function defaultOutcomeReportTemplate() {
  return {
    heading: 'Official election outcome',
    letterhead: 'Office of civic elections',
    intro:
      'This certified report is issued after voting closed. It lists how many ballots were counted for each option, when the contest opened, and when it ended. Individual choices are never shown.',
    footer: 'NOT FOR PROFIT — civic public good. Not a commercial product.',
    contactLine: '',
    showJurisdiction: true,
  };
}

export function presentOutcomeReportTemplate(raw) {
  const base = defaultOutcomeReportTemplate();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    heading: String(src.heading || base.heading).slice(0, 120),
    letterhead: String(src.letterhead || base.letterhead).slice(0, 160),
    intro: String(src.intro || base.intro).slice(0, 4000),
    footer: String(src.footer || base.footer).slice(0, 500),
    contactLine: src.contactLine != null ? String(src.contactLine).slice(0, 240) : base.contactLine,
    showJurisdiction: src.showJurisdiction !== false,
    authenticity: {
      qr: true,
      hash: true,
      integrity: true,
      customizable: false,
      note: 'The QR verification mark and hash / HMAC seals are always included. Admins cannot remove or redesign them.',
    },
  };
}

export function sanitizeOutcomeReportTemplate(patch = {}, previous = defaultOutcomeReportTemplate()) {
  const next = presentOutcomeReportTemplate(previous);
  if (patch.heading != null) next.heading = sanitizeText(patch.heading, 120) || next.heading;
  if (patch.letterhead != null) next.letterhead = sanitizeText(patch.letterhead, 160);
  if (patch.intro != null) next.intro = sanitizeText(patch.intro, 4000) || next.intro;
  if (patch.footer != null) next.footer = sanitizeText(patch.footer, 500) || next.footer;
  if (patch.contactLine != null) next.contactLine = sanitizeText(patch.contactLine, 240);
  if (patch.showJurisdiction != null) next.showJurisdiction = Boolean(patch.showJurisdiction);
  return presentOutcomeReportTemplate(next);
}

export function compactReportId(id) {
  return String(id || '')
    .replace(/-/g, '')
    .toUpperCase();
}

export function parseCompactReportId(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^RO1[/:_]/, '');
  const hex = raw.replace(/-/g, '');
  if (/^[0-9A-F]{32}$/.test(hex)) {
    return `${hex.slice(0, 8).toLowerCase()}-${hex.slice(8, 12).toLowerCase()}-${hex.slice(12, 16).toLowerCase()}-${hex.slice(16, 20).toLowerCase()}-${hex.slice(20).toLowerCase()}`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim())) {
    return String(value).trim().toLowerCase();
  }
  return null;
}

export function publicBaseUrl(config) {
  const explicit = String(config?.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const origin = Array.isArray(config?.origins) ? String(config.origins[0] || '').trim() : '';
  return origin.replace(/\/+$/, '') || 'http://127.0.0.1:3000';
}

export function outcomeVerifyUrl(config, reportId) {
  const compact = compactReportId(reportId);
  return `${publicBaseUrl(config)}${OUTCOME_QR_PATH}/${compact}`;
}

export function outcomeVerifyPageUrl(config, reportId) {
  return `${publicBaseUrl(config)}${OUTCOME_VERIFY_PATH}?id=${encodeURIComponent(reportId)}`;
}

export function qrPayloadForReport(config, reportId) {
  const url = outcomeVerifyUrl(config, reportId);
  const upper = url.toUpperCase();
  if (isQrAlphanumeric(upper) && upper.length <= 61) return upper;
  if (isQrAlphanumeric(url) && url.length <= 84) return url;
  return `RO1/${compactReportId(reportId)}`;
}

export function outcomeReportReady(election, now) {
  if (!election) return false;
  const cutoff = Number(election.cutoffTime);
  const ts = Number(now);
  if (!Number.isFinite(cutoff) || !Number.isFinite(ts)) return false;
  if (ts < cutoff) return false;
  return Boolean(election.tally);
}

export function outcomePdfOwnerPassword(secret, reportId) {
  return createHmac('sha256', String(secret || ''))
    .update(`outcome-pdf-owner:${reportId || ''}`)
    .digest('base64url');
}

export function outcomePdfIntegrity(secret, fields) {
  const questions = Array.isArray(fields.questions) ? fields.questions : [];
  const optionLines = questions.flatMap((q) =>
    (q.options || []).map((o) => `${q.id || ''}|${o.id || ''}|${o.label || ''}|${o.count ?? ''}`),
  );
  const canonical = [
    OUTCOME_REPORT_SCHEMA,
    fields.reportId || '',
    fields.electionId || '',
    fields.startTime == null ? '' : String(fields.startTime),
    fields.cutoffTime == null ? '' : String(fields.cutoffTime),
    fields.acceptedBallots == null ? '' : String(fields.acceptedBallots),
    fields.tallyPostedAt || '',
    optionLines.join(';'),
  ].join('\n');
  return createHmac('sha256', String(secret || '')).update(canonical).digest('hex');
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jurisdictionName(store, election) {
  if (!election?.jurisdictionId) return null;
  const row = store?.getJurisdiction?.(election.jurisdictionId);
  return row?.name || election.jurisdictionId;
}

export function officialOutcomeFacts(election, deps = {}, now) {
  const ts = now ?? deps.config?.nowFn?.() ?? Math.floor(Date.now() / 1000);
  const results = buildResults(election, { now: ts });
  const questions = (results.questions || []).map((q) => ({
    id: q.id,
    prompt: q.prompt,
    type: q.type,
    method: q.method,
    totalVotes: q.totalVotes,
    outcomeNote: q.outcome?.note || null,
    options: (q.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      count: o.count,
    })),
  }));
  return {
    electionId: String(election.id),
    electionTitle: election.title || null,
    shortCode: election.shortCode || null,
    jurisdictionId: election.jurisdictionId || null,
    jurisdictionName: jurisdictionName(deps.store, election),
    startTime: election.startTime,
    startTimeIso: isoUtc(election.startTime),
    cutoffTime: election.cutoffTime,
    cutoffTimeIso: isoUtc(election.cutoffTime),
    acceptedBallots: election.acceptedBallots ?? 0,
    participantCount: election.participantCount ?? null,
    tallyPostedAt: election.tally?.postedAt || null,
    questions,
    available: Boolean(results.available),
  };
}

export function formatOutcomeProof(fields) {
  const lines = [
    OUTCOME_REPORT_BEGIN,
    `schema: ${OUTCOME_REPORT_SCHEMA}`,
    fields.reportId ? `reportId: ${fields.reportId}` : null,
    fields.electionId ? `electionId: ${fields.electionId}` : null,
    fields.pdfSha256 ? `pdfSha256: ${fields.pdfSha256}` : null,
    fields.integrity ? `integrity: hmac-sha256:${fields.integrity}` : null,
    fields.verifyUrl ? `verify: ${fields.verifyUrl}` : null,
    OUTCOME_REPORT_END,
  ];
  return lines.filter((line) => line != null && line !== '').join('\n');
}

export function outcomeReportLines({ template, facts, reportId, integrity, verifyUrl, verifyPageUrl }) {
  const tpl = presentOutcomeReportTemplate(template);
  const lines = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    tpl.letterhead || null,
    tpl.heading,
    '',
    tpl.intro,
    '',
    `Election: ${facts.electionTitle || '—'}`,
    `Election id: ${facts.electionId || '—'}`,
    facts.shortCode ? `Short code: ${facts.shortCode}` : null,
    tpl.showJurisdiction && facts.jurisdictionName
      ? `Jurisdiction: ${facts.jurisdictionName}`
      : tpl.showJurisdiction && facts.jurisdictionId
        ? `Jurisdiction: ${facts.jurisdictionId}`
        : null,
    `Voting started (UTC): ${facts.startTimeIso || isoUtc(facts.startTime) || '—'}`,
    `Voting ended (UTC): ${facts.cutoffTimeIso || isoUtc(facts.cutoffTime) || '—'}`,
    `Ballots accepted: ${facts.acceptedBallots ?? '—'}`,
    facts.participantCount != null ? `Registered on the roll: ${facts.participantCount}` : null,
    facts.tallyPostedAt ? `Tally posted: ${facts.tallyPostedAt}` : null,
    '',
    'How many people voted for each option',
  ];
  for (const question of facts.questions || []) {
    lines.push('');
    lines.push(question.prompt || question.id || 'Question');
    if (question.method) lines.push(`Method: ${question.method}`);
    for (const option of question.options || []) {
      const count = option.count == null ? '—' : String(option.count);
      lines.push(`  ${option.label}: ${count}`);
    }
    if (question.outcomeNote) lines.push(question.outcomeNote);
  }
  lines.push('');
  lines.push(tpl.footer);
  if (tpl.contactLine) lines.push(tpl.contactLine);
  lines.push('');
  lines.push(
    'This PDF is encrypted and locked against modification. Printing and copying are allowed. Editing, assembling pages, and filling forms are not. Drop the file at /outcomes/verify to confirm the SHA-256 still matches the Node fingerprint.',
  );
  lines.push(`Report id: ${reportId}`);
  lines.push(`Integrity (HMAC-SHA256): ${integrity}`);
  lines.push(`Verify: ${verifyPageUrl || verifyUrl}`);
  lines.push('');
  lines.push(
    formatOutcomeProof({
      reportId,
      electionId: facts.electionId,
      integrity,
      verifyUrl: verifyPageUrl || verifyUrl,
    }),
  );
  return lines.filter((line) => line != null);
}

export function buildOutcomeReportPdf(input) {
  const secret = input.hmacSecret;
  if (!secret) {
    throw new HttpError(500, 'outcome PDF HMAC secret is not configured', { code: 'OUTCOME_PDF_SECRET' });
  }
  const reportId = input.reportId || randomUUID();
  const facts = input.facts;
  const integrity =
    input.integrity ||
    outcomePdfIntegrity(secret, {
      reportId,
      electionId: facts.electionId,
      startTime: facts.startTime,
      cutoffTime: facts.cutoffTime,
      acceptedBallots: facts.acceptedBallots,
      tallyPostedAt: facts.tallyPostedAt,
      questions: facts.questions,
    });
  const verifyUrl = input.verifyUrl || outcomeVerifyUrl(input.config, reportId);
  const verifyPageUrl = input.verifyPageUrl || outcomeVerifyPageUrl(input.config, reportId);
  const qrPayload = input.qrPayload || qrPayloadForReport(input.config, reportId);
  const qr = encodeQr(qrPayload);
  const lines = outcomeReportLines({
    template: input.template,
    facts,
    reportId,
    integrity,
    verifyUrl,
    verifyPageUrl,
  });
  const ownerPassword = input.ownerPassword || outcomePdfOwnerPassword(secret, reportId);
  const created = pdfCreatedDay(facts.cutoffTime);
  const pdf = buildDeterministicPdf({
    title: presentOutcomeReportTemplate(input.template).heading || 'Official election outcome',
    lines,
    created,
    protect: {
      ownerPassword,
      userPassword: '',
      permissions: PDF_RECEIPT_PERMISSIONS,
    },
    authenticity: {
      heading: 'Authenticity seal (required)',
      lines: [
        'This page cannot be removed or redesigned by the clerk template. Scan the QR code or drop this file at the verify URL. A modified PDF will not match the SHA-256 the Node recorded.',
        `Report id: ${reportId}`,
        `Integrity (HMAC-SHA256): ${integrity}`,
        `Verify URL: ${verifyPageUrl}`,
        `QR payload: ${qr.payload}`,
      ],
      modules: qr.modules,
      caption: `Scan to verify. ${verifyUrl}`,
      moduleSize: qr.size > 33 ? 2.2 : 2.6,
    },
  });
  const enc = readPdfEncryption(pdf);
  if (!enc || pdfAllowsModify(enc.permissions)) {
    throw new HttpError(500, 'outcome PDF was not locked against modification', { code: 'OUTCOME_PDF_LOCK' });
  }
  return {
    filename: OUTCOME_REPORT_PDF_FILENAME,
    pdf,
    pdfSha256: sha256Hex(pdf),
    pdfProtected: true,
    pdfModify: false,
    integrity,
    reportId,
    verifyUrl,
    verifyPageUrl,
    qrPayload: qr.payload,
    qrVersion: qr.version,
    lines,
    permissions: enc.permissions,
  };
}

export function fingerprintFromPdfBody(body = {}) {
  const listed = body.pdfSha256 || body.pdf_sha256 || body.sha256;
  if (listed && /^[0-9a-fA-F]{64}$/.test(String(listed).trim())) {
    return String(listed).trim().toLowerCase();
  }
  const raw = body.pdf || body.pdfBase64 || body.file;
  if (!raw) return null;
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'pdf must be base64', { code: 'OUTCOME_PDF' });
  }
  const s = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(400, 'file is not a PDF', { code: 'OUTCOME_PDF' });
  }
  return sha256Hex(buf);
}

export function presentOutcomeReport(row, extras = {}) {
  if (!row) return null;
  return {
    schema: OUTCOME_REPORT_SCHEMA,
    nfp: true,
    id: row.id,
    reportId: row.id,
    electionId: row.electionId,
    electionTitle: extras.electionTitle || row.electionTitle || null,
    startTime: row.startTime,
    startTimeIso: isoUtc(row.startTime),
    cutoffTime: row.cutoffTime,
    cutoffTimeIso: isoUtc(row.cutoffTime),
    acceptedBallots: row.acceptedBallots,
    pdfSha256: row.pdfSha256,
    integrity: row.integrity,
    pdfProtected: true,
    pdfModify: false,
    verifyPath: OUTCOME_VERIFY_PATH,
    verifyUrl: extras.verifyUrl || null,
    issuedAt: row.issuedAt,
    filename: OUTCOME_REPORT_PDF_FILENAME,
  };
}

export function subscribeVoterToOutcome(store, { userId, electionId, source = 'vote-default' }) {
  if (!userId || !electionId) return null;
  store.requireElection(electionId);
  const existing = store.findOutcomeSubscription(userId, electionId);
  if (existing && existing.subscribed === false) return existing;
  return store.upsertOutcomeSubscription({
    userId,
    electionId: String(electionId),
    subscribed: true,
    source: existing?.source || source,
  });
}

export function resolveVoterForOutcomeSubscribe(store, { identityCommitment, userId, electionId }) {
  let resolved = userId || null;
  if (identityCommitment) {
    try {
      const linked = store.findUserIdForCommitment(electionId, identityCommitment);
      if (linked) resolved = linked;
    } catch {
      /* commitment may be absent on the on-chain path */
    }
  }
  return resolved;
}

export function outcomeEmailBodies({ electionTitle, facts, pdfSha256, integrity, verifyPageUrl, reportId }) {
  const subject = `Official outcome: ${facts.electionTitle || electionTitle || 'election'}`;
  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'Voting has ended. Attached is the locked official outcome PDF for this contest. It lists how many people voted for each option, when voting started, and when it ended.',
    '',
    `Election: ${facts.electionTitle || '—'}`,
    `Started (UTC): ${facts.startTimeIso || '—'}`,
    `Ended (UTC): ${facts.cutoffTimeIso || '—'}`,
    `Ballots accepted: ${facts.acceptedBallots ?? '—'}`,
    pdfSha256 ? `PDF SHA-256: ${pdfSha256}` : null,
    integrity ? `Integrity (HMAC-SHA256): ${integrity}` : null,
    '',
    `Drop the PDF at ${verifyPageUrl || OUTCOME_VERIFY_PATH} to confirm it is authentic. A modified file will not match.`,
    reportId ? `Report id: ${reportId}` : null,
    '',
    'You were subscribed because you voted in this contest (unsubscribe from My desk if you no longer want these reports).',
  ]
    .filter((line) => line != null)
    .join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>Voting has ended. The attached PDF is the <strong>official outcome report</strong> for this contest. It is encrypted and locked against modification.</p>
<p>Election: ${htmlEscape(facts.electionTitle || '—')}<br/>
Started (UTC): ${htmlEscape(facts.startTimeIso || '—')}<br/>
Ended (UTC): ${htmlEscape(facts.cutoffTimeIso || '—')}<br/>
Ballots accepted: ${htmlEscape(facts.acceptedBallots ?? '—')}</p>
${pdfSha256 ? `<p>PDF SHA-256: <code style="word-break:break-all">${htmlEscape(pdfSha256)}</code></p>` : ''}
<p>Drop the file at <code>${htmlEscape(verifyPageUrl || OUTCOME_VERIFY_PATH)}</code> to confirm it is authentic.</p>
<p style="color:#444">Civic public good. Not a commercial product.</p>
</body></html>`;
  return { subject, text, html };
}

async function issueCanonicalPdf(deps, election, now) {
  const existing = deps.store.getOutcomeReportForElection(election.id);
  if (existing) {
    return { row: existing, artifact: null, created: false };
  }
  const facts = officialOutcomeFacts(election, deps, now);
  if (!facts.available) {
    throw new HttpError(409, 'certified counts are not posted yet', { code: 'OUTCOME_NOT_READY' });
  }
  const reportId = randomUUID();
  const template = presentOutcomeReportTemplate(deps.store.getOutcomeReportTemplate());
  const artifact = buildOutcomeReportPdf({
    reportId,
    facts,
    template,
    hmacSecret: deps.config.receiptPdfSecret,
    config: deps.config,
  });
  const row = await deps.store.saveOutcomeReport({
    id: reportId,
    electionId: String(election.id),
    electionTitle: facts.electionTitle,
    startTime: facts.startTime,
    cutoffTime: facts.cutoffTime,
    acceptedBallots: facts.acceptedBallots,
    pdfSha256: artifact.pdfSha256,
    integrity: artifact.integrity,
    verifyUrl: artifact.verifyPageUrl,
    qrPayload: artifact.qrPayload,
    issuedAt: new Date().toISOString(),
    pdf: artifact.pdf.toString('base64'),
  });
  return { row, artifact, created: true, facts };
}

async function deliverToSubscriber(deps, { row, artifact, facts, user, election }) {
  if (!user) return { skipped: true, reason: 'no_user' };
  if (deps.store.hasOutcomeDelivery(row.id, user.id)) {
    return { skipped: true, reason: 'already_delivered' };
  }
  const to = userEmail(user);
  const verifyPageUrl = row.verifyUrl || outcomeVerifyPageUrl(deps.config, row.id);
  const bodies = outcomeEmailBodies({
    electionTitle: election?.title || facts?.electionTitle,
    facts: facts || officialOutcomeFacts(election, deps),
    pdfSha256: row.pdfSha256,
    integrity: row.integrity,
    verifyPageUrl,
    reportId: row.id,
  });
  let emailed = false;
  if (to) {
    const pdf = artifact?.pdf || Buffer.from(row.pdf, 'base64');
    await deps.mailer.send({
      to,
      ...bodies,
      attachments: [
        {
          filename: OUTCOME_REPORT_PDF_FILENAME,
          contentType: 'application/pdf',
          content: pdf,
        },
      ],
      meta: {
        purpose: 'outcome-report',
        electionId: String(election.id),
        reportId: row.id,
        pdfSha256: row.pdfSha256,
      },
    });
    emailed = true;
  }
  await deps.store.addOutcomeDelivery({
    reportId: row.id,
    userId: user.id,
    emailHint: to ? emailHint(to) : null,
    emailed,
  });
  await deps.store.addNotification({
    userId: user.id,
    type: 'outcome_report',
    title: 'Official outcome report',
    body: `Voting ended for ${election.title}. The locked official PDF is ready to verify at ${OUTCOME_VERIFY_PATH}.`,
    electionId: election.id,
  });
  return { emailed, toHint: to ? emailHint(to) : null };
}

export async function dispatchOfficialOutcomeReports(deps, { electionId, now } = {}) {
  const ts = now ?? deps.config.nowFn();
  const elections = electionId
    ? [deps.store.requireElection(electionId)]
    : deps.store.listElections();
  const issued = [];
  for (const election of elections) {
    if (!outcomeReportReady(election, ts)) continue;
    const { row, artifact, created, facts } = await issueCanonicalPdf(deps, election, ts);
    const subscribers = deps.store.listActiveOutcomeSubscribers(election.id);
    let emailed = 0;
    for (const sub of subscribers) {
      const user = deps.store.getUser(sub.userId);
      const result = await deliverToSubscriber(deps, {
        row,
        artifact,
        facts: facts || officialOutcomeFacts(election, deps, ts),
        user,
        election,
      });
      if (result?.emailed) emailed += 1;
    }
    issued.push({
      electionId: String(election.id),
      reportId: row.id,
      created,
      subscribers: subscribers.length,
      emailed,
    });
  }
  return { ok: true, nfp: true, issued };
}

export async function deliverOutcomeReportToUser(deps, { user, electionId, now }) {
  const election = deps.store.requireElection(electionId);
  const ts = now ?? deps.config.nowFn();
  if (!outcomeReportReady(election, ts)) return { delivered: false, reason: 'not_ready' };
  const { row, artifact, facts } = await issueCanonicalPdf(deps, election, ts);
  const result = await deliverToSubscriber(deps, {
    row,
    artifact,
    facts: facts || officialOutcomeFacts(election, deps, ts),
    user,
    election,
  });
  return { delivered: !result.skipped, ...result, reportId: row.id };
}

export function lookupOutcomeReport(deps, raw = {}, extras = {}) {
  const submittedPdfHash = fingerprintFromPdfBody({ ...raw, ...extras });
  const reportId =
    parseCompactReportId(raw.reportId || raw.id || extras.reportId || extras.id) ||
    parseCompactReportId(raw.token) ||
    null;
  const electionRef = raw.electionId || extras.electionId || null;
  let row = null;
  if (submittedPdfHash && deps.store.findOutcomeReportByPdfSha256) {
    row = deps.store.findOutcomeReportByPdfSha256(submittedPdfHash);
  }
  if (!row && reportId) row = deps.store.getOutcomeReport(reportId);
  if (!row && electionRef) row = deps.store.getOutcomeReportForElection(electionRef);
  if (!row) {
    throw new HttpError(404, 'official outcome report not found', {
      code: 'OUTCOME_REPORT_NOT_FOUND',
      authentic: false,
    });
  }
  const election = deps.store.getElection(row.electionId);
  let pdfUnmodified = null;
  if (submittedPdfHash) {
    pdfUnmodified = row.pdfSha256 === submittedPdfHash;
  } else if (raw.pdfSha256 && row.pdfSha256) {
    pdfUnmodified = row.pdfSha256 === String(raw.pdfSha256).toLowerCase();
  }
  const listedIntegrity = String(raw.integrity || extras.integrity || '')
    .replace(/^hmac-sha256:/i, '')
    .trim();
  const integrityMatch = listedIntegrity ? listedIntegrity === row.integrity : null;
  return {
    ok: true,
    nfp: true,
    authentic: submittedPdfHash ? pdfUnmodified === true : integrityMatch !== false,
    schema: OUTCOME_REPORT_SCHEMA,
    reportId: row.id,
    electionId: row.electionId,
    electionTitle: election?.title || row.electionTitle || null,
    startTime: row.startTime,
    startTimeIso: isoUtc(row.startTime),
    cutoffTime: row.cutoffTime,
    cutoffTimeIso: isoUtc(row.cutoffTime),
    acceptedBallots: row.acceptedBallots,
    pdfProtected: true,
    pdfModify: false,
    pdfSha256: row.pdfSha256,
    pdfUnmodified,
    integrity: row.integrity,
    integrityMatch,
    verifyPath: OUTCOME_VERIFY_PATH,
    note:
      pdfUnmodified === false
        ? 'This file does not match the SHA-256 the Node recorded. It is not the authentic official outcome PDF.'
        : 'This is the official outcome PDF the Node issued after voting closed. It cannot be edited in place; a changed copy will fail this check.',
  };
}

export async function previewOutcomeReportPdf(deps, { electionId, template } = {}) {
  const election = electionId ? deps.store.getElection(electionId) : deps.store.listElections()[0];
  const sampleFacts = election
    ? officialOutcomeFacts(election, deps)
    : {
        electionId: 'preview',
        electionTitle: 'Sample contest (preview)',
        shortCode: 'preview',
        jurisdictionId: 'demo',
        jurisdictionName: 'Demo jurisdiction',
        startTime: 1_700_000_000,
        startTimeIso: isoUtc(1_700_000_000),
        cutoffTime: 1_700_086_400,
        cutoffTimeIso: isoUtc(1_700_086_400),
        acceptedBallots: 12,
        participantCount: 20,
        tallyPostedAt: '2026-09-19T00:00:00.000Z',
        questions: [
          {
            id: 'q1',
            prompt: 'Adopt the measure?',
            method: 'plurality',
            options: [
              { id: 'yes', label: 'Yes', count: 8 },
              { id: 'no', label: 'No', count: 4 },
            ],
            outcomeNote: 'Yes wins with 8 votes.',
          },
        ],
        available: true,
      };
  if (election && !sampleFacts.available) {
    sampleFacts.available = true;
    sampleFacts.questions = (sampleFacts.questions || []).map((q) => ({
      ...q,
      options: (q.options || []).map((o, i) => ({ ...o, count: i === 0 ? 3 : 1 })),
    }));
    sampleFacts.acceptedBallots = sampleFacts.acceptedBallots || 4;
  }
  const tpl = sanitizeOutcomeReportTemplate(template || {}, deps.store.getOutcomeReportTemplate());
  return buildOutcomeReportPdf({
    reportId: '00000000-0000-4000-8000-000000000000',
    facts: sampleFacts,
    template: tpl,
    hmacSecret: deps.config.receiptPdfSecret,
    config: deps.config,
  });
}

export function electionStateNameForReport(election, now) {
  const state = electionState(election, now);
  return { state, ready: outcomeReportReady(election, now) };
}
