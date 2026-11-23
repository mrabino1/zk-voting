// NOT FOR PROFIT — civic public good, not a commercial product.
// The node's civic-vote path on the rollup (src/rollup/service.mjs): unit rules with a fake
// L1/L2 client, then the real thing — node service, L2 operator, Anvil L1 — when Foundry is installed.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';

import * as bc from '../public/ballot-crypto.js';
import { createRollupClient } from '../src/rollup/client.mjs';
import { RollupService } from '../src/rollup/service.mjs';

class MemStore {
  constructor() {
    this.elections = new Map();
    this.registrations = [];
    this.disqualifications = [];
    this.persists = 0;
  }
  add(e) {
    this.elections.set(e.id, e);
    return e;
  }
  requireElection(id) {
    const e = this.elections.get(id);
    if (!e) throw new Error('no election');
    return e;
  }
  listElections() {
    return [...this.elections.values()];
  }
  listEligibleRegistrations(id) {
    return this.registrations.filter((r) => r.electionId === id);
  }
  listDisqualifications(id) {
    return this.disqualifications.filter((d) => d.electionId === id);
  }
  async persist() {
    this.persists += 1;
  }
}

const vote = (over = {}) => ({
  id: 'e1',
  electionType: 'vote',
  title: 'Parks',
  startTime: 2_000_000_000,
  cutoffTime: 2_000_003_600,
  ballotSpecHash: '0x' + '11'.repeat(32),
  questions: [{ id: 'q', options: [{ id: 'a', label: 'North' }, { id: 'b', label: 'South' }, { id: 'c', label: 'East' }] }],
  ...over,
});

