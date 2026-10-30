// NOT FOR PROFIT — civic public good, not a commercial product.
// ALLOW_REVOTE stays off until the inbox can store a replacement. A published
// block keeps the first ballot hash.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { encryptAggregateBallot } from '../src/aggregateBallot.mjs';
import { createChain, REVERT_RETRY_BACKOFF_SECONDS } from '../src/chain.mjs';
import { ALLOW_REVOTE_CHAIN_CONFIGURED, getConfig } from '../src/config.mjs';
import { createSealedDeal, finalizeShare, initGuardian } from '../src/guardians/index.mjs';
import { partialDecrypt } from '../src/guardians/threshold.mjs';
import { HttpError } from '../src/http.mjs';
import { relayVote } from '../src/relay.mjs';
import { createApp } from '../src/server.mjs';
import { electionsDiag } from '../src/superAdmin/diagnostics.mjs';
import { ciphertextForTally } from '../src/tallyOpen.mjs';

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

function listen(application) {
  return new Promise((resolve, reject) => {
    const s = application.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

describe('ALLOW_REVOTE', () => {
  test('defaults off and is refused while a chain is configured', async () => {
    assert.equal(getConfig({ allowRevote: false }).allowRevote, false);
    assert.equal(getConfig({}).allowRevote, false);
    assert.equal(getConfig({ allowRevote: true }).allowRevote, true);
    assert.throws(
      () => getConfig({ allowRevote: true, chainRpc: 'http://127.0.0.1:8545' }),
      new RegExp(ALLOW_REVOTE_CHAIN_CONFIGURED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-chain-'));
    try {
      await assert.rejects(
        () =>
          createApp({
            dataDir: tmp,
            quiet: true,
            port: 0,
            allowRevote: true,
            chain: { isConfigured: () => true, isReady: () => false },
          }),
        /ALLOW_REVOTE cannot be on while a chain is configured/,
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a replacement keeps the published block and the public ballot hash', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 0,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      const cfg = await api('GET', '/api/config');
      assert.equal(cfg.json.allowRevote, true);
      await api('POST', '/api/auth/dev-login', {
        body: { handle: 'admin', role: 'platform_admin' },
        jar: adminJar,
      });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Revote poll',
          electionType: 'poll',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [
            {
              type: 'YES_NO',
              prompt: 'Sample?',
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No' },
              ],
            },
          ],
        },
      });
      assert.equal(election.status, 201, election.text);
      const id = election.json.id;
      const reg = await api('POST', `/api/elections/${id}/register`, {
        jar: adminJar,
        body: { identityCommitment: '0xca11' },
      });
      assert.equal(reg.status, 201, reg.text);
      const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
      assert.equal(freeze.status, 200, freeze.text);

      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: '0xabc', electionId: id },
          encryptedBallot: '0x01',
          identityCommitment: '0xca11',
        },
      });
      assert.equal(first.status, 201, first.text);
      const publishedHash = first.json.vote.ballotHash;
      const blocks = JSON.stringify(created.explorer.chain.blocks);
      const txs = JSON.stringify(created.explorer.chain.txs);

      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: '0xabc', electionId: id },
          encryptedBallot: '0x02',
          identityCommitment: '0xca11',
        },
      });
      assert.equal(second.status, 201, second.text);
      assert.equal(second.json.vote.ballotHash, publishedHash);
      assert.notEqual(second.json.receipt.ballotHash, publishedHash);
      assert.equal(JSON.stringify(second.json.vote).includes(second.json.receipt.ballotHash), false);
      assert.equal(JSON.stringify(created.explorer.chain.blocks), blocks);
      assert.equal(JSON.stringify(created.explorer.chain.txs), txs);

      const row = created.store.findVote(id, '0xabc');
      assert.equal(row.ballotHash, publishedHash);
      assert.equal(row.publishedBallotHash, publishedHash);
      assert.equal(created.store.requireElection(id).acceptedBallots, 1);
      assert.equal(created.store.listVotes(id).length, 1);
      const envelopes = created.store.listEnvelopes(id);
      assert.equal(envelopes.length, 1);
      assert.equal(envelopes[0].encryptedBallot, '0x01');
      assert.equal(envelopes[0].tallyEncryptedBallot, '0x02');

      const listed = await api('GET', `/api/elections/${id}/ballots`);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.json.ballots.length, 1);
      assert.equal(listed.json.ballots[0].ballotHash, publishedHash);
      assert.equal(listed.text.includes(second.json.receipt.ballotHash), false);

      const checked = await api('POST', '/api/receipts/verify', {
        body: { ballotHash: second.json.receipt.ballotHash, electionId: id },
      });
      assert.equal(checked.status, 200, checked.text);
      assert.equal(checked.json.counted, true);
      assert.equal(checked.json.ballotHash, second.json.receipt.ballotHash);
      const firstChecked = await api('POST', '/api/receipts/verify', {
        body: { ballotHash: publishedHash, electionId: id },
      });
      assert.equal(firstChecked.status, 200, firstChecked.text);
      assert.equal(firstChecked.json.counted, true);
      assert.equal(firstChecked.json.ballotHash, publishedHash);

      created.store.data.envelopes = created.store.data.envelopes.filter((env) => env.nullifier !== row.nullifier);
      await created.store.replaceVote(
        {
          nullifier: row.nullifier,
          ballotHash: '0x99',
          electionId: id,
          relayer: 'node',
          acceptedAt: row.acceptedAt,
        },
        { encryptedBallot: '0x03' },
      );
      const rebuilt = created.store.listEnvelopes(id);
      assert.equal(rebuilt.length, 1);
      assert.equal(rebuilt[0].encryptedBallot, null);
      assert.equal(rebuilt[0].tallyEncryptedBallot, '0x03');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a later hour keeps the first block and the replacement receipt time', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-hour-'));
    let now = 1_700_000_000;
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 3600,
      nowFn: () => now,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', {
        body: { handle: 'admin', role: 'platform_admin' },
        jar: adminJar,
      });
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Hourly revote',
          electionType: 'vote',
          startTime: now - 10,
          cutoffTime: now + 20_000,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }],
        },
      });
      assert.equal(election.status, 201, election.text);
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(first.status, 201, first.text);
      const sealed = created.explorer.chain.sealed.length;
      now += 3600;
      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x02', identityCommitment: '0xca11' },
      });
      assert.equal(second.status, 201, second.text);
      assert.equal(second.json.receipt.acceptedAt, first.json.receipt.acceptedAt + 3600);
      assert.equal(created.explorer.chain.sealed.length, sealed);
      assert.equal(second.json.vote.ballotHash, first.json.vote.ballotHash);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('the same vote pass can replace that ballot and cannot be reused by another', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-pass-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 0,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Pass revote',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      for (const commitment of ['0xca11', '0xca12']) {
        assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: commitment } })).status, 201);
      }
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const pass = await created.votePass.mintForTest(id);
      const other = await created.votePass.mintForTest(id);
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(first.status, 201, first.text);
      const again = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x02', identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(again.status, 201, again.text);
      const stolen = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xdef', electionId: id }, encryptedBallot: '0x03', identityCommitment: '0xca12', votePass: pass },
      });
      assert.equal(stolen.status, 409, stolen.text);
      assert.equal(stolen.json.code, 'VOTE_PASS_SPENT');
      const secondVoter = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xdef', electionId: id }, encryptedBallot: '0x04', identityCommitment: '0xca12', votePass: other },
      });
      assert.equal(secondVoter.status, 201, secondVoter.text);
      const cross = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x05', identityCommitment: '0xca11', votePass: other },
      });
      assert.equal(cross.status, 409, cross.text);
      assert.equal(cross.json.code, 'VOTE_PASS_SPENT');
      const hashes = created.store.data.votePassSpent[id];
      const tags = created.store.data.votePassTags;
      assert.ok(Array.isArray(tags) && tags.length >= 1);
      assert.deepEqual(tags, [...tags].sort());
      for (const row of created.store.listVotes(id)) {
        assert.equal(Object.hasOwn(row, 'spentPassHash'), false);
      }
      for (const tag of tags) {
        assert.equal(hashes.includes(tag), false);
        assert.equal(tag.length, 64);
      }
      const voteJson = JSON.stringify(created.store.listVotes(id));
      for (const hash of hashes) assert.equal(voteJson.includes(hash), false);
      await assert.rejects(
        () => created.store.acceptVote({
          nullifier: '0xabc',
          ballotHash: '0x11',
          electionId: id,
          relayer: 'node',
          acceptedAt: now,
        }, { encryptedBallot: '0x06' }),
        (err) => err instanceof HttpError && err.extra?.code === 'NULLIFIER_USED',
      );
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('racing first submits keep one explorer row and one ballot', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-race-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 3600,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Race',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const origAccept = created.store.acceptVote.bind(created.store);
      let entered = 0;
      let releaseFirst;
      const secondEntered = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      created.store.acceptVote = async (...args) => {
        entered += 1;
        if (entered === 1) {
          await secondEntered;
          return origAccept(...args);
        }
        releaseFirst();
        await new Promise((resolve) => setImmediate(resolve));
        return origAccept(...args);
      };
      const body = { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' };
      const [a, b] = await Promise.all([
        api('POST', `/api/elections/${id}/vote`, { body }),
        api('POST', `/api/elections/${id}/vote`, { body }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 409]);
      assert.equal(created.store.listVotes(id).length, 1);
      assert.equal(created.store.requireElection(id).acceptedBallots, 1);
      assert.equal(created.explorer.chain.sealed.length, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a failed queue rolls the ballot back', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-rollback-'));
    const adminJar = {};
    const chain = {
      isConfigured: () => true,
      isReady: () => true,
      async createElection() {
        return { onChainElectionId: '1', params: {} };
      },
      async submitVote() {
        throw new Error('queue failed');
      },
      async flushVoteQueue() {
        return [];
      },
    };
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 3600,
      chain,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Rollback',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const pass = await created.votePass.mintForTest(id);
      const cast = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11', votePass: pass },
      });
      assert.notEqual(cast.status, 201, cast.text);
      assert.equal(created.store.listVotes(id).length, 0);
      assert.equal(created.store.listEnvelopes(id).length, 0);
      assert.equal((created.store.data.receipts || []).filter((row) => String(row.electionId) === String(id)).length, 0);
      assert.equal(created.store.requireElection(id).acceptedBallots, 0);
      assert.equal(created.explorer.chain.sealed.length, 0);
      assert.equal(created.store.votePassSpent(id, created.store.data.votePassSpent?.[id]?.[0]), false);
      const spent = created.store.data.votePassSpent?.[id];
      assert.equal(Array.isArray(spent) ? spent.length : 0, 0);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a mined proof resubmitted is 409 and does not dead-letter the hour', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-replay-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 3600,
    });
    const spent = new Set();
    const sent = [];
    const chain = createChain(
      {
        chainRpc: 'http://127.0.0.1:9',
        ballotInboxAddress: '0x0000000000000000000000000000000000000001',
        disclosureIntervalSeconds: 3600,
        chainId: 31337,
        nowFn: () => 1_700_003_600,
        quiet: true,
      },
      {
        queueStore: created.store,
        nullifierSpent: async (_electionId, nullifier) => spent.has(BigInt(nullifier).toString()),
        writeSubmitBatch: async ({ batch }) => {
          if (batch.some((row) => spent.has(BigInt(row.nullifier).toString()))) {
            const err = new Error('execution reverted');
            err.revert = true;
            throw err;
          }
          sent.push(batch.map((row) => BigInt(row.nullifier).toString()));
          return { hash: '0xabc', batched: true, count: batch.length };
        },
      },
    );
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = 1_700_003_600;
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Replay',
          startTime: now - 10,
          cutoffTime: now + 10_000,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      for (const commitment of ['0xca11', '0xca12']) {
        assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: commitment } })).status, 201);
      }
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const bodyFor = (nullifier, encryptedBallot) => ({
        proof: { accept: true },
        publicInputs: { nullifier, electionId: id },
        encryptedBallot,
        identityCommitment: nullifier === '0xabc' ? '0xca11' : '0xca12',
      });
      const first = await relayVote({
        store: created.store,
        explorer: created.explorer,
        chain,
        config: created.config,
        electionId: id,
        body: bodyFor('0xabc', '0x01'),
        now,
        intervalSeconds: 3600,
      });
      assert.equal(first.ok, true);
      const queuedNullifier = created.store.loadChainVoteQueue().rows[0].nullifier;
      spent.add(BigInt(queuedNullifier).toString());
      await chain.dropQueuedVote(created.store.requireElection(id).onChainElectionId || id, '0xabc');
      await assert.rejects(
        () => relayVote({
          store: created.store,
          explorer: created.explorer,
          chain,
          config: created.config,
          electionId: id,
          body: bodyFor('0xabc', '0xevil'),
          now,
          intervalSeconds: 3600,
        }),
        (err) => err instanceof HttpError && err.extra?.code === 'NULLIFIER_USED',
      );
      assert.equal(created.store.loadChainVoteQueue().rows.length, 0);
      await relayVote({
        store: created.store,
        explorer: created.explorer,
        chain,
        config: created.config,
        electionId: id,
        body: bodyFor('0xdef', '0x02'),
        now,
        intervalSeconds: 3600,
      });
      const flushed = await chain.flushVoteQueue(now + 3600);
      assert.equal(chain.deadLettersFor(created.store.requireElection(id).onChainElectionId || id).length, 0);
      assert.equal(flushed.some((row) => row.deadLetter), false);
      assert.deepEqual(sent, [[BigInt('0xdef').toString()]]);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a replacement Yes is the certified tally and a dead letter blocks it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-revote-tally-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      allowRevote: true,
      disclosureIntervalSeconds: 0,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Replacement tally',
          startTime: now - 10,
          cutoffTime: now + 3600,
          questions: [{ type: 'YES_NO', prompt: 'Adopt?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }],
          jurisdictionId: 'demo',
          tallyScheme: 'opens_ballots',
          threshold: 2,
          guardianCount: 2,
        },
      });
      assert.equal(election.status, 201, election.text);
      const id = election.json.id;
      const secrets = [];
      for (let i = 1; i <= 2; i += 1) secrets.push(await initGuardian({ index: i, guardianId: `g${i}` }));
      for (const secret of secrets) {
        assert.equal((await api('POST', `/api/elections/${id}/guardians`, {
          jar: adminJar,
          body: { guardianId: secret.guardianId, label: secret.guardianId, transportPublicKey: secret.transportPublicKey },
        })).status, 201);
      }
      const roster = secrets.map((secret) => ({ index: secret.index, transportPublicKey: secret.transportPublicKey }));
      const deals = [];
      for (const secret of secrets) {
        const deal = await createSealedDeal({ index: secret.index, threshold: 2, roster });
        deals.push(deal);
        assert.equal((await api('POST', `/api/elections/${id}/guardians/deals`, { jar: adminJar, body: deal })).status, 201);
      }
      const shares = [];
      for (const secret of secrets) {
        shares.push(await finalizeShare({
          index: secret.index,
          privateJwk: secret.transportPrivateJwk,
          deals,
          threshold: 2,
          guardianCount: 2,
        }));
      }
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const pub = created.store.requireElection(id).tallyPubKey;
      const no = encryptAggregateBallot({ jointPublicKey: pub, choice: 1, choiceRandomness: 11n, nOptions: 2 });
      const yes = encryptAggregateBallot({ jointPublicKey: pub, choice: 0, choiceRandomness: 12n, nOptions: 2 });
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: no.encryptedBallot, identityCommitment: '0xca11' },
      });
      assert.equal(first.status, 201, first.text);
      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: yes.encryptedBallot, identityCommitment: '0xca11' },
      });
      assert.equal(second.status, 201, second.text);
      const stored = created.store.requireElection(id);
      stored.cutoffTime = now - 1;
      await created.store.persist();
      const blocked = {
        ...created.chain,
        deadLettersFor: () => [{ nullifier: '1' }],
      };
      created.chain.deadLettersFor = blocked.deadLettersFor;
      const refused = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: {} });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'CHAIN_DEAD_LETTER');
      created.chain.deadLettersFor = () => [];
      const envelopes = created.store.listEnvelopes(id);
      const product = (await import('../src/aggregateBallot.mjs')).aggregateCiphertexts(envelopes.map((env) => ciphertextForTally(env)));
      for (const share of shares) {
        const posted = await api('POST', `/api/elections/${id}/guardians/partials`, {
          jar: adminJar,
          body: {
            index: share.index,
            partials: product.options.map((opt, j) => partialDecrypt({
              shareScalar: share.shareScalar,
              index: share.index,
              electionId: id,
              ballotHash: `aggregate:${j}`,
              jointPublicKey: share.jointPublicKey,
              ephemeral: opt.c1Hex,
            })),
          },
        });
        assert.equal(posted.status, 201, posted.text);
      }
      const tally = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: {} });
      assert.equal(tally.status, 200, tally.text);
      assert.deepEqual(tally.json.election.tally.counts, [1, 0]);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('with re-vote off, a spent pass is refused even for the same nullifier', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-pass-once-'));
    const adminJar = {};
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Pass once',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const pass = await created.votePass.mintForTest(id);
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(first.status, 201, first.text);
      const again = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x02', identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(again.status, 409, again.text);
      assert.equal(again.json.code, 'VOTE_PASS_SPENT');
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('tally waits while a ballot is still queued', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-tally-queued-'));
    const adminJar = {};
    const chain = createChain(
      {
        chainRpc: 'http://127.0.0.1:9',
        ballotInboxAddress: '0x0000000000000000000000000000000000000001',
        disclosureIntervalSeconds: 3600,
        chainId: 31337,
        quiet: true,
      },
      { writeSubmitBatch: async () => ({ hash: '0xabc', batched: true, count: 1 }) },
    );
    chain.createElection = async () => ({ onChainElectionId: '1', params: {} });
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 3600,
      chain,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Queued tally',
          startTime: now - 10,
          cutoffTime: now + 3600,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const cast = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(cast.status, 201, cast.text);
      const stored = created.store.requireElection(id);
      stored.cutoffTime = now - 1;
      await created.store.persist();
      const refused = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [1, 0] } });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'CHAIN_QUEUE_PENDING');
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a writer can exclude a dead letter and the tally then shows the count', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-exclude-'));
    const adminJar = {};
    const chain = createChain(
      {
        chainRpc: 'http://127.0.0.1:9',
        ballotInboxAddress: '0x0000000000000000000000000000000000000001',
        disclosureIntervalSeconds: 3600,
        chainId: 31337,
        quiet: true,
      },
      {
        queueStore: null,
        nullifierSpent: async () => false,
        writeSubmitBatch: async () => {
          const err = new Error('execution reverted');
          err.revert = true;
          throw err;
        },
      },
    );
    chain.createElection = async () => ({ onChainElectionId: '1', params: {} });
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 3600,
      chain,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      const now = Math.floor(Date.now() / 1000);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Exclude',
          startTime: now - 10,
          cutoffTime: now + 7200,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const cast = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(cast.status, 201, cast.text);
      const onChain = created.store.requireElection(id).onChainElectionId;
      const at = now + 8000;
      await chain.flushVoteQueue(at);
      await chain.flushVoteQueue(at + REVERT_RETRY_BACKOFF_SECONDS);
      await chain.flushVoteQueue(at + REVERT_RETRY_BACKOFF_SECONDS * 2);
      assert.equal(chain.deadLettersFor(onChain).length, 1);
      const stored = created.store.requireElection(id);
      const acceptedAt = created.store.listVotes(id)[0].acceptedAt;
      let tick = Math.floor(Date.now() / 1000);
      if (tick <= acceptedAt) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        tick = Math.floor(Date.now() / 1000);
      }
      stored.cutoffTime = tick;
      await created.store.persist();
      assert.ok(acceptedAt < stored.cutoffTime);
      const refused = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [1, 0] } });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'CHAIN_DEAD_LETTER');
      assert.equal(created.store.listVotes(id).length, 1);
      const nullifier = chain.deadLettersFor(onChain)[0].nullifier;
      const excluded = await api('POST', `/api/elections/${id}/chain-dead-letter/exclude`, {
        jar: adminJar,
        body: { nullifier, reason: 'The chain batch reverted and the supplementary batch is not available.' },
      });
      assert.equal(excluded.status, 200, excluded.text);
      assert.equal(excluded.json.excluded.count, 1);
      const tally = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [1, 0] } });
      assert.equal(tally.status, 200, tally.text);
      assert.equal(tally.json.election.tally.excluded.count, 1);
      const results = await api('GET', `/api/elections/${id}/results`);
      assert.equal(results.json.results.excludedCount, 1);
      assert.equal(results.json.results.excludedReasons[0].reason.includes('reverted'), true);
      const diag = electionsDiag(created.store, tick);
      assert.equal(diag.elections.find((row) => row.id === String(id)).excludedCount, 1);
      assert.equal(created.store.listVotes(id).length, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a marked ballot is not repaired, and a second repair waits', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-repair-limit-'));
    const chain = createChain(
      {
        chainRpc: 'http://127.0.0.1:9',
        ballotInboxAddress: '0x0000000000000000000000000000000000000001',
        disclosureIntervalSeconds: 3600,
        chainId: 31337,
        quiet: true,
      },
      { writeSubmitBatch: async () => ({ hash: '0xabc', batched: true, count: 1 }) },
    );
    chain.createElection = async () => ({ onChainElectionId: '1', params: {} });
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 3600,
      chain,
    });
    const server = await listen(created.app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const adminJar = {};
    const api = async (method, url, { body, jar } = {}) => {
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
      return { status: res.status, json, text };
    };
    try {
      const now = Math.floor(Date.now() / 1000);
      const admin = await api('POST', '/api/auth/dev-login', { body: { handle: 'admin', role: 'platform_admin' }, jar: adminJar });
      assert.equal(admin.status, 200, admin.text);
      const election = await api('POST', '/api/elections', {
        jar: adminJar,
        body: {
          title: 'Repair limit',
          startTime: now - 10,
          cutoffTime: now + 7200,
          treeDepth: 16,
          questions: [{ type: 'YES_NO', prompt: 'Sample?' }],
        },
      });
      assert.equal(election.status, 201, election.text);
      const id = election.json.id;
      assert.equal((await api('POST', `/api/elections/${id}/register`, { jar: adminJar, body: { identityCommitment: '0xca11' } })).status, 201);
      assert.equal((await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar })).status, 200);
      const cast = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(cast.status, 201, cast.text);
      const onChain = created.store.requireElection(id).onChainElectionId;
      await chain.dropQueuedVote(onChain, '0xabc');
      let calls = 0;
      const orig = chain.nullifierChainState.bind(chain);
      chain.nullifierChainState = async (...args) => {
        calls += 1;
        return orig(...args);
      };
      const marked = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(marked.status, 409, marked.text);
      assert.equal(calls, 0);
      const payload = created.store.chainBallotPayload(id, '0xabc');
      delete payload.chainQueuedAt;
      delete payload.chainTxHash;
      await created.store.persist();
      const repaired = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(repaired.status, 409, repaired.text);
      assert.equal(calls, 1);
      await chain.dropQueuedVote(onChain, '0xabc');
      delete created.store.chainBallotPayload(id, '0xabc').chainQueuedAt;
      const limited = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11' },
      });
      assert.equal(limited.status, 409, limited.text);
      assert.equal(calls, 1);
      assert.equal(created.store.listVotes(id).length, 1);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
