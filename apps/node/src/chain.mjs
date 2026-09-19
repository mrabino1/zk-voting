// NOT FOR PROFIT — civic public good, not a commercial product.
// Optional ElectionFactory create + BallotInbox submit via viem when CHAIN_RPC
// is configured. JSON-only demo remains when CHAIN_RPC is unset.

import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, isAddress, keccak256, stringToHex, zeroAddress } from 'viem';
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

/** Same shape as `@zk-voting/chain-client` FACTORY_ABI (create + ElectionCreated). */
export const electionFactoryAbi = [
  {
    type: 'function',
    name: 'createElection',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'title', type: 'string' },
          { name: 'metadataURI', type: 'string' },
          { name: 'startTime', type: 'uint64' },
          { name: 'cutoffTime', type: 'uint64' },
          { name: 'maxParticipants', type: 'uint32' },
          { name: 'treeDepth', type: 'uint8' },
          { name: 'ballotSpecHash', type: 'bytes32' },
          { name: 'clerk', type: 'address' },
          { name: 'registrar', type: 'address' },
          { name: 'disqualificationOfficer', type: 'address' },
          { name: 'tallyOperator', type: 'address' },
          { name: 'verifier', type: 'address' },
          { name: 'questionCount', type: 'uint8' },
          { name: 'jurisdictionId', type: 'bytes32' },
          { name: 'tallyPubKeyX', type: 'bytes32' },
          { name: 'tallyPubKeyY', type: 'bytes32' },
          { name: 'tallyScheme', type: 'uint8' },
        ],
      },
    ],
    outputs: [
      { name: 'electionId', type: 'uint256' },
      { name: 'election', type: 'address' },
    ],
  },
  {
    type: 'event',
    name: 'ElectionCreated',
    inputs: [
      { name: 'electionId', type: 'uint256', indexed: true },
      { name: 'election', type: 'address', indexed: true },
      { name: 'jurisdictionId', type: 'bytes32', indexed: true },
      { name: 'startTime', type: 'uint64', indexed: false },
      { name: 'cutoffTime', type: 'uint64', indexed: false },
    ],
  },
];

export function decodeElectionCreated(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return {};
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: electionFactoryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'ElectionCreated') {
        return {
          electionId: decoded.args.electionId,
          election: decoded.args.election,
          jurisdictionId: decoded.args.jurisdictionId,
          startTime: decoded.args.startTime,
          cutoffTime: decoded.args.cutoffTime,
        };
      }
    } catch {
      continue;
    }
  }
  return {};
}

function unpackCreateResult(result) {
  if (result == null) return {};
  if (Array.isArray(result)) {
    return { electionId: result[0], election: result[1] };
  }
  if (typeof result === 'object') {
    return {
      electionId: result.electionId ?? result[0],
      election: result.election ?? result[1],
    };
  }
  return {};
}

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
  return BigInt(String(value));
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

export function isNonZeroAddress(value) {
  if (!value) return false;
  try {
    if (!isAddress(String(value))) return false;
    return getAddress(String(value)) !== zeroAddress;
  } catch {
    return false;
  }
}

export function pickAddress(...candidates) {
  for (const c of candidates) {
    if (isNonZeroAddress(c)) return getAddress(c);
  }
  return null;
}

