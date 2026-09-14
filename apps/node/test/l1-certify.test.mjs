// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { createL1Certifier, computeTallyHash } from '../src/l1Certify.mjs';
import { getConfig } from '../src/config.mjs';
import { mergeTallyL1 } from '../src/store.mjs';

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

async function api(base, method, url, { body, jar } = {}) {
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

async function tallyFixture(overrides = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-l1-'));
  const created = await createApp({
    dataDir: tmp,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    ...overrides,
  });
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  await api(base, 'POST', '/api/auth/dev-login', {
    body: { handle: 'admin' },
    jar,
  });
  const now = Math.floor(Date.now() / 1000);
  const createdEl = await api(base, 'POST', '/api/elections', {
    jar,
    body: {
      title: 'L1 cert',
      startTime: now - 120,
      cutoffTime: now + 3600,
      questions: [{ type: 'YES_NO', prompt: 'Q?' }],
      jurisdictionId: 'demo',
    },
  });
  const electionId = createdEl.json.id;
  assert.equal(createdEl.status, 201, createdEl.json?.error);
  await api(base, 'POST', `/api/elections/${electionId}/register`, {
    jar,
    body: { identityCommitment: '0x' + '11'.repeat(32) },
  });
  await api(base, 'POST', `/api/elections/${electionId}/freeze`, { jar, body: {} });
  const voted = await api(base, 'POST', `/api/elections/${electionId}/vote`, {
    body: {
      proof: { accept: true },
      publicInputs: { nullifier: 7, electionId },
      encryptedBallot: '0xaa',
    },
  });
  assert.equal(voted.status, 201, voted.json?.error);
  const election = created.store.requireElection(electionId);
  election.cutoffTime = now - 1;
  await created.store.persist();
  return { tmp, created, server, base, jar, electionId };
}

async function closeFixture(fx) {
  await new Promise((resolve, reject) => {
    fx.server.close((err) => (err ? reject(err) : resolve()));
  });
  await rm(fx.tmp, { recursive: true, force: true });
}

describe('L1 certifier unit', () => {
  test('no-op when L1 env is unset', async () => {
    const cert = createL1Certifier(
      getConfig({
        l1Rpc: '',
        l1TallyMirrorAddress: '',
        l1PublisherPrivateKey: '',
      }),
    );
    assert.equal(cert.isConfigured(), false);
    assert.equal(cert.skipReason(), 'L1 env unset');
    const result = await cert.certifyTally({ electionId: 1, counts: [2, 0], totalBallots: 2 });
    assert.equal(result.status, 'skipped');
    assert.equal(result.posted, false);
    assert.equal(result.resultHash, computeTallyHash([2, 0]));
  });

  test('mock postFn is treated as configured (CI, no keys)', async () => {
    const calls = [];
    const cert = createL1Certifier(getConfig({}), {
      postFn: async (args) => {
        calls.push(args);
        return { posted: true, status: 'posted', txHash: '0xabc', resultHash: args.resultHash };
      },
    });
    assert.equal(cert.isConfigured(), true);
    const result = await cert.certifyTally({ electionId: 3, counts: [1, 0], totalBallots: 1 });
    assert.equal(result.status, 'posted');
    assert.equal(result.txHash, '0xabc');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].electionId, 3);
  });

  test('postFn throw becomes failed, not an exception', async () => {
    const cert = createL1Certifier(getConfig({}), {
      postFn: async () => {
        throw new Error('rpc down');
      },
    });
    const result = await cert.certifyTally({ electionId: 1, counts: [1], totalBallots: 1 });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /rpc down/);
  });
});

describe('mergeTallyL1', () => {
  test('does not clobber a posted record with a later failed retry', () => {
    const prev = { status: 'posted', posted: true, txHash: '0xabc', chainId: 31337 };
    const next = mergeTallyL1(prev, { status: 'failed', error: 'rpc down' });
    assert.equal(next.status, 'posted');
    assert.equal(next.txHash, '0xabc');
    assert.equal(next.lastError, 'rpc down');
  });

  test('already_posted keeps the original txHash', () => {
    const prev = { status: 'posted', posted: true, txHash: '0xabc', mirror: '0x1' };
    const next = mergeTallyL1(prev, { status: 'already_posted', alreadyPosted: true, txHash: null });
    assert.equal(next.status, 'already_posted');
    assert.equal(next.txHash, '0xabc');
    assert.equal(next.mirror, '0x1');
  });
});

