// NOT FOR PROFIT — civic public good, not a commercial product.
// Read-only ERC-20 access. ZK-Voting never writes to the token chain.
// A second archive RPC is optional; when both are set they must agree.

import {
  createPublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  getAddress,
  isAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
} from 'viem';

import { HttpError } from './http.mjs';

export const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'));

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

const ERC1271_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

const ERC1271_MAGIC = '0x1626ba7e';
const ZERO = '0x0000000000000000000000000000000000000000';

function rpcError(code, message) {
  return new HttpError(code === 'RPC_DISAGREEMENT' ? 409 : 503, message, { code });
}

export function assertRpcAgreement(label, left, right) {
  const show = (value) => {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return JSON.stringify(value.map((item) => show(item)));
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return JSON.stringify(keys.map((key) => [key, show(value[key])]));
    }
    return JSON.stringify(value);
  };
  if (show(left) !== show(right)) {
    throw rpcError('RPC_DISAGREEMENT', `archive RPCs disagree on ${label}`);
  }
}

/**
 * Bisect eth_getLogs ranges when a provider rejects a wide query.
 * @param {(from: bigint, to: bigint) => Promise<object[]>} fetchRange
 */
export async function pagedLogs(fetchRange, fromBlock, toBlock) {
  const from = BigInt(fromBlock);
  const to = BigInt(toBlock);
  if (to < from) return [];
  try {
    const logs = await fetchRange(from, to);
    if (logs.length >= 1000 && to > from) {
      const mid = from + (to - from) / 2n;
      const left = await pagedLogs(fetchRange, from, mid);
      const right = await pagedLogs(fetchRange, mid + 1n, to);
      return [...left, ...right];
    }
    return logs;
  } catch (err) {
    if (to <= from) throw err;
    const mid = from + (to - from) / 2n;
    const left = await pagedLogs(fetchRange, from, mid);
    const right = await pagedLogs(fetchRange, mid + 1n, to);
    return [...left, ...right];
  }
}

function topicAddress(addr) {
  return `0x${getAddress(addr).slice(2).toLowerCase().padStart(64, '0')}`;
}

async function readTokenAt(client, token, fn, args, blockNumber) {
  return client.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: fn,
    args,
    blockNumber,
  });
}

