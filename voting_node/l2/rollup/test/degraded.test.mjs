// NOT FOR PROFIT — civic public good, not a commercial product.
// /health is served before L1 init. L2_ALLOW_DEGRADED keeps a failed startup
// running without L1 submissions, and retries until init succeeds. Off, the
// process still exits.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { allowDegraded, redactOperatorLog, retryDelayMs, startOperator } from '../boot.mjs';

const ADDR = `0x${'11'.repeat(20)}`;
const KEY = `0x${'ab'.repeat(32)}`;
const TOKEN = 'l1-auth-token-value';
const BALLOT = 'ballot-token-value';
const WRITES = new Set(['commitBatch', 'verifyBatch', 'executeBatches', 'send', 'prove']);

const open = [];

afterEach(async () => {
  while (open.length) {
    const handle = open.pop();
    await handle.close?.();
    handle.sleeper?.release();
  }
});

function env(over = {}) {
  return {
    L1_RPC: 'http://127.0.0.1:9',
    L1_CHAIN_ID: '31337',
    ROLLUP_ADDRESS: ADDR,
    OPERATOR_PRIVATE_KEY: KEY,
    L1_RPC_AUTH_TOKEN: TOKEN,
    L2_BALLOT_TOKEN: BALLOT,
    L2_ALLOW_DEGRADED: '1',
    ...over,
  };
}

