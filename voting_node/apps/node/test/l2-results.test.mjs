// NOT FOR PROFIT — civic public good, not a commercial product.
// GET /api/l2/identity and /api/l2/:l2Id/elections/:uuid/results (L2 / L1 readers).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import express from 'express';

import { l2ResultsRouter } from '../src/routes/l2Results.mjs';
import { computeElectionKey, computeL2Id } from '../../../l2/identity.mjs';

const OPERATOR = '0x' + 'ab'.repeat(20);
const L2_UUID = '3f9c1a52-7b0e-4d61-9a2f-5c8e1b7d4a30';
const SALT = '0x' + '11'.repeat(32);
const ELECTION = 'b5d2c3e4-1f6a-4b7c-8d9e-0a1b2c3d4e5f';
const L2_ID = computeL2Id({ operator: OPERATOR, l2Uuid: L2_UUID, salt: SALT });

function fakeL2Fetch(elections) {
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    let result = null;
    if (method === 'zkv_l2Identity') result = { l2Id: L2_ID, l2Uuid: L2_UUID };
    if (method === 'zkv_getElection') result = elections[params[0]] || null;
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
}

describe('L2 results API', () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    const env = {
      L2_UUID,
      L2_SALT: SALT,
      L2_OPERATOR_ADDRESS: OPERATOR,
      L1_CHAIN_ID: '1',
      L2_CIVIC_RPC: 'http://l2.test:8546',
      L1_SUBMITTER_PRIVATE_KEY: '',
    };
    const deps = { store: { getElection: () => null } };
    app.use(
      '/api',
      l2ResultsRouter(deps, {
        env,
        fetchImpl: fakeL2Fetch({ [ELECTION]: { electionUuid: ELECTION, tally: { countsHash: '0x01' } } }),
      }),
    );
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise((r) => {
      server = app.listen(0, '127.0.0.1', r);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('identity is public and never leaks the salt', async () => {
    const res = await fetch(`${base}/api/l2/identity`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.l2Id, L2_ID);
    assert.equal(body.l1Status, 'l1-addresses-tbd');
    assert.equal(JSON.stringify(body).includes(SALT.slice(2)), false);
  });

  test('outcome from the L2 by (l2Id, electionUuid)', async () => {
    const res = await fetch(`${base}/api/l2/${L2_ID}/elections/${ELECTION}/results?source=l2`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.source, 'l2');
    assert.equal(body.election.tally.countsHash, '0x01');
    assert.equal(body.electionKey, computeElectionKey({ l1ChainId: 1, l2Id: L2_ID, electionUuid: ELECTION }));
  });

  test('L1 reader is stubbed until the canonical addresses exist', async () => {
    const res = await fetch(`${base}/api/l2/${L2_ID}/elections/${ELECTION}/results?source=l1`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.status, 'l1-addresses-tbd');
    assert.equal(body.electionKey, computeElectionKey({ l1ChainId: 1, l2Id: L2_ID, electionUuid: ELECTION }));
  });

  test('wrong L2 and bad params', async () => {
    const other = '0x' + '44'.repeat(32);
    const res = await fetch(`${base}/api/l2/${other}/elections/${ELECTION}/results?source=l2`);
    assert.equal((await res.json()).status, 'wrong-l2');
    assert.equal((await fetch(`${base}/api/l2/nope/elections/${ELECTION}/results`)).status, 400);
    assert.equal((await fetch(`${base}/api/l2/${L2_ID}/elections/7/results`)).status, 400);
  });
});
