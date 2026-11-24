// NOT FOR PROFIT — civic public good, not a commercial product.
// Node L1 reads send Authorization only when L1_RPC_AUTH_TOKEN is set.
// Civic L2 calls stay unauthenticated.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { l2FundingStatus, readOutcomeFromL1, readOutcomeFromL2 } from '../src/l2Identity.mjs';

const TOKEN = 'test-token';
const MIRROR = '0x' + '11'.repeat(20);
const L2_ID = '0x' + 'ab'.repeat(32);
const ELECTION = '11111111-1111-4111-8111-111111111111';

function jsonResponse(result) {
  return {
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  };
}

describe('node L1 RPC auth', () => {
  test('readOutcomeFromL1 sends the bearer token only when it is set', async () => {
    const authed = [];
    const open = [];
    const fetchAuthed = async (_url, init) => {
      authed.push(init.headers);
      return jsonResponse('0x' + '00'.repeat(128));
    };
    const fetchOpen = async (_url, init) => {
      open.push(init.headers);
      return jsonResponse('0x' + '00'.repeat(128));
    };
    const cfg = { l1Rpc: 'http://127.0.0.1:9', l1TallyMirror: MIRROR, l1ChainId: 1 };
    const ids = { l2Id: L2_ID, electionUuid: ELECTION };

    const withToken = await readOutcomeFromL1(cfg, ids, {
      fetchImpl: fetchAuthed,
      env: { L1_RPC_AUTH_TOKEN: TOKEN },
    });
    assert.equal(withToken.status, 'not-found');
    assert.equal(authed.length, 1);
    assert.equal(authed[0].Authorization, `Bearer ${TOKEN}`);
    assert.equal(authed[0]['content-type'], 'application/json');

    const without = await readOutcomeFromL1(cfg, ids, {
      fetchImpl: fetchOpen,
      env: { L1_RPC_AUTH_TOKEN: '  ' },
    });
    assert.equal(without.status, 'not-found');
    assert.equal(open.length, 1);
    assert.equal(Object.hasOwn(open[0], 'Authorization'), false);
    assert.deepEqual(open[0], { 'content-type': 'application/json' });
  });

  test('L1 funding check uses the same header rule', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      const method = JSON.parse(init.body).method;
      const result = method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x3b9aca00';
      return jsonResponse(result);
    };
    await l2FundingStatus(
      { l1Rpc: 'http://127.0.0.1:9', operator: MIRROR },
      { fetchImpl, env: { L1_RPC_AUTH_TOKEN: TOKEN } },
    );
    assert.ok(seen.length >= 1);
    for (const headers of seen) assert.equal(headers.Authorization, `Bearer ${TOKEN}`);

    const plain = [];
    const fetchPlain = async (_url, init) => {
      plain.push(init.headers);
      const method = JSON.parse(init.body).method;
      const result = method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x3b9aca00';
      return jsonResponse(result);
    };
    await l2FundingStatus({ l1Rpc: 'http://127.0.0.1:9', operator: MIRROR }, { fetchImpl: fetchPlain, env: {} });
    assert.ok(plain.length >= 1);
    for (const headers of plain) assert.equal(Object.hasOwn(headers, 'Authorization'), false);
  });

  test('civic L2 RPC calls do not send the L1 bearer token', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      return jsonResponse({ l2Id: L2_ID });
    };
    await readOutcomeFromL2(
      { civicRpc: 'http://127.0.0.1:9', l2Id: L2_ID },
      { l2Id: '0x' + 'ff'.repeat(32), electionUuid: ELECTION },
      { fetchImpl },
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { 'content-type': 'application/json' });
    assert.equal(Object.hasOwn(seen[0], 'Authorization'), false);
  });
});
