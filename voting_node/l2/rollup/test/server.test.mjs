// NOT FOR PROFIT — civic public good, not a commercial product.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { RollupState } from '../state.mjs';
import { createApi } from '../server.mjs';

const submitted = [];
const operator = {
  desert: false,
  batches: [{ batchNumber: 1, stateRoot: '1', included: ['1:5'] }],
  state: Object.assign(new RollupState(), {
    publicView: (id) => (id === 1 ? { electionId: 1, status: 'open', ballotCount: null } : null),
    rollPath: () => null,
    desertProof: () => ({ leaf: {}, accumulator: [], siblings: [] }),
  }),
  status: () => ({ lastBatch: 1 }),
  receipt: (e, n) => (e === 1 && n === 5n ? { status: 'settled', batchNumber: 1 } : null),
  submitBallot: async (b) => {
    if (b.electionId !== 1) throw Object.assign(new Error('unknown election'), { status: 404 });
    submitted.push(b);
    return { status: 'pending', nullifier: String(b.nullifier) };
  },
};

let base;
let server;
before(async () => {
  server = createApi(operator, { ballotToken: 'secret' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (body, token) =>
  fetch(`${base}/v1/ballots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test('ballots need the node token and come back as a pending receipt', async () => {
  assert.equal((await post({ electionId: 1, nullifier: '5' })).status, 401);
  assert.equal((await post({ electionId: 1, nullifier: '5' }, 'wrong')).status, 401);
  const res = await post({ electionId: 1, nullifier: '5', ciphertexts: [[['1', '2'], ['3', '4']]] }, 'secret');
  assert.equal(res.status, 202);
  assert.equal(submitted[0].nullifier, 5n);
  assert.deepEqual(submitted[0].ciphertexts, [[[1n, 2n], [3n, 4n]]]);
  assert.equal((await post({ electionId: 2, nullifier: '5' }, 'secret')).status, 404);
});

test('public views carry no live turnout and batches hide included nullifiers', async () => {
  const view = await (await fetch(`${base}/v1/elections/1`)).json();
  assert.equal(view.ballotCount, null);
  const { batches } = await (await fetch(`${base}/v1/batches`)).json();
  assert.equal(batches[0].included, undefined);
  assert.equal((await fetch(`${base}/v1/receipts/1/5`)).status, 200);
  assert.equal((await fetch(`${base}/v1/receipts/1/6`)).status, 404);
});

test('the desert proof (which reveals the running sum) is served only in desert mode', async () => {
  assert.equal((await fetch(`${base}/v1/elections/1/desert-proof`)).status, 409);
  operator.desert = true;
  assert.equal((await fetch(`${base}/v1/elections/1/desert-proof`)).status, 200);
  operator.desert = false;
});
