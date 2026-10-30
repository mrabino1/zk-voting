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
  receiptEmailBodies,
  buildReceiptPdf,
  hashReceiptToken,
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

async function request(baseUrl, method, url, { body, jar, headers } = {}) {
  const res = await fetch(baseUrl + url, {
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

function api(method, url, opts) {
  return request(base, method, url, opts);
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
    assert.match(text, /BEGIN ZK-VOTING VOTE RECEIPT/);
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
    assert.match(blob, /ballot was accepted/);
    assert.doesNotMatch(blob, /was counted/);
    const mailed = receiptEmailBodies({
      election: { id: 'el-1', title: 'Town poll' },
      vote: { electionId: 'el-1' },
      token: 'holder-token',
    });
    assert.match(mailed.text, /ballot was accepted/);
    assert.match(mailed.html, /ballot was accepted/);
    assert.doesNotMatch(mailed.text, /was counted/);
    assert.doesNotMatch(mailed.html, /was counted/);
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
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-receipt-'));
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
      jar: adminJar,
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
    assert.match(receipt.proofText, /BEGIN ZK-VOTING VOTE RECEIPT/);
    assert.equal(leakChoice(receipt).join(','), '');
    assert.equal(voted.json.vote.choice, undefined);

    const noToken = await api('POST', '/api/receipts/email', {
      body: { email: 'voter@example.org', nullifier: receipt.nullifier, ballotHash: receipt.ballotHash },
    });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, 'RECEIPT_TOKEN_REQUIRED');

    const notOptedIn = await api('POST', '/api/receipts/email', {
      body: { token: receipt.token, email: 'voter@example.org' },
    });
    assert.equal(notOptedIn.status, 400);
    assert.equal(notOptedIn.json.code, 'EMAIL_OPT_IN_REQUIRED');
    const noAddress = await api('POST', '/api/receipts/email', {
      jar: voterJar,
      body: { token: receipt.token, optIn: true },
    });
    assert.equal(noAddress.status, 400);
    assert.equal(noAddress.json.code, 'EMAIL_REQUIRED');

    const emailed = await api('POST', '/api/receipts/email', {
      body: { token: receipt.token, email: 'voter@example.org', optIn: true },
    });
    assert.equal(emailed.status, 200, emailed.json?.error);
    assert.equal(emailed.json.emailed, true);
    assert.equal(emailed.json.receiptsProveChoice, false);
    const captured = mailer.lastVoteReceipt();
    assert.ok(captured);
    assert.equal(captured.to, 'voter@example.org');
    assert.match(captured.subject, /not your choices/i);
    assert.match(captured.text, /BEGIN ZK-VOTING VOTE RECEIPT/);
    assert.match(captured.html, /BEGIN ZK-VOTING VOTE RECEIPT/);
    // Thin, opt-in email: token only. No attachment, nullifier, ballot hash.
    assert.equal(captured.attachments.length, 0);
    const mailDump = JSON.stringify({ text: captured.text, html: captured.html, meta: captured.meta });
    for (const handle of [receipt.nullifier, receipt.ballotHash]) {
      assert.ok(handle);
      assert.equal(mailDump.toLowerCase().includes(String(handle).toLowerCase()), false, `email leaks ${handle}`);
    }
    assert.doesNotMatch(mailDump, /nullifier:|ballotHash:|userOpHash:/);
    assert.equal(captured.meta.nullifier, undefined);
    assert.equal(captured.meta.ballotHash, undefined);
    assert.doesNotMatch(captured.text, new RegExp(ZEBRA));
    assert.doesNotMatch(captured.html, new RegExp(ZEBRA));
    assert.doesNotMatch(captured.text, /I voted for/i);
    // Nothing about the send is stored with the receipt row.
    const row = store.findReceiptByTokenHash(hashReceiptToken(receipt.token));
    assert.equal(row.emailHint, undefined);
    assert.equal(row.emailedAt, undefined);
    assert.equal(row.userOpHash, undefined);

    const pdf = await api('POST', '/api/receipts/pdf', { body: { token: receipt.token } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.res.headers.get('content-type') || '', /pdf/);
    assert.equal(pdf.res.headers.get('x-pdf-sha256'), receipt.pdfSha256);
    assert.equal(pdf.res.headers.get('x-pdf-protected'), 'true');
    assert.equal(pdf.res.headers.get('x-pdf-modify'), 'false');
    assert.equal(pdf.res.headers.get('x-receipts-prove-choice'), 'false');
    const rawPdf = await fetch(base + '/api/receipts/pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: receipt.token }),
    });
    const pdfBuf = Buffer.from(await rawPdf.arrayBuffer());
    assert.equal(sha256Hex(pdfBuf), receipt.pdfSha256);
    const pdfLatin = pdfBuf.toString('latin1');
    assert.match(pdfLatin, /%PDF-/);
    assert.match(pdfLatin, /\/Filter \/Standard/);
    assert.doesNotMatch(pdfLatin, new RegExp(ZEBRA));
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
    localTmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-receipt-0-'));
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
      jar: localAdmin,
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
      body: { token: voted.json.receipt.token, email: 'copy@example.org', optIn: true },
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

describe('re-vote receipt lookup', () => {
  let localTmp;
  let localApp;
  let localStore;
  let localVotePass;
  let localServer;
  let localBase;
  let localClock;
  const localAdmin = {};

  function call(method, url, opts) {
    return request(localBase, method, url, opts);
  }

  before(async () => {
    localTmp = await mkdtemp(path.join(os.tmpdir(), 'poll-blocks-'));
    localClock = HOUR_START + 90;
    const created = await createApp({
      dataDir: localTmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: HOUR,
      disclosureDelaySeconds: 0,
      resultsMinVotes: 0,
      disclosureMinBlockVotes: 1,
      nowFn: () => localClock,
    });
    localApp = created.app;
    localStore = created.store;
    localVotePass = created.votePass;
    localServer = await listen(localApp);
    localBase = `http://127.0.0.1:${localServer.address().port}`;
    await call('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: localAdmin });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      localServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(localTmp, { recursive: true, force: true });
  });

  async function pdfBytes(token) {
    const res = await fetch(localBase + '/api/receipts/pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    assert.equal(res.status, 200);
    return Buffer.from(await res.arrayBuffer());
  }

  test('token and hash checks use that receipt, and the PDF follows the ballot hash', async () => {
    const created = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Receipt re-vote',
        startTime: localClock - 10,
        cutoffTime: localClock + 86400,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the sample ordinance?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await call('POST', `/api/elections/${id}/register`, {
      jar: localAdmin,
      body: { identityCommitment: '0xca11' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const pass = await localVotePass.mintForTest(id);

    const first = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca11',
        votePass: pass,
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    const second = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x02',
        identityCommitment: '0xca11',
        votePass: pass,
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    const firstHash = first.json.vote.ballotHash;
    const secondHash = second.json.receipt.ballotHash;
    assert.equal(second.json.vote.ballotHash, firstHash);
    const nullifier = first.json.vote.nullifier;
    assert.notEqual(secondHash, firstHash);
    assert.equal(second.json.receipt.ballotHash, secondHash);

    const byFirstToken = await call('POST', '/api/receipts/verify', { body: { token: first.json.receipt.token } });
    assert.equal(byFirstToken.status, 200, byFirstToken.json?.error);
    assert.equal(byFirstToken.json.counted, true);
    assert.equal(byFirstToken.json.ballotHash, firstHash);

    const bySecondToken = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(bySecondToken.status, 200, bySecondToken.json?.error);
    assert.equal(bySecondToken.json.counted, true);
    assert.equal(bySecondToken.json.accepted, true);
    assert.equal(bySecondToken.json.ballotHash, secondHash);
    assert.equal(bySecondToken.json.published, false);
    assert.equal(bySecondToken.json.replacement, true);
    assert.equal(bySecondToken.json.inFinalTally, false);
    assert.equal(bySecondToken.json.explorerUrl, null);
    assert.equal(byFirstToken.json.replacement, false);
    assert.equal(byFirstToken.json.counted, bySecondToken.json.counted);
    assert.equal(byFirstToken.json.accepted, bySecondToken.json.accepted);
    assert.equal(byFirstToken.json.counted, true);
    assert.equal(bySecondToken.json.accepted, true);
    assert.equal(
      bySecondToken.json.note,
      'Your replacement ballot was accepted. It will appear in the final tally, not in an hourly block.',
    );
    assert.equal(bySecondToken.json.nextPublishAt, null);
    assert.notEqual(byFirstToken.json.note, bySecondToken.json.note);

    const pendingCurrent = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(pendingCurrent.status, 404);
    assert.equal(pendingCurrent.json.counted, false);

    const firstPdf = await pdfBytes(first.json.receipt.token);
    const secondPdf = await pdfBytes(second.json.receipt.token);
    const rows = (localStore.data.receipts || []).filter((row) => String(row.electionId) === String(id));
    const firstRow = rows.find((row) => row.ballotHash === firstHash);
    const secondRow = rows.find((row) => row.ballotHash === secondHash);
    assert.ok(firstRow && secondRow);
    assert.notEqual(firstRow.pdfSha256, secondRow.pdfSha256);
    const others = (localStore.data.receipts || []).filter((row) => String(row.electionId) !== String(id));
    localStore.data.receipts = [secondRow, firstRow, ...others];
    assert.equal(localStore.findReceiptForVote(id, nullifier, firstHash).ballotHash, firstHash);
    assert.equal(localStore.findReceiptForVote(id, nullifier, secondHash).ballotHash, secondHash);
    assert.equal(localStore.findReceiptForVote(id, nullifier, firstHash).pdfSha256, firstRow.pdfSha256);
    assert.equal(localStore.findReceiptForVote(id, nullifier, secondHash).pdfSha256, secondRow.pdfSha256);

    localClock = HOUR_START + HOUR;
    const bySecondHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(bySecondHash.status, 404);
    assert.equal(bySecondHash.json.counted, false);

    const firstFile = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: firstHash, electionId: id, pdf: firstPdf.toString('base64') },
    });
    assert.equal(firstFile.status, 200, firstFile.json?.error);
    assert.equal(firstFile.json.ballotHash, firstHash);
    assert.equal(firstFile.json.pdfUnmodified, true);

    const crossed = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: firstHash, electionId: id, pdf: secondPdf.toString('base64') },
    });
    assert.equal(crossed.status, 200, crossed.json?.error);
    assert.equal(crossed.json.pdfUnmodified, false);

    await localStore.setTally(id, [0, 1]);
    const secondFile = await call('POST', '/api/receipts/verify', {
      body: { token: second.json.receipt.token, pdf: secondPdf.toString('base64') },
    });
    assert.equal(secondFile.status, 200, secondFile.json?.error);
    assert.equal(secondFile.json.published, false);
    assert.equal(secondFile.json.inFinalTally, true);
    assert.equal(secondFile.json.replacement, true);
    assert.equal(secondFile.json.explorerUrl, null);
    assert.equal(secondFile.json.ballotHash, secondHash);
    assert.equal(secondFile.json.pdfUnmodified, true);
    assert.equal(
      secondFile.json.note,
      'Your replacement ballot is counted in the final tally. The receipt still cannot prove which option was marked.',
    );
    const secondByHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id, pdf: secondPdf.toString('base64') },
    });
    assert.equal(secondByHash.status, 200, secondByHash.json?.error);
    assert.deepEqual(secondByHash.json, secondFile.json);
    const hashOnly = await call('POST', '/api/receipts/verify', {
      body: { ballotHash: secondHash, electionId: id },
    });
    assert.equal(hashOnly.status, 404);
    assert.equal(hashOnly.json.counted, false);
    const wrongNullifier = `0x${'11'.repeat(32)}`;
    assert.notEqual(wrongNullifier, nullifier);
    const wrong = await call('POST', '/api/receipts/verify', {
      body: { nullifier: wrongNullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(wrong.status, 404);
    assert.equal(wrong.json.counted, false);

    const byNullifier = await call('POST', '/api/receipts/verify', {
      body: { nullifier, electionId: id, pdf: firstPdf.toString('base64') },
    });
    assert.equal(byNullifier.status, 200, byNullifier.json?.error);
    assert.equal(byNullifier.json.ballotHash, firstHash);
    assert.equal(byNullifier.json.pdfUnmodified, true);
  });

  test('a vote replacement stays unpublished and joins the final tally after the seal lifts', async () => {
    localClock = HOUR_START + 90;
    const cutoff = HOUR_START + 3 * HOUR;
    const created = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Receipt re-vote vote',
        startTime: localClock - 10,
        cutoffTime: cutoff,
        treeDepth: 16,
        electionType: 1,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the sample ordinance?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    assert.equal(created.json.election.electionType, 1);
    const id = created.json.id;
    const reg = await call('POST', `/api/elections/${id}/register`, {
      jar: localAdmin,
      body: { identityCommitment: '0xca33' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const pass = await localVotePass.mintForTest(id);
    const first = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xcee', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca33',
        votePass: pass,
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    const second = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xcee', electionId: id },
        encryptedBallot: '0x02',
        identityCommitment: '0xca33',
        votePass: pass,
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    const firstHash = first.json.vote.ballotHash;
    const secondHash = second.json.receipt.ballotHash;
    assert.equal(second.json.vote.ballotHash, firstHash);
    const nullifier = first.json.vote.nullifier;
    assert.notEqual(secondHash, firstHash);

    const before = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(before.status, 200, before.json?.error);
    assert.equal(before.json.published, false);
    assert.equal(before.json.replacement, true);
    assert.equal(before.json.inFinalTally, false);
    assert.equal(before.json.explorerUrl, null);
    assert.equal(
      before.json.note,
      'Your replacement ballot was accepted. It will appear in the final tally, not in an hourly block.',
    );
    const beforeHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(beforeHash.status, 404);

    await localStore.setTally(id, [0, 1]);
    const sealed = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(sealed.status, 200, sealed.json?.error);
    assert.equal(sealed.json.published, false);
    assert.equal(sealed.json.inFinalTally, false);
    assert.equal(sealed.json.replacement, true);
    const sealedHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(sealedHash.status, 404);

    localClock = cutoff;
    const holder = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(holder.status, 200, holder.json?.error);
    assert.equal(holder.json.published, false);
    assert.equal(holder.json.inFinalTally, true);
    assert.equal(holder.json.replacement, true);
    assert.equal(holder.json.explorerUrl, null);
    assert.equal(holder.json.ballotHash, secondHash);
    assert.equal(
      holder.json.note,
      'Your replacement ballot is counted in the final tally. The receipt still cannot prove which option was marked.',
    );
    const byHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(byHash.status, 200, byHash.json?.error);
    assert.deepEqual(byHash.json, holder.json);
    assert.equal(JSON.stringify(byHash.json).includes(firstHash), false);
  });
});

describe('re-vote receipt uses its own hour', () => {
  const DELAY = 1800;
  const H = HOUR_START;
  const H1 = H + HOUR;
  const H2 = H + 2 * HOUR;
  let localTmp;
  let localStore;
  let localVotePass;
  let localServer;
  let localBase;
  let localClock;
  const localAdmin = {};

  function call(method, url, opts) {
    return request(localBase, method, url, opts);
  }

  before(async () => {
    localTmp = await mkdtemp(path.join(os.tmpdir(), 'poll-blocks-'));
    localClock = H + 90;
    const created = await createApp({
      dataDir: localTmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: HOUR,
      disclosureDelaySeconds: DELAY,
      resultsMinVotes: 0,
      disclosureMinBlockVotes: 1,
      nowFn: () => localClock,
    });
    localStore = created.store;
    localVotePass = created.votePass;
    localServer = await listen(created.app);
    localBase = `http://127.0.0.1:${localServer.address().port}`;
    await call('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: localAdmin });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      localServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(localTmp, { recursive: true, force: true });
  });

  test('a replacement stays unpublished through H+2 plus 30 minutes and counts in the final tally', async () => {
    const created = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Receipt hours',
        startTime: H - 10,
        cutoffTime: H2 + DELAY + 86400,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the sample ordinance?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await call('POST', `/api/elections/${id}/register`, {
      jar: localAdmin,
      body: { identityCommitment: '0xca11' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const pass = await localVotePass.mintForTest(id);

    const first = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca11',
        votePass: pass,
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    localClock = H1 + 90;
    const second = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x02',
        identityCommitment: '0xca11',
        votePass: pass,
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    const firstHash = first.json.vote.ballotHash;
    const secondHash = second.json.receipt.ballotHash;
    assert.equal(second.json.vote.ballotHash, firstHash);
    const nullifier = first.json.vote.nullifier;
    assert.notEqual(secondHash, firstHash);
    const rows = (localStore.data.receipts || []).filter((row) => String(row.electionId) === String(id));
    const firstRow = rows.find((row) => row.ballotHash === firstHash);
    const secondRow = rows.find((row) => row.ballotHash === secondHash);
    assert.equal(firstRow.acceptedAt, H);
    assert.equal(secondRow.acceptedAt, H1);

    localClock = H1 + DELAY;
    const early = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(early.status, 200, early.json?.error);
    assert.equal(early.json.published, false);
    assert.equal(early.json.counted, true);
    assert.equal(early.json.accepted, true);
    assert.equal(early.json.ballotHash, secondHash);
    assert.equal(early.json.acceptedAt, secondRow.acceptedAt);
    assert.equal(early.json.acceptedAtIso, new Date(secondRow.acceptedAt * 1000).toISOString());
    assert.equal(early.json.disclosureHourClosedAt, null);
    const earlyHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(earlyHash.status, 404);
    assert.equal(earlyHash.json.counted, false);

    const firstNow = await call('POST', '/api/receipts/verify', { body: { token: first.json.receipt.token } });
    assert.equal(firstNow.status, 200, firstNow.json?.error);
    assert.equal(firstNow.json.published, true);
    assert.equal(firstNow.json.counted, early.json.counted);
    assert.equal(firstNow.json.accepted, early.json.accepted);
    assert.equal(firstNow.json.acceptedAt, firstRow.acceptedAt);
    assert.notEqual(firstNow.json.acceptedAt, early.json.acceptedAt);

    localClock = H2;
    const atHourClose = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(atHourClose.status, 200, atHourClose.json?.error);
    assert.equal(atHourClose.json.published, false);
    assert.equal(atHourClose.json.counted, true);
    assert.equal(atHourClose.json.accepted, true);

    localClock = H2 + DELAY;
    const atDelay = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(atDelay.status, 200, atDelay.json?.error);
    assert.equal(atDelay.json.published, false);
    assert.equal(atDelay.json.counted, true);
    assert.equal(atDelay.json.accepted, true);
    assert.equal(atDelay.json.ballotHash, secondHash);
    assert.equal(atDelay.json.acceptedAt, secondRow.acceptedAt);
    assert.equal(atDelay.json.acceptedAtIso, new Date(secondRow.acceptedAt * 1000).toISOString());
    assert.equal(atDelay.json.nextPublishAt, null);
    assert.equal(atDelay.json.disclosureHourClosedAt, null);
    assert.equal(atDelay.json.replacement, true);
    assert.equal(atDelay.json.inFinalTally, false);
    assert.equal(atDelay.json.explorerUrl, null);
    assert.equal(
      atDelay.json.note,
      'Your replacement ballot was accepted. It will appear in the final tally, not in an hourly block.',
    );
    const delayedHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(delayedHash.status, 404);
    assert.equal(delayedHash.json.counted, false);

    await localStore.setTally(id, [0, 1]);
    const open = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(open.status, 200, open.json?.error);
    assert.equal(open.json.published, false);
    assert.equal(open.json.inFinalTally, true);
    assert.equal(open.json.replacement, true);
    assert.equal(open.json.explorerUrl, null);
    assert.equal(open.json.counted, true);
    assert.equal(open.json.accepted, true);
    assert.equal(open.json.ballotHash, secondHash);
    assert.equal(open.json.acceptedAt, secondRow.acceptedAt);
    assert.equal(open.json.acceptedAtIso, new Date(secondRow.acceptedAt * 1000).toISOString());
    assert.equal(open.json.nextPublishAt, null);
    assert.equal(
      open.json.note,
      'Your replacement ballot is counted in the final tally. The receipt still cannot prove which option was marked.',
    );
    const byHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: secondHash, electionId: id },
    });
    assert.equal(byHash.status, 200, byHash.json?.error);
    assert.deepEqual(byHash.json, open.json);
  });

  test('the explorer row after the final tally does not expose the replacement hash', async () => {
    localClock = H + 90;
    const created = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Explorer replacement',
        startTime: H - 10,
        cutoffTime: H2 + DELAY + 86400,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the sample ordinance?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await call('POST', `/api/elections/${id}/register`, {
      jar: localAdmin,
      body: { identityCommitment: '0xca22' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const pass = await localVotePass.mintForTest(id);
    const first = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xbee', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca22',
        votePass: pass,
      },
    });
    assert.equal(first.status, 201, first.json?.error);
    localClock = H1 + 90;
    const second = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xbee', electionId: id },
        encryptedBallot: '0x02',
        identityCommitment: '0xca22',
        votePass: pass,
      },
    });
    assert.equal(second.status, 201, second.json?.error);
    const firstHash = first.json.vote.ballotHash;
    const secondHash = second.json.receipt.ballotHash;
    assert.equal(second.json.vote.ballotHash, firstHash);
    const nullifier = first.json.vote.nullifier;
    assert.notEqual(secondHash, firstHash);

    localClock = H2 + DELAY;
    await localStore.setTally(id, [0, 1]);
    const holder = await call('POST', '/api/receipts/verify', { body: { token: second.json.receipt.token } });
    assert.equal(holder.status, 200, holder.json?.error);
    assert.equal(holder.json.published, false);
    assert.equal(holder.json.inFinalTally, true);
    assert.equal(holder.json.replacement, true);
    assert.equal(holder.json.explorerUrl, null);
    assert.equal(holder.json.ballotHash, secondHash);
    assert.equal(
      holder.json.note,
      'Your replacement ballot is counted in the final tally. The receipt still cannot prove which option was marked.',
    );

    const row = await call('GET', `/api/explorer/nullifiers/${encodeURIComponent(nullifier)}`);
    assert.equal(row.status, 200, row.json?.error);
    assert.equal(row.json.ballotHash, firstHash);
    assert.equal(row.json.tx?.payload?.ballotHash, firstHash);
    const rowText = JSON.stringify(row.json);
    assert.equal(rowText.includes(secondHash), false);
    assert.equal(rowText.includes('"superseded"'), false);
    assert.equal(rowText.includes('"replaced"'), false);
    const blocks = await call('GET', '/api/explorer/blocks');
    assert.equal(blocks.status, 200, blocks.json?.error);
    let sawFirst = false;
    for (const block of blocks.json.blocks || []) {
      const one = await call('GET', `/api/explorer/blocks/${block.number}`);
      const body = JSON.stringify(one.json);
      assert.equal(body.includes(secondHash), false);
      for (const tx of one.json?.block?.txs || []) {
        if (String(tx.electionId) !== String(id)) continue;
        assert.notEqual(tx.payload?.ballotHash, secondHash);
        assert.notEqual(tx.ballotHash, secondHash);
        if (String(tx.type).toLowerCase() === 'vote') {
          assert.equal(tx.payload.ballotHash, firstHash);
          sawFirst = true;
        }
      }
    }
    assert.equal(sawFirst, true);
  });
});

describe('first-ballot receipts keep the disclosure gates', () => {
  const DELAY = 1800;
  const H = HOUR_START;
  const H1 = H + HOUR;
  let localTmp;
  let localStore;
  let localServer;
  let localBase;
  let localClock;
  const localAdmin = {};

  function call(method, url, opts) {
    return request(localBase, method, url, opts);
  }

  before(async () => {
    localTmp = await mkdtemp(path.join(os.tmpdir(), 'poll-blocks-'));
    localClock = H + 90;
    const created = await createApp({
      dataDir: localTmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: HOUR,
      disclosureDelaySeconds: DELAY,
      resultsMinVotes: 100,
      disclosureMinBlockVotes: 10,
      nowFn: () => localClock,
    });
    localStore = created.store;
    localServer = await listen(created.app);
    localBase = `http://127.0.0.1:${localServer.address().port}`;
    await call('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: localAdmin });
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      localServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(localTmp, { recursive: true, force: true });
  });

  test('one ballot stays sealed after the hour and after the deadline until the tally', async () => {
    const created = await call('POST', '/api/elections', {
      jar: localAdmin,
      body: {
        title: 'Gated receipt',
        startTime: H - 10,
        cutoffTime: H1 + DELAY + 10,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt the sample ordinance?' }],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    const id = created.json.id;
    const reg = await call('POST', `/api/elections/${id}/register`, {
      jar: localAdmin,
      body: { identityCommitment: '0xca11' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await call('POST', `/api/elections/${id}/freeze`, { jar: localAdmin });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const voted = await call('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '0xabc', electionId: id },
        encryptedBallot: '0x01',
        identityCommitment: '0xca11',
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);
    const hash = voted.json.vote.ballotHash;
    const nullifier = voted.json.vote.nullifier;

    localClock = H1 + DELAY;
    const afterHour = await call('POST', '/api/receipts/verify', { body: { token: voted.json.receipt.token } });
    assert.equal(afterHour.status, 200, afterHour.json?.error);
    assert.equal(afterHour.json.published, false);
    assert.equal(afterHour.json.counted, true);
    assert.equal(afterHour.json.accepted, true);
    assert.notEqual(
      afterHour.json.note,
      'Your replacement ballot was accepted. It will appear in the final tally, not in an hourly block.',
    );
    const afterHourHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: hash, electionId: id },
    });
    assert.equal(afterHourHash.status, 404);

    localClock = H1 + DELAY + 11;
    const afterEnd = await call('POST', '/api/receipts/verify', { body: { token: voted.json.receipt.token } });
    assert.equal(afterEnd.status, 200, afterEnd.json?.error);
    assert.equal(afterEnd.json.published, false);
    const afterEndHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: hash, electionId: id },
    });
    assert.equal(afterEndHash.status, 404);

    await localStore.setTally(id, [1, 0]);
    const tallied = await call('POST', '/api/receipts/verify', { body: { token: voted.json.receipt.token } });
    assert.equal(tallied.status, 200, tallied.json?.error);
    assert.equal(tallied.json.published, true);
    assert.equal(tallied.json.ballotHash, hash);
    const talliedHash = await call('POST', '/api/receipts/verify', {
      body: { nullifier, ballotHash: hash, electionId: id },
    });
    assert.equal(talliedHash.status, 200, talliedHash.json?.error);
    assert.equal(talliedHash.json.published, true);
    assert.equal(talliedHash.json.ballotHash, hash);
  });
});
