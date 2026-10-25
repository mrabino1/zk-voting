// NOT FOR PROFIT — civic public good, not a commercial product.
// Terms of Use: deterministic PDF SHA-256, acceptance log, SES PDF capture.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { buildRawMime } from '../src/mailer.mjs';
import {
  getTermsDocument,
  loadTermsDocument,
  parseFrontMatter,
  requireAcceptedTerms,
  resetTermsCache,
  sha256Hex,
} from '../src/terms.mjs';
import { HttpError } from '../src/http.mjs';

let tmp;
let app;
let store;
let mailer;
let server;
let base;
const jar = {};
const voterJar = {};

function applyCookies(res, cookieJar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    cookieJar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(cookieJar) {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar: cookieJar } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookieJar ? { cookie: cookieHeader(cookieJar) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (cookieJar) applyCookies(res, cookieJar);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, json, text, status: res.status };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function lastCode() {
  const hit = mailer.lastOtp();
  assert.ok(hit?.code, 'expected a captured OTP');
  return hit.code;
}

describe('terms document hashes', () => {
  test('canonical hash is SHA-256 of exact PDF bytes; markdown hash is published too', () => {
    resetTermsCache();
    const a = getTermsDocument();
    const b = loadTermsDocument();
    assert.equal(a.hashOf, 'pdf-bytes');
    assert.equal(a.hashAlgo, 'sha256');
    assert.match(a.pdfSha256, /^[0-9a-f]{64}$/);
    assert.match(a.markdownSha256, /^[0-9a-f]{64}$/);
    assert.equal(a.pdfSha256, b.pdfSha256);
    assert.equal(a.markdownSha256, b.markdownSha256);
    assert.equal(sha256Hex(a.pdf), a.pdfSha256);
    assert.equal(createHash('sha256').update(a.pdf).digest('hex'), a.pdfSha256);
    assert.equal(sha256Hex(a.markdownBytes), a.markdownSha256);
    assert.notEqual(a.pdfSha256, a.markdownSha256);
    assert.ok(a.pdf.length > 200);
    assert.equal(a.pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.match(a.markdown, /NOT FOR PROFIT/);
    assert.ok(a.blocks.some((block) => block.type === 'h1'));
  });

  test('changing markdown changes both hashes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-terms-src-'));
    const filePath = path.join(dir, 'terms.md');
    await writeFile(
      filePath,
      '---\nversion: 9\nlastUpdated: 2026-09-19\ntitle: Test Terms\nfilename: test.pdf\n---\n\n# Test\n\nAlpha.\n',
      'utf8',
    );
    const first = loadTermsDocument({ filePath });
    await writeFile(
      filePath,
      '---\nversion: 9\nlastUpdated: 2026-09-19\ntitle: Test Terms\nfilename: test.pdf\n---\n\n# Test\n\nBeta.\n',
      'utf8',
    );
    const second = loadTermsDocument({ filePath });
    assert.notEqual(first.pdfSha256, second.pdfSha256);
    assert.notEqual(first.markdownSha256, second.markdownSha256);
    await rm(dir, { recursive: true, force: true });
  });

  test('front matter is stripped from the hashed markdown body', () => {
    const { meta, body } = parseFrontMatter(
      '---\nversion: 1\ntitle: X\n---\n\n# Hello\n',
    );
    assert.equal(meta.version, '1');
    assert.equal(meta.title, 'X');
    assert.equal(body.trim(), '# Hello');
  });

  test('requireAcceptedTerms rejects missing flags', () => {
    assert.throws(() => requireAcceptedTerms({}), (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      assert.equal(err.extra.code, 'TERMS_REQUIRED');
      return true;
    });
    assert.equal(requireAcceptedTerms({ acceptedTerms: true }), true);
    assert.equal(requireAcceptedTerms({ acceptedTerms: 'yes' }), true);
  });

  test('SESv2 raw MIME carries a PDF attachment', () => {
    const pdf = getTermsDocument().pdf;
    const raw = buildRawMime({
      from: 'noreply@example.com',
      to: 'voter@example.com',
      subject: 'Terms',
      text: 'attached',
      html: '<p>attached</p>',
      attachments: [{ filename: 'zk-voting-terms.pdf', contentType: 'application/pdf', content: pdf }],
    });
    const mime = raw.toString('utf8');
    assert.match(mime, /multipart\/mixed/);
    assert.match(mime, /application\/pdf/);
    assert.match(mime, /filename="zk-voting-terms.pdf"/);
    assert.match(mime, /Content-Transfer-Encoding: base64/);
  });
});

