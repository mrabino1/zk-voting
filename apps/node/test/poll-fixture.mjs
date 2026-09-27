// NOT FOR PROFIT — shared token-poll test fixture. Mock ERC-20, no Anvil.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { createApp } from '../src/server.mjs';
import { createMemoryTokenChain, createTokenRegistry } from '../src/tokenSource.mjs';

export function applyCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(';')[0];
    const i = pair.indexOf('=');
    if (i === -1) continue;
    jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

export function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function apiFor(base) {
  return async function api(method, url, { body, jar } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar ? { cookie: cookieHeader(jar) } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (jar) applyCookies(res, jar);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, json, text, status: res.status };
  };
}

export async function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

export async function startPollNode({
  pollsEnabled = true,
  disclosureIntervalSeconds = 0,
  votingTokenAddress,
  votingTokenChainId,
} = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'republic-poll-'));
  const chain = createMemoryTokenChain({ chainId: 31337 });
  const registry = createTokenRegistry();
  registry.inject(chain.chainId, chain);
  const clock = { t: 1_700_000_100 };
  const created = await createApp({
    dataDir: tmp,
    pollsEnabled,
    allowDevLogin: true,
    nowFn: () => clock.t,
    disclosureIntervalSeconds,
    tokenRegistry: registry,
    votingTokenAddress: votingTokenAddress === undefined ? chain.token : votingTokenAddress,
    votingTokenChainId: votingTokenChainId === undefined ? chain.chainId : votingTokenChainId,
  });
  const server = await listen(created.app);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = apiFor(base);
  return {
    ...created,
    tmp,
    chain,
    clock,
    server,
    base,
    api,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

export async function login(api, handle, role) {
  const jar = {};
  const res = await api('POST', '/api/auth/dev-login', { body: { handle, role }, jar });
  return { jar, res };
}

export function freshAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export const TOKEN = '0x1111111111111111111111111111111111111111';
