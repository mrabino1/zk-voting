// NOT FOR PROFIT — civic public good, not a commercial product.
// Read-only ERC-20 access. ZK-Voting never writes to the token chain.
// A second archive RPC is optional; when both are set they must agree.

import {
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  getAddress,
  isAddress,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
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

const VOTES_ABI = parseAbi([
  'function CLOCK_MODE() view returns (string)',
  'function delegates(address) view returns (address)',
  'function getPastVotes(address,uint256) view returns (uint256)',
  'event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)',
  'event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance)',
]);

export const DELEGATE_VOTES_CHANGED_TOPIC = keccak256(
  stringToHex('DelegateVotesChanged(address,uint256,uint256)'),
);
export const DELEGATE_CHANGED_TOPIC = keccak256(stringToHex('DelegateChanged(address,address,address)'));

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

function topicToAddress(topic) {
  return getAddress(`0x${String(topic).slice(-40)}`);
}

/**
 * Replay DelegateVotesChanged and DelegateChanged up to the snapshot.
 * The last power event for a delegate is the checkpoint. A later getPastVotes
 * call must match it; a miss means the log range did not start at deployment.
 */
export function rowsFromVoteLogs(powerLogs, changedLogs) {
  const events = [];
  for (const log of powerLogs || []) {
    if (!log.topics?.[1] || !log.data) continue;
    const [previous, next] = decodeAbiParameters(parseAbiParameters('uint256, uint256'), log.data);
    events.push({
      kind: 'power',
      block: BigInt(log.blockNumber),
      index: Number(log.logIndex ?? log.index ?? 0),
      delegate: topicToAddress(log.topics[1]),
      next,
      previous,
    });
  }
  for (const log of changedLogs || []) {
    if (!log.topics?.[1] || !log.topics?.[3]) continue;
    events.push({
      kind: 'delegate',
      block: BigInt(log.blockNumber),
      index: Number(log.logIndex ?? log.index ?? 0),
      delegator: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[3]),
    });
  }
  events.sort((a, b) => {
    if (a.block !== b.block) return a.block < b.block ? -1 : 1;
    return a.index - b.index;
  });
  const power = new Map();
  const delegators = new Map();
  const current = new Map();
  for (const event of events) {
    if (event.kind === 'power') {
      power.set(event.delegate.toLowerCase(), { address: event.delegate, weight: event.next });
      continue;
    }
    const who = event.delegator.toLowerCase();
    const prev = current.get(who);
    if (prev && delegators.get(prev)) delegators.get(prev).delete(who);
    const dest = event.to.toLowerCase();
    current.set(who, dest);
    if (dest !== ZERO.toLowerCase()) {
      if (!delegators.has(dest)) delegators.set(dest, new Set());
      delegators.get(dest).add(who);
    }
  }
  const rows = [];
  for (const [key, row] of power) {
    if (row.weight <= 0n) continue;
    rows.push({
      address: row.address,
      weight: row.weight.toString(),
      delegators: delegators.get(key)?.size || 0,
    });
  }
  rows.sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : a.address.toLowerCase() > b.address.toLowerCase() ? 1 : 0));
  return rows;
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
    async clockMode(token) {
      const address = getAddress(token);
      try {
        return await both('clock', (c) =>
          c.readContract({ address, abi: VOTES_ABI, functionName: 'CLOCK_MODE' }),
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'token has no block-number vote checkpoints', { code: 'TOKEN_UNSUPPORTED' });
      }
    },
    async getPastVotes(token, addr, blockNumber) {
      const address = getAddress(token);
      const who = getAddress(addr);
      try {
        return await both('getPastVotes', (c) =>
          c.readContract({
            address,
            abi: VOTES_ABI,
            functionName: 'getPastVotes',
            args: [who, BigInt(blockNumber)],
          }),
        );
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'token has no block-number vote checkpoints', { code: 'TOKEN_UNSUPPORTED' });
      }
    },
    async delegatesAt(token, addr, blockNumber) {
      const address = getAddress(token);
      const who = getAddress(addr);
      return both('delegates', (c) =>
        c.readContract({
          address,
          abi: VOTES_ABI,
          functionName: 'delegates',
          args: [who],
          blockNumber: BigInt(blockNumber),
        }),
      );
    },
    async votingPowerAt(token, snapshotBlock, startBlock) {
      const address = getAddress(token);
      const from = BigInt(startBlock);
      const to = BigInt(snapshotBlock);
      if (to < from) return [];
      const pull = async (client) => {
        const power = await pagedLogs(
          (a, b) =>
            client.getLogs({
              address,
              fromBlock: a,
              toBlock: b,
              topics: [DELEGATE_VOTES_CHANGED_TOPIC],
            }),
          from,
          to,
        );
        const changed = await pagedLogs(
          (a, b) =>
            client.getLogs({
              address,
              fromBlock: a,
              toBlock: b,
              topics: [DELEGATE_CHANGED_TOPIC],
            }),
          from,
          to,
        );
        return rowsFromVoteLogs(power, changed);
      };
      const rows = await pull(primary);
      if (secondary) {
        assertRpcAgreement('vote-power', rows, await pull(secondary));
      }
      for (const row of rows) {
        const onchain = await both('getPastVotes', (c) =>
          c.readContract({
            address,
            abi: VOTES_ABI,
            functionName: 'getPastVotes',
            args: [getAddress(row.address), to],
          }),
        );
        if (onchain !== BigInt(row.weight)) {
          throw rpcError('RPC_DISAGREEMENT', 'vote logs do not match getPastVotes');
        }
      }
      return rows;
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
/** In-memory fixture and local Anvil only. Production refuses every chain except mainnet. */
export const LOCAL_TOKEN_CHAIN_ID = 31337;

/**
 * Token polls read Ethereum mainnet. Chain id 1 is the only production id.
 * 31337 exists so the in-memory tests can run without a public network.
 */
export function tokenChainAllowed(chainId, { production = false } = {}) {
  const n = Number(chainId);
  if (n === ETHEREUM_MAINNET_CHAIN_ID) return true;
  if (!production && n === LOCAL_TOKEN_CHAIN_ID) return true;
  return false;
}

/**
 * The one ERC-20 every poll reads. Unset or invalid address fails closed.
 * A chain id other than Ethereum mainnet fails closed in production.
 * The Node never sends a transaction.
 */
export function resolveVotingToken({
  address = process.env.VOTING_TOKEN_ADDRESS,
  chainId = process.env.VOTING_TOKEN_CHAIN_ID,
  production = false,
} = {}) {
  const raw = String(address ?? '').trim();
  const chainText =
    chainId == null || String(chainId).trim() === '' ? String(ETHEREUM_MAINNET_CHAIN_ID) : String(chainId).trim();
  const parsed = Number(chainText);
  const parsedOk = Number.isInteger(parsed) && parsed > 0;
  const allowed = parsedOk && tokenChainAllowed(parsed, { production });
  const addressOk = Boolean(raw) && isAddress(raw);
  const configured = addressOk && allowed;
  let reason = null;
  if (!configured) {
    if (!raw) reason = 'unset';
    else if (!addressOk) reason = 'invalid';
    else reason = 'not_ethereum_l1';
  }
  return {
    configured,
    address: addressOk ? getAddress(raw) : '',
    chainId: allowed ? parsed : ETHEREUM_MAINNET_CHAIN_ID,
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
  const voteBalances = new Map();
  const delegateOf = new Map();
  let supply = 0n;
  let nextNumber = 1n;
  let nextTimestamp = 1_700_000_000n;
  const openLogs = [];
  const logs = [];
  const openVoteEvents = [];
  const voteEvents = [];
  const blocks = [];
  const history = new Map();
  const contracts = new Map();

  function bal(addr) {
    return balances.get(lower(addr)) || 0n;
  }

  function setBal(addr, value) {
    balances.set(lower(addr), value);
  }

  function votesOf(addr) {
    return voteBalances.get(lower(addr)) || 0n;
  }

  function setVotes(addr, value) {
    const who = getAddress(addr);
    const previous = votesOf(who);
    if (value === 0n) voteBalances.delete(lower(who));
    else voteBalances.set(lower(who), value);
    openVoteEvents.push({
      kind: 'power',
      delegate: who,
      previous,
      next: value,
    });
  }

  function moveVotes(from, to, amount) {
    const n = BigInt(amount);
    if (n === 0n || lower(from) === lower(to)) return;
    if (from && lower(from) !== lower(ZERO)) setVotes(from, votesOf(from) - n);
    if (to && lower(to) !== lower(ZERO)) setVotes(to, votesOf(to) + n);
  }

  function mine({ timestamp, finalized = false } = {}) {
    const number = nextNumber;
    nextNumber += 1n;
    const ts = timestamp == null ? nextTimestamp : BigInt(timestamp);
    nextTimestamp = ts + 12n;
    history.set(number.toString(), {
      balances: new Map(balances),
      supply,
      votes: new Map(voteBalances),
      delegates: new Map(delegateOf),
    });
    for (const log of openLogs) {
      logs.push({ ...log, block: number });
    }
    openLogs.length = 0;
    for (const event of openVoteEvents) {
      voteEvents.push({ ...event, block: number, index: voteEvents.length });
    }
    openVoteEvents.length = 0;
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
      moveVotes(ZERO, delegateOf.get(lower(to)) || ZERO, n);
    },
    transfer(from, to, amount) {
      const n = BigInt(amount);
      if (bal(from) < n) throw new Error('insufficient balance');
      setBal(from, bal(from) - n);
      setBal(to, bal(to) + n);
      openLogs.push({ from: getAddress(from), to: getAddress(to), amount: n });
      moveVotes(delegateOf.get(lower(from)) || ZERO, delegateOf.get(lower(to)) || ZERO, n);
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
    /**
     * ERC20Votes delegation. address(0) undelegates. Voting power stays zero
     * until this is called, including a delegation to the holder themselves.
     * The change is checkpointed when the next block is mined.
     */
    delegate(account, to) {
      const who = getAddress(account);
      const dest = !to || lower(to) === lower(ZERO) ? ZERO : getAddress(to);
      const from = delegateOf.get(lower(who)) || ZERO;
      if (lower(from) === lower(dest)) return;
      const balance = bal(who);
      delegateOf.set(lower(who), dest);
      openVoteEvents.push({
        kind: 'delegate',
        delegator: who,
        from: getAddress(from),
        to: dest,
      });
      moveVotes(from, dest, balance);
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
    async clockMode() {
      return 'mode=blocknumber&from=default';
    },
    async getPastVotes(addrToken, addr, blockNumber) {
      if (getAddress(addrToken) !== tokenAddress) return 0n;
      const snap = history.get(BigInt(blockNumber).toString());
      if (!snap) throw new HttpError(400, 'unknown token block', { code: 'RPC_UNAVAILABLE' });
      if (BigInt(blockNumber) >= nextNumber) {
        throw new HttpError(400, 'snapshot block is not in the past', { code: 'CLOSE_NOT_FINAL' });
      }
      return snap.votes.get(lower(addr)) || 0n;
    },
    async delegatesAt(addrToken, addr, blockNumber) {
      if (getAddress(addrToken) !== tokenAddress) return ZERO;
      const snap = history.get(BigInt(blockNumber).toString());
      if (!snap) throw new HttpError(400, 'unknown token block', { code: 'RPC_UNAVAILABLE' });
      return snap.delegates.get(lower(addr)) || ZERO;
    },
    async votingPowerAt(addrToken, snapshotBlock, startBlock) {
      if (getAddress(addrToken) !== tokenAddress) return [];
      const from = BigInt(startBlock);
      const to = BigInt(snapshotBlock);
      const power = [];
      const changed = [];
      for (const event of voteEvents) {
        if (event.block < from || event.block > to) continue;
        if (event.kind === 'power') {
          power.push({
            blockNumber: event.block,
            logIndex: event.index,
            topics: [DELEGATE_VOTES_CHANGED_TOPIC, topicAddress(event.delegate)],
            data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [event.previous, event.next]),
          });
        } else {
          changed.push({
            blockNumber: event.block,
            logIndex: event.index,
            topics: [
              DELEGATE_CHANGED_TOPIC,
              topicAddress(event.delegator),
              topicAddress(event.from),
              topicAddress(event.to),
            ],
            data: '0x',
          });
        }
      }
      const rows = rowsFromVoteLogs(power, changed);
      for (const row of rows) {
        const onchain = await this.getPastVotes(addrToken, row.address, to);
        if (onchain !== BigInt(row.weight)) {
          throw new HttpError(409, 'vote logs do not match getPastVotes', { code: 'RPC_DISAGREEMENT' });
        }
      }
      return rows;
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
