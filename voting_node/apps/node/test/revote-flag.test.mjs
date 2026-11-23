// NOT FOR PROFIT — civic public good, not a commercial product.
// ALLOW_REVOTE (polls): a later ballot replaces the earlier one in the node's
// count. A published block keeps the first ballot hash.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { encryptAggregateBallot } from '../src/aggregateBallot.mjs';
import { getConfig } from '../src/config.mjs';
import { createSealedDeal, finalizeShare, initGuardian } from '../src/guardians/index.mjs';
import { partialDecrypt } from '../src/guardians/threshold.mjs';
import { HttpError } from '../src/http.mjs';
import { createApp } from '../src/server.mjs';
import { electionsDiag } from '../src/superAdmin/diagnostics.mjs';
import { dropPassToBallotLinks, EXCLUSION_APPROVAL_TTL_SECONDS, Store } from '../src/store.mjs';
import {
  DEFAULT_TALLY_CHALLENGE_SECONDS,
  MIN_TALLY_CHALLENGE_SECONDS,
  PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS,
  resolveTallyChallengeSeconds,
  tallyAllowedAt,
} from '../src/supplementaryBatch.mjs';
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
  test('defaults off; the tally challenge window has a floor', () => {
    assert.equal(getConfig({ allowRevote: false }).allowRevote, false);
    assert.equal(getConfig({}).allowRevote, false);
    assert.equal(getConfig({ allowRevote: true }).allowRevote, true);
    assert.equal(getConfig({}).tallyChallengeSeconds, MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(getConfig({ tallyChallengeSeconds: 0 }).tallyChallengeSeconds, MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(getConfig({ tallyChallengeSeconds: 90 }).tallyChallengeSeconds, 90);
    assert.equal(resolveTallyChallengeSeconds(undefined, { isTest: false }), DEFAULT_TALLY_CHALLENGE_SECONDS);
    assert.equal(resolveTallyChallengeSeconds(0, { isProduction: true }), PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(resolveTallyChallengeSeconds(90, { isProduction: true }), PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(resolveTallyChallengeSeconds(DEFAULT_TALLY_CHALLENGE_SECONDS, { isProduction: true }), DEFAULT_TALLY_CHALLENGE_SECONDS);
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      assert.equal(resolveTallyChallengeSeconds(-3, { isProduction: true }), PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS);
      assert.equal(resolveTallyChallengeSeconds(-3, { isProduction: true }), PRODUCTION_MIN_TALLY_CHALLENGE_SECONDS);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = origWarn;
    }
    assert.equal(tallyAllowedAt({ cutoffTime: 100 }, 60), 160);
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
      const pass = await created.votePass.mintForTest(id);
      const freeze = await api('POST', `/api/elections/${id}/freeze`, { jar: adminJar });
      assert.equal(freeze.status, 200, freeze.text);

      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: {
          proof: { accept: true },
          publicInputs: { nullifier: '0xabc', electionId: id },
          encryptedBallot: '0x01',
          identityCommitment: '0xca11',
          votePass: pass,
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
          votePass: pass,
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
      assert.equal(checked.status, 404, checked.text);
      assert.equal(checked.json.counted, false);
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
          spentPassHash: created.store.data.votePassSpent[id][0],
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
      const pass = await created.votePass.mintForTest(id);
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x01', identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(first.status, 201, first.text);
      const sealed = created.explorer.chain.sealed.length;
      now += 3600;
      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x02', identityCommitment: '0xca11', votePass: pass },
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
      assert.equal(cross.status, 201, cross.text);
      const hashes = created.store.data.votePassSpent[id];
      assert.equal(created.store.data.votePassTags, undefined);
      const linked = JSON.stringify({
        votes: created.store.listVotes(id),
        receipts: created.store.data.receipts,
        envelopes: created.store.listEnvelopes(id),
        payloads: created.store.data.chainBallotPayloads,
      });
      for (const row of created.store.listVotes(id)) {
        assert.equal(Object.hasOwn(row, 'spentPassHash'), false);
      }
      for (const hash of hashes) assert.equal(linked.includes(hash), false);
      created.store.data.votes[0].spentPassHash = hashes[0];
      created.store.data.votePassTags = ['aa'];
      assert.equal(dropPassToBallotLinks(created.store.data), true);
      assert.equal(created.store.data.votePassTags, undefined);
      assert.equal(Object.hasOwn(created.store.data.votes[0], 'spentPassHash'), false);
      const badProof = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: false }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x06', identityCommitment: '0xca11', votePass: pass },
      });
      assert.notEqual(badProof.status, 201, badProof.text);
      assert.equal(badProof.json.code === 'PROOF_INVALID' || badProof.json.code === 'VOTE_VK_MISSING', true);
      const badPass = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: '0x07', identityCommitment: '0xca11', votePass: { token: 'zz', signature: '1' } },
      });
      assert.equal(badPass.status, 400, badPass.text);
      assert.equal(badPass.json.code, 'VOTE_PASS_BAD');
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

  test('a replacement Yes is the final tally', async () => {
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
      const pass = await created.votePass.mintForTest(id);
      const no = encryptAggregateBallot({ jointPublicKey: pub, choice: 1, choiceRandomness: 11n, nOptions: 2 });
      const yes = encryptAggregateBallot({ jointPublicKey: pub, choice: 0, choiceRandomness: 12n, nOptions: 2 });
      const first = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: no.encryptedBallot, identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(first.status, 201, first.text);
      const second = await api('POST', `/api/elections/${id}/vote`, {
        body: { proof: { accept: true }, publicInputs: { nullifier: '0xabc', electionId: id }, encryptedBallot: yes.encryptedBallot, identityCommitment: '0xca11', votePass: pass },
      });
      assert.equal(second.status, 201, second.text);
      const stored = created.store.requireElection(id);
      stored.cutoffTime = now - 1;
      await created.store.persist();
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

  test('an exclusion approval expires after 24 hours and shows the first reason', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'exclude-approval-'));
    try {
      const store = await Store.open({ dataDir: tmp, databaseUrl: '', quiet: true });
      const id = '11111111-1111-4111-8111-111111111111';
      store.data.elections.push({ id });
      const nullifier = '0x' + 'ab'.repeat(32);
      const at = 1_700_000_000;
      const pending = await store.noteExclusionApproval(id, {
        nullifier,
        userId: 'operator-a',
        reason: 'sealed batch reverted',
        at,
      });
      assert.equal(pending.status, 'pending');
      assert.equal(pending.reason, 'sealed batch reverted');
      assert.equal(pending.reasonCode, 'excluded');
      await assert.rejects(
        () =>
          store.noteExclusionApproval(id, {
            nullifier,
            userId: 'operator-a',
            reason: 'again',
            at: at + EXCLUSION_APPROVAL_TTL_SECONDS - 1,
          }),
        (err) => err instanceof HttpError && err.extra?.code === 'SAME_OPERATOR',
      );
      const expired = await store.noteExclusionApproval(id, {
        nullifier,
        userId: 'operator-a',
        reason: 'fresh after a day',
        at: at + EXCLUSION_APPROVAL_TTL_SECONDS,
      });
      assert.equal(expired.status, 'pending');
      assert.equal(expired.reason, 'fresh after a day');
      store.requireElection(id).exclusionApprovals[0].reasonCode = 'other';
      const rebound = await store.noteExclusionApproval(id, {
        nullifier,
        userId: 'operator-b',
        reason: 'tied to the public code',
        at: at + EXCLUSION_APPROVAL_TTL_SECONDS + 5,
      });
      assert.equal(rebound.status, 'pending');
      assert.equal(rebound.reasonCode, 'excluded');
      const shown = await store.noteExclusionApproval(id, {
        nullifier,
        userId: 'operator-c',
        reason: 'second note',
        at: at + EXCLUSION_APPROVAL_TTL_SECONDS + 10,
      });
      assert.equal(shown.status, 'ready');
      assert.equal(shown.reason, 'tied to the public code');
      assert.equal(shown.reasonCode, 'excluded');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('diagnostics list pending exclusion releases', () => {
    const store = {
      data: {
        elections: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            title: 'Pending release',
            startTime: 1,
            cutoffTime: 2,
            rollFrozen: true,
            acceptedBallots: 1,
            questions: [],
            excludedBallots: [
              { nullifier: '0x' + '11'.repeat(32), reasonCode: 'excluded', releasePending: true },
              { nullifier: '0x' + '22'.repeat(32), reasonCode: 'excluded' },
            ],
          },
        ],
        polls: [],
      },
      hiddenVoteCount() {
        return 0;
      },
    };
    const diag = electionsDiag(store, 10);
    const row = diag.elections[0];
    assert.equal(row.pendingReleases, 1);
    assert.equal(row.excludedCount, 2);
  });

});