describe('terms HTTP: public hashes, accept, view, SES capture', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-terms-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      requireEmailMfa: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /terms is the public SPA; GET /api/terms publishes both hashes without PII', async () => {
    const page = await api('GET', '/terms');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    assert.match(page.text, /NOT FOR PROFIT/);
    assert.match(page.text, /href="\/terms"/);

    const { status, json } = await api('GET', '/api/terms');
    assert.equal(status, 200);
    assert.equal(json.nfp, true);
    assert.equal(json.hashOf, 'pdf-bytes');
    assert.equal(json.hashAlgo, 'sha256');
    assert.match(json.pdfSha256, /^[0-9a-f]{64}$/);
    assert.match(json.markdownSha256, /^[0-9a-f]{64}$/);
    assert.equal(json.accepted, false);
    assert.equal(json.acceptance, null);
    assert.equal(json.emailMfaVendor, 'ses');
    assert.ok(Array.isArray(json.blocks) && json.blocks.length > 3);
    assert.ok(!JSON.stringify(json).includes('@example.com'));
  });

  test('GET /terms.pdf bytes match X-Pdf-SHA256 and the stored fingerprint', async () => {
    const doc = getTermsDocument();
    const res = await fetch(`${base}/terms.pdf`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /pdf/);
    assert.equal(res.headers.get('x-pdf-sha256'), doc.pdfSha256);
    assert.equal(res.headers.get('x-markdown-sha256'), doc.markdownSha256);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(sha256Hex(buf), doc.pdfSha256);
    assert.equal(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');

    const apiPdf = await fetch(`${base}/api/terms.pdf`);
    assert.equal(apiPdf.status, 200);
    assert.equal(apiPdf.headers.get('x-pdf-sha256'), doc.pdfSha256);
    const apiBuf = Buffer.from(await apiPdf.arrayBuffer());
    assert.equal(sha256Hex(apiBuf), doc.pdfSha256);
  });

  test('GET /api/config advertises terms hash-of-pdf-bytes', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.auth.terms.hashOf, 'pdf-bytes');
    assert.equal(json.auth.terms.path, '/terms');
    assert.equal(json.auth.terms.pdfPath, '/terms.pdf');
    assert.equal(json.auth.emailMfaVendor, 'ses');
  });

  test('POST /api/terms/accept unsigned is 401; missing flag is 400 TERMS_REQUIRED', async () => {
    const unsigned = await api('POST', '/api/terms/accept', {
      body: { acceptedTerms: true, email: 'spam@example.com' },
    });
    assert.equal(unsigned.status, 401);

    const login = await api('POST', '/api/auth/dev-login', {
      body: { handle: 'terms-voter', role: 'voter' },
      jar: voterJar,
    });
    assert.equal(login.status, 200, login.json?.error);

    const missing = await api('POST', '/api/terms/accept', {
      body: {},
      jar: voterJar,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'TERMS_REQUIRED');
  });

  test('new-person email register without acceptedTerms is TERMS_REQUIRED', async () => {
    const start = await api('POST', '/api/identity/email/start', {
      body: { email: 'no-terms@example.com', handle: 'no-terms' },
    });
    assert.equal(start.status, 400);
    assert.equal(start.json.code, 'TERMS_REQUIRED');
  });

  test('register + OTP records PDF SHA-256 and captures the SES PDF attachment', async () => {
    const before = mailer.sent.length;
    const start = await api('POST', '/api/identity/email/start', {
      body: { email: 'terms-alice@example.com', handle: 'terms-alice', acceptedTerms: true },
      jar,
    });
    assert.equal(start.status, 200, start.json?.error);
    assert.equal(start.json.mfaRequired, true);

    const verify = await api('POST', '/api/auth/mfa/verify', {
      body: { code: lastCode() },
      jar,
    });
    assert.equal(verify.status, 200, verify.json?.error);
    assert.equal(verify.json.user.handle, 'terms-alice');

    const doc = getTermsDocument();
    assert.equal(verify.json.user.termsHash, doc.pdfSha256);
    assert.equal(verify.json.user.termsVersion, doc.version);
    assert.ok(verify.json.user.termsAcceptedAt);
    assert.ok(verify.json.user.termsEmailSentAt);

    const captured = mailer.lastTermsPdf();
    assert.ok(captured, 'expected a captured terms-pdf message');
    assert.equal(captured.to, 'terms-alice@example.com');
    assert.equal(captured.meta.purpose, 'terms-pdf');
    assert.equal(captured.meta.pdfSha256, doc.pdfSha256);
    assert.equal(captured.attachments.length, 1);
    assert.equal(captured.attachments[0].filename, doc.filename);
    assert.equal(captured.attachments[0].contentType, 'application/pdf');
    assert.equal(captured.attachments[0].sha256, doc.pdfSha256);
    assert.equal(sha256Hex(captured.attachments[0].content), doc.pdfSha256);
    assert.ok(mailer.sent.length > before);

    const me = await api('GET', '/api/me', { jar });
    assert.equal(me.json.user.termsHash, doc.pdfSha256);

    const listed = store.listTermsRecords({ userId: me.json.user.id, action: 'accept' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].pdfSha256, doc.pdfSha256);
    assert.equal(listed[0].markdownSha256, doc.markdownSha256);
    assert.equal(listed[0].emailed, true);
    assert.equal(listed[0].hashOf, 'pdf-bytes');

    const disk = JSON.parse(await readFile(path.join(tmp, 'zk-voting.json'), 'utf8'));
    assert.ok(Array.isArray(disk.termsAcceptances));
    assert.equal(disk.termsAcceptances.length, 1);
    const person = disk.users.find((u) => u.handle === 'terms-alice');
    assert.equal(person.termsHash, doc.pdfSha256);
  });

  test('second accept of the same hash does not send another PDF', async () => {
    const before = mailer.sent.filter((m) => m.meta?.purpose === 'terms-pdf').length;
    const again = await api('POST', '/api/terms/accept', {
      body: { acceptedTerms: true, source: 'page' },
      jar,
    });
    assert.equal(again.status, 200, again.json?.error);
    assert.equal(again.json.ok, true);
    assert.equal(again.json.emailSkipped, 'already_sent_this_hash');
    assert.equal(again.json.emailed, false);
    const after = mailer.sent.filter((m) => m.meta?.purpose === 'terms-pdf').length;
    assert.equal(after, before);
  });

  test('signed-in GET view records once per session+hash', async () => {
    const first = await api('POST', '/api/terms/view', { body: {}, jar });
    assert.equal(first.status, 200);
    assert.equal(first.json.recorded, true);
    assert.equal(first.json.view.action, 'view');
    assert.equal(first.json.view.pdfSha256, getTermsDocument().pdfSha256);
    assert.ok(!String(first.json.view.emailHint || '').includes('terms-alice@example.com'));

    const second = await api('POST', '/api/terms/view', { body: {}, jar });
    assert.equal(second.status, 200);
    assert.equal(second.json.view.id, first.json.view.id);

    const publicView = await api('POST', '/api/terms/view', { body: {} });
    assert.equal(publicView.status, 200);
    assert.equal(publicView.json.recorded, false);

    const mine = await api('GET', '/api/terms', { jar });
    assert.equal(mine.json.accepted, true);
    assert.equal(mine.json.acceptance.pdfSha256, getTermsDocument().pdfSha256);
  });

  test('dev-login accept without an email still stores the hash', async () => {
    const doc = getTermsDocument();
    const accept = await api('POST', '/api/terms/accept', {
      body: { acceptedTerms: true },
      jar: voterJar,
    });
    assert.equal(accept.status, 200, accept.json?.error);
    assert.equal(accept.json.pdfSha256, doc.pdfSha256);
    assert.equal(accept.json.emailSkipped, 'no_email');
    const me = await api('GET', '/api/me', { jar: voterJar });
    assert.equal(me.json.user.termsHash, doc.pdfSha256);
  });
});
