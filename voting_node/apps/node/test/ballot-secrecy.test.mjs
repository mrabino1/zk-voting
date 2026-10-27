// NOT FOR PROFIT — civic public good, not a commercial product.
// Regressions for the ballot-secrecy findings: mock proofs off the dev chain,
// vote-request shape, Poseidon nullifier, aggregate batching, and no stored ranking.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { keccak256, toHex } from 'viem';

import { createApp } from '../src/server.mjs';
import { planDisclosureBatch } from '../src/chain.mjs';
import { mockVoteProofAllowed } from '../src/voteProof.mjs';
import { buildVoteRequestBody } from '../public/vote.js';
import { electionNullifierHex } from '../public/passkey-wallet.js';
import { poseidonHashLeftRight } from '../public/poseidon.js';
import { P256_G, p256Mul, pointToRaw } from '../public/p256-math.js';
import { encryptAggregateBallot, aggregateCiphertexts } from '../src/aggregateBallot.mjs';

function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

describe('ballot secrecy regressions', () => {
  test('P-256 double of the generator matches the known point', () => {
    const doubled = p256Mul(2n, P256_G);
    assert.equal(doubled.x, 0x7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978n);
    assert.equal(doubled.y, 0x07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1n);
  });

  test('aggregate envelopes hide the choice and sum one-hot bits', () => {
    const y = '0x' + Buffer.from(pointToRaw(P256_G)).toString('hex');
    const a = encryptAggregateBallot({ jointPublicKey: y, choice: 1, choiceRandomness: 11n, nOptions: 3 });
    const b = encryptAggregateBallot({ jointPublicKey: y, choice: 1, choiceRandomness: 12n, nOptions: 3 });
    assert.notEqual(a.encryptedBallot, b.encryptedBallot);
    assert.equal(a.ballotHash.startsWith('0x'), true);
    const product = aggregateCiphertexts([a.encryptedBallot, b.encryptedBallot]);
    assert.equal(product.nOptions, 3);
    assert.equal(product.ballots, 2);
  });

  test('nullifier is Poseidon(secret, chain election id), not keccak of the credential', () => {
    const secret = new Uint8Array(32);
    secret[31] = 9;
    const hex = electionNullifierHex(secret, 42);
    let secretField = 0n;
    for (const b of secret) secretField = (secretField << 8n) + BigInt(b);
    assert.equal(hex, '0x' + poseidonHashLeftRight(secretField, 42n).toString(16).padStart(64, '0'));
    const keccakNullifier = keccak256(toHex(secret));
    assert.notEqual(hex.toLowerCase(), keccakNullifier.toLowerCase());
  });

  test('vote request builder has no account, userOp, or credential', () => {
    const body = buildVoteRequestBody({
      electionId: '1',
      nullifier: '0x11',
      ballotHash: '0x22',
      encryptedBallot: '0x33',
      proof: { accept: true },
    });
    for (const key of ['address', 'userOpHash', 'credentialId', 'identityCommitment', 'answers', 'ranking']) {
      assert.equal(Object.hasOwn(body, key), false);
    }
  });

  test('mock proofs are refused off the local dev chain and the test default', () => {
    assert.equal(mockVoteProofAllowed({ chainId: 31337 }), true);
    assert.equal(mockVoteProofAllowed({ chainId: 1 }), false);
    assert.equal(mockVoteProofAllowed({ chainId: 27427, allowMockProofs: false }), false);
    assert.equal(mockVoteProofAllowed({ allowMockProofs: true, chainId: 1 }), true);
  });

  test('disclosure batch waits, then sorts by nullifier', () => {
    const pending = [
      { nullifier: 30n },
      { nullifier: 2n },
      { nullifier: 10n },
    ];
    const early = planDisclosureBatch({
      pending,
      interval: 3600,
      now: 100,
      startTime: 0,
      lastBatchAt: 0,
    });
    assert.equal(early.action, 'wait');
    assert.equal(early.batch.length, 0);
    const due = planDisclosureBatch({
      pending,
      interval: 3600,
      now: 3600,
      startTime: 0,
      lastBatchAt: 0,
    });
    assert.equal(due.action, 'batch');
    assert.deepEqual(due.batch.map((row) => row.nullifier), [2n, 10n, 30n]);
    const immediate = planDisclosureBatch({
      pending,
      interval: 0,
      now: 1,
      startTime: 0,
      lastBatchAt: 0,
    });
    assert.equal(immediate.action, 'immediate');
  });

  test('a non-dev chain rejects proof.accept', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-secrecy-'));
    const jar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      chainId: 1,
      disclosureIntervalSeconds: 0,
    });
    const server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function api(method, url, body, { cookie = true } = {}) {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (cookie) applyCookies(res, jar);
      const json = await res.json();
      return { status: res.status, json };
    }
    try {
      assert.equal((await api('POST', '/api/auth/dev-login', { handle: 'admin' })).status, 200);
      const election = await api('POST', '/api/elections', {
        title: 'No mock',
        startTime: Math.floor(Date.now() / 1000) - 10,
        cutoffTime: Math.floor(Date.now() / 1000) + 3600,
        treeDepth: 16,
        questions: [{ type: 'YES_NO', prompt: 'Adopt?' }],
      });
      assert.equal(election.status, 201, JSON.stringify(election.json));
      const id = election.json.election.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { identityCommitment: '0xabc' })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`)).status, 200);
      const vote = await api('POST', `/api/elections/${id}/vote`, {
        proof: { accept: true },
        publicInputs: { nullifier: '1', electionId: id },
        encryptedBallot: '0xab',
        address: '0x1111111111111111111111111111111111111111',
        userOpHash: '0x22',
        credentialId: 'cred',
        identityCommitment: '0xabc',
      }, { cookie: false });
      assert.equal(vote.status, 400, JSON.stringify(vote.json));
      assert.equal(vote.json.code, 'MOCK_PROOF_NOT_ALLOWED');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('token poll copy stays public', () => {
  let tmp;
  let server;
  let base;
  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-poll-copy-'));
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    server = await new Promise((resolve, reject) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });
  test('english poll lede says the poll is not an anonymous ballot', async () => {
    const res = await fetch(base + '/locales/en.js');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /not anonymous ballots/);
  });
});