export function createViemTokenSource({ chainId, primaryUrl, secondaryUrl }) {
  if (!primaryUrl) {
    throw rpcError('RPC_UNAVAILABLE', `TOKEN_RPC_${chainId} is not set`);
  }
  const primary = createPublicClient({ transport: http(primaryUrl) });
  const secondary = secondaryUrl ? createPublicClient({ transport: http(secondaryUrl) }) : null;

  async function both(label, run) {
    const a = await run(primary);
    if (!secondary) return a;
    const b = await run(secondary);
    assertRpcAgreement(label, a, b);
    return a;
  }

  async function getBlock(numberOrTag) {
    return both('block', async (client) => {
      const block =
        typeof numberOrTag === 'bigint'
          ? await client.getBlock({ blockNumber: numberOrTag })
          : await client.getBlock({ blockTag: numberOrTag });
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
      };
    });
  }

  return {
    kind: 'viem',
    chainId: Number(chainId),
    async probeToken(token) {
      const address = getAddress(token);
      try {
        const latest = await getBlock('latest');
        const [decimals, symbol, totalSupply, code] = await Promise.all([
          both('decimals', (c) => readTokenAt(c, address, 'decimals', [], latest.number)),
          both('symbol', (c) => readTokenAt(c, address, 'symbol', [], latest.number)),
          both('totalSupply', (c) => readTokenAt(c, address, 'totalSupply', [], latest.number)),
          both('code', async (c) => c.getBytecode({ address, blockNumber: latest.number })),
        ]);
        if (!code || code === '0x') {
          throw rpcError('TOKEN_UNSUPPORTED', 'address has no contract code');
        }
        await both('balanceOf', (c) => readTokenAt(c, address, 'balanceOf', [ZERO], latest.number));
        await pagedLogs(
          (from, to) =>
            primary.getLogs({
              address,
              fromBlock: from,
              toBlock: to,
              topics: [TRANSFER_TOPIC],
            }),
          latest.number > 0n ? latest.number - 1n : 0n,
          latest.number,
        );
        return {
          address,
          symbol: String(symbol),
          decimals: Number(decimals),
          totalSupply,
          warnings: [
            'Rebasing and fee-on-transfer tokens are unsupported. Weights use end-of-block balanceOf.',
            'Tokens in staking or liquidity-pool contracts cannot vote unless that contract signs.',
          ],
        };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const msg = String(err?.message || err);
        if (/returned no data|execution reverted|not a contract/i.test(msg)) {
          throw new HttpError(400, 'token is not a readable ERC-20', { code: 'TOKEN_UNSUPPORTED' });
        }
        throw new HttpError(503, 'token RPC unavailable', { code: 'RPC_UNAVAILABLE' });
      }
    },
    latestBlock() {
      return getBlock('latest');
    },
    getBlock(number) {
      return getBlock(BigInt(number));
    },
    async balanceAt(token, addr, blockNumber) {
      const address = getAddress(token);
      const who = getAddress(addr);
      const block = BigInt(blockNumber);
      return both('balance', (c) => readTokenAt(c, address, 'balanceOf', [who], block));
    },
    async totalSupplyAt(token, blockNumber) {
      const address = getAddress(token);
      return both('totalSupply', (c) =>
        readTokenAt(c, address, 'totalSupply', [], BigInt(blockNumber)),
      );
    },
    async touchedBlocks(token, addr, fromExcl, toIncl) {
      const address = getAddress(token);
      const who = topicAddress(addr);
      const from = BigInt(fromExcl) + 1n;
      const to = BigInt(toIncl);
      if (to < from) return [];
      const pull = async (client, topicIndex) => {
        const topics = [TRANSFER_TOPIC, null, null];
        topics[topicIndex] = who;
        const logs = await pagedLogs(
          (a, b) => client.getLogs({ address, fromBlock: a, toBlock: b, topics }),
          from,
          to,
        );
        return logs.map((log) => log.blockNumber);
      };
      const blocks = await both('logs', async (client) => {
        const fromLogs = await pull(client, 1);
        const toLogs = await pull(client, 2);
        const set = new Set([...fromLogs, ...toLogs].map((n) => n.toString()));
        return [...set].map((n) => BigInt(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      });
      return blocks;
    },
    async finalizedBlock() {
      try {
        return await getBlock('finalized');
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(503, 'finalized block unavailable', { code: 'RPC_UNAVAILABLE' });
      }
    },
    async blockBeforeTimestamp(ts) {
      const target = BigInt(ts);
      const latest = await getBlock('latest');
      let lo = 0n;
      let hi = latest.number;
      let ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) / 2n;
        const block = await getBlock(mid);
        if (block.timestamp < target) {
          ans = block;
          lo = mid + 1n;
        } else if (mid === 0n) {
          break;
        } else {
          hi = mid - 1n;
        }
      }
      return ans;
    },
    async hasCode(addr) {
      const code = await both('code', (c) => c.getBytecode({ address: getAddress(addr) }));
      return Boolean(code && code !== '0x');
    },
    async isValidSignature(addr, hash, signature) {
      const data = encodeFunctionData({
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [hash, signature],
      });
      try {
        const raw = await both('erc1271', (c) =>
          c.call({ to: getAddress(addr), data }).then((r) => r.data),
        );
        if (!raw || raw === '0x') return false;
        const value = decodeFunctionResult({
          abi: ERC1271_ABI,
          functionName: 'isValidSignature',
          data: raw,
        });
        return String(value).toLowerCase() === ERC1271_MAGIC;
      } catch {
        return false;
      }
    },
  };
}

function lower(addr) {
  return getAddress(addr).toLowerCase();
}

/**
 * In-memory ERC-20 used by tests. Balances are end-of-block.
 * A flash loan borrows and repays inside the open block, so the mined
 * end balance does not include it.
 */
export const ETHEREUM_MAINNET_CHAIN_ID = 1;