function fakeClient() {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    return {};
  };
  return {
    calls,
    chainId: 31337,
    address: '0x00000000000000000000000000000000000000aa',
    account: '0x00000000000000000000000000000000000000bb',
    jurisdictionId: '0x' + '22'.repeat(32),
    hex32: (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`,
    now: async () => 1_900_000_000,
    info: { status: 'scheduled', startTime: 2_000_000_000, cutoffTime: 2_000_003_600, optionCount: 3, threshold: 1, ballotCount: 0, jointKey: ['1', '2'] },
    async election() {
      return this.info;
    },
    createElection: async (config) => {
      calls.push(['createElection', config]);
      return { electionId: 7, configHash: '0x01', tx: '0xtx' };
    },
    registerVoters: record('registerVoters'),
    disqualify: record('disqualify'),
    submitBallot: async (b) => {
      calls.push(['submitBallot', b]);
      return { status: 'pending', commitment: '99' };
    },
    guardian: async () => ({ committed: false, excluded: false, sharesPosted: false }),
    committee: async () => ({}),
  };
}

describe('rollup service rules (fake L1/L2)', () => {
  test('only a one-question civic VOTE with 2–8 options can use the rollup', async () => {
    const store = new MemStore();
    const svc = new RollupService({ store, client: fakeClient(), config: {} });
    store.add(vote({ id: 'poll', electionType: 'poll' }));
    await assert.rejects(svc.prepare('poll'), /only civic votes/);
    store.add(vote({ id: 'two', questions: [vote().questions[0], vote().questions[0]] }));
    await assert.rejects(svc.prepare('two'), /one question/);
    store.add(vote());
    const r = await svc.prepare('e1', { minBallots: 3 });
    assert.equal(r.minBallots, 3);
  });

  test('guardians enroll by identity key before publishing, and publish sends them to L1', async () => {
    const store = new MemStore();
    const client = fakeClient();
    const svc = new RollupService({ store, client, config: {} });
    store.add(vote());
    await assert.rejects(svc.enrollGuardian('e1', { identityKey: ['1', '2'] }), /Baby Jubjub point/);
    const keys = [1, 2, 3].map(() => bc.identityKeypair().key);
    for (const key of keys) await svc.enrollGuardian('e1', { identityKey: key.map(String) });
    await assert.rejects(svc.enrollGuardian('e1', { identityKey: keys[0].map(String) }), /already a guardian/);

    await svc.publish('e1', { metadataURI: 'https://vote.example/e1' });
    const [, config] = client.calls.find((c) => c[0] === 'createElection');
    assert.equal(config.optionCount, 3);
    assert.equal(config.threshold, 2, 'default threshold is a majority');
    assert.deepEqual(config.guardians, keys);
    assert.equal(config.registrar, client.account);
    assert.equal(store.requireElection('e1').rollup.electionId, 7);
    await assert.rejects(svc.enrollGuardian('e1', { identityKey: bc.identityKeypair().key.map(String) }), /fixed once/);
  });

  test('roll sync sends each new commitment and disqualification once', async () => {
    const store = new MemStore();
    const client = fakeClient();
    const svc = new RollupService({ store, client, config: {} });
    store.add(vote({ rollup: { electionId: 7, guardians: [], synced: { commitments: [], disqualified: [] }, receipts: {}, mailbox: [] } }));
    store.registrations.push({ electionId: 'e1', identityCommitment: '0x05' }, { electionId: 'e1', identityCommitment: '0x06' });
    assert.deepEqual(await svc.syncRoll('e1'), { registered: 2, disqualified: 0 });
    store.registrations.push({ electionId: 'e1', identityCommitment: '0x07' });
    store.disqualifications.push({ electionId: 'e1', identityCommitment: '0x05', reasonCode: 5 });
    assert.deepEqual(await svc.syncRoll('e1'), { registered: 1, disqualified: 1 });
    assert.deepEqual(
      client.calls.filter((c) => c[0] === 'registerVoters').map((c) => c[2]),
      [['5', '6'], ['7']],
    );
  });

  test('a cast ballot leaves only a receipt on the node, never the ciphertexts', async () => {
    const store = new MemStore();
    const client = fakeClient();
    const svc = new RollupService({ store, client, config: {} });
    const e = store.add(vote({ rollup: { electionId: 7, guardians: [], synced: { commitments: [], disqualified: [] }, receipts: {}, mailbox: [] } }));
    const ctx = bc.contextOf({ chainId: 31337, rollup: client.address });
    const jointKey = bc.mulBase(5n);
    const ballot = bc.encryptBallot({ ctx, electionId: 7, jointKey, optionCount: 3, choice: 1 });
    const receipt = await svc.castBallot('e1', bc.toJSONSafe({ nullifier: 123n, ...ballot }));
    assert.equal(receipt.status, 'pending');
    assert.equal(client.calls.find((c) => c[0] === 'submitBallot')[1].electionId, 7);
    const stored = JSON.stringify(bc.toJSONSafe(e));
    for (const [c1] of ballot.ciphertexts) assert.ok(!stored.includes(c1[0].toString()), 'no ciphertext stored');
    assert.deepEqual(Object.keys(e.rollup.receipts), ['123']);
  });
});

// ------------------------------------------------------------------ integration

const anvilHelpers = await import('../../../l2/rollup/test/helpers/anvil.mjs');
const skip = anvilHelpers.foundryAvailable() ? false : process.env.CI === 'true' ? false : 'Foundry not installed';

describe('rollup client chain guard', () => {
  test('an L1_RPC on another chain is refused before any read or write', async () => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls += 1;
        const { id, method } = JSON.parse(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(method === 'eth_chainId' ? { result: '0x7a69' } : { error: { code: -32601, message: 'unexpected' } }) }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = createRollupClient({
        l1Rpc: `http://127.0.0.1:${server.address().port}`,
        chainId: 1,
        address: `0x${'11'.repeat(20)}`,
        privateKey: `0x${'22'.repeat(32)}`,
      });
      await assert.rejects(client.election(1), (err) => err.code === 'L1_CHAIN_MISMATCH' && /serves chain 31337/.test(err.message));
      await assert.rejects(client.closeElection(1), (err) => err.code === 'L1_CHAIN_MISMATCH');
      assert.equal(calls, 1, 'the chain id is asked once, and nothing else is sent');
    } finally {
      server.close();
    }
  });
});

