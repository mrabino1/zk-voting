// NOT FOR PROFIT — civic public good, not a commercial product.
// Canonical Terms of Use: markdown source, deterministic PDF, SHA-256 of
// exact PDF bytes (the hash stored on accept: SHA-256 of the emailed PDF).
// Markdown SHA-256 is published too.

import { DEFAULT_BRAND_NAME, brandName } from './branding.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from './http.mjs';
import { normalizeEmail, userEmail } from './identity.mjs';
import { buildDeterministicPdf } from './pdf.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERMS_MARKDOWN_PATH = path.join(PKG_ROOT, 'legal', 'terms.md');
export const TERMS_PDF_FILENAME = 'zk-voting-terms.pdf';

/** Terms hash is 64 hex chars — SHA-256 of the PDF bytes. */
export const TERMS_HASH_ALGO = 'sha256';
export const TERMS_HASH_OF = 'pdf-bytes';

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function isAcceptedTermsFlag(value) {
  if (value === true || value === 1) return true;
  const s = String(value || '')
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

export function requireAcceptedTerms(body) {
  if (!isAcceptedTermsFlag(body?.acceptedTerms)) {
    throw new HttpError(400, 'You must accept the Terms of Use', { code: 'TERMS_REQUIRED' });
  }
  return true;
}

export function parseFrontMatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text };
  }
  const meta = {};
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: match[2].replace(/^\r?\n/, '') };
}

