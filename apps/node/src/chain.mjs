// NOT FOR PROFIT — civic public good, not a commercial product.
// Optional BallotInbox submit via viem when CHAIN_RPC is configured.

import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { HttpError } from './http.mjs';

export const ballotInboxAbi = [
  {
    type: 'function',
    name: 'submitVote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'a', type: 'uint256[2]' },
      { name: 'b', type: 'uint256[2][2]' },
      { name: 'c', type: 'uint256[2]' },
      { name: 'publicInputs', type: 'uint256[]' },
      { name: 'encryptedBallot', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nullifierUsed',
    stateMutability: 'view',
    inputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'nullifier', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'acceptedBallots',
    stateMutability: 'view',
    inputs: [{ name: 'electionId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
];

export function republicChain(chainId, rpc) {
  return defineChain({
    id: chainId,
    name: 'Republic',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc || 'http://127.0.0.1:8545'] } },
  });
}

function asBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  const s = String(value);
  return BigInt(s);
}

function dummyPoints() {
  return {
    a: [1n, 2n],
    b: [
      [1n, 2n],
      [3n, 4n],
    ],
    c: [5n, 6n],
  };
}

export function groth16Points(proof) {
  if (!proof || proof.accept === true || proof.accept === 'true') {
    return dummyPoints();
  }
  if (proof.pi_a && proof.pi_b && proof.pi_c) {
    return {
      a: [asBigInt(proof.pi_a[0]), asBigInt(proof.pi_a[1])],
      b: [
        [asBigInt(proof.pi_b[0][0]), asBigInt(proof.pi_b[0][1])],
        [asBigInt(proof.pi_b[1][0]), asBigInt(proof.pi_b[1][1])],
      ],
      c: [asBigInt(proof.pi_c[0]), asBigInt(proof.pi_c[1])],
    };
  }
  if (proof.a && proof.b && proof.c) {
    return {
      a: [asBigInt(proof.a[0]), asBigInt(proof.a[1])],
      b: [
        [asBigInt(proof.b[0][0]), asBigInt(proof.b[0][1])],
        [asBigInt(proof.b[1][0]), asBigInt(proof.b[1][1])],
      ],
      c: [asBigInt(proof.c[0]), asBigInt(proof.c[1])],
    };
  }
  return dummyPoints();
}

export function createChain(config) {
  const rpc = config.chainRpc;
  const inbox = config.ballotInboxAddress;
  let key = config.relayerPrivateKey || '';
  if (key && !key.startsWith('0x')) key = `0x${key}`;

  const configured = Boolean(rpc);
  const ready = Boolean(rpc && inbox && key);

  let wallet;
  let publicClient;
  let account;

  if (ready) {
    const chain = republicChain(config.chainId, rpc);
    account = privateKeyToAccount(key);
    publicClient = createPublicClient({ chain, transport: http(rpc) });
    wallet = createWalletClient({ account, chain, transport: http(rpc) });
  }

  return {
    configured,
    ready,
    account,
    isConfigured() {
      return configured;
    },
    isReady() {
      return ready;
    },
    async submitVote({ electionId, proof, publicInputs, encryptedBallot }) {
      if (!configured) return null;
      if (!ready) {
        throw new HttpError(
          503,
          'CHAIN_RPC is set but BALLOT_INBOX_ADDRESS or RELAYER_PRIVATE_KEY is missing',
        );
      }
      const { a, b, c } = groth16Points(proof);
      const inputs = publicInputs.map((x) => asBigInt(x));
      try {
        const hash = await wallet.writeContract({
          address: inbox,
          abi: ballotInboxAbi,
          functionName: 'submitVote',
          args: [asBigInt(electionId), a, b, c, inputs, encryptedBallot],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return { hash, receipt };
      } catch (err) {
        throw new HttpError(502, `BallotInbox submitVote failed: ${err.message || err}`);
      }
    },
  };
}
