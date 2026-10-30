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
import { dropPassToBallotLinks } from '../src/store.mjs';
import {
  DEFAULT_TALLY_CHALLENGE_SECONDS,
  MIN_TALLY_CHALLENGE_SECONDS,
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

function installDom() {
  class Node {
    constructor(type) {
      this.nodeType = type;
      this.childNodes = [];
    }
    append(...kids) {
      for (const kid of kids) this.childNodes.push(kid);
    }
    get textContent() {
      if (this.nodeType === 3) return this.data || '';
      return this.childNodes.map((child) => (child.textContent == null ? '' : child.textContent)).join('');
    }
    set textContent(value) {
      const text = new Node(3);
      text.data = String(value);
      this.childNodes = [text];
    }
    replaceChildren(...kids) {
      this.childNodes = kids.flat().filter((child) => child != null && child !== false);
    }
    focus() {}
  }
  class Element extends Node {
    constructor(tag) {
      super(1);
      this.tagName = String(tag).toUpperCase();
      this.attrs = {};
      this.className = '';
      this.style = {};
      this.dataset = {};
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }
    addEventListener() {}
  }
  globalThis.document = {
    createElement(tag) {
      return new Element(tag);
    },
    createTextNode(value) {
      const text = new Node(3);
      text.data = String(value);
      return text;
    },
  };
}

function domH(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function renderExcludedNotice(payload) {
  installDom();
  const { renderResults } = await import('../public/results.js');
  const main = document.createElement('main');
  await renderResults(main, {
    h: domH,
    api: async () => payload,
    loadElection: async () => ({ election: null }),
    formatTime: (value) => String(value ?? ''),
    electionStateInfo: () => ({ className: 'status-tallied', label: 'Tallied' }),
    electionId: payload.id || payload.electionId || 'election',
    SAMPLE_QUESTIONS: [],
  });
  return main.textContent;
}

describe('ALLOW_REVOTE', () => {
  test('defaults off and is refused while a chain is configured', async () => {
    assert.equal(getConfig({ allowRevote: false }).allowRevote, false);
    assert.equal(getConfig({}).allowRevote, false);
    assert.equal(getConfig({ allowRevote: true }).allowRevote, true);
    assert.equal(getConfig({}).tallyChallengeSeconds, MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(getConfig({ tallyChallengeSeconds: 0 }).tallyChallengeSeconds, MIN_TALLY_CHALLENGE_SECONDS);
    assert.equal(getConfig({ tallyChallengeSeconds: 90 }).tallyChallengeSeconds, 90);
    assert.equal(resolveTallyChallengeSeconds(undefined, { isTest: false }), DEFAULT_TALLY_CHALLENGE_SECONDS);
    assert.equal(tallyAllowedAt({ cutoffTime: 100 }, 60), 160);
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

  test('a replacement Yes is the final tally and a dead letter blocks it', async () => {
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
    const queue = {
      saved: { rows: [], batchAt: {}, inFlight: {}, deadLetter: [], attempts: {}, supplementary: [] },
      loadChainVoteQueue() {
        return JSON.parse(JSON.stringify(this.saved));
      },
      async saveChainVoteQueue(doc) {
        this.saved = JSON.parse(JSON.stringify(doc || {}));
      },
    };
    const chain = createChain(
      {
        chainRpc: 'http://127.0.0.1:9',
        ballotInboxAddress: '0x0000000000000000000000000000000000000001',
        disclosureIntervalSeconds: 3600,
        chainId: 31337,
        quiet: true,
      },
      {
        queueStore: queue,
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
      const window = created.config.tallyChallengeSeconds;
      stored.cutoffTime = tick - window;
      await created.store.persist();
      assert.ok(acceptedAt < stored.cutoffTime);
      const nullifier = chain.deadLettersFor(onChain)[0].nullifier;
      const tooSoon = await api('POST', `/api/elections/${id}/chain-dead-letter/exclude`, {
        jar: adminJar,
        body: { nullifier, reason: 'too soon' },
      });
      stored.cutoffTime = tick + 3600;
      await created.store.persist();
      const open = await api('POST', `/api/elections/${id}/chain-dead-letter/exclude`, {
        jar: adminJar,
        body: { nullifier, reason: 'still open' },
      });
      assert.equal(open.status, 409, open.text);
      assert.equal(open.json.code, 'NOT_CLOSED');
      stored.cutoffTime = tick - window;
      await created.store.persist();
      assert.equal(tooSoon.status, 409, tooSoon.text);
      assert.equal(tooSoon.json.code, 'REPLAY_REQUIRED');
      queue.saved.deadLetter[0].row = { nullifier: 'nope' };
      chain.reloadVoteQueue();
      const replay = await api('POST', `/api/elections/${id}/chain-dead-letter/replay`, {
        jar: adminJar,
        body: { nullifier },
      });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.json.restored, 0);
      assert.ok(replay.json.kept >= 1);
      const refused = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [0, 0] } });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json.code, 'CHAIN_DEAD_LETTER');
      assert.equal(created.store.listVotes(id).length, 1);
      const excluded = await api('POST', `/api/elections/${id}/chain-dead-letter/exclude`, {
        jar: adminJar,
        body: { nullifier, reason: 'The chain batch reverted and the supplementary batch is not available.' },
      });
      assert.equal(excluded.status, 200, excluded.text);
      assert.equal(excluded.json.excluded.count, 1);
      assert.equal(JSON.stringify(excluded.json).includes(String(nullifier)), false);
      const audit = Object.values(created.explorer.chain.txs).find((tx) => tx.type === 'ballot_excluded');
      assert.equal(audit.payload.count, 1);
      assert.equal(audit.payload.reason.includes('reverted'), true);
      assert.equal(Object.hasOwn(audit.payload, 'nullifier'), false);
      const counted = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [1, 0] } });
      assert.equal(counted.status, 400, counted.text);
      const tally = await api('POST', `/api/elections/${id}/tally`, { jar: adminJar, body: { counts: [0, 0] } });
      assert.equal(tally.status, 200, tally.text);
      assert.deepEqual(tally.json.election.tally.counts, [0, 0]);
      assert.equal(tally.json.election.tally.excluded.count, 1);
      const results = await api('GET', `/api/elections/${id}/results`);
      assert.equal(results.json.results.excludedCount, 1);
      assert.match(results.json.results.message, /not counted/i);
      assert.equal(results.json.results.excludedReasons[0].reason.includes('reverted'), true);
      const page = await renderExcludedNotice(results.json);
      assert.match(page, new RegExp(`${results.json.results.excludedCount}[^<]{0,80}not counted`, 'i'));
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
