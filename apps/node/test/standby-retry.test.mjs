// NOT FOR PROFIT — civic public good, not a commercial product.
// The browser client pauses on a standby 503 instead of surfacing an error.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fetchWithStandbyRetry, standbyDelayMs } from '../public/standby-retry.js';

describe('standby fetch retry', () => {
  test('uses Retry-After when the standby sends one', () => {
    const response = { headers: { get: (name) => (name === 'retry-after' ? '2' : null) } };
    assert.equal(standbyDelayMs(response, 0), 2000);
  });

  test('retries a 503 and returns the following success', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return {
          status: 503,
          headers: { get: () => '0.01' },
        };
      }
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    };
    const response = await fetchWithStandbyRetry('http://node/api/elections', { method: 'GET' }, fetchImpl);
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
  });
});
