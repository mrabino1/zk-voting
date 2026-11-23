// NOT FOR PROFIT — civic public good, not a commercial product.
// viem client for ZkVotingRollup, as the operator uses it.

import { createRequire } from 'node:module';

import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const { ROLLUP_ABI, ERRORS_ABI } = require('../../packages/chain-client/index.js');

export { ROLLUP_ABI };

const toBytes32 = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

/** StoredBatchInfo as viem wants it (bytes32 as hex). */
export function storedForAbi(b) {
  return {
    batchNumber: BigInt(b.batchNumber),
    timestamp: BigInt(b.timestamp),
    priorityOperations: BigInt(b.priorityOperations),
    priorityOpsHash: toBytes32(b.priorityOpsHash),
    onchainOpsHash: toBytes32(b.onchainOpsHash),
    stateRoot: toBytes32(b.stateRoot),
    commitment: toBytes32(b.commitment),
  };
}

export function createL1({ rpcUrl, chainId, rollup, privateKey }) {
  const chain = defineChain({
    id: Number(chainId),
    name: `l1-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKey ? privateKeyToAccount(privateKey) : null;
  const wallet = account ? createWalletClient({ chain, transport, account }) : null;
  const address = getAddress(rollup);
  const read = (functionName, args = []) => publicClient.readContract({ address, abi: ROLLUP_ABI, functionName, args });

  async function send(functionName, args) {
    if (!wallet) throw new Error('L1 submitter key is not configured');
    const { request } = await publicClient.simulateContract({
      address,
      abi: [...ROLLUP_ABI, ...ERRORS_ABI],
      functionName,
      args,
      account,
    });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
    return receipt;
  }

  return {
    address,
    account: account?.address ?? null,
    publicClient,
    read,
    send,

    async latestBlock() {
      return publicClient.getBlock({ blockTag: 'latest' });
    },

    /** Queued requests and forced-ballot payloads in `[fromBlock, toBlock]`. */
    async requestsBetween(fromBlock, toBlock) {
      const logs = await publicClient.getLogs({ address, fromBlock, toBlock });
      const events = parseEventLogs({ abi: ROLLUP_ABI, logs });
      const requests = [];
      const payloads = new Map();
      for (const ev of events) {
        if (ev.eventName === 'PriorityRequestQueued') {
          requests.push({ id: Number(ev.args.requestId), opType: Number(ev.args.opType), pubdata: ev.args.pubdata });
        } else if (ev.eventName === 'BallotForced') {
          payloads.set(Number(ev.args.requestId), ev.args.payload);
        }
      }
      return { requests, payloads };
    },

    /** The genesis StoredBatchInfo: batch 0 committed in the deployment transaction. */
    async genesis() {
      const logs = await publicClient.getLogs({ address, fromBlock: 0n, toBlock: 'latest' });
      const ev = parseEventLogs({ abi: ROLLUP_ABI, logs, eventName: 'BatchCommitted' }).find(
        (e) => e.args.batchNumber === 0n,
      );
      if (!ev) throw new Error('rollup genesis not found');
      const block = await publicClient.getBlock({ blockNumber: ev.blockNumber });
      return {
        stored: {
          batchNumber: 0n,
          timestamp: block.timestamp,
          priorityOperations: 0n,
          priorityOpsHash: 0n,
          onchainOpsHash: 0n,
          stateRoot: BigInt(ev.args.stateRoot),
          commitment: 0n,
        },
        block: ev.blockNumber,
      };
    },

    async commitBatch(last, next) {
      const receipt = await send('commitBatch', [
        storedForAbi(last),
        { newStateRoot: toBytes32(next.newStateRoot), timestamp: BigInt(next.timestamp), pubdata: next.pubdata },
      ]);
      const ev = parseEventLogs({ abi: ROLLUP_ABI, logs: receipt.logs, eventName: 'BatchCommitted' })[0];
      return { receipt, commitment: BigInt(ev.args.commitment) };
    },

    verifyBatch: (batch, proof) => send('verifyBatch', [storedForAbi(batch), proof.map(BigInt)]),
    executeBatches: (batches, ops) => send('executeBatches', [batches.map(storedForAbi), ops]),
    isMockVerifier: async () => {
      const verifier = await read('batchVerifier');
      return publicClient.readContract({
        address: verifier,
        abi: [{ type: 'function', name: 'isMock', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] }],
        functionName: 'isMock',
      });
    },
  };
}
