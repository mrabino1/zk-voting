// NOT FOR PROFIT — civic public good, not a commercial product.
// The node rollup client sends Authorization only when L1_RPC_AUTH_TOKEN is set.
// An empty token, and a test process that does not pass one, send no header.

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';

import { createRollupClient } from '../src/rollup/client.mjs';

const TOKEN = 'test-token';
const ROLLUP = `0x${'11'.repeat(20)}`;

function listen() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ authorization: req.headers.authorization, method: parsed.method });
      const result = parsed.method === 'eth_chainId' ? '0x1' : null;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          ...(result ? { result } : { error: { code: -32000, message: 'stop' } }),
        }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

describe('node L1 RPC auth', () => {
  test('rollup client sends the bearer token only when authToken is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    try {
      const authed = createRollupClient({
        l1Rpc: withToken.url,
        chainId: 1,
        address: ROLLUP,
        authToken: TOKEN,
      });
      await authed.election(1).catch(() => {});
      assert.ok(withToken.requests.length >= 1);
      for (const req of withToken.requests) assert.equal(req.authorization, `Bearer ${TOKEN}`);

      const open = createRollupClient({
        l1Rpc: withoutToken.url,
        chainId: 1,
        address: ROLLUP,
        authToken: '',
      });
      await open.election(1).catch(() => {});
      assert.ok(withoutToken.requests.length >= 1);
      for (const req of withoutToken.requests) assert.equal(req.authorization, undefined);
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('a test config without authToken does not inherit L1_RPC_AUTH_TOKEN', async () => {
    const server = await listen();
    const previous = process.env.L1_RPC_AUTH_TOKEN;
    const previousEnv = process.env.NODE_ENV;
    process.env.L1_RPC_AUTH_TOKEN = TOKEN;
    process.env.NODE_ENV = 'test';
    try {
      const client = createRollupClient({
        l1Rpc: server.url,
        chainId: 1,
        address: ROLLUP,
      });
      await client.election(1).catch(() => {});
      assert.ok(server.requests.length >= 1);
      for (const req of server.requests) assert.equal(req.authorization, undefined);
    } finally {
      if (previous === undefined) delete process.env.L1_RPC_AUTH_TOKEN;
      else process.env.L1_RPC_AUTH_TOKEN = previous;
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
      await server.close();
    }
  });
});
