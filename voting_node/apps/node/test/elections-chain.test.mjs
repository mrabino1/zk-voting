// NOT FOR PROFIT — civic public good, not a commercial product.
// POST /api/elections drives ElectionFactory when CHAIN_RPC is set.
// Mocks the chain client; a live RPC test is skipped unless RUN_CHAIN_TESTS=1.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex } from 'viem';

import {
  chainElectionIdOf,
  createChain,
  decodeElectionCreated,
  electionFactoryAbi,
  resolveCreateElectionParams,
  toJurisdictionBytes32,
} from '../src/chain.mjs';
import { HttpError } from '../src/http.mjs';
import { createApp } from '../src/server.mjs';
import { isUuid } from '../src/electionIds.mjs';

// Anvil's public dev account #0 key (test-only; holds nothing).
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FACTORY = '0x1111111111111111111111111111111111111111';
const CLONE = '0x2222222222222222222222222222222222222222';
const VERIFIER = '0x3333333333333333333333333333333333333333';
const RELAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const runLive =
  process.env.RUN_CHAIN_TESTS === '1' &&
  Boolean(process.env.CHAIN_RPC) &&
  Boolean(process.env.ELECTION_FACTORY_ADDRESS || process.env.FACTORY) &&
  Boolean(process.env.RELAYER_PRIVATE_KEY) &&
  Boolean(process.env.VERIFIER_ADDRESS || process.env.VERIFIER);

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

