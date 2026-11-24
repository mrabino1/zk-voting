// NOT FOR PROFIT — civic public good, not a commercial product.
// The node stays up when the L2 operator is degraded: /health names the
// reason, and calls that need the operator return a clear 503.

import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { errorHandler } from '../src/http.mjs';
import { createRollupClient, RollupError } from '../src/rollup/client.mjs';
import { RollupService } from '../src/rollup/service.mjs';
import { l2Diag } from '../src/superAdmin/diagnostics.mjs';

const SECRET = 'ballot-token-secret';
const KEY = `0x${'cd'.repeat(32)}`;
const ADDR = `0x${'22'.repeat(20)}`;
const cleanups = [];

after(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function listen(server) {
  return new Promise((resolve, reject) => {
    const listening = server.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
}

async function degradedOperator(reason = 'genesis_not_found') {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const leak = `leak ${SECRET} ${KEY} http://user:${SECRET}@rpc.example/v1`;
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'degraded', reason, error: leak }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: leak, status: 'degraded', reason: `note ${SECRET}` }));
  });
  await listen(server);
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

class MemStore {
  constructor() {
    this.elections = new Map();
  }
  add(election) {
    this.elections.set(election.id, election);
    return election;
  }
  requireElection(id) {
    const election = this.elections.get(id);
    if (!election) throw new Error('no election');
    return election;
  }
  listElections() {
    return [...this.elections.values()];
  }
  async persist() {}
}

function publishedVote() {
  return {
    id: 'e1',
    electionType: 'vote',
    title: 'Parks',
    rollup: { electionId: 4, receipts: {} },
  };
}

describe('node handles a degraded L2 operator', () => {
  test('health, diagnostics, and ballot submission stay up and do not echo secrets', async () => {
    const l2 = await degradedOperator('missing_operator_key');
    const client = createRollupClient(
      {
        l1Rpc: 'http://127.0.0.1:9',
        chainId: 31337,
        address: ADDR,
        l2Url: l2.url,
        l2Token: SECRET,
        authToken: '',
      },
      { fetchImpl: globalThis.fetch },
    );
    const health = await client.l2Health();
    assert.deepEqual(health, { status: 'degraded', reason: 'missing_operator_key' });
    assert.equal(JSON.stringify(health).includes(SECRET), false);

    await assert.rejects(client.submitBallot({ electionId: 4, nullifier: 5n, ciphertexts: [], proof: {} }), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'L2_DEGRADED');
      assert.equal(err.reason, 'degraded');
      assert.match(err.message, /degraded \(degraded\)/);
      assert.equal(err.message.includes(SECRET), false);
      assert.equal(err.message.includes(KEY), false);
      assert.equal(String(err.message).includes('user:'), false);
      return true;
    });

    const store = new MemStore();
    store.add(publishedVote());
    const logs = [];
    const rollup = new RollupService({
      store,
      client,
      config: { rollup: { l2Url: l2.url, authToken: '' } },
      log: (line) => logs.push(line),
    });
    const castError = await rollup
      .castBallot('e1', { nullifier: '5', ciphertexts: [[[1n, 2n], [3n, 4n]]], proof: { a: 1n } })
      .then(
        () => {
          throw new Error('expected the degraded operator to reject the ballot');
        },
        (err) => err,
      );
    assert.equal(castError.status, 503);
    assert.equal(castError.extra.code, 'L2_DEGRADED');
    assert.equal(castError.extra.mode, 'degraded');
    assert.match(castError.message, /L2 operator is degraded/);
    assert.equal(castError.message.includes(SECRET), false);
    assert.equal(castError.message.includes(KEY), false);

    const app = express();
    app.get('/vote', (_req, _res, next) => next(castError));
    app.use(errorHandler);
    const httpServer = await listen(app);
    cleanups.push(() => new Promise((resolve) => httpServer.close(() => resolve())));
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/vote`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'L2_DEGRADED');
    assert.equal(body.mode, 'degraded');
    assert.match(body.error, /degraded/);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.equal(res.headers.get('x-zk-voting-mode'), 'degraded');

    await rollup.receipt('e1', '5').then(
      () => {
        throw new Error('expected receipt to fail while degraded');
      },
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.extra.code, 'L2_DEGRADED');
      },
    );

    const diag = await l2Diag({
      rollup,
      config: { rollup: { l2Url: l2.url }, nowFn: () => 0 },
      writer: null,
      explorer: { chain: {} },
    });
    assert.equal(diag.operator.status, 'degraded');
    assert.equal(diag.operator.reason, 'missing_operator_key');
    assert.equal(JSON.stringify(diag).includes(SECRET), false);

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'zk-voting-l2-degraded-'));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    let probe = () => rollup.l2Health();
    const created = await createApp({
      dataDir: tmp,
      allowDevLogin: true,
      adminHandle: 'admin',
      quiet: true,
      port: 0,
      disclosureIntervalSeconds: 0,
      rollupService: {
        enabled: true,
        l2Health: () => probe(),
        async tick() {},
      },
    });
    const nodeServer = await listen(created.app);
    cleanups.push(() => new Promise((resolve) => nodeServer.close(() => resolve())));
    const nodeUrl = `http://127.0.0.1:${nodeServer.address().port}`;
    const nodeHealth = await fetch(`${nodeUrl}/health`);
    assert.equal(nodeHealth.status, 200);
    const nodeBody = await nodeHealth.json();
    assert.equal(nodeBody.ok, true);
    assert.equal(nodeBody.l2.status, 'degraded');
    assert.equal(nodeBody.l2.reason, 'missing_operator_key');
    assert.equal(JSON.stringify(nodeBody).includes(SECRET), false);

    probe = async () => {
      throw new Error(`boom ${SECRET}`);
    };
    const again = await fetch(`${nodeUrl}/health`);
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.ok, true);
    assert.equal(againBody.l2.status, 'unreachable');
    assert.equal(JSON.stringify(againBody).includes(SECRET), false);

    store.add({
      id: 'e2',
      electionType: 'vote',
      rollup: { electionId: 9 },
    });
    const ticking = new RollupService({
      store,
      client: {
        async election() {
          throw new RollupError(`the L2 operator is degraded (genesis_not_found) ${SECRET}`, {
            status: 503,
            code: 'L2_DEGRADED',
            reason: 'genesis_not_found',
          });
        },
      },
      config: { l1RpcAuthToken: SECRET },
      log: (line) => logs.push(line),
    });
    await ticking.tick();
    assert.match(logs.at(-1), /degraded/);
    assert.equal(logs.at(-1).includes(SECRET), false);
  });
});