describe('civic vote through node, L2 operator and L1', { skip }, () => {
  let anvil;
  let server;
  let op;
  let svc;
  let store;
  let deployment;

  before(async () => {
    const { createL1 } = await import('../../../l2/rollup/l1.mjs');
    const { Operator } = await import('../../../l2/rollup/operator.mjs');
    const { createApi } = await import('../../../l2/rollup/server.mjs');
    anvil = await anvilHelpers.startAnvil();
    // The Docker Compose layout: governor, operator and node clerk are three accounts.
    deployment = anvilHelpers.deployLocal(anvil.rpcUrl, { operator: anvilHelpers.OPERATOR_ADDRESS, clerk: anvilHelpers.CLERK_ADDRESS });
    assert.equal(deployment.operator, anvilHelpers.OPERATOR_ADDRESS);
    assert.equal(deployment.clerk, anvilHelpers.CLERK_ADDRESS);
    const l1 = createL1({ rpcUrl: anvil.rpcUrl, chainId: 31337, rollup: deployment.rollup, privateKey: anvilHelpers.OPERATOR_KEY });
    op = await new Operator({ l1, chainId: 31337, allowMockProofs: true }).init();
    server = createApi(op, { ballotToken: 'node-token' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    store = new MemStore();
    svc = new RollupService({
      store,
      config: {},
      client: createRollupClient({
        l1Rpc: anvil.rpcUrl,
        chainId: 31337,
        address: deployment.rollup,
        privateKey: anvilHelpers.CLERK_KEY,
        jurisdictionId: deployment.jurisdictionId,
        l2Url: `http://127.0.0.1:${server.address().port}`,
        l2Token: 'node-token',
      }),
    });
  });

  after(() => {
    server?.close();
    anvil?.stop();
  });

  test('draft → guardians → L1 → roll → ballots → close → shares → certified totals', { timeout: 600_000 }, async () => {
    const now = await anvil.now();
    store.add(vote({ startTime: now + 2 * 3600, cutoffTime: now + 3 * 3600 }));
    await svc.prepare('e1', { threshold: 2, minBallots: 3 });
    const guardians = [1, 2, 3].map((index) => ({ index, ...bc.identityKeypair() }));
    for (const g of guardians) await svc.enrollGuardian('e1', { label: `G${g.index}`, identityKey: g.key.map(String) });
    let view = await svc.publish('e1');
    assert.equal(view.l1.status, 'keygen');
    const electionId = view.l1.electionId;
    const ctx = bc.contextOf({ chainId: 31337, rollup: deployment.rollup });

    // Guardians commit and deal through the node's relay and mailbox (what rollup-guardian does).
    for (const g of guardians) {
      g.polynomial = bc.dealPolynomial(2);
      await svc.commitGuardian('e1', g.index, bc.toJSONSafe(
        bc.commitGuardian({ ctx, electionId, index: g.index, polynomial: g.polynomial, identitySecret: g.secret }),
      ));
      for (const r of guardians) {
        const share = bc.evalPolynomial(g.polynomial.coefficients, r.index);
        const box = await bc.sealBox({ senderSecret: g.secret, recipientKey: r.key, payload: { share }, context: `t:${g.index}:${r.index}` });
        await svc.postShareMessage('e1', { from: g.index, to: r.index, box });
      }
    }
    for (const g of guardians) {
      g.share = 0n;
      for (const m of svc.inbox('e1', g.index)) {
        const sender = guardians.find((x) => x.index === m.from);
        const { share } = await bc.openBox({ recipientSecret: g.secret, senderKey: sender.key, box: m.box, context: `t:${m.from}:${g.index}` });
        g.share = (g.share + share) % bc.ORDER;
      }
    }

    // Registrations made on the node reach L1 at finalizeKey; the operator applies them.
    const voters = [1, 2, 3, 4].map((i) => ({ secret: 500n + BigInt(i), commitment: bc.poseidon2(400n + BigInt(i), 500n + BigInt(i)) }));
    for (const v of voters) store.registrations.push({ electionId: 'e1', identityCommitment: v.commitment.toString() });
    await anvil.warp(3601);
    view = await svc.finalizeKey('e1');
    assert.equal(view.l1.status, 'scheduled');
    await op.tick();
    assert.equal(op.state.publicView(electionId).rollSize, 4);

    // Voting: the browser's job, then POST /vote → castBallot.
    await anvil.warp(3601);
    await op.sync();
    const context = await svc.ballotContext('e1');
    const jointKey = context.jointKey.map(BigInt);
    for (const [i, choice] of [2, 0, 2, 2].entries()) {
      const ballot = bc.encryptBallot({ ctx, electionId, jointKey, optionCount: 3, choice });
      await svc.castBallot('e1', bc.toJSONSafe({ nullifier: bc.nullifierOf(voters[i].secret, electionId), ...ballot }));
    }
    await op.tick();
    const receipt = await svc.receipt('e1', bc.nullifierOf(voters[0].secret, electionId));
    assert.equal(receipt.status, 'settled');

    // After the cutoff the node's tick closes the vote; guardians post shares; the node finalizes.
    await anvil.warp(3601);
    await svc.tick();
    await op.tick();
    view = await svc.view('e1');
    assert.equal(view.l1.status, 'closed');
    const accumulator = view.accumulator.map((w) => [w[0].map(BigInt), w[1].map(BigInt)]);
    for (const g of guardians.slice(0, 2)) {
      await svc.postShares('e1', g.index, bc.toJSONSafe(
        bc.decryptionShares({ ctx, electionId, index: g.index, secretShare: g.share, accumulator }),
      ));
    }
    await svc.tick();
    view = await svc.view('e1');
    assert.equal(view.l1.status, 'finalized');
    assert.deepEqual(view.result.counts, ['1', '0', '3']);
  });
});
