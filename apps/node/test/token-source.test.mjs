// NOT FOR PROFIT — token source paging, timestamp search, and dual RPC agreement.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertRpcAgreement, createMemoryTokenChain, pagedLogs } from '../src/tokenSource.mjs';

describe('token source', () => {
  test('paged logs bisect a range the provider rejects', async () => {
    const logs = await pagedLogs(
      async (from, to) => {
        if (to - from > 2n) throw new Error('range too wide');
        const out = [];
        for (let n = from; n <= to; n += 1n) out.push({ blockNumber: n });
        return out;
      },
      1n,
      7n,
    );
    assert.deepEqual(
      logs.map((log) => log.blockNumber),
      [1n, 2n, 3n, 4n, 5n, 6n, 7n],
    );
  });

  test('blockBeforeTimestamp returns the last block strictly before cutoff', async () => {
    const chain = createMemoryTokenChain();
    chain.mint('0x00000000000000000000000000000000000000aa', 1n);
    chain.mine({ timestamp: 1000n });
    const mid = chain.mine({ timestamp: 1100n });
    chain.mine({ timestamp: 1200n });
    const found = await chain.blockBeforeTimestamp(1200n);
    assert.equal(found.number, mid.number);
    assert.equal(found.timestamp < 1200n, true);
  });

  test('a second archive RPC must agree', () => {
    assert.doesNotThrow(() => assertRpcAgreement('balance', 5n, 5n));
    assert.throws(() => assertRpcAgreement('balance', 5n, 4n), /disagree/);
  });
});