function controllableSleep() {
  const delays = [];
  let pending = null;
  return {
    delays,
    sleep(ms) {
      delays.push(ms);
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    release() {
      const resolve = pending;
      pending = null;
      if (resolve) resolve();
    },
  };
}

function fakeL1(behavior = {}) {
  const calls = [];
  const l1 = {
    address: ADDR,
    calls,
    writes: () => calls.filter((name) => WRITES.has(name)),
    async genesis() {
      calls.push('genesis');
      if (behavior.genesis) return behavior.genesis(calls);
      throw new Error('rollup genesis not found');
    },
    async isMockVerifier() {
      calls.push('isMockVerifier');
      return behavior.mock !== false;
    },
    async commitBatch() {
      calls.push('commitBatch');
    },
    async verifyBatch() {
      calls.push('verifyBatch');
    },
    async executeBatches() {
      calls.push('executeBatches');
    },
    async send() {
      calls.push('send');
    },
    prove() {
      calls.push('prove');
    },
  };
  return l1;
}

function track(handle, sleeper) {
  handle.sleeper = sleeper;
  open.push(handle);
  return handle;
}

async function boot(over = {}) {
  const sleeper = over.sleeper || controllableSleep();
  const l1 = over.l1 || fakeL1(over.l1Behavior);
  const log = over.log || { info() {}, warn() {}, error() {} };
  let inits = 0;
  let ticks = 0;
  let submits = 0;
  const handle = await startOperator({
    env: over.env || env(),
    host: '127.0.0.1',
    port: 0,
    exit: over.exit,
    log,
    onListening: over.onListening,
    deps: {
      readL1ChainId: async () => {
        if (over.readChain) return over.readChain();
        return 31337;
      },
      createL1: () => {
        if (over.onCreateL1) over.onCreateL1();
        return l1;
      },
      createOperator: () => ({
        async init() {
          inits += 1;
          if (over.init) return over.init(l1);
          await l1.genesis();
          return this;
        },
        async tick() {
          ticks += 1;
          if (over.tick) return over.tick(l1);
          await l1.commitBatch();
        },
        async submitBallot() {
          submits += 1;
          return { status: 'pending' };
        },
        status() {
          return { rollup: ADDR, chainId: 31337, lastBatch: 1, desertMode: false };
        },
        batches: [],
        desert: false,
        state: { publicView() { return null; }, rollPath() { return null; }, desertProof() { return {}; } },
        receipt() {
          return null;
        },
      }),
      sleep: sleeper.sleep,
      batchIntervalMs: over.batchIntervalMs ?? 60_000,
      ...(over.deps || {}),
    },
  });
  track(handle, sleeper);
  return { handle, l1, sleeper, log, counts: () => ({ inits, ticks, submits }) };
}

async function waitFor(fn, ms = 1500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

describe('L2_ALLOW_DEGRADED', () => {
  test('is off unless explicitly enabled', () => {
    for (const value of [undefined, '', 'false', '0', 'off', 'no', 'FALSE']) {
      assert.equal(allowDegraded({ L2_ALLOW_DEGRADED: value }), false, String(value));
    }
    for (const value of ['1', 'true', ' yes ', 'on', 'ON']) {
      assert.equal(allowDegraded({ L2_ALLOW_DEGRADED: value }), true, value);
    }
    assert.deepEqual([0, 1, 2, 3, 4, 8].map(retryDelayMs), [2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test('redacts keys, the auth token, and credentialed RPC URLs', () => {
    const text = `failed ${KEY} token ${TOKEN} at http://alice:${TOKEN}@rpc.example/v1?apikey=${TOKEN}`;
    const out = redactOperatorLog(text, {
      OPERATOR_PRIVATE_KEY: KEY,
      L1_RPC_AUTH_TOKEN: TOKEN,
      L2_BALLOT_TOKEN: BALLOT,
      L1_RPC: `http://alice:${TOKEN}@rpc.example/v1?apikey=${TOKEN}`,
    });
    assert.equal(out.includes(KEY), false);
    assert.equal(out.includes(KEY.slice(2)), false);
    assert.equal(out.includes(TOKEN), false);
    assert.equal(out.includes('alice:'), false);
    assert.match(out, /\[redacted\]/);
  });

  test('/health is served before Operator.init', async () => {
    let initsDuringListen = null;
    const seen = await boot({
      onListening: async (h) => {
        const res = await fetch(`${h.url}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.status, 'starting');
        assert.equal(body.reason, null);
        initsDuringListen = true;
      },
      init(l1) {
        assert.equal(initsDuringListen, true);
        return (async () => {
          await l1.genesis();
          return {
            status() {
              return { rollup: ADDR, lastBatch: 0 };
            },
          };
        })();
      },
      l1Behavior: { genesis: () => ({ stored: {}, block: 1n }) },
    });
    assert.equal(initsDuringListen, true);
    await seen.handle.done;
    const ready = await (await fetch(`${seen.handle.url}/health`)).json();
    assert.equal(ready.status, 'ok');
    assert.equal(ready.ok, true);
    assert.equal(seen.counts().inits, 1);
  });

  test('genesis not found, a missing key, and a missing prover stay degraded and submit nothing', async () => {
    const cases = [
      {
        name: 'genesis',
        env: {},
        reason: 'genesis_not_found',
        l1Behavior: {},
      },
      {
        name: 'missing key',
        env: { OPERATOR_PRIVATE_KEY: '' },
        reason: 'missing_operator_key',
        l1Behavior: { genesis: () => ({ stored: {}, block: 1n }) },
      },
      {
        name: 'missing prover',
        env: {},
        reason: 'no_batch_prover',
        l1Behavior: { genesis: () => ({ stored: {}, block: 1n }), mock: false },
      },
    ];
    for (const item of cases) {
      const warns = [];
      const seen = await boot({
        env: env(item.env),
        l1Behavior: item.l1Behavior,
        log: { info() {}, error() {}, warn: (line) => warns.push(String(line)) },
      });
      await waitFor(() => seen.sleeper.delays.length >= 1);
      const health = await fetch(`${seen.handle.url}/health`);
      assert.equal(health.status, 200, item.name);
      const body = await health.json();
      assert.equal(body.ok, true, item.name);
      assert.equal(body.status, 'degraded', item.name);
      assert.equal(body.reason, item.reason, item.name);
      assert.equal(JSON.stringify(body).includes(KEY), false, item.name);
      assert.equal(JSON.stringify(body).includes(TOKEN), false, item.name);
      assert.equal(JSON.stringify(body).includes(BALLOT), false, item.name);

      const status = await fetch(`${seen.handle.url}/v1/status`);
      assert.equal(status.status, 503, item.name);
      const denied = await status.json();
      assert.equal(denied.status, 'degraded', item.name);
      assert.equal(denied.reason, item.reason, item.name);
      assert.match(denied.error, /degraded/, item.name);

      const unauth = await fetch(`${seen.handle.url}/v1/ballots`, { method: 'POST', body: '{}' });
      assert.equal(unauth.status, 401, item.name);
      const ballot = await fetch(`${seen.handle.url}/v1/ballots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BALLOT}`, 'content-type': 'application/json' },
        body: JSON.stringify({ electionId: 1, nullifier: '5' }),
      });
      assert.equal(ballot.status, 503, item.name);
      assert.equal((await ballot.json()).reason, item.reason, item.name);

      seen.sleeper.release();
      await waitFor(() => seen.sleeper.delays.length >= 2);
      assert.deepEqual(seen.l1.writes(), [], item.name);
      assert.equal(seen.counts().ticks, 0, item.name);
      assert.equal(seen.counts().submits, 0, item.name);
      assert.equal(warns.length, 1, item.name);
      assert.match(warns[0], new RegExp(`L2 degraded \\(${item.reason}\\)`), item.name);
      assert.equal(warns[0].includes(KEY), false, item.name);
      assert.equal(warns[0].includes(TOKEN), false, item.name);
      assert.equal(warns[0].includes(BALLOT), false, item.name);
      if (item.name === 'missing key') assert.equal(seen.counts().inits, 0);
      await seen.handle.close();
    }
  });

  test('a chain-id failure is degraded, redacted, and does not touch L1 writes', async () => {
    const warns = [];
    const rpc = `http://alice:${TOKEN}@rpc.example/v1?apikey=${TOKEN}`;
    let created = 0;
    const seen = await boot({
      env: env({ L1_RPC: rpc, L1_CHAIN_ID: '' }),
      log: { info() {}, error() {}, warn: (line) => warns.push(String(line)) },
      readChain() {
        throw new Error(`chain id failed for ${rpc} key ${KEY} token ${TOKEN}`);
      },
      onCreateL1() {
        created += 1;
      },
    });
    await waitFor(() => seen.sleeper.delays.length >= 1);
    const body = await (await fetch(`${seen.handle.url}/health`)).json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.reason, 'l1_chain_id');
    assert.equal(created, 0);
    assert.deepEqual(seen.l1.writes(), []);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /l1_chain_id/);
    assert.equal(warns[0].includes(TOKEN), false);
    assert.equal(warns[0].includes(KEY), false);
    assert.equal(warns[0].includes('alice:'), false);
    assert.deepEqual(seen.sleeper.delays, [2000]);
  });

  test('recovers when a later init succeeds and only then submits', async () => {
    let attempt = 0;
    const seen = await boot({
      batchIntervalMs: 20,
      l1Behavior: {
        genesis() {
          attempt += 1;
          if (attempt < 3) throw new Error('rollup genesis not found');
          return { stored: {}, block: 1n };
        },
      },
    });
    await waitFor(() => seen.sleeper.delays.length >= 1);
    assert.deepEqual(seen.l1.writes(), []);
    seen.sleeper.release();
    await waitFor(() => seen.sleeper.delays.length >= 2);
    assert.deepEqual(seen.l1.writes(), []);
    assert.deepEqual(seen.sleeper.delays, [2000, 4000]);
    seen.sleeper.release();
    await seen.handle.done;
    const body = await (await fetch(`${seen.handle.url}/health`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.lastBatch, 1);
    await waitFor(() => seen.l1.writes().includes('commitBatch'));
    assert.equal(seen.counts().ticks >= 1, true);
    assert.equal(attempt, 3);
  });

  test('flag off keeps fail-fast and does not retry', async () => {
    const exits = [];
    const errors = [];
    let inits = 0;
    const seen = await boot({
      env: env({ L2_ALLOW_DEGRADED: 'false' }),
      exit(code) {
        exits.push(code);
      },
      log: { info() {}, warn() {}, error: (line) => errors.push(String(line)) },
      onListening: async (h) => {
        const res = await fetch(`${h.url}/health`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, 'starting');
        assert.equal(inits, 0);
      },
      init() {
        inits += 1;
        throw new Error('rollup genesis not found');
      },
    });
    await seen.handle.done;
    assert.deepEqual(exits, [2]);
    assert.equal(inits, 1);
    assert.equal(seen.counts().inits, 1);
    assert.equal(seen.sleeper.delays.length, 0);
    assert.match(errors[0], /rollup genesis not found/);
    assert.equal(errors[0].includes(KEY), false);
    assert.equal(errors[0].includes(TOKEN), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(inits, 1);
    assert.equal(seen.counts().inits, 1);
    assert.deepEqual(seen.l1.writes(), []);
  });

  test('an unusable key is degraded and never constructs an L1 client', async () => {
    let created = 0;
    const seen = await boot({
      env: env({ OPERATOR_PRIVATE_KEY: 'not-a-key' }),
      onCreateL1() {
        created += 1;
      },
    });
    await waitFor(() => seen.sleeper.delays.length >= 1);
    const body = await (await fetch(`${seen.handle.url}/health`)).json();
    assert.equal(body.status, 'degraded');
    assert.equal(body.reason, 'unusable_operator_key');
    assert.equal(created, 0);
    assert.equal(seen.counts().inits, 0);
    assert.deepEqual(seen.l1.writes(), []);
  });
});
