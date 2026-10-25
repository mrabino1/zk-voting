// NOT FOR PROFIT — civic public good, not a commercial product.
// Official outcome PDFs: locked, QR + hash sealed, default subscribe on vote.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { parseRoute } from '../public/router.js';
import { createApp } from '../src/server.mjs';
import { encodeQr } from '../src/qr.mjs';
import {
  defaultOutcomeReportTemplate,
  outcomeReportReady,
  presentOutcomeReportTemplate,
  sanitizeOutcomeReportTemplate,
} from '../src/outcomeReports.mjs';
import { decryptPdfStreams, pdfAllowsModify, readPdfEncryption } from '../src/pdf.mjs';
import { sha256Hex } from '../src/terms.mjs';

function loc(pathname, search = '') {
  return { pathname, hash: '', search };
}

describe('QR encoder', () => {
  test('finder patterns sit at three corners', () => {
    const qr = encodeQr('HTTP://127.0.0.1:3000/O/AABBCCDDEEFF00112233445566778899');
    assert.ok(qr.size >= 21);
    assert.equal(qr.modules.length, qr.size);
    const n = qr.size;
    function finder(top, left) {
      assert.equal(qr.modules[top][left], true);
      assert.equal(qr.modules[top + 6][left + 6], true);
      assert.equal(qr.modules[top + 3][left + 3], true);
      assert.equal(qr.modules[top + 1][left + 1], false);
    }
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
  });

  test('same payload is deterministic', () => {
    const a = encodeQr('RO1/ABCDEF');
    const b = encodeQr('RO1/ABCDEF');
    assert.equal(JSON.stringify(a.modules), JSON.stringify(b.modules));
  });
});

describe('outcome report helpers', () => {
  test('template cannot disable QR or hash seals', () => {
    const next = sanitizeOutcomeReportTemplate(
      { heading: 'County results', includeQr: false, qr: false, hash: false, authenticity: false },
      defaultOutcomeReportTemplate(),
    );
    assert.equal(next.heading, 'County results');
    assert.equal(next.authenticity.qr, true);
    assert.equal(next.authenticity.hash, true);
    assert.equal(next.authenticity.customizable, false);
    const presented = presentOutcomeReportTemplate({ heading: 'X', qr: false });
    assert.equal(presented.authenticity.qr, true);
  });

  test('ready only after cutoff and tally', () => {
    const now = 1_000;
    assert.equal(outcomeReportReady({ cutoffTime: 900, tally: { counts: [1] } }, now), true);
    assert.equal(outcomeReportReady({ cutoffTime: 1_100, tally: { counts: [1] } }, now), false);
    assert.equal(outcomeReportReady({ cutoffTime: 900, tally: null }, now), false);
  });

  test('SPA maps /outcomes/verify', () => {
    assert.equal(parseRoute(loc('/outcomes/verify')).name, 'outcomeVerify');
    assert.equal(parseRoute(loc('/outcomes/verify', 'id=abc')).name, 'outcomeVerify');
  });
});

