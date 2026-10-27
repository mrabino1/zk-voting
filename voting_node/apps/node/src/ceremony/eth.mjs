// NOT FOR PROFIT — civic public good, not a commercial product.
// Minimal read-only Ethereum JSON-RPC client for the ceremony beacon.
//
// Only eth_chainId, eth_blockNumber and eth_getBlockByNumber are called.
// Several endpoints may be configured (comma-separated CEREMONY_ETH_RPC_URL);
// then every one must answer and agree on the block hash. The head is the
// highest one reported, the finalized block the lowest, so a lagging or lying
// node can only make the server wait, never accept early. Endpoint URLs often
// carry an API key, so they never appear in errors, logs, or the transcript.

import { ETH_MAINNET_CHAIN_ID } from './beacon.mjs';

export class EthRpcError extends Error {
  constructor(message, code = 'CEREMONY_ETH_RPC') {
    super(message);
    this.code = code;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function parseRpcUrls(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const urls = [];
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    let u;
    try {
      u = new URL(text);
    } catch {
      throw new Error('CEREMONY_ETH_RPC_URL has an entry that is not a URL');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
      throw new Error('CEREMONY_ETH_RPC_URL must use https (plain http only for localhost)');
    }
    urls.push(u.toString());
  }
  return urls;
}

function hexToInt(hex, what) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(hex)) throw new EthRpcError(`RPC returned a bad ${what}`);
  const n = Number.parseInt(hex.slice(2), 16);
  if (!Number.isSafeInteger(n)) throw new EthRpcError(`RPC returned a bad ${what}`);
  return n;
}

export function createEthRpc({ urls = [], fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const endpoints = parseRpcUrls(urls);
  let idSeq = 0;

  function requireConfigured() {
    if (!endpoints.length) {
      throw new EthRpcError(
        'no Ethereum RPC is configured. Set CEREMONY_ETH_RPC_URL to a read-only mainnet endpoint.',
        'CEREMONY_ETH_RPC_UNSET',
      );
    }
  }

  async function rpc(url, index, method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++idSeq, method, params }),
        signal: ctrl.signal,
        redirect: 'error',
      });
    } catch {
      throw new EthRpcError(`Ethereum RPC #${index + 1} did not answer ${method}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new EthRpcError(`Ethereum RPC #${index + 1} answered ${method} with HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new EthRpcError(`Ethereum RPC #${index + 1} sent invalid JSON for ${method}`);
    }
    if (body?.error) throw new EthRpcError(`Ethereum RPC #${index + 1} refused ${method}`);
    return body?.result;
  }

  async function each(method, params) {
    requireConfigured();
    return Promise.all(
      endpoints.map(async (url, i) => {
        const chain = hexToInt(await rpc(url, i, 'eth_chainId', []), 'chain id');
        if (chain !== ETH_MAINNET_CHAIN_ID) {
          throw new EthRpcError(`Ethereum RPC #${i + 1} is on chain ${chain}, not mainnet (1)`, 'CEREMONY_ETH_RPC_CHAIN');
        }
        return rpc(url, i, method, params);
      }),
    );
  }

  return {
    get configured() {
      return endpoints.length > 0;
    },
    get endpointCount() {
      return endpoints.length;
    },
    /** Highest head any endpoint reports. */
    async headBlock() {
      const rows = await each('eth_blockNumber', []);
      return Math.max(...rows.map((r) => hexToInt(r, 'block number')));
    },
    /** Lowest finalized block any endpoint reports. */
    async finalizedBlock() {
      const rows = await each('eth_getBlockByNumber', ['finalized', false]);
      return Math.min(
        ...rows.map((b) => {
          if (!b) throw new EthRpcError('Ethereum RPC has no finalized block');
          return hexToInt(b.number, 'finalized block number');
        }),
      );
    },
    /** The block at `number`; every endpoint must agree on its hash. */
    async block(number) {
      const rows = await each('eth_getBlockByNumber', [`0x${Number(number).toString(16)}`, false]);
      let first = null;
      for (const b of rows) {
        if (!b) throw new EthRpcError(`Ethereum RPC does not have block ${number} yet`, 'CEREMONY_BEACON_FUTURE');
        if (hexToInt(b.number, 'block number') !== Number(number)) throw new EthRpcError('Ethereum RPC returned the wrong block');
        if (typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) throw new EthRpcError('Ethereum RPC returned a bad block hash');
        const row = {
          number: Number(number),
          hash: b.hash.toLowerCase(),
          parentHash: typeof b.parentHash === 'string' ? b.parentHash.toLowerCase() : null,
          timestamp: b.timestamp ? hexToInt(b.timestamp, 'timestamp') : null,
        };
        if (first && first.hash !== row.hash) {
          throw new EthRpcError(`Ethereum RPC endpoints disagree on the hash of block ${number}`, 'CEREMONY_ETH_RPC_DISAGREE');
        }
        first = first || row;
      }
      return first;
    },
  };
}