async function boot(opts = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-chain-'));
  const created = await createApp({
    dataDir: tmp,
    allowDevLogin: true,
    adminHandle: 'admin',
    quiet: true,
    port: 0,
    disclosureIntervalSeconds: 0,
    ...opts,
  });
  const server = await listen(created.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function api(method, url, { body, jar: j } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(j ? { cookie: cookieHeader(j) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (j) applyCookies(res, j);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, json, text, status: res.status };
  }
  const login = await api('POST', '/api/auth/dev-login', { body: { handle: 'admin' }, jar });
  assert.equal(login.status, 200, login.json?.error);
  return {
    tmp,
    ...created,
    server,
    base,
    jar,
    api,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

function mockChain({
  configured = true,
  factoryReady = true,
  create,
  submitVote,
} = {}) {
  const calls = { create: [], submit: [] };
  return {
    calls,
    configured,
    ready: configured,
    isConfigured: () => configured,
    isReady: () => configured,
    isFactoryReady: () => factoryReady,
    async createElection(input) {
      calls.create.push(input);
      if (create) return create(input);
      return {
        onChainElectionId: '42',
        onChainElectionAddress: CLONE,
        createTxHash: `0x${'ab'.repeat(32)}`,
        factoryAddress: FACTORY,
        chainId: 27427,
        params: {
          clerk: RELAYER,
          registrar: RELAYER,
          disqualificationOfficer: RELAYER,
          tallyOperator: RELAYER,
          verifier: VERIFIER,
        },
      };
    },
    async submitVote(args) {
      calls.submit.push(args);
      if (submitVote) return submitVote(args);
      return { hash: `0x${'cd'.repeat(32)}` };
    },
  };
}

function electionBody(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    title: 'On-chain general',
    startTime: now - 60,
    cutoffTime: now + 3600,
    maxParticipants: 0,
    treeDepth: 16,
    jurisdictionId: 'demo',
    questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }],
    ...extra,
  };
}

describe('ElectionCreated log decode', () => {
  test('decodeElectionCreated reads factory logs', () => {
    const topics = encodeEventTopics({
      abi: electionFactoryAbi,
      eventName: 'ElectionCreated',
      args: {
        electionId: 7n,
        election: CLONE,
        jurisdictionId: keccak256(stringToHex('demo')),
      },
    });
    const data = encodeAbiParameters(
      [
        { name: 'startTime', type: 'uint64' },
        { name: 'cutoffTime', type: 'uint64' },
      ],
      [1n, 2n],
    );
    const decoded = decodeElectionCreated({ logs: [{ data, topics }] });
    assert.equal(decoded.electionId, 7n);
    assert.equal(String(decoded.election).toLowerCase(), CLONE.toLowerCase());
  });
});

describe('factory param helpers', () => {
  test('toJurisdictionBytes32 hashes Node string ids', () => {
    assert.equal(toJurisdictionBytes32('demo'), keccak256(stringToHex('demo')));
    const raw = `0x${'ab'.repeat(32)}`;
    assert.equal(toJurisdictionBytes32(raw), raw);
  });

  test('resolveCreateElectionParams defaults officers to relayer', () => {
    const params = resolveCreateElectionParams(
      { verifierAddress: VERIFIER },
      {
        title: 'T',
        metadataURI: '',
        startTime: 1,
        cutoffTime: 2,
        maxParticipants: 0,
        treeDepth: 20,
        ballotSpecHash: `0x${'11'.repeat(32)}`,
        questions: [{ type: 'YES_NO' }],
        jurisdictionId: 'demo',
      },
      RELAYER,
    );
    assert.equal(params.clerk, RELAYER);
    assert.equal(params.verifier, VERIFIER);
    assert.equal(params.questionCount, 1);
    assert.equal(params.jurisdictionId, keccak256(stringToHex('demo')));
  });

  test('resolveCreateElectionParams requires verifier when chain env is used', () => {
    assert.throws(
      () =>
        resolveCreateElectionParams(
          {},
          {
            title: 'T',
            startTime: 1,
            cutoffTime: 2,
            treeDepth: 20,
            ballotSpecHash: `0x${'11'.repeat(32)}`,
            questions: [{ type: 'YES_NO' }],
            jurisdictionId: 'demo',
          },
          RELAYER,
        ),
      (err) => err instanceof HttpError && err.status === 503 && err.extra.code === 'CHAIN_NOT_READY',
    );
  });

  test('chainElectionIdOf prefers on-chain id', () => {
    assert.equal(chainElectionIdOf({ id: 1, onChainElectionId: '99' }), '99');
    assert.equal(chainElectionIdOf({ id: 1 }), '1');
  });
});

describe('POST /api/elections with mocked factory', () => {
  const apps = [];
  after(async () => {
    for (const a of apps) await a.close();
  });

  test('JSON-only demo does not call the factory', async () => {
    const chain = mockChain({ configured: false });
    chain.createElection = async () => {
      throw new Error('factory must not be called in demo mode');
    };
    const ctx = await boot({ chain });
    apps.push(ctx);
    const { status, json } = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody(),
    });
    assert.equal(status, 201, json?.error);
    assert.equal(json.chainMode, 'demo');
    assert.match(String(json.onChainElectionId), /^\d+$/);
    assert.equal(json.onChainElectionAddress, null);
    assert.equal(isUuid(json.election.id), true);
    assert.equal(chain.calls.create.length, 0);
  });

  test('configured chain persists Node id ↔ on-chain id mapping', async () => {
    const chain = mockChain();
    const ctx = await boot({ chain });
    apps.push(ctx);
    const { status, json } = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody({ title: 'Mapped' }),
    });
    assert.equal(status, 201, json?.error);
    assert.equal(json.chainMode, 'onchain');
    assert.equal(json.onChainElectionId, '42');
    assert.equal(json.onChainElectionAddress.toLowerCase(), CLONE.toLowerCase());
    assert.equal(isUuid(json.election.id), true);
    assert.equal(json.election.onChainElectionId, '42');
    assert.equal(json.election.chainMode, 'onchain');
    assert.equal(json.election.factoryAddress.toLowerCase(), FACTORY.toLowerCase());
    assert.ok(json.createTxHash);
    assert.equal(chain.calls.create.length, 1);
    assert.equal(chain.calls.create[0].title, 'Mapped');
    const stored = ctx.store.requireElection(json.election.id);
    assert.equal(stored.onChainElectionId, '42');
    assert.equal(ctx.store.getElectionByOnChainId('42')?.id, stored.id);
    const listed = await ctx.api('GET', '/api/elections');
    assert.equal(listed.json.elections[0].onChainElectionId, '42');
  });

  test('factory failure returns 502 and does not write zk-voting.json', async () => {
    const chain = mockChain({
      create: async () => {
        throw new HttpError(502, 'ElectionFactory createElection failed: revert MissingRole', {
          code: 'CHAIN_CREATE_FAILED',
        });
      },
    });
    const ctx = await boot({ chain });
    apps.push(ctx);
    const { status, json } = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody(),
    });
    assert.equal(status, 502);
    assert.match(json.error, /ElectionFactory createElection failed/);
    assert.equal(json.code, 'CHAIN_CREATE_FAILED');
    assert.equal(ctx.store.listElections().length, 0);
  });

  test('CHAIN_RPC without factory address is 503 to the clerk', async () => {
    const ctx = await boot({
      chainRpc: 'http://127.0.0.1:8545',
      relayerPrivateKey: ANVIL_KEY,
      electionFactoryAddress: '',
      verifierAddress: VERIFIER,
    });
    apps.push(ctx);
    const { status, json } = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody(),
    });
    assert.equal(status, 503);
    assert.equal(json.code, 'CHAIN_NOT_READY');
    assert.match(json.error, /ELECTION_FACTORY_ADDRESS/);
    assert.equal(ctx.store.listElections().length, 0);
  });

  test('CHAIN_RPC without verifier address is 503', async () => {
    const chain = createChain({
      chainRpc: 'http://127.0.0.1:8545',
      chainId: 27427,
      relayerPrivateKey: ANVIL_KEY,
      electionFactoryAddress: FACTORY,
      verifierAddress: '',
      ballotInboxAddress: '',
    });
    const ctx = await boot({ chain });
    apps.push(ctx);
    const { status, json } = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody(),
    });
    assert.equal(status, 503);
    assert.equal(json.code, 'CHAIN_NOT_READY');
    assert.match(json.error, /verifier/i);
  });

  test('GET /api/config describes factory vs demo', async () => {
    const demo = await boot();
    apps.push(demo);
    const demoCfg = await demo.api('GET', '/api/config');
    assert.equal(demoCfg.json.chainConfigured, false);
    assert.match(demoCfg.json.chain.note, /CHAIN_RPC unset/);

    const live = await boot({
      chainRpc: 'http://127.0.0.1:8545',
      relayerPrivateKey: ANVIL_KEY,
      electionFactoryAddress: FACTORY,
      verifierAddress: VERIFIER,
    });
    apps.push(live);
    const liveCfg = await live.api('GET', '/api/config');
    assert.equal(liveCfg.json.chainConfigured, true);
    assert.equal(liveCfg.json.electionFactoryAddress.toLowerCase(), FACTORY.toLowerCase());
    assert.equal(liveCfg.json.factoryReady, true);
    assert.match(liveCfg.json.chain.note, /ElectionFactory/);
  });

  test('vote relay submits the on-chain election id', async () => {
    const chain = mockChain();
    const ctx = await boot({ chain });
    apps.push(ctx);
    const created = await ctx.api('POST', '/api/elections', {
      jar: ctx.jar,
      body: electionBody({ startTime: Math.floor(Date.now() / 1000) - 10 }),
    });
    const id = created.json.election.id;
    const reg = await ctx.api('POST', `/api/elections/${id}/register`, {
      jar: ctx.jar,
      body: { identityCommitment: '0x1234' },
    });
    assert.equal(reg.status, 201, reg.json?.error);
    const freeze = await ctx.api('POST', `/api/elections/${id}/freeze`, { jar: ctx.jar });
    assert.equal(freeze.status, 200, freeze.json?.error);
    const vote = await ctx.api('POST', `/api/elections/${id}/vote`, {
      body: {
        proof: { accept: true },
        publicInputs: { nullifier: '7', electionId: id },
        identityCommitment: '0x1234',
        encryptedBallot: '0xab',
      },
    });
    assert.equal(vote.status, 201, vote.json?.error);
    assert.equal(chain.calls.submit.length, 1);
    assert.equal(String(chain.calls.submit[0].electionId), '42');
  });
});

test(
  'live ElectionFactory createElection (skipped without RUN_CHAIN_TESTS=1 and RPC env)',
  { skip: !runLive },
  async () => {
    const ctx = await boot({
      chainRpc: process.env.CHAIN_RPC,
      electionFactoryAddress: process.env.ELECTION_FACTORY_ADDRESS || process.env.FACTORY,
      relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
      verifierAddress: process.env.VERIFIER_ADDRESS || process.env.VERIFIER,
      ballotInboxAddress: process.env.BALLOT_INBOX_ADDRESS || '',
      chainId: Number(process.env.CHAIN_ID || 27427),
    });
    try {
      const { status, json } = await ctx.api('POST', '/api/elections', {
        jar: ctx.jar,
        body: electionBody({ title: 'Live factory probe' }),
      });
      assert.equal(status, 201, json?.error);
      assert.equal(json.chainMode, 'onchain');
      assert.ok(json.onChainElectionId);
      assert.ok(json.onChainElectionAddress);
    } finally {
      await ctx.close();
    }
  },
);