describe('L1 certification HTTP', () => {
  test('POST /tally skips L1 when env unset', async () => {
    const fx = await tallyFixture();
    try {
      const { status, json } = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/tally`, {
        jar: fx.jar,
        body: { counts: [1, 0] },
      });
      assert.equal(status, 200, json?.error);
      assert.equal(json.l1Certification.status, 'skipped');
      assert.match(json.l1Certification.reason, /L1 env unset|incomplete/);
      assert.equal(json.election.tally.countsHash, computeTallyHash([1, 0]));
      assert.equal(json.election.tally.l1.status, 'skipped');

      const cfg = await api(fx.base, 'GET', '/api/config');
      assert.equal(cfg.json.l1CertificationConfigured, false);

      const view = await api(fx.base, 'GET', `/api/elections/${fx.electionId}/l1`);
      assert.equal(view.status, 200);
      assert.equal(view.json.tallied, true);
      assert.equal(view.json.l1Configured, false);

      const retry = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/certify-l1`, {
        jar: fx.jar,
        body: {},
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.l1Certification.status, 'skipped');
    } finally {
      await closeFixture(fx);
    }
  });

  test('POST /tally posts via mock and certify-l1 retries', async () => {
    const posts = [];
    const fx = await tallyFixture({
      l1Hooks: {
        postFn: async (args) => {
          posts.push(args);
          return {
            posted: true,
            status: 'posted',
            txHash: `0x${String(posts.length).padStart(64, 'a')}`,
            resultHash: args.resultHash,
            mirror: '0x' + '22'.repeat(20),
            chainId: 11155111,
          };
        },
      },
    });
    try {
      const { status, json } = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/tally`, {
        jar: fx.jar,
        body: { counts: [1, 0] },
      });
      assert.equal(status, 200, json?.error);
      assert.equal(json.l1Certification.status, 'posted');
      assert.equal(json.l1Certification.posted, true);
      assert.equal(json.election.tally.l1.chainId, 11155111);
      assert.equal(posts.length, 1);

      const retry = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/certify-l1`, {
        jar: fx.jar,
        body: {},
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.l1Certification.posted, true);
      assert.equal(posts.length, 2);

      const health = await api(fx.base, 'GET', '/health');
      assert.equal(health.json.l1CertificationConfigured, true);
    } finally {
      await closeFixture(fx);
    }
  });

  test('AlreadyPosted retry keeps the original L1 tx hash', async () => {
    let calls = 0;
    const fx = await tallyFixture({
      l1Hooks: {
        postFn: async (args) => {
          calls += 1;
          if (calls === 1) {
            return {
              posted: true,
              status: 'posted',
              txHash: `0x${'ab'.repeat(32)}`,
              resultHash: args.resultHash,
              mirror: '0x' + '22'.repeat(20),
              chainId: 31337,
            };
          }
          const err = new Error(
            'The contract function "postResult" reverted with the following signature:\n0xe9f155db',
          );
          err.cause = { signature: '0xe9f155db' };
          throw err;
        },
      },
    });
    try {
      const first = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/tally`, {
        jar: fx.jar,
        body: { counts: [1, 0] },
      });
      assert.equal(first.status, 200, first.json?.error);
      assert.equal(first.json.l1Certification.status, 'posted');

      const retry = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/certify-l1`, {
        jar: fx.jar,
        body: {},
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.l1Certification.status, 'already_posted');
      assert.equal(retry.json.l1Certification.txHash, `0x${'ab'.repeat(32)}`);
      assert.equal(retry.json.election.tally.l1.txHash, `0x${'ab'.repeat(32)}`);
      assert.equal(calls, 2);
    } finally {
      await closeFixture(fx);
    }
  });

  test('L1 failure does not roll back the Node tally', async () => {
    const fx = await tallyFixture({
      l1Hooks: {
        postFn: async () => {
          throw new Error('insufficient funds');
        },
      },
    });
    try {
      const { status, json } = await api(fx.base, 'POST', `/api/elections/${fx.electionId}/tally`, {
        jar: fx.jar,
        body: { counts: [1, 0] },
      });
      assert.equal(status, 200, json?.error);
      assert.equal(json.election.stateName, 'Tallied');
      assert.equal(json.l1Certification.status, 'failed');
      assert.match(json.l1Certification.error, /insufficient funds/);
    } finally {
      await closeFixture(fx);
    }
  });
});
