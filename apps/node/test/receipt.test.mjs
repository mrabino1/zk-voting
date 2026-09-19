// NOT FOR PROFIT — civic public good, not a commercial product.
// Choice-free vote receipts: email body + PDF, paste-to-verify portal, hourly turnout.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import {
  RECEIPT_SCHEMA,
  formatReceiptProof,
  parseReceiptProof,
  receiptLines,
  buildReceiptPdf,
} from '../src/receipts.mjs';
import {
  decryptPdfStreams,
  pdfAllowsModify,
  readPdfEncryption,
} from '../src/pdf.mjs';
import { sha256Hex } from '../src/terms.mjs';

const HOUR = 3600;
const HOUR_START = 1_699_999_200;
const ZEBRA = 'ZEBRA-CANDIDATE-ALPHA';

let tmp;
let app;
let store;
let mailer;
let server;
let base;
let clock;
const adminJar = {};
const voterJar = {};

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function api(method, url, { body, jar, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(jar ? { cookie: cookieHeader(jar) } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) applyCookies(res, jar);
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

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function leakChoice(value, acc = []) {
  if (value == null) return acc;
  if (typeof value === 'string') {
    if (value.includes(ZEBRA) || /I voted for/i.test(value)) acc.push(value.slice(0, 80));
    return acc;
  }
  if (typeof value !== 'object') return acc;
  for (const [k, v] of Object.entries(value)) {
    if (/^(choice|optionId|optionIds|answers|selected|plaintext|ranking|candidate)$/i.test(k)) {
      acc.push(k);
    }
    leakChoice(v, acc);
  }
  return acc;
}

describe('receipt proof helpers', () => {
  test('format and parse round-trip; JSON also parses', () => {
    const text = formatReceiptProof({
      electionId: 'el-1',
      nullifier: '0xabc',
      ballotHash: '0xdef',
      token: 'tok_example_token_value_32bytes____',
      acceptedAt: HOUR_START + 90,
    });
    assert.match(text, /BEGIN REPUBLIC VOTE RECEIPT/);
    const parsed = parseReceiptProof(text);
    assert.equal(parsed.schema, RECEIPT_SCHEMA);
    assert.equal(parsed.electionId, 'el-1');
    assert.equal(parsed.nullifier, '0xabc');
    assert.equal(parsed.ballotHash, '0xdef');
    assert.equal(parsed.token, 'tok_example_token_value_32bytes____');
    const fromJson = parseReceiptProof(
      JSON.stringify({ schema: RECEIPT_SCHEMA, token: parsed.token, ballotHash: '0xdef' }),
    );
    assert.equal(fromJson.token, parsed.token);
  });

  test('PDF lines never include a marked option', () => {
    const lines = receiptLines({
      election: { id: 'el-1', title: 'Town poll', jurisdictionId: 'demo', shortCode: 'abc' },
      vote: {
        electionId: 'el-1',
        nullifier: '0x' + 'ab'.repeat(32),
        ballotHash: '0x' + 'cd'.repeat(32),
        relayer: 'node',
        acceptedAt: HOUR_START + 90,
      },
      token: 'holder-token',
      published: false,
      nextPublishAt: HOUR_START + HOUR,
      includeToken: true,
    });
    const blob = lines.join('\n');
    assert.match(blob, /Ballot hash/);
    assert.match(blob, /does not list which option/);
    assert.match(blob, /locked against modification/);
    assert.doesNotMatch(blob, new RegExp(ZEBRA));
    assert.doesNotMatch(blob, /I voted for/i);
    const { pdf, pdfSha256, pdfProtected, integrity } = buildReceiptPdf({
      election: { id: 'el-1', title: 'Town poll', jurisdictionId: 'demo' },
      vote: {
        electionId: 'el-1',
        nullifier: '0x' + 'ab'.repeat(32),
        ballotHash: '0x' + 'cd'.repeat(32),
        acceptedAt: HOUR_START + 90,
      },
      token: 'holder-token',
      hmacSecret: 'unit-receipt-pdf-secret',
    });
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(sha256Hex(pdf), pdfSha256);
    assert.equal(pdfProtected, true);
    assert.ok(integrity);
    const enc = readPdfEncryption(pdf);
    assert.ok(enc);
    assert.equal(pdfAllowsModify(enc.permissions), false);
    assert.doesNotMatch(pdf.toString('latin1'), new RegExp(ZEBRA));
    assert.doesNotMatch(pdf.toString('latin1'), /holder-token/);
    const opened = decryptPdfStreams(pdf, '')
      .map((s) => s.text)
      .join('\n');
    assert.match(opened, /holder-token/);
    assert.match(opened, /locked against modification/);
    assert.doesNotMatch(opened, new RegExp(ZEBRA));
  });
});

describe('email receipt, PDF, and verify portal', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-receipt-'));
    clock = HOUR_START + 90;
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: HOUR,
      nowFn: () => clock,
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', {
      body: { handle: 'receipt-voter', role: 'voter', email: 'voter@example.org' },
      jar: voterJar,
    });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  async function openElection() {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title: 'Receipt contest',
        startTime: clock - 10,
        cutoffTime: clock + 86400,
        treeDepth: 16,
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Adopt the sample ordinance?',
            options: [
              { id: 'yes', label: ZEBRA },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await api('POST', `/api/elections/${id}/register`, {
      jar: voterJar,
      body: { identityCommitment: '0xca11' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    return id;
  }

  test('GET /receipt is the public SPA; config advertises the portal', async () => {
    const page = await api('GET', '/receipt');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
    assert.match(page.text, /NOT FOR PROFIT/);
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.receipts.proveChoice, false);
    assert.equal(cfg.json.receipts.verifyPath, '/receipt');
    assert.equal(cfg.json.receipts.pdfProtected, true);
    assert.equal(cfg.json.receipts.pdfModify, false);
    assert.equal(cfg.json.coercion.receiptsProveChoice, false);
  });

  test('vote returns a holder receipt; email body+PDF omit the marked option', async () => {
    const id = await openElection();
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca11',
        choice: 0,
        optionId: 'yes',
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);
    assert.equal(voted.json.published, false);
    const receipt = voted.json.receipt;
    assert.equal(receipt.schema, RECEIPT_SCHEMA);
    assert.equal(receipt.receiptsProveChoice, false);
    assert.ok(receipt.token);
    assert.match(receipt.pdfSha256, /^[0-9a-f]{64}$/);
    assert.equal(receipt.pdfProtected, true);
    assert.equal(receipt.pdfModify, false);
    assert.match(receipt.proofText, /BEGIN REPUBLIC VOTE RECEIPT/);
    assert.equal(leakChoice(receipt).join(','), '');
    assert.equal(voted.json.vote.choice, undefined);

    const noToken = await api('POST', '/api/receipts/email', {
      body: { email: 'voter@example.org', nullifier: receipt.nullifier, ballotHash: receipt.ballotHash },
    });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, 'RECEIPT_TOKEN_REQUIRED');

    const emailed = await api('POST', '/api/receipts/email', {
      body: { token: receipt.token, email: 'voter@example.org' },
    });
    assert.equal(emailed.status, 200, emailed.json?.error);
    assert.equal(emailed.json.emailed, true);
    assert.equal(emailed.json.receiptsProveChoice, false);
    const captured = mailer.lastVoteReceipt();
    assert.ok(captured);
    assert.equal(captured.to, 'voter@example.org');
    assert.match(captured.subject, /not your choices/i);
    assert.match(captured.text, /BEGIN REPUBLIC VOTE RECEIPT/);
    assert.match(captured.html, /BEGIN REPUBLIC VOTE RECEIPT/);
    assert.equal(captured.attachments.length, 1);
    assert.equal(captured.attachments[0].contentType, 'application/pdf');
    assert.equal(captured.attachments[0].sha256, emailed.json.pdfSha256);
    const pdfLatin = captured.attachments[0].content.toString('latin1');
    assert.match(pdfLatin, /%PDF-/);
    assert.match(pdfLatin, /\/Filter \/Standard/);
    assert.doesNotMatch(captured.text, new RegExp(ZEBRA));
    assert.doesNotMatch(captured.html, new RegExp(ZEBRA));
    assert.doesNotMatch(pdfLatin, new RegExp(ZEBRA));
    assert.doesNotMatch(pdfLatin, new RegExp(String(receipt.token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(captured.text, /I voted for/i);
    assert.match(captured.text, /locked against modification/i);
    assert.equal(emailed.json.pdfProtected, true);

    const pdf = await api('POST', '/api/receipts/pdf', { body: { token: receipt.token } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.res.headers.get('content-type') || '', /pdf/);
    assert.equal(pdf.res.headers.get('x-pdf-sha256'), emailed.json.pdfSha256);
    assert.equal(pdf.res.headers.get('x-pdf-protected'), 'true');
    assert.equal(pdf.res.headers.get('x-pdf-modify'), 'false');
    assert.equal(pdf.res.headers.get('x-receipts-prove-choice'), 'false');
    const pdfBuf = Buffer.from(captured.attachments[0].content);
    assert.equal(sha256Hex(pdfBuf), emailed.json.pdfSha256);
    const enc = readPdfEncryption(pdfBuf);
    assert.ok(enc);
    assert.equal(pdfAllowsModify(enc.permissions), false);

    const byPdf = await api('POST', '/api/receipts/verify', {
      body: { pdf: pdfBuf.toString('base64') },
    });
    assert.equal(byPdf.status, 200, byPdf.json?.error);
    assert.equal(byPdf.json.counted, true);
    assert.equal(byPdf.json.pdfUnmodified, true);
    assert.equal(byPdf.json.pdfProtected, true);

    const tampered = Buffer.from(pdfBuf);
    tampered[tampered.length - 30] ^= 0xff;
    const badPdf = await api('POST', '/api/receipts/verify', {
      body: { token: receipt.token, pdf: tampered.toString('base64') },
    });
    assert.equal(badPdf.status, 200, badPdf.json?.error);
    assert.equal(badPdf.json.counted, true);
    assert.equal(badPdf.json.pdfUnmodified, false);

    const onlyBad = await api('POST', '/api/receipts/verify', {
      body: { pdf: tampered.toString('base64') },
    });
    assert.equal(onlyBad.status, 404);

    const pendingHash = await api('POST', '/api/receipts/verify', {
      body: { nullifier: receipt.nullifier, ballotHash: receipt.ballotHash, electionId: id },
    });
    assert.equal(pendingHash.status, 404, 'public hash lookup must wait for disclosure');

    const withToken = await api('POST', '/api/receipts/verify', { body: { proof: receipt.proofText } });
    assert.equal(withToken.status, 200, withToken.json?.error);
    assert.equal(withToken.json.counted, true);
    assert.equal(withToken.json.published, false);
    assert.equal(withToken.json.receiptsProveChoice, false);
    assert.equal(withToken.json.metrics.acceptedBallotsDisclosed, 0);
    assert.equal(leakChoice(withToken.json).join(','), '');

    const metricsLive = await api('GET', `/api/receipts/metrics?electionId=${encodeURIComponent(id)}`);
    assert.equal(metricsLive.json.acceptedBallotsDisclosed, 0);
    assert.equal(metricsLive.json.hours.length, 0);
    assert.ok(!('acceptedBallotsActual' in metricsLive.json));
    assert.ok(!('pending' in metricsLive.json));

    clock = HOUR_START + HOUR;
    const after = await api('POST', '/api/receipts/verify', {
      body: { nullifier: receipt.nullifier, ballotHash: receipt.ballotHash, electionId: id },
    });
    assert.equal(after.status, 200, after.json?.error);
    assert.equal(after.json.counted, true);
    assert.equal(after.json.published, true);
    assert.equal(after.json.acceptedAt, null, 'public hash lookup must not echo intra-hour acceptedAt');
    assert.ok(after.json.disclosureHourClosedAt);
    assert.equal(after.json.metrics.acceptedBallotsDisclosed, 1);
    assert.equal(after.json.metrics.hours.length, 1);
    assert.equal(after.json.metrics.hours[0].ballots, 1);
    assert.equal(leakChoice(after.json).join(','), '');
  });
});

describe('instant disclosure still hides choice on receipts', () => {
  let localTmp;
  let localServer;
  let localBase;
  const localAdmin = {};
  const localVoter = {};
  let localMailer;

  before(async () => {
    localTmp = await mkdtemp(path.join(os.tmpdir(), 'republic-receipt-0-'));
    const created = await createApp({
      dataDir: localTmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    localMailer = created.mailer;
    localServer = await listen(created.app);
    localBase = `http://127.0.0.1:${localServer.address().port}`;
    const call = async (method, url, { body, jar } = {}) => {
      const res = await fetch(localBase + url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(jar ? { cookie: cookieHeader(jar) } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (jar) applyCookies(res, jar);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    };
    await call('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: localAdmin });
    await call('POST', '/api/auth/dev-login', { body: { handle: 'v', role: 'voter' }, jar: localVoter });
    const createdEl = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Instant',
        startTime: nowSec() - 10,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'X?', options: [{ id: 'yes', label: ZEBRA }, { id: 'no', label: 'No' }] }],
      },
    });
    const id = createdEl.json.id;
    await call('POST', `/api/elections/${id}/register`, {
      jar: localVoter,
      body: { identityCommitment: '0x1' },
    });
    await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    const voted = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '7', electionId: id },
        encryptedBallot: '0x99',
        identityCommitment: '0x1',
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);
    const emailed = await call('POST', '/api/receipts/email', {
      body: { token: voted.json.receipt.token, email: 'copy@example.org' },
    });
    assert.equal(emailed.status, 200, emailed.json?.error);
    const captured = localMailer.lastVoteReceipt();
    assert.doesNotMatch(captured.text, new RegExp(ZEBRA));
    const verified = await call('POST', '/api/receipts/verify', { body: { proof: voted.json.receipt.proofText } });
    assert.equal(verified.json.counted, true);
    assert.equal(verified.json.published, true);
    assert.equal(leakChoice(verified.json).join(','), '');
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      localServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(localTmp, { recursive: true, force: true });
  });

  test('placeholder so after() runs', () => {
    assert.ok(localMailer.lastVoteReceipt());
  });
});
