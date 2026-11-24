// NOT FOR PROFIT — civic public good, not a commercial product.
// L1_RPC_AUTH_TOKEN adds Authorization: Bearer <token> on L1 JSON-RPC calls
// and adds nothing when the variable is unset or blank.

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, test } from 'node:test';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { l1RpcHeaders, l1ViemHttp, readL1RpcAuthToken, redactL1RpcAuth, scrubL1RpcAuthError } from '../l1RpcAuth.js';
import { createL1, readL1ChainId } from '../rollup/l1.mjs';
import { chainIdOf, verifyDeployedCode } from '../../tools/deploy/l1Guard.mjs';
import { readRollupElection } from '../../tools/auditor/rollup.mjs';

const TOKEN = 'test-token';
const ROLLUP = '0x' + '11'.repeat(20);
const votingNode = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runBash(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

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

function assertBearer(requests, token) {
  assert.ok(requests.length >= 1);
  for (const req of requests) {
    if (token) assert.equal(req.authorization, `Bearer ${token}`);
    else assert.equal(req.authorization, undefined);
  }
}

describe('L1 JSON-RPC callers', () => {
  test('operator client and startup chain-id check send the bearer token only when it is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    try {
      const authed = createL1({
        rpcUrl: withToken.url,
        chainId: 1,
        rollup: ROLLUP,
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
      });
      assert.equal(await authed.publicClient.getChainId(), 1);
      assert.equal(await readL1ChainId(withToken.url, { L1_RPC_AUTH_TOKEN: `  ${TOKEN}  ` }), 1);
      assertBearer(withToken.requests, TOKEN);

      const open = createL1({ rpcUrl: withoutToken.url, chainId: 1, rollup: ROLLUP, env: {} });
      assert.equal(await open.publicClient.getChainId(), 1);
      assert.equal(await readL1ChainId(withoutToken.url, { L1_RPC_AUTH_TOKEN: '   ' }), 1);
      assertBearer(withoutToken.requests, '');
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('chain-id read scrubs the token from an RPC error', async () => {
    const server = await listen(() => ({ jsonrpc: '2.0', id: 1, error: { message: `bad ${TOKEN}` } }));
    try {
      await assert.rejects(readL1ChainId(server.url, { L1_RPC_AUTH_TOKEN: TOKEN }), (err) => {
        const text = `${err?.message || ''} ${err?.details || ''} ${err?.shortMessage || ''}`;
        assert.equal(text.includes(TOKEN), false);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  test('deploy guard chain id and code checks send the bearer token only when it is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    const env = { L1_RPC_AUTH_TOKEN: TOKEN };
    try {
      assert.equal(await chainIdOf(withToken.url, fetch, env), 1);
      assert.equal(await verifyDeployedCode(withToken.url, ROLLUP, fetch, env), '0x1234');
      assertBearer(withToken.requests, TOKEN);

      assert.equal(await chainIdOf(withoutToken.url, fetch, {}), 1);
      assert.equal(await verifyDeployedCode(withoutToken.url, ROLLUP, fetch, { L1_RPC_AUTH_TOKEN: '' }), '0x1234');
      assertBearer(withoutToken.requests, '');
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('auditor L1 read sends the bearer token only when it is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    try {
      await readRollupElection({
        rpc: withToken.url,
        rollup: ROLLUP,
        electionId: 1,
        env: { L1_RPC_AUTH_TOKEN: TOKEN },
      }).catch(() => {});
      assertBearer(withToken.requests, TOKEN);

      await readRollupElection({
        rpc: withoutToken.url,
        rollup: ROLLUP,
        electionId: 1,
        env: { L1_RPC_AUTH_TOKEN: '' },
      }).catch(() => {});
      assertBearer(withoutToken.requests, '');
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  test('shell rpc_call and the connectivity check send the bearer token only when it is set', async () => {
    const withToken = await listen();
    const withoutToken = await listen();
    const common = path.join(votingNode, 'scripts/lib/common.sh');
    const services = path.join(votingNode, 'system_actions/lib/services.sh');
    const script = `
      set -euo pipefail
      source "$COMMON"
      rpc_call "$URL" eth_chainId >/dev/null
      apply_l1_rpc_auth
      printf '%s' "\${ETH_RPC_HEADERS:-}"
      source "$SERVICES"
      rpc_ok "$URL" "$(l1_rpc_auth_token)"
    `;
    try {
      const authed = await runBash(script, {
        COMMON: common,
        SERVICES: services,
        URL: withToken.url,
        L1_RPC_AUTH_TOKEN: TOKEN,
        ETH_RPC_HEADERS: '',
      });
      assert.equal(authed.code, 0, authed.stderr);
      assert.equal(authed.stdout, `Authorization:Bearer ${TOKEN}`);
      assert.equal(authed.stderr.includes(TOKEN), false);
      assertBearer(withToken.requests, TOKEN);

      const open = await runBash(script, {
        COMMON: common,
        SERVICES: services,
        URL: withoutToken.url,
        L1_RPC_AUTH_TOKEN: '   ',
        ETH_RPC_HEADERS: '',
      });
      assert.equal(open.code, 0, open.stderr);
      assert.equal(open.stdout, '');
      assertBearer(withoutToken.requests, '');
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });
});