export function markdownToPdfLines(markdown, { skipTitle } = {}) {
  const lines = [];
  const src = String(markdown || '').replace(/\r\n/g, '\n');
  let skippedTitle = false;
  const skip = String(skipTitle || '')
    .trim()
    .toLowerCase();
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      lines.push('');
      continue;
    }
    if (line.startsWith('# ')) {
      const heading = line.slice(2).trim();
      if (!skippedTitle && skip && heading.toLowerCase() === skip) {
        skippedTitle = true;
        continue;
      }
      lines.push(heading.toUpperCase());
      lines.push('');
      continue;
    }
    if (line.startsWith('## ')) {
      lines.push('');
      lines.push(line.slice(3).trim());
      continue;
    }
    if (/^[-*] /.test(line)) {
      lines.push(`  • ${line.slice(2).trim()}`);
      continue;
    }
    lines.push(line.replace(/\*\*([^*]+)\*\*/g, '$1'));
  }
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function markdownToBlocks(markdown) {
  const blocks = [];
  const src = String(markdown || '').replace(/\r\n/g, '\n').trim();
  const chunks = src.split(/\n{2,}/);
  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t) continue;
    if (t.startsWith('# ')) {
      blocks.push({ type: 'h1', text: t.replace(/^#\s+/, '') });
      continue;
    }
    if (t.startsWith('## ')) {
      const first = t.split('\n')[0];
      blocks.push({ type: 'h2', text: first.replace(/^##\s+/, '') });
      const rest = t.split('\n').slice(1).join('\n').trim();
      if (rest) blocks.push({ type: 'paragraph', text: rest.replace(/\*\*([^*]+)\*\*/g, '$1') });
      continue;
    }
    if (/^[-*] /.test(t)) {
      blocks.push({
        type: 'list',
        items: t.split('\n').map((l) => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean),
      });
      continue;
    }
    blocks.push({ type: 'paragraph', text: t.replace(/\*\*([^*]+)\*\*/g, '$1') });
  }
  return blocks;
}

function readTermsFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Load canonical markdown, build the PDF, hash both.
 * Cached in-process: the file does not change at runtime.
 */
export function loadTermsDocument({ filePath = TERMS_MARKDOWN_PATH } = {}) {
  const raw = readTermsFile(filePath);
  const { meta, body } = parseFrontMatter(raw);
  const markdown = body.replace(/\s+$/, '') + '\n';
  const markdownBytes = Buffer.from(markdown, 'utf8');
  const title = meta.title || `${brandName()} Terms of Use`;
  const lastUpdated = meta.lastUpdated || '2026-09-19';
  const version = String(meta.version || '1');
  const filename = meta.filename || TERMS_PDF_FILENAME;
  const pdf = buildDeterministicPdf({
    title,
    lines: markdownToPdfLines(markdown, { skipTitle: title }),
    created: lastUpdated,
    // Fixed so the accepted-terms PDF hash does not change when the site is renamed.
    author: DEFAULT_BRAND_NAME,
  });
  const plainTextSha256 = sha256Hex(markdownBytes);
  return {
    title,
    version,
    lastUpdated,
    filename,
    markdown,
    markdownBytes,
    plainText: markdown,
    markdownSha256: plainTextSha256,
    plainTextSha256,
    pdf,
    pdfSha256: sha256Hex(pdf),
    hashOf: TERMS_HASH_OF,
    hashAlgo: TERMS_HASH_ALGO,
    blocks: markdownToBlocks(markdown),
    path: filePath,
  };
}

let cached = null;

export function getTermsDocument(options) {
  if (options?.filePath && options.filePath !== TERMS_MARKDOWN_PATH) {
    return loadTermsDocument(options);
  }
  if (!cached) cached = loadTermsDocument(options);
  return cached;
}

export function resetTermsCache() {
  cached = null;
}

export function publicTermsView(doc = getTermsDocument()) {
  return {
    nfp: true,
    title: doc.title,
    version: doc.version,
    lastUpdated: doc.lastUpdated,
    filename: doc.filename,
    hashAlgo: doc.hashAlgo,
    hashOf: doc.hashOf,
    pdfSha256: doc.pdfSha256,
    markdownSha256: doc.markdownSha256,
    plainTextSha256: doc.plainTextSha256,
    note: 'termsHash stored on accept is SHA-256 of the exact PDF bytes (the emailed attachment). plainTextSha256 (same bytes as markdownSha256) is SHA-256 of the UTF-8 /terms plain text after front matter. Sign-in stores that digest as termsNotifiedHash only after a successful SES send.',
    blocks: doc.blocks,
    markdown: doc.markdown,
  };
}

export function termsEmailBodies(doc) {
  const subject = `${brandName()} Terms of Use (PDF copy)`;
  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    `A PDF of the ${brandName()} Terms of Use you accepted is attached (${doc.filename}).`,
    '',
    `PDF SHA-256: ${doc.pdfSha256}`,
    `Markdown SHA-256: ${doc.markdownSha256}`,
    `Version: ${doc.version} · Last updated: ${doc.lastUpdated}`,
    '',
    'The recorded fingerprint is SHA-256 of the exact PDF bytes. Keep this message if you need to show which text you agreed to.',
    '',
    'If you did not accept these Terms, ignore this message.',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>A PDF of the ${escapeHtml(brandName())} Terms of Use you accepted is attached (<code>${doc.filename}</code>).</p>
<p>PDF SHA-256 (stored fingerprint):</p>
<p style="font-family:ui-monospace,monospace;font-size:0.85rem;word-break:break-all">${doc.pdfSha256}</p>
<p>Markdown SHA-256: <code>${doc.markdownSha256}</code></p>
<p>Version ${doc.version} · Last updated ${doc.lastUpdated}.</p>
<p style="color:#444">Civic public good. Not a commercial product. The recorded hash is of the exact PDF bytes.</p>
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function termsPageUrls(config = {}) {
  const base = String(config.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return { pageUrl: '/terms', pdfUrl: '/terms.pdf' };
  return { pageUrl: `${base}/terms`, pdfUrl: `${base}/terms.pdf` };
}

/**
 * Sign-in notice. The PDF is attached and the public /terms URL is in the body.
 * Sent once per member per plain-text hash.
 */
export function termsUpdatedEmailBodies(doc, { pageUrl = '/terms', pdfUrl = '/terms.pdf' } = {}) {
  const subject = `${brandName()} Terms of Use were updated`;
  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    `The ${brandName()} Terms of Use were updated. The current terms are attached as a PDF.`,
    '',
    `Read them: ${pageUrl}`,
    `PDF: ${pdfUrl}`,
    '',
    `Plain-text SHA-256: ${doc.plainTextSha256}`,
    `PDF SHA-256: ${doc.pdfSha256}`,
    `Version: ${doc.version} · Last updated: ${doc.lastUpdated}`,
    '',
    'This message is sent once for this text, the next time you sign in.',
  ].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en"><body style="font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.5;color:#111">
<p class="nfp" style="font-weight:700;letter-spacing:0.04em">NOT FOR PROFIT</p>
<p>The ${escapeHtml(brandName())} Terms of Use were updated. The current terms are attached as a PDF.</p>
<p><a href="${escapeHtml(pageUrl)}">Read the Terms of Use</a></p>
<p>PDF SHA-256: <code>${escapeHtml(doc.pdfSha256)}</code></p>
<p>Plain-text SHA-256: <code>${escapeHtml(doc.plainTextSha256)}</code></p>
<p>Version ${escapeHtml(doc.version)} · Last updated ${escapeHtml(doc.lastUpdated)}.</p>
<p style="color:#444">Civic public good. Not a commercial product. Sent once per version of this text.</p>
</body></html>`;
  return { subject, text, html };
}

function publicRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    action: row.action,
    userId: row.userId || null,
    handle: row.handle || null,
    emailHint: row.email ? String(row.email).replace(/^[^@]+/, (l) => `${l.slice(0, 1)}***`) : null,
    termsVersion: row.termsVersion,
    pdfSha256: row.pdfSha256,
    markdownSha256: row.markdownSha256,
    emailed: Boolean(row.emailed),
    emailedAt: row.emailedAt || null,
    source: row.source || null,
    createdAt: row.createdAt,
  };
}

/**
 * @param {{ store: import('./store.mjs').Store, mailer: ReturnType<typeof import('./mailer.mjs').createMailer>, config?: object }} deps
 */
export function createTermsService({ store, mailer, config = {}, getDocument = null }) {
  const inflight = new Map();

  function document() {
    return (getDocument || getTermsDocument)();
  }

  /**
   * On sign-in, email the current terms once per member per plain-text hash.
   * The stored hash and sent timestamp change only after SES (or the capture
   * mailer) accepts the message. A send failure leaves them unchanged and
   * does not throw, so sign-in can continue.
   */
  async function maybeNotifyTermsUpdated(user) {
    if (!user?.id) return { sent: false, reason: 'no_user' };
    const running = inflight.get(user.id);
    if (running) {
      await running;
      return maybeNotifyTermsUpdated(store.getUser(user.id) || user);
    }
    const job = deliverTermsUpdate(store.getUser(user.id) || user);
    inflight.set(user.id, job);
    try {
      return await job;
    } finally {
      inflight.delete(user.id);
    }
  }

  async function deliverTermsUpdate(user) {
    const account = user?.id ? store.getUser(user.id) || user : null;
    if (!account?.id) return { sent: false, reason: 'no_user' };
    const doc = document();
    const hash = doc.plainTextSha256;
    if (account.termsNotifiedHash === hash) {
      return { sent: false, reason: 'unchanged', plainTextSha256: hash };
    }
    const to = userEmail(account);
    if (!to) return { sent: false, reason: 'no_email', plainTextSha256: hash };
    if (!mailer) return { sent: false, reason: 'no_mailer', plainTextSha256: hash };

    const urls = termsPageUrls(config);
    const bodies = termsUpdatedEmailBodies(doc, urls);
    try {
      await mailer.send({
        to,
        ...bodies,
        attachments: [
          {
            filename: doc.filename,
            contentType: 'application/pdf',
            content: doc.pdf,
          },
        ],
        meta: {
          purpose: 'terms-updated',
          plainTextSha256: hash,
          pdfSha256: doc.pdfSha256,
          termsVersion: doc.version,
        },
      });
    } catch {
      console.warn(`[republic] terms-updated notice userId=${account.id} reason=send_failed`);
      return { sent: false, reason: 'send_failed', plainTextSha256: hash };
    }

    const now = new Date().toISOString();
    account.termsNotifiedHash = hash;
    account.termsNotifiedAt = now;
    try {
      await store.persist();
    } catch {
      console.warn(`[republic] terms-updated notice userId=${account.id} reason=persist_failed`);
    }
    return { sent: true, plainTextSha256: hash, termsNotifiedAt: account.termsNotifiedAt };
  }

  async function recordEvent({
    action,
    user = null,
    email = null,
    sessionId = null,
    source = null,
    emailPdf = false,
  }) {
    const kind = action === 'view' ? 'view' : 'accept';
    const doc = document();
    let to = null;
    if (email) {
      try {
        to = normalizeEmail(email);
      } catch {
        to = null;
      }
    }
    if (!to && user) to = userEmail(user);

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      action: kind,
      userId: user?.id || null,
      handle: user?.handle || null,
      email: to,
      sessionId: sessionId || null,
      termsVersion: doc.version,
      pdfSha256: doc.pdfSha256,
      markdownSha256: doc.markdownSha256,
      hashOf: TERMS_HASH_OF,
      source: source || null,
      emailed: false,
      emailedAt: null,
      createdAt: now,
    };

    if (kind === 'accept' && user) {
      user.termsHash = doc.pdfSha256;
      user.termsVersion = doc.version;
      user.termsMarkdownSha256 = doc.markdownSha256;
      user.termsAcceptedAt = now;
    }

    if (kind === 'accept' && emailPdf && to) {
      const already =
        user && user.termsEmailHash === doc.pdfSha256 && user.termsEmailSentAt;
      if (already) {
        row.emailSkipped = 'already_sent_this_hash';
      } else {
        const bodies = termsEmailBodies(doc);
        try {
          await mailer.send({
            to,
            ...bodies,
            attachments: [
              {
                filename: doc.filename,
                contentType: 'application/pdf',
                content: doc.pdf,
              },
            ],
            meta: {
              purpose: 'terms-pdf',
              pdfSha256: doc.pdfSha256,
              markdownSha256: doc.markdownSha256,
              termsVersion: doc.version,
            },
          });
          row.emailed = true;
          row.emailedAt = now;
          if (user) {
            user.termsEmailSentAt = now;
            user.termsEmailHash = doc.pdfSha256;
          }
        } catch (err) {
          if (Number(err.status) === 503) {
            row.emailSkipped = 'ses_unconfigured';
          } else {
            row.emailSkipped = 'send_failed';
          }
        }
      }
    } else if (kind === 'accept' && emailPdf && !to) {
      row.emailSkipped = 'no_email';
    }

    await store.addTermsRecord(row);
    return { record: row, document: doc };
  }

  async function accept({ user, email, sessionId, source, emailPdf = true }) {
    if (!user && !email) {
      throw new HttpError(400, 'sign in or provide an email to accept the Terms');
    }
    return recordEvent({
      action: 'accept',
      user,
      email,
      sessionId,
      source: source || 'accept',
      emailPdf,
    });
  }

  async function view({ user, sessionId, source }) {
    if (!user) return { record: null, document: document() };
    const doc = document();
    const recent = store
      .listTermsRecords({ userId: user.id, action: 'view' })
      .find((r) => r.pdfSha256 === doc.pdfSha256 && r.sessionId && r.sessionId === sessionId);
    if (recent) return { record: recent, document: doc };
    return recordEvent({
      action: 'view',
      user,
      sessionId,
      source: source || 'view',
      emailPdf: false,
    });
  }

  async function maybeAcceptNewPerson(user, { acceptedTerms, email, sessionId, source } = {}) {
    if (!user || !isAcceptedTermsFlag(acceptedTerms)) return null;
    if (user.termsHash === document().pdfSha256) return null;
    return accept({
      user,
      email: email || userEmail(user),
      sessionId,
      source: source || 'register',
      emailPdf: true,
    });
  }

  return {
    document,
    publicView: () => publicTermsView(document()),
    accept,
    view,
    maybeAcceptNewPerson,
    maybeNotifyTermsUpdated,
    publicRecord,
    vendor: 'ses',
    hashOf: TERMS_HASH_OF,
    config,
  };
}