/** bytes32 jurisdiction id, or keccak256 of the Node's string id (e.g. "demo"). */
export function toJurisdictionBytes32(id) {
  const s = String(id || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  return keccak256(stringToHex(s));
}

export function chainElectionIdOf(election) {
  if (!election) return null;
  if (election.onChainElectionId != null && election.onChainElectionId !== '') {
    return String(election.onChainElectionId);
  }
  return election.id != null ? String(election.id) : null;
}

/**
 * Map a clerk POST body onto ElectionFactory ElectionParams.
 * Officer roles default to the relayer when the form omits addresses
 * (same as `CreateElection.s.sol` using msg.sender). Verifier must be set.
 */
export function resolveCreateElectionParams(config, input, fromAddress) {
  const from = pickAddress(fromAddress);
  const clerk = pickAddress(input.clerk, config.clerkAddress, from);
  const registrar = pickAddress(input.registrar, config.registrarAddress, from);
  const disqualificationOfficer = pickAddress(
    input.disqualificationOfficer,
    config.disqualificationOfficerAddress,
    from,
  );
  const tallyOperator = pickAddress(input.tallyOperator, config.tallyOperatorAddress, from);
  const verifier = pickAddress(input.verifier, config.verifierAddress);
  const missing = [];
  if (!clerk) missing.push('clerk');
  if (!registrar) missing.push('registrar');
  if (!disqualificationOfficer) missing.push('disqualificationOfficer');
  if (!tallyOperator) missing.push('tallyOperator');
  if (!verifier) missing.push('verifier (set VERIFIER_ADDRESS from DeployLocal VERIFIER=)');
  if (missing.length) {
    throw new HttpError(
      503,
      `CHAIN_RPC is set but missing on-chain role address(es): ${missing.join(', ')}`,
      { code: 'CHAIN_NOT_READY', missing },
    );
  }
  const questionCount = Number(
    input.questionCount ?? (Array.isArray(input.questions) ? input.questions.length : 0),
  );
  if (!Number.isInteger(questionCount) || questionCount < 1) {
    throw new HttpError(
      400,
      'on-chain elections require at least one question (ElectionFactory questionCount >= 1)',
      { code: 'QUESTION_COUNT' },
    );
  }
  return {
    title: String(input.title),
    metadataURI: String(input.metadataURI || ''),
    startTime: input.startTime,
    cutoffTime: input.cutoffTime,
    maxParticipants: Number(input.maxParticipants ?? 0),
    treeDepth: Number(input.treeDepth),
    ballotSpecHash: input.ballotSpecHash,
    clerk,
    registrar,
    disqualificationOfficer,
    tallyOperator,
    verifier,
    questionCount,
    jurisdictionId: toJurisdictionBytes32(input.jurisdictionId),
    tallyPubKeyX: input.tallyPubKeyX || `0x${'00'.repeat(32)}`,
    tallyPubKeyY: input.tallyPubKeyY || `0x${'00'.repeat(32)}`,
    tallyScheme:
      input.tallyScheme === 'opens_ballots' || input.tallyScheme === 1 || input.tallyScheme === '1'
        ? 1
        : Number(input.tallyScheme || 0) || 0,
  };
}

export function createChain(config) {
  const rpc = config.chainRpc;
  let key = config.relayerPrivateKey || '';
  if (key && !key.startsWith('0x')) key = `0x${key}`;

  const configured = Boolean(rpc);
  const hasWallet = Boolean(rpc && key);
  const factoryAddress = () => config.electionFactoryAddress || '';
  const inboxAddress = () => config.ballotInboxAddress || '';

  let wallet;
  let publicClient;
  let account;

  if (hasWallet) {
    const chain = republicChain(config.chainId, rpc);
    account = privateKeyToAccount(key);
    publicClient = createPublicClient({ chain, transport: http(rpc) });
    wallet = createWalletClient({ account, chain, transport: http(rpc) });
  }

  return {
    configured,
    get ready() {
      return Boolean(hasWallet && inboxAddress());
    },
    account,
    isConfigured() {
      return configured;
    },
    isReady() {
      return Boolean(hasWallet && inboxAddress());
    },
    isFactoryReady() {
      return Boolean(hasWallet && factoryAddress());
    },
    /**
     * @returns {Promise<null|{onChainElectionId: string, onChainElectionAddress: string|null, createTxHash: string|null, factoryAddress: string, chainId: number, params: object}>}
     */
    async createElection(input) {
      if (!configured) return null;
      if (!hasWallet) {
        throw new HttpError(503, 'CHAIN_RPC is set but RELAYER_PRIVATE_KEY is missing', {
          code: 'CHAIN_NOT_READY',
        });
      }
      const factoryAddr = factoryAddress();
      if (!factoryAddr) {
        throw new HttpError(
          503,
          'CHAIN_RPC is set but ELECTION_FACTORY_ADDRESS is missing. Deploy once, then pin the shared factory on this Node (env or /office/site). Do not deploy a new factory per jurisdiction fork.',
          { code: 'CHAIN_NOT_READY' },
        );
      }
      const params = resolveCreateElectionParams(config, input, account.address);
      try {
        const viemParams = {
          ...params,
          startTime: asBigInt(params.startTime),
          cutoffTime: asBigInt(params.cutoffTime),
        };
        let hash;
        let simulated = null;
        const sim = await publicClient.simulateContract({
          address: getAddress(factoryAddr),
          abi: electionFactoryAbi,
          functionName: 'createElection',
          args: [viemParams],
          account,
        });
        simulated = sim.result;
        hash = await wallet.writeContract(sim.request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const fromSim = unpackCreateResult(simulated);
        const decoded = decodeElectionCreated(receipt);
        const electionId = fromSim.electionId ?? decoded.electionId;
        const election = fromSim.election ?? decoded.election;
        if (electionId == null || electionId === '') {
          throw new Error('factory transaction did not return electionId (no ElectionCreated log)');
        }
        return {
          onChainElectionId: String(electionId),
          onChainElectionAddress: election ? getAddress(election) : null,
          createTxHash: hash || null,
          factoryAddress: getAddress(factoryAddr),
          chainId: config.chainId,
          params,
        };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `ElectionFactory createElection failed: ${err.message || err}`, {
          code: 'CHAIN_CREATE_FAILED',
        });
      }
    },
    async submitVote({ electionId, proof, publicInputs, encryptedBallot }) {
      if (!configured) return null;
      const inbox = inboxAddress();
      if (!hasWallet || !inbox) {
        throw new HttpError(
          503,
          'CHAIN_RPC is set but BALLOT_INBOX_ADDRESS or RELAYER_PRIVATE_KEY is missing',
          { code: 'CHAIN_NOT_READY' },
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
        throw new HttpError(502, `BallotInbox submitVote failed: ${err.message || err}`, {
          code: 'CHAIN_VOTE_FAILED',
        });
      }
    },
  };
}
