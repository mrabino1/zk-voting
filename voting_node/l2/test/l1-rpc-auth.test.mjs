// NOT FOR PROFIT — civic public good, not a commercial product.
// L1_RPC_AUTH_TOKEN adds Authorization: Bearer <token> on L1 JSON-RPC calls
// and adds nothing when the variable is unset or blank.

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';

import { l1RpcHeaders, l1ViemHttp, readL1RpcAuthToken, redactL1RpcAuth, scrubL1RpcAuthError } from '../l1RpcAuth.js';
import { checkSubmitterFunding } from '../prover/funding.mjs';
import { loadSettlementView } from '../prover/settle.mjs';

const TOKEN = 'test-token';
const MIRROR = '0x' + '11'.repeat(20);

function rpcResult(body) {
  if (body.method === 'eth_getBalance') return { jsonrpc: '2.0', id: body.id ?? 1, result: '0xde0b6b3a7640000' };
  if (body.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: body.id ?? 1, result: '0x3b9aca00' };
  if (body.method === 'eth_chainId') return { jsonrpc: '2.0', id: body.id ?? 1, result: '0x1' };
  if (body.method === 'eth_getCode') return { jsonrpc: '2.0', id: body.id ?? 1, result: '0x1234' };
  if (body.method === 'eth_call') return { jsonrpc: '2.0', id: body.id ?? 1, result: '0x' + '00'.repeat(64) };
  return { jsonrpc: '2.0', id: body.id ?? 1, result: '0x1' };
}

function listen(onBody = rpcResult) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      requests.push({ authorization: req.headers.authorization, body });
      const payload = onBody(body, req);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(payload));
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

describe('L1 RPC auth helper', () => {
  test('omits Authorization when the token is unset, empty, or blank', () => {
    for (const env of [{}, { L1_RPC_AUTH_TOKEN: '' }, { L1_RPC_AUTH_TOKEN: '   ' }, { L1_RPC_AUTH_TOKEN: '\n' }]) {
      const headers = l1RpcHeaders(env);
      assert.deepEqual(headers, { 'content-type': 'application/json' });
      assert.equal(Object.hasOwn(headers, 'Authorization'), false);
      assert.equal(readL1RpcAuthToken(env), '');
    }
  });

  test('sets Authorization: Bearer when the token is non-empty', () => {
    const headers = l1RpcHeaders({ L1_RPC_AUTH_TOKEN: `  ${TOKEN}  ` });
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers['content-type'], 'application/json');
  });

  test('viem http() is unchanged without a token and carries fetchOptions with one', () => {
    const calls = [];
    const httpFactory = (url, opts) => {
      calls.push({ url, opts });
      return { url, opts };
    };
    l1ViemHttp(httpFactory, 'http://127.0.0.1:1', {});
    l1ViemHttp(httpFactory, 'http://127.0.0.1:1', { L1_RPC_AUTH_TOKEN: '' });
    l1ViemHttp(httpFactory, 'http://127.0.0.1:1', { L1_RPC_AUTH_TOKEN: TOKEN });
    assert.equal(calls[0].opts, undefined);
    assert.equal(calls[1].opts, undefined);
    assert.deepEqual(calls[2].opts, {
      fetchOptions: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
  });

  test('redacts the token from errors and leaves other text', () => {
    const err = new Error(`denied ${TOKEN}`);
    err.stack = `Error: denied ${TOKEN}\n    at rpc`;
    scrubL1RpcAuthError(err, { L1_RPC_AUTH_TOKEN: TOKEN });
    assert.equal(err.message.includes(TOKEN), false);
    assert.match(err.message, /\[redacted\]/);
    assert.equal(err.stack.includes(TOKEN), false);
    assert.equal(redactL1RpcAuth('plain failure', {}), 'plain failure');
  });
});

describe('L1 JSON-RPC callers', () => {
  test('funding check sends the bearer token only when it is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    try {
      const funded = await checkSubmitterFunding({
        l1Rpc: withToken.url,
        address: MIRROR,
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
      });
      assert.equal(funded.level, 'ok');
      assert.ok(withToken.requests.length >= 1);
      for (const req of withToken.requests) {
        assert.equal(req.authorization, `Bearer ${TOKEN}`);
      }

      const open = await checkSubmitterFunding({
        l1Rpc: withoutToken.url,
        address: MIRROR,
        env: {},
      });
      assert.equal(open.level, 'ok');
      assert.ok(withoutToken.requests.length >= 1);
      for (const req of withoutToken.requests) {
        assert.equal(req.authorization, undefined);
      }
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('funding error text does not include the token', async () => {
    const server = await listen(() => ({ jsonrpc: '2.0', id: 1, error: { message: `bad ${TOKEN}` } }));
    try {
      const result = await checkSubmitterFunding({
        l1Rpc: server.url,
        address: MIRROR,
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
      });
      assert.equal(result.level, 'unreachable');
      assert.equal(result.message.includes(TOKEN), false);
      assert.match(result.message, /\[redacted\]/);
    } finally {
      await server.close();
    }
  });

  test('settlement view sends the bearer token on every L1 call, and none when unset', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    const config = {
      l1Rpc: '',
      settlementAddress: MIRROR,
      l1ChainId: 1,
    };
    try {
      await loadSettlementView({ ...config, l1Rpc: withToken.url }, fetch, { L1_RPC_AUTH_TOKEN: TOKEN });
      assert.ok(withToken.requests.length >= 2);
      for (const req of withToken.requests) {
        assert.equal(req.authorization, `Bearer ${TOKEN}`);
      }

      await loadSettlementView({ ...config, l1Rpc: withoutToken.url }, fetch, { L1_RPC_AUTH_TOKEN: '   ' });
      assert.ok(withoutToken.requests.length >= 2);
      for (const req of withoutToken.requests) {
        assert.equal(req.authorization, undefined);
      }
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('viem public client sends the bearer token only when the helper is given one', async () => {
    const { createPublicClient, http } = await import('viem');
    const withToken = await listen();
    const withoutToken = await listen();
    try {
      const authed = createPublicClient({
        transport: l1ViemHttp(http, withToken.url, { L1_RPC_AUTH_TOKEN: TOKEN }),
      });
      assert.equal(await authed.getChainId(), 1);
      assert.ok(withToken.requests.length >= 1);
      for (const req of withToken.requests) {
        assert.equal(req.authorization, `Bearer ${TOKEN}`);
      }

      const open = createPublicClient({
        transport: l1ViemHttp(http, withoutToken.url, {}),
      });
      assert.equal(await open.getChainId(), 1);
      assert.ok(withoutToken.requests.length >= 1);
      for (const req of withoutToken.requests) {
        assert.equal(req.authorization, undefined);
      }
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });
});
