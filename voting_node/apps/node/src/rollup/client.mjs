// NOT FOR PROFIT — civic public good, not a commercial product.
// The node's view of the rollup: ZkVotingRollup on L1 (viem) and the L2 operator's API.
// The node account is the jurisdiction's clerk, registrar and officer, and relays guardian
// calls (which carry the guardians' own signatures). See smart-contracts/docs/ROLLUP.md.

import { createRequire } from 'node:module';

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fromJSONSafe, toJSONSafe } from '../../public/ballot-crypto.js';

const require = createRequire(import.meta.url);
const { ROLLUP_ABI, ERRORS_ABI, decodeElectionInfo } = require('@zk-voting/chain-client');

const ABI = [...ROLLUP_ABI, ...ERRORS_ABI];
const hex32 = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

export class RollupError extends Error {
  constructor(message, { status = 502, code = 'ROLLUP_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Contract revert → `{ status, code }` the API can return. */
function fromRevert(err) {
  const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const name = reverted?.data?.errorName;
  if (name) return new RollupError(`L1 rejected the call: ${name}`, { status: 409, code: name });
  return new RollupError(err?.shortMessage || err?.message || 'L1 call failed');
}

/**
 * @param {object} cfg config.rollup: { l1Rpc, chainId, address, privateKey, jurisdictionId, l2Url, l2Token }
 * @returns {null | object} null when the rollup is not configured
 */
export function createRollupClient(cfg, { fetchImpl = globalThis.fetch } = {}) {
  if (!cfg?.l1Rpc || !cfg?.address) return null;
  const chain = defineChain({
    id: Number(cfg.chainId),
    name: `l1-${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.l1Rpc] } },
  });
  const transport = http(cfg.l1Rpc);
  const pub = createPublicClient({ chain, transport });
  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : null;
  const wallet = account ? createWalletClient({ chain, transport, account }) : null;
  const address = getAddress(cfg.address);
  // The chain id signs transactions and binds every ballot, so the RPC must serve that chain.
  // Checked once; a failed RPC call is retried on the next use, a mismatch is not.
  let chainChecked = null;
  async function onExpectedChain() {
    if (!chainChecked) {
      chainChecked = pub.getChainId().then(
        (actual) => {
          if (actual !== Number(cfg.chainId)) {
            throw new RollupError(`L1_RPC serves chain ${actual}, but the node is configured for ${cfg.chainId} (L1_CHAIN_ID)`, {
              status: 503,
              code: 'L1_CHAIN_MISMATCH',
            });
          }
        },
        (err) => {
          chainChecked = null;
          throw new RollupError(`L1 unreachable: ${err?.shortMessage || err?.message || 'error'}`, { status: 503, code: 'L1_UNREACHABLE' });
        },
      );
    }
    return chainChecked;
  }

  const read = async (functionName, args = []) => {
    await onExpectedChain();
    return pub.readContract({ address, abi: ABI, functionName, args });
  };

  async function send(functionName, args) {
    if (!wallet) throw new RollupError('the node has no L1 key (ROLLUP_PRIVATE_KEY)', { status: 503, code: 'NO_L1_KEY' });
    await onExpectedChain();
    let request;
    try {
      ({ request } = await pub.simulateContract({ address, abi: ABI, functionName, args, account }));
    } catch (err) {
      throw fromRevert(err);
    }
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new RollupError(`${functionName} reverted`, { code: 'REVERTED' });
    return receipt;
  }

  async function l2(path, { method = 'GET', body } = {}) {
    if (!cfg.l2Url) throw new RollupError('the L2 operator URL is not configured', { status: 503, code: 'NO_L2' });
    let res;
    try {
      res = await fetchImpl(new URL(path, cfg.l2Url), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cfg.l2Token ? { authorization: `Bearer ${cfg.l2Token}` } : {}),
        },
        body: body ? JSON.stringify(toJSONSafe(body)) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RollupError('the L2 operator is unreachable', { status: 503, code: 'L2_UNREACHABLE' });
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (!res.ok) throw new RollupError(json.error || `L2 answered ${res.status}`, { status: res.status, code: 'L2_REJECTED' });
    return json;
  }

  return {
    address,
    chainId: Number(cfg.chainId),
    account: account?.address ?? null,
    jurisdictionId: cfg.jurisdictionId,

    // ------------------------------------------------------------ L1 reads
    /** The node account's L1 balance and the current gas price, both in wei. */
    async accountBalance() {
      if (!account) return null;
      const [balanceWei, gasPriceWei] = await Promise.all([pub.getBalance({ address: account.address }), pub.getGasPrice()]);
      return { balanceWei, gasPriceWei };
    },

    async election(id) {
      try {
        return decodeElectionInfo(await read('election', [id]));
      } catch (err) {
        if (/UnknownElection/.test(String(err?.message))) return null;
        throw err;
      }
    },
    accumulator: async (id) => (await read('accumulator', [id])).map((w) => [[w[0], w[1]], [w[2], w[3]]]),
    decryptionShares: (id, index) => read('decryptionShares', [id, index]),
    async guardian(id, index) {
      const [keyX, keyY, committed, excluded, sharesPosted] = await read('guardian', [id, index]);
      return { key: [keyX, keyY], committed, excluded, sharesPosted };
    },
    async guardianCommitments(id, index) {
      const [cx, cy] = await read('guardianCommitments', [id, index]);
      return cx.map((x, t) => [x, cy[t]]);
    },
    async committee(id) {
      const [committed, excluded, disputed, openedAt, lastCommitAt] = await read('committeeState', [id]);
      return { committed, excluded, disputed, openedAt: Number(openedAt), lastCommitAt: Number(lastCommitAt) };
    },
    async result(id) {
      const [counts, resultHash] = await read('result', [id]);
      return { counts: counts.map(String), resultHash };
    },
    desertMode: () => read('desertMode'),
    async now() {
      return Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
    },

    // ----------------------------------------------------------- L1 writes
    async createElection(config) {
      const receipt = await send('createElection', [config]);
      const ev = parseEventLogs({ abi: ROLLUP_ABI, logs: receipt.logs, eventName: 'ElectionCreated' })[0];
      return { electionId: Number(ev.args.electionId), configHash: ev.args.configHash, tx: receipt.transactionHash };
    },
    commitGuardian: (id, index, c) => send('commitGuardian', [id, index, c.cx, c.cy, c.pok, c.auth]),
    complainShare: (id, dealer, recipient, share, sig) => send('complainShare', [id, dealer, recipient, share, sig]),
    openShareDispute: (id, dealer, recipient, sig) => send('openShareDispute', [id, dealer, recipient, sig]),
    revealShare: (id, dealer, share) => send('revealShare', [id, dealer, share]),
    expireShareDispute: (id, dealer) => send('expireShareDispute', [id, dealer]),
    finalizeKey: (id) => send('finalizeKey', [id]),
    haltElection: (id) => send('haltElection', [id]),
    registerVoters: (id, commitments) => send('registerVoters', [id, commitments.map(BigInt)]),
    disqualify: (id, commitment, reasonCode) => send('disqualify', [id, BigInt(commitment), reasonCode]),
    closeElection: (id) => send('closeElection', [id]),
    postDecryptionShares: (id, index, shares) => send('postDecryptionShares', [id, index, shares]),
    finalizeResult: (id, counts, subset) => send('finalizeResult', [id, counts.map(BigInt), subset]),

    // ----------------------------------------------------------------- L2
    submitBallot: (body) => l2('/v1/ballots', { method: 'POST', body }),
    receipt: (id, nullifier) => l2(`/v1/receipts/${id}/${BigInt(nullifier)}`),
    async l2Election(id) {
      return l2(`/v1/elections/${id}`);
    },
    l2Status: () => l2('/v1/status'),
    l2Batches: (limit = 50) => l2(`/v1/batches?limit=${limit}`),
    hex32,
    fromJSONSafe,
  };
}