describe('official outcome PDF HTTP', () => {
  let tmp;
  let app;
  let store;
  let mailer;
  let server;
  let base;
  const adminJar = {};
  const voterJar = {};
  const otherJar = {};

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

  async function createOpenElection(title) {
    const created = await api('POST', '/api/elections', {
      jar: adminJar,
      body: {
        title,
        startTime: nowSec() - 120,
        cutoffTime: nowSec() + 3600,
        treeDepth: 16,
        questions: [
          {
            type: 'YES_NO',
            prompt: 'Adopt the measure?',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
    });
    assert.equal(created.status, 201, created.json?.error);
    return created.json.election.id;
  }

  async function officerEnroll(electionId, identityCommitment, userId) {
    const registered = await api('POST', `/api/elections/${electionId}/register`, {
      jar: adminJar,
      body: { identityCommitment, userId },
    });
    assert.equal(registered.status, 201, registered.json?.error);
  }

  async function votePinToken(jar, pin = '2580') {
    const verified = await api('POST', '/api/me/pin/verify', {
      jar,
      body: { pin, purpose: 'vote' },
    });
    assert.equal(verified.status, 200, verified.json?.error);
    return verified.json.pinToken;
  }

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-outcome-pdf-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      receiptPdfSecret: 'unit-outcome-pdf-secret',
      publicBaseUrl: 'http://127.0.0.1:3000',
    });
    app = created.app;
    store = created.store;
    mailer = created.mailer;
    server = await listen(app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', { body: { handle: 'voter1', role: 'voter' }, jar: voterJar });
    await api('POST', '/api/auth/dev-login', { body: { handle: 'other', role: 'voter' }, jar: otherJar });
    const voter = store.getUserByHandle('voter1');
    voter.email = 'voter1@example.gov';
    const other = store.getUserByHandle('other');
    other.email = 'other@example.gov';
    await store.persist();
    const pin = await api('POST', '/api/me/pin', {
      jar: voterJar,
      body: { pin: '2580', confirmPin: '2580' },
    });
    assert.equal(pin.status, 200, pin.json?.error);
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmp, { recursive: true, force: true });
  });

  test('GET /api/config advertises official reports', async () => {
    const { status, json } = await api('GET', '/api/config');
    assert.equal(status, 200);
    assert.equal(json.outcomes.officialReport.pdfProtected, true);
    assert.equal(json.outcomes.officialReport.pdfModify, false);
    assert.equal(json.outcomes.officialReport.qr, true);
    assert.equal(json.outcomes.officialReport.defaultSubscribeOnVote, true);
    assert.equal(json.outcomes.officialReport.verifyPath, '/outcomes/verify');
  });

  test('SPA serves /outcomes/verify', async () => {
    const page = await api('GET', '/outcomes/verify');
    assert.equal(page.status, 200);
    assert.match(page.res.headers.get('content-type') || '', /html/);
  });

  test('vote default-subscribes; unsubscribe is the exception; PDF after cutoff+tally', async () => {
    const id = await createOpenElection('Outcome PDF race');
    const commit = '0xabc111';
    await officerEnroll(id, commit, store.getUserByHandle('voter1').id);
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      jar: voterJar,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 501, electionId: id },
        identityCommitment: commit,
        encryptedBallot: '0xaa',
        pinToken: await votePinToken(voterJar),
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);

    const subs = await api('GET', '/api/me/outcome-subscriptions', { jar: voterJar });
    assert.equal(subs.status, 200, subs.json?.error);
    const mine = (subs.json.subscriptions || []).find((s) => String(s.electionId) === String(id));
    assert.ok(mine);
    assert.equal(mine.subscribed, true);
    assert.equal(mine.votedDefault, true);
    assert.equal(mine.reportIssued, false);

    store.requireElection(id).cutoffTime = nowSec() - 1;
    await store.persist();
    const beforeTally = await api('GET', `/api/outcomes/reports?electionId=${encodeURIComponent(id)}`);
    assert.equal((beforeTally.json.reports || []).length, 0);

    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);

    const captured = mailer.lastOutcomeReport();
    assert.ok(captured, 'expected SES capture of official outcome PDF');
    assert.equal(captured.meta.purpose, 'outcome-report');
    assert.equal(captured.to, 'voter1@example.gov');
    assert.equal(captured.attachments[0].contentType, 'application/pdf');
    const pdf = captured.attachments[0].content;
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const enc = readPdfEncryption(pdf);
    assert.ok(enc);
    assert.equal(pdfAllowsModify(enc.permissions), false);
    const opened = decryptPdfStreams(pdf, '')
      .map((s) => s.text)
      .join('\n');
    assert.match(opened, /Adopt the measure/);
    assert.match(opened, /Yes: 1/);
    assert.match(opened, /No: 0/);
    assert.match(opened, /Voting started/);
    assert.match(opened, /Voting ended/);
    assert.match(opened, /Authenticity seal/);
    assert.match(opened, /HMAC-SHA256/);
    assert.match(opened, /\d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)? \d+(?:\.\d+)? re/);

    const listed = await api('GET', `/api/outcomes/reports?electionId=${encodeURIComponent(id)}`);
    assert.equal(listed.json.reports.length, 1);
    const reportId = listed.json.reports[0].id;
    assert.match(listed.json.reports[0].pdfSha256, /^[0-9a-f]{64}$/);
    assert.equal(listed.json.reports[0].pdfSha256, sha256Hex(pdf));

    const verifyOk = await api('POST', '/api/outcomes/verify', {
      body: { pdf: pdf.toString('base64') },
    });
    assert.equal(verifyOk.status, 200, verifyOk.json?.error);
    assert.equal(verifyOk.json.authentic, true);
    assert.equal(verifyOk.json.pdfUnmodified, true);
    assert.equal(verifyOk.json.pdfModify, false);

    const tampered = Buffer.from(pdf);
    tampered[tampered.length - 20] = tampered[tampered.length - 20] ^ 0xff;
    const verifyBad = await api('POST', '/api/outcomes/verify', {
      body: { pdf: tampered.toString('base64') },
    });
    assert.equal(verifyBad.status, 404);
    assert.equal(verifyBad.json.authentic, false);

    const byId = await api('POST', '/api/outcomes/verify', { body: { reportId } });
    assert.equal(byId.status, 200);
    assert.equal(byId.json.electionId, id);

    const dl = await api('GET', `/api/outcomes/reports/${id}/pdf`);
    assert.equal(dl.status, 200);
    assert.equal(dl.res.headers.get('content-type'), 'application/pdf');
    assert.equal(dl.res.headers.get('x-pdf-protected'), 'true');
    assert.equal(dl.res.headers.get('x-pdf-modify'), 'false');

    const redirect = await fetch(`${base}/o/${reportId.replace(/-/g, '')}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('location') || '', /\/outcomes\/verify/);
  });

  test('unsubscribed voter is not emailed; optional subscribe still works', async () => {
    const id = await createOpenElection('Unsubscribe exception');
    const commit = '0xabc222';
    await officerEnroll(id, commit, store.getUserByHandle('voter1').id);
    await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      jar: voterJar,
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: 601, electionId: id },
        identityCommitment: commit,
        encryptedBallot: '0xbb',
        pinToken: await votePinToken(voterJar),
      },
    });
    assert.equal(voted.status, 201, voted.json?.error);
    const off = await api('PUT', `/api/me/outcome-subscriptions/${id}`, {
      jar: voterJar,
      body: { subscribed: false },
    });
    assert.equal(off.status, 200, off.json?.error);
    assert.equal(off.json.subscription.subscribed, false);

    const beforeCount = mailer.sent.filter((m) => m.meta?.purpose === 'outcome-report').length;
    store.requireElection(id).cutoffTime = nowSec() - 1;
    await store.persist();
    const tally = await api('POST', `/api/elections/${id}/tally`, {
      jar: adminJar,
      body: { counts: [1, 0] },
    });
    assert.equal(tally.status, 200, tally.json?.error);
    const afterCount = mailer.sent.filter((m) => m.meta?.purpose === 'outcome-report').length;
    assert.equal(afterCount, beforeCount);

    const on = await api('POST', '/api/me/outcome-subscriptions', {
      jar: otherJar,
      body: { electionId: id },
    });
    assert.equal(on.status, 201, on.json?.error);
    const mailed = mailer.sent.filter((m) => m.meta?.purpose === 'outcome-report' && m.to === 'other@example.gov');
    assert.ok(mailed.length >= 1);
  });

  test('admin template customizes letterhead but cannot drop authenticity', async () => {
    const saved = await api('PATCH', '/api/admin/outcome-report-template', {
      jar: adminJar,
      body: {
        heading: 'Certified county result',
        letterhead: 'County of Example, Clerk of Elections',
        intro: 'Custom intro for the official report.',
        qr: false,
        hash: false,
      },
    });
    assert.equal(saved.status, 200, saved.json?.error);
    assert.equal(saved.json.template.heading, 'Certified county result');
    assert.equal(saved.json.template.authenticity.qr, true);
    assert.equal(saved.json.template.authenticity.hash, true);

    const previewRes = await fetch(`${base}/api/admin/outcome-report-template/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(adminJar) },
      body: JSON.stringify({
        heading: 'Certified county result',
        letterhead: 'County of Example, Clerk of Elections',
      }),
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.headers.get('x-pdf-protected'), 'true');
    const pdf = Buffer.from(await previewRes.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const opened = decryptPdfStreams(pdf, '')
      .map((s) => s.text)
      .join('\n');
    assert.match(opened, /County of Example, Clerk of Elections/);
    assert.match(opened, /Certified county result/);
    assert.match(opened, /Authenticity seal/);
    assert.match(opened, /HMAC-SHA256/);

    const forbidden = await api('PATCH', '/api/admin/outcome-report-template', {
      jar: voterJar,
      body: { heading: 'nope' },
    });
    assert.equal(forbidden.status, 403);
  });
});