/**
 * The one ERC-20 every poll reads. Unset or invalid address fails closed.
 * Chain id defaults to Ethereum mainnet. The Node never sends a transaction.
 */
export function resolveVotingToken({
  address = process.env.VOTING_TOKEN_ADDRESS,
  chainId = process.env.VOTING_TOKEN_CHAIN_ID,
} = {}) {
  const raw = String(address ?? '').trim();
  const chainText = chainId == null || String(chainId).trim() === '' ? String(ETHEREUM_MAINNET_CHAIN_ID) : String(chainId).trim();
  const parsed = Number(chainText);
  const chainOk = Number.isInteger(parsed) && parsed > 0 && parsed !== 27427;
  const addressOk = Boolean(raw) && isAddress(raw);
  const configured = addressOk && chainOk;
  let reason = null;
  if (!configured) reason = !raw ? 'unset' : 'invalid';
  return {
    configured,
    address: addressOk ? getAddress(raw) : '',
    chainId: chainOk ? parsed : ETHEREUM_MAINNET_CHAIN_ID,
    reason,
    readOnly: true,
  };
}

export function createMemoryTokenChain({
  chainId = 31337,
  symbol = 'TEST',
  decimals = 18,
  token = '0x1111111111111111111111111111111111111111',
} = {}) {
  const tokenAddress = getAddress(token);
  const balances = new Map();
  let supply = 0n;
  let nextNumber = 1n;
  let nextTimestamp = 1_700_000_000n;
  const openLogs = [];
  const logs = [];
  const blocks = [];
  const history = new Map();
  const contracts = new Map();

  function bal(addr) {
    return balances.get(lower(addr)) || 0n;
  }

  function setBal(addr, value) {
    balances.set(lower(addr), value);
  }

  function mine({ timestamp, finalized = false } = {}) {
    const number = nextNumber;
    nextNumber += 1n;
    const ts = timestamp == null ? nextTimestamp : BigInt(timestamp);
    nextTimestamp = ts + 12n;
    const snap = new Map(balances);
    history.set(number.toString(), { balances: snap, supply });
    for (const log of openLogs) {
      logs.push({ ...log, block: number });
    }
    openLogs.length = 0;
    const hash = keccak256(stringToHex(`zk-voting-mock-block:${number}:${ts}`));
    const block = { number, hash, timestamp: ts, finalized: Boolean(finalized) };
    blocks.push(block);
    return block;
  }

  function balanceAt(addr, blockNumber) {
    const snap = history.get(BigInt(blockNumber).toString());
    if (!snap) {
      throw new HttpError(400, 'unknown token block', { code: 'RPC_UNAVAILABLE' });
    }
    return snap.balances.get(lower(addr)) || 0n;
  }

  const api = {
    kind: 'memory',
    chainId: Number(chainId),
    token: tokenAddress,
    symbol,
    decimals,
    mint(to, amount) {
      const n = BigInt(amount);
      setBal(to, bal(to) + n);
      supply += n;
      openLogs.push({ from: ZERO, to: getAddress(to), amount: n });
    },
    transfer(from, to, amount) {
      const n = BigInt(amount);
      if (bal(from) < n) throw new Error('insufficient balance');
      setBal(from, bal(from) - n);
      setBal(to, bal(to) + n);
      openLogs.push({ from: getAddress(from), to: getAddress(to), amount: n });
    },
    /**
     * Borrow and repay inside the open block. End-of-block balance is unchanged.
     * The two Transfer logs are recorded so a touched-block scan sees the block,
     * and balanceOf at that block does not include the loan.
     */
    flashLoan(borrower, amount) {
      const n = BigInt(amount);
      const lender = getAddress('0x0000000000000000000000000000000000000f1a');
      openLogs.push({ from: lender, to: getAddress(borrower), amount: n, flash: true });
      openLogs.push({ from: getAddress(borrower), to: lender, amount: n, flash: true });
    },
    mine,
    finalizeThrough(number) {
      const limit = BigInt(number);
      for (const block of blocks) {
        if (block.number <= limit) block.finalized = true;
      }
    },
    setContractWallet(addr, valid) {
      contracts.set(lower(addr), valid);
    },
    async probeToken(addr) {
      if (getAddress(addr) !== tokenAddress) {
        throw new HttpError(400, 'token is not a readable ERC-20', { code: 'TOKEN_UNSUPPORTED' });
      }
      return {
        address: tokenAddress,
        symbol,
        decimals,
        totalSupply: supply,
        warnings: [
          'Rebasing and fee-on-transfer tokens are unsupported. Weights use end-of-block balanceOf.',
          'Tokens in staking or liquidity-pool contracts cannot vote unless that contract signs.',
        ],
      };
    },
    async latestBlock() {
      if (!blocks.length) throw new HttpError(503, 'token RPC unavailable', { code: 'RPC_UNAVAILABLE' });
      return blocks[blocks.length - 1];
    },
    async getBlock(number) {
      const block = blocks.find((b) => b.number === BigInt(number));
      if (!block) throw new HttpError(400, 'unknown token block', { code: 'RPC_UNAVAILABLE' });
      return block;
    },
    async balanceAt(addrToken, addr, blockNumber) {
      if (getAddress(addrToken) !== tokenAddress) return 0n;
      return balanceAt(addr, blockNumber);
    },
    async totalSupplyAt(addrToken, blockNumber) {
      if (getAddress(addrToken) !== tokenAddress) return 0n;
      const snap = history.get(BigInt(blockNumber).toString());
      if (!snap) throw new HttpError(400, 'unknown token block', { code: 'RPC_UNAVAILABLE' });
      return snap.supply;
    },
    async touchedBlocks(addrToken, addr, fromExcl, toIncl) {
      if (getAddress(addrToken) !== tokenAddress) return [];
      const who = lower(addr);
      const from = BigInt(fromExcl);
      const to = BigInt(toIncl);
      const set = new Set();
      for (const log of logs) {
        if (log.block <= from || log.block > to) continue;
        if (lower(log.from) === who || lower(log.to) === who) set.add(log.block.toString());
      }
      return [...set].map((n) => BigInt(n)).sort((a, b) => (a < b ? -1 : 1));
    },
    async finalizedBlock() {
      let ans = null;
      for (const block of blocks) if (block.finalized) ans = block;
      return ans;
    },
    async blockBeforeTimestamp(ts) {
      const target = BigInt(ts);
      let ans = null;
      for (const block of blocks) {
        if (block.timestamp < target) ans = block;
      }
      return ans;
    },
    async hasCode(addr) {
      return contracts.has(lower(addr));
    },
    async isValidSignature(addr, hash, signature) {
      const valid = contracts.get(lower(addr));
      if (!valid) return false;
      return valid(hash, signature) === true;
    },
  };
  return api;
}

