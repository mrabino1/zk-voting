// NOT FOR PROFIT — civic public good, not a commercial product.
// Off-chain ballot unlinkability: every persisted or relayed path that used to
// tie a ballot (nullifier / ballot hash / receipt) to an account is gone.
// See docs/OPERATOR.md "Ballot unlinkability" and
// docs/proposals/ballot-unlinkability-contracts.md for what remains on-chain.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { resetLogBuffer, setLogLevel, tailLogs } from '../src/superAdmin/logs.mjs';
import { isBallotRequest } from '../src/auth.mjs';
import { VOTE_IDENTITY_KEYS, sanitizeVoteBody } from '../src/http.mjs';
import { coarseAcceptedAt } from '../src/relay.mjs';
import { BALLOT_TIMING_COLLECTIONS, scrubBallotLinkage } from '../src/store.mjs';
import { createVotePassService, fdh as nodeFdh, hashVotePassToken } from '../src/votePass.mjs';
import { blindVotePass, fdh as browserFdh, unblindVotePass } from '../public/vote-pass.js';

let tmp;
let server;
let base;
let store;
let created;
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

async function api(method, url, { body, jar } = {}) {
  const res = await fetch(base + url, {
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
  return { res, json, text, status: res.status };
}

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function openElection(title = 'Unlinkability contest') {
  const made = await api('POST', '/api/elections', {
    jar: adminJar,
    body: {
      title,
      startTime: nowSec() - 10,
      cutoffTime: nowSec() + 86400,
      treeDepth: 16,
      questions: [{ type: 'YES_NO', prompt: 'Adopt?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }],
    },
  });
  assert.equal(made.status, 201, made.json?.error);
  const id = made.json.id;
  const reg = await api('POST', `/api/elections/${id}/register`, {
    jar: adminJar,
    body: { identityCommitment: '0xfeed01' },
  });
  assert.equal(reg.status, 201, reg.json?.error);
  const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
  assert.equal(freeze.status, 200, freeze.json?.error);
  return id;
}

async function getPass(id, extra = {}, jar = undefined) {
  const key = await api('GET', `/api/elections/${id}/vote-pass`);
  assert.equal(key.status, 200, key.json?.error);
  const pending = await blindVotePass(key.json, id);
  const issued = await api('POST', `/api/elections/${id}/vote-pass`, {
    jar,
    body: { blinded: pending.blinded, ...extra },
  });
  assert.equal(issued.status, 201, issued.json?.error);
  // The Node only ever saw the blinded value — never the token it will verify.
  assert.equal(JSON.stringify(issued.json).includes(pending.token), false);
  return unblindVotePass(key.json, id, pending, issued.json.blindSignature);
}

const voteBody = (id, nullifier, extra = {}) => ({
  proof: { accept: true },
  publicInputs: { nullifier, electionId: id },
  encryptedBallot: '0x0badc0de',
  ...extra,
});

describe('ballot unlinkability (off-chain)', () => {
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-unlink-'));
    created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    store = created.store;
    server = await listen(created.app);
    base = `http://127.0.0.1:${server.address().port}`;
    await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar: adminJar });
    await api('POST', '/api/auth/dev-login', { body: { handle: 'unlink-voter', role: 'voter' }, jar: voterJar });
    const pin = await api('POST', '/api/me/pin', { jar: voterJar, body: { pin: '2580', confirmPin: '2580' } });
    assert.equal(pin.status, 200, pin.json?.error);
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(tmp, { recursive: true, force: true });
  });

  test('vote pass FDH is identical in the Node and the browser module', async () => {
    const svc = createVotePassService({ writerActive: true });
    const key = await svc.publicKey();
    for (const token of ['00'.repeat(32), 'ab'.repeat(32), 'f0e1'.repeat(16)]) {
      assert.equal(await browserFdh(key.n, '42', token), nodeFdh(key.n, '42', token));
    }
  });

  test('blind pass: verifies once, rejects forgeries and cross-election reuse', async () => {
    const svc = createVotePassService({ writerActive: true });
    const key = await svc.publicKey();
    const pending = await blindVotePass(key, 'e1');
    const sig = await svc.signBlinded(pending.blinded);
    const pass = await unblindVotePass(key, 'e1', pending, sig);
    assert.notEqual(pass.signature, sig, 'unblinded signature differs from what the signer saw');
    assert.equal(await svc.verify('e1', pass), hashVotePassToken(pass.token));
    await assert.rejects(() => svc.verify('e2', pass), (err) => err.extra?.code === 'VOTE_PASS_INVALID');
    const forged = { token: pass.token, signature: (BigInt(`0x${pass.signature}`) + 1n).toString(16) };
    await assert.rejects(() => svc.verify('e1', forged), (err) => err.extra?.code === 'VOTE_PASS_INVALID');
  });

  test('ballot request strips every identity-bearing key', () => {
    const body = sanitizeVoteBody({
      ...voteBody('1', '9'),
      identityCommitment: '0x1',
      address: '0x' + '11'.repeat(20),
      sender: '0x' + '22'.repeat(20),
      smartAccount: '0x' + '33'.repeat(20),
      userOpHash: '0x' + 'ab'.repeat(32),
      userOp: { sender: '0x' + '44'.repeat(20) },
      credentialId: 'cred',
      pinToken: 'pin',
      email: 'me@example.org',
    });
    for (const k of VOTE_IDENTITY_KEYS) assert.equal(body[k], undefined, k);
    assert.equal(body.encryptedBallot, '0x0badc0de');
  });

  test('session-less vote: no subscription, no userOpHash/email fields, coarse time, spent pass', async () => {
    const id = await openElection();
    const pass = await getPass(id);
    const voted = await api('POST', `/api/elections/${id}/vote`, {
      body: voteBody(id, '0x5001', {
        votePass: pass,
        userOpHash: '0x' + 'cd'.repeat(32),
        identityCommitment: '0xfeed01',
        address: '0x' + '55'.repeat(20),
      }),
    });
    assert.equal(voted.status, 201, voted.json?.error);
    assert.equal(voted.json.receipt.userOpHash ?? null, null);
    assert.equal(voted.json.vote.identityCommitment, undefined);

    // Same pass, new nullifier → refused (one pass, one ballot).
    const again = await api('POST', `/api/elections/${id}/vote`, {
      body: voteBody(id, '0x5002', { votePass: pass }),
    });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'VOTE_PASS_SPENT');

    assert.equal((store.data.outcomeSubscriptions || []).filter((s) => String(s.electionId) === String(id)).length, 0);
    const votes = store.data.votes.filter((v) => String(v.electionId) === String(id));
    const receipts = store.data.receipts.filter((r) => String(r.electionId) === String(id));
    assert.equal(votes.length, 1);
    for (const row of [...votes, ...receipts]) {
      assert.equal(row.userOpHash, undefined);
      assert.equal(row.emailHint, undefined);
      assert.equal(row.emailedAt, undefined);
      assert.equal(row.userId, undefined);
      assert.equal(row.identityCommitment, undefined);
      assert.equal(row.acceptedAt % 3600, 0, 'acceptedAt is bucketed, not the second of the vote');
    }
    // The spent list holds a hash of the token, not the token or signature.
    const spent = JSON.stringify(store.data.votePassSpent);
    assert.equal(spent.includes(pass.token), false);
    assert.equal(spent.includes(pass.signature), false);

    // Nothing written to disk mentions the voter's account next to this ballot.
    const user = store.getUserByHandle('unlink-voter');
    const disk = await readFile(path.join(tmp, 'zk-voting.json'), 'utf8').catch(() => JSON.stringify(store.data));
    const parsed = JSON.parse(disk);
    const ballotRows = JSON.stringify({ votes: parsed.votes, receipts: parsed.receipts, envelopes: parsed.envelopes });
    assert.equal(ballotRows.includes(user.id), false);
    assert.equal(ballotRows.includes('cd'.repeat(32)), false);
  });

  test('a signed-in voter casts without cookies; the account is never on the ballot request', async () => {
    const id = await openElection('Session-less cast');
    // Eligibility request: signed in (session cookie) and PIN-gated.
    const pinless = await api('POST', `/api/elections/${id}/vote-pass`, { jar: voterJar, body: { blinded: '0x1234' } });
    assert.equal(pinless.status, 403);
    const verified = await api('POST', '/api/me/pin/verify', { jar: voterJar, body: { pin: '2580', purpose: 'vote' } });
    assert.equal(verified.status, 200, verified.json?.error);
    const pass = await getPass(id, { pinToken: verified.json.pinToken }, voterJar);
    const before = JSON.stringify(store.getUserByHandle('unlink-voter'));
    const voted = await api('POST', `/api/elections/${id}/vote`, { body: voteBody(id, '0x6001', { votePass: pass }) });
    assert.equal(voted.status, 201, voted.json?.error);
    assert.equal(JSON.stringify(store.getUserByHandle('unlink-voter')), before, 'user row untouched by the ballot');
  });

  test('plaintext ballots are refused unless explicitly allowed (non-production)', async () => {
    const id = await openElection('Plaintext refusal');
    const plain = '0x' + Buffer.from(JSON.stringify({ answers: [{ optionIds: ['yes'] }] })).toString('hex');
    const res = await api('POST', `/api/elections/${id}/vote`, { body: voteBody(id, '0x7001', { encryptedBallot: plain }) });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'PLAINTEXT_BALLOT');
  });

  test('stored ballot order is not arrival order', async () => {
    const id = await openElection('Order');
    const cast = [];
    for (let i = 0; i < 12; i += 1) {
      const nullifier = `0x${(0x8000 + i).toString(16)}`;
      const r = await api('POST', `/api/elections/${id}/vote`, { body: voteBody(id, nullifier) });
      assert.equal(r.status, 201, r.json?.error);
      cast.push(r.json.vote.nullifier);
    }
    const stored = store.data.votes.filter((v) => String(v.electionId) === String(id)).map((v) => v.nullifier);
    assert.deepEqual([...stored].sort(), [...cast].sort());
    // 1 / 12! chance of a false failure.
    assert.notDeepEqual(stored, cast);
  });

  test('outcome reports are opt-in: /api/config says so', async () => {
    const cfg = await api('GET', '/api/config');
    assert.equal(cfg.json.outcomes.officialReport.defaultSubscribeOnVote, false);
  });

  test('API keys are not stamped with lastUsedAt by the ballot request', () => {
    assert.equal(isBallotRequest({ method: 'POST', originalUrl: '/api/elections/abc/vote' }), true);
    assert.equal(isBallotRequest({ method: 'POST', originalUrl: '/api/elections/abc/vote?x=1' }), true);
    assert.equal(isBallotRequest({ method: 'POST', originalUrl: '/api/elections/abc/vote-pass' }), false);
    assert.equal(isBallotRequest({ method: 'GET', originalUrl: '/api/elections/abc/vote' }), false);
  });

  test('coarseAcceptedAt buckets to the disclosure interval (hour when instant)', () => {
    assert.equal(coarseAcceptedAt(1_700_000_123, 3600), 1_699_999_200);
    assert.equal(coarseAcceptedAt(1_700_000_123, 0), 1_699_999_200);
    assert.equal(coarseAcceptedAt(1_700_000_123, 900), 1_699_999_200 + 900);
  });

  test('legacy data is scrubbed on load', () => {
    const data = scrubBallotLinkage({
      receipts: [{ nullifier: '0x1', userOpHash: '0xab', emailHint: 'm***@x', emailedAt: 'now', acceptedAt: 1_700_000_123 }],
      votes: [{ nullifier: '0x1', acceptedAt: 1_700_000_123 }],
      outcomeSubscriptions: [
        { userId: 'u', electionId: '1', source: 'vote-default', createdAt: '2026-10-26T17:43:21.123Z', updatedAt: '2026-10-26T17:43:21.123Z' },
        { userId: 'u', electionId: '2', source: 'manual', createdAt: '2026-10-26T17:43:21.123Z' },
      ],
    });
    assert.deepEqual(Object.keys(data.receipts[0]).sort(), ['acceptedAt', 'nullifier']);
    assert.equal(data.receipts[0].acceptedAt, 1_699_999_200);
    assert.equal(data.votes[0].acceptedAt, 1_699_999_200);
    assert.equal(data.outcomeSubscriptions[0].source, 'legacy-default');
    assert.equal(data.outcomeSubscriptions[0].createdAt, '2026-10-26T00:00:00.000Z');
    assert.equal(data.outcomeSubscriptions[1].createdAt, '2026-10-26T17:43:21.123Z');
    assert.deepEqual(data.votePassSpent, {});
  });

  test('ballot collections get hour-truncated row timestamps in Postgres', () => {
    for (const name of ['votes', 'receipts', 'envelopes', 'votePassSpent', 'heldChainBallots']) {
      assert.ok(BALLOT_TIMING_COLLECTIONS.includes(name), name);
    }
  });
});

test('the access log never records the ballot POST (no line, no timestamp)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-unlink-log-'));
  const app = await createApp({ dataDir: dir, allowDevLogin: true, quiet: false, logLevel: 'warn' });
  const srv = await listen(app.app);
  const at = `http://127.0.0.1:${srv.address().port}`;
  setLogLevel('info');
  resetLogBuffer();
  try {
    await fetch(`${at}/api/elections/abc/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nullifier: '0x1' }),
    });
    await fetch(`${at}/api/elections/abc/vote/?x=1`, { method: 'POST' });
    await fetch(`${at}/health`);
    await new Promise((r) => setTimeout(r, 50));
    const lines = tailLogs(500).lines.map((l) => l.message);
    assert.ok(lines.some((l) => l.includes('GET /health')), 'other requests are still logged');
    assert.equal(lines.some((l) => /\/vote\b/.test(l)), false, lines.join('\n'));
  } finally {
    await new Promise((r) => srv.close(r));
    try {
      app.writer?.release();
    } catch {
      /* released */
    }
    await rm(dir, { recursive: true, force: true });
  }
});