export function tokenRpcMap(env = process.env) {
  const map = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^TOKEN_RPC_(\d+)(_2)?$/.exec(key);
    if (!match || !String(value || '').trim()) continue;
    const id = match[1];
    map[id] = map[id] || {};
    if (match[2]) map[id].secondary = String(value).trim();
    else map[id].primary = String(value).trim();
  }
  return map;
}

export function createTokenRegistry(config = {}) {
  const injected = new Map();
  const rpcs = config.tokenRpcs || tokenRpcMap();
  return {
    inject(chainId, source) {
      injected.set(Number(chainId), source);
    },
    get(chainId) {
      const id = Number(chainId);
      if (injected.has(id)) return injected.get(id);
      const urls = rpcs[String(id)];
      if (!urls?.primary) {
        throw new HttpError(503, `TOKEN_RPC_${id} is not set`, { code: 'RPC_UNAVAILABLE' });
      }
      return createViemTokenSource({
        chainId: id,
        primaryUrl: urls.primary,
        secondaryUrl: urls.secondary || '',
      });
    },
  };
}

export function bytesOf(signature) {
  const hex = String(signature || '');
  if (!hex.startsWith('0x')) return new Uint8Array();
  return hexToBytes(hex);
}

export { toHex, ZERO as ZERO_ADDRESS };
