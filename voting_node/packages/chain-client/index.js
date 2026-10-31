/**
 * @fileoverview Chain client for ElectionFactory and BallotInbox.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Uses **viem** when it is installed (encode ABI, `readContract`,
 * `writeContract`, `simulateContract`). When viem is absent, falls back
 * to `fetch` JSON-RPC (`eth_call`, `eth_sendTransaction`, `eth_getBlockByNumber`)
 * with packed calldata. Nested `ElectionParams` encoding without viem is
 * rejected with a clear error — do not half-encode a struct.
 */

"use strict";

const {
  serializePublicInputs,
  snarkjsProofToSolidity,
  toBigInt,
  toHex32,
  hexToBytes,
  bytesToHex,
  functionSelector,
  encodePacked,
  encodeEgBallot,
  digestEgBallot,
  ballotDigest,
} = require("@zk-voting/proof-helpers");
const { ZK_VOTING_CHAIN_ID } = require("@zk-voting/types");

/** @typedef {import('@zk-voting/types').ElectionParams} ElectionParams */
/** @typedef {import('@zk-voting/types').VoteEnvelope} VoteEnvelope */

const FACTORY_ABI = [
  {
    type: "function",
    name: "createElection",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "title", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "startTime", type: "uint64" },
          { name: "cutoffTime", type: "uint64" },
          { name: "maxParticipants", type: "uint32" },
          { name: "treeDepth", type: "uint8" },
          { name: "ballotSpecHash", type: "bytes32" },
          { name: "clerk", type: "address" },
          { name: "registrar", type: "address" },
          { name: "disqualificationOfficer", type: "address" },
          { name: "tallyOperator", type: "address" },
          { name: "verifier", type: "address" },
          { name: "questionCount", type: "uint8" },
          { name: "jurisdictionId", type: "bytes32" },
          { name: "tallyPubKeyX", type: "bytes32" },
          { name: "tallyPubKeyY", type: "bytes32" },
          { name: "tallyScheme", type: "uint8" },
          { name: "electionType", type: "uint8" },
        ],
      },
    ],
    outputs: [
      { name: "electionId", type: "uint256" },
      { name: "election", type: "address" },
    ],
  },
  {
    type: "event",
    name: "ElectionCreated",
    inputs: [
      { name: "electionId", type: "uint256", indexed: true },
      { name: "election", type: "address", indexed: true },
      { name: "jurisdictionId", type: "bytes32", indexed: true },
      { name: "startTime", type: "uint64", indexed: false },
      { name: "cutoffTime", type: "uint64", indexed: false },
      { name: "electionType", type: "uint8", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getElection",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "electionCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getPartyRegistry",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ name: "registry", type: "address" }],
  },
];

const INBOX_ABI = [
  {
    type: "function",
    name: "submitVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "electionId", type: "uint256" },
      { name: "a", type: "uint256[2]" },
      { name: "b", type: "uint256[2][2]" },
      { name: "c", type: "uint256[2]" },
      { name: "publicInputs", type: "uint256[]" },
      { name: "encryptedBallot", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submitVoteBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "electionId", type: "uint256" },
      { name: "a", type: "uint256[2][]" },
      { name: "b", type: "uint256[2][2][]" },
      { name: "c", type: "uint256[2][]" },
      { name: "publicInputs", type: "uint256[][]" },
      { name: "encryptedBallots", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nullifierUsed",
    stateMutability: "view",
    inputs: [
      { name: "electionId", type: "uint256" },
      { name: "nullifier", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "closedBallotCount",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ballotHashOf",
    stateMutability: "view",
    inputs: [
      { name: "electionId", type: "uint256" },
      { name: "nullifier", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
];

const PARTY_REGISTRY_ABI = [
  {
    type: "function",
    name: "partyCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "hasActiveGates",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isRejected",
    stateMutability: "view",
    inputs: [{ name: "identityCommitment", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
];

const ELECTION_ABI = [
  {
    type: "function",
    name: "eligibleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "disqualificationRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "state",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "inbox",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

let _viem = undefined;
function tryViem() {
  if (_viem !== undefined) return _viem;
  try {
    _viem = require("viem");
  } catch {
    _viem = null;
  }
  return _viem;
}

function padAddress(addr) {
  const hex = String(addr).replace(/^0x/i, "").toLowerCase().padStart(40, "0");
  if (hex.length !== 40) throw new Error(`bad address: ${addr}`);
  return `0x${hex}`;
}

function decodeAddressWord(word) {
  const hex = String(word).replace(/^0x/i, "").padStart(64, "0");
  return `0x${hex.slice(24)}`;
}

function decodeUintWord(word) {
  return toBigInt(word);
}

/**
 * JSON-RPC helper. `eth_call` by default.
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} [id]
 */
function standbyDelayMs(res, attempt) {
  const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  const retryAfter = Number(header);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 5000);
  return Math.min(400 * 2 ** attempt, 2000);
}

async function rpc(rpcUrl, method, params, id = 1) {
  let res;
  let body;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (res.status === 503 && attempt < 4) {
      await new Promise((r) => setTimeout(r, standbyDelayMs(res, attempt)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`rpc ${method}: HTTP ${res.status}`);
    }
    body = await res.json();
    const message = body && body.error ? body.error.message || "" : "";
    if (res.ok && body && body.error && /maintenance handover|standby/i.test(message) && attempt < 4) {
      await new Promise((r) => setTimeout(r, standbyDelayMs(res, attempt)));
      continue;
    }
    break;
  }
  if (body.error) {
    const msg = body.error.message || JSON.stringify(body.error);
    throw new Error(`rpc ${method}: ${msg}`);
  }
  return body.result;
}

/**
 * @param {string} rpcUrl
 * @param {{to: string, data: string, from?: string}} tx
 * @param {string} [blockTag]
 * @returns {Promise<string>}
 */
async function ethCall(rpcUrl, tx, blockTag = "latest") {
  const params = [{ to: padAddress(tx.to), data: tx.data }];
  if (tx.from) params[0].from = padAddress(tx.from);
  return rpc(rpcUrl, "eth_call", [params[0], blockTag]);
}

/**
 * @param {string} rpcUrl
 * @param {{to: string, data: string, from?: string, gas?: string}} tx
 */
async function ethSendTransaction(rpcUrl, tx) {
  const payload = { to: padAddress(tx.to), data: tx.data };
  if (tx.from) payload.from = padAddress(tx.from);
  if (tx.gas) payload.gas = tx.gas;
  return rpc(rpcUrl, "eth_sendTransaction", [payload]);
}

function selectorFor(signature) {
  return functionSelector(signature);
}

/** View calldata: selector + one uint256. */
function calldataUint256(signature, value) {
  return `${selectorFor(signature)}${toHex32(value).slice(2)}`;
}

function calldataTwoUint256(signature, a, b) {
  return `${selectorFor(signature)}${toHex32(a).slice(2)}${toHex32(b).slice(2)}`;
}

/**
 * @typedef {Object} ChainClientOptions
 * @property {string} [rpcUrl] JSON-RPC endpoint (Foundry Anvil default http://127.0.0.1:8545).
 *   Civic ZK-Voting L2 sequencer listens on :8546 and is not this EVM.
 * @property {number} [chainId]
 * @property {string} factoryAddress ElectionFactory.
 * @property {string} [inboxAddress] BallotInbox; can also be read from Election.inbox().
 * @property {object} [walletClient] viem WalletClient (writes).
 * @property {object} [publicClient] viem PublicClient (reads).
 * @property {string} [account] Sender for eth_sendTransaction fallback.
 */

function normalizeOptions(factoryOrOpts, maybeOpts) {
  if (typeof factoryOrOpts === "string") {
    return { factoryAddress: factoryOrOpts, ...(maybeOpts || {}) };
  }
  return { ...(factoryOrOpts || {}) };
}

/**
 * Bind an ElectionFactory. Returns a handle with `address`, `abi`, reads, and writes.
 *
 * @param {string|ChainClientOptions} factoryAddressOrOpts
 * @param {ChainClientOptions} [opts]
 */
function getFactory(factoryAddressOrOpts, opts) {
  const options = normalizeOptions(factoryAddressOrOpts, opts);
  const address = padAddress(options.factoryAddress);
  const rpcUrl = options.rpcUrl || process.env.ZK_VOTING_RPC_URL || "http://127.0.0.1:8545";
  const chainId = options.chainId || Number(process.env.ZK_VOTING_CHAIN_ID || ZK_VOTING_CHAIN_ID);
  const viem = tryViem();

  async function read(functionName, args = []) {
    if (viem && options.publicClient) {
      return options.publicClient.readContract({
        address,
        abi: FACTORY_ABI,
        functionName,
        args,
      });
    }
    if (functionName === "electionCount") {
      const raw = await ethCall(rpcUrl, { to: address, data: selectorFor("electionCount()") });
      return decodeUintWord(raw);
    }
    if (functionName === "implementation") {
      const raw = await ethCall(rpcUrl, { to: address, data: selectorFor("implementation()") });
      return decodeAddressWord(raw);
    }
    if (functionName === "getElection") {
      const raw = await ethCall(rpcUrl, {
        to: address,
        data: calldataUint256("getElection(uint256)", args[0]),
      });
      return decodeAddressWord(raw);
    }
    throw new Error(`getFactory.read: ${functionName} needs viem publicClient or a known view selector`);
  }

  return {
    address,
    abi: FACTORY_ABI,
    rpcUrl,
    chainId,
    read,
    electionCount: () => read("electionCount"),
    implementation: () => read("implementation"),
    getElection: (electionId) => read("getElection", [electionId]),
    options,
  };
}

function assertElectionParams(params) {
  if (!params || typeof params !== "object") {
    throw new TypeError("createElection: ElectionParams object required");
  }
  const required = [
    "title",
    "metadataURI",
    "startTime",
    "cutoffTime",
    "maxParticipants",
    "treeDepth",
    "ballotSpecHash",
    "clerk",
    "registrar",
    "disqualificationOfficer",
    "tallyOperator",
    "verifier",
    "questionCount",
    "jurisdictionId",
  ];
  for (const key of required) {
    if (params[key] === undefined || params[key] === null) {
      throw new Error(`createElection: missing params.${key}`);
    }
  }
  const depth = Number(params.treeDepth);
  if (depth < 16 || depth > 32) {
    throw new Error("createElection: treeDepth must be 16..32");
  }
  if (toBigInt(params.cutoffTime) <= toBigInt(params.startTime)) {
    throw new Error("createElection: cutoffTime must be after startTime");
  }
}

function toViemParams(params) {
  return {
    title: String(params.title),
    metadataURI: String(params.metadataURI),
    startTime: toBigInt(params.startTime),
    cutoffTime: toBigInt(params.cutoffTime),
    maxParticipants: Number(params.maxParticipants),
    treeDepth: Number(params.treeDepth),
    ballotSpecHash: toHex32(params.ballotSpecHash),
    clerk: padAddress(params.clerk),
    registrar: padAddress(params.registrar),
    disqualificationOfficer: padAddress(params.disqualificationOfficer),
    tallyOperator: padAddress(params.tallyOperator),
    verifier: padAddress(params.verifier),
    questionCount: Number(params.questionCount),
    jurisdictionId: toHex32(params.jurisdictionId),
    tallyPubKeyX: toHex32(params.tallyPubKeyX || 0),
    tallyPubKeyY: toHex32(params.tallyPubKeyY || 0),
    tallyScheme: Number(params.tallyScheme || 0),
    electionType: Number(params.electionType || 0),
  };
}

function unpackCreateResult(result) {
  if (result == null) return {};
  if (Array.isArray(result)) {
    return { electionId: result[0], election: result[1] };
  }
  if (typeof result === "object") {
    return {
      electionId: result.electionId ?? result[0],
      election: result.election ?? result[1],
    };
  }
  return {};
}

/**
 * Read `ElectionCreated` from a transaction receipt.
 * @param {{logs?: Array<{data?: string, topics?: string[]}>}|null|undefined} receipt
 * @param {object} [viemLib]
 * @returns {{electionId?: bigint, election?: string, jurisdictionId?: string, startTime?: bigint, cutoffTime?: bigint, electionType?: number}}
 */
function decodeElectionCreated(receipt, viemLib) {
  const viem = viemLib || tryViem();
  if (!viem || typeof viem.decodeEventLog !== "function") return {};
  if (!receipt || !Array.isArray(receipt.logs)) return {};
  for (const log of receipt.logs) {
    try {
      const decoded = viem.decodeEventLog({
        abi: FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "ElectionCreated") {
        return {
          electionId: decoded.args.electionId,
          election: decoded.args.election,
          jurisdictionId: decoded.args.jurisdictionId,
          startTime: decoded.args.startTime,
          cutoffTime: decoded.args.cutoffTime,
          electionType: decoded.args.electionType,
        };
      }
    } catch {
      continue;
    }
  }
  return {};
}

async function resolveCreatedElection(factory, viem, receipt, simulated) {
  const fromSim = unpackCreateResult(simulated);
  const decoded = decodeElectionCreated(receipt, viem);
  let electionId = fromSim.electionId ?? decoded.electionId;
  let election = fromSim.election ?? decoded.election;
  if ((electionId == null || election == null) && typeof factory.electionCount === "function") {
    try {
      const count = await factory.electionCount();
      if (electionId == null) electionId = count;
      if (election == null && count != null) {
        election = await factory.getElection(count);
      }
    } catch {
      // leave unset; caller surfaces a clear error
    }
  }
  return { electionId, election };
}

/**
 * Create an election via ElectionFactory.createElection.
 *
 * @param {string|ChainClientOptions} factoryAddressOrOpts
 * @param {ElectionParams} params
 * @param {ChainClientOptions} [opts]
 * @returns {Promise<{hash?: string, electionId?: bigint, election?: string, receipt?: unknown, result?: unknown}>}
 */
async function createElection(factoryAddressOrOpts, params, opts) {
  const options = normalizeOptions(factoryAddressOrOpts, opts);
  assertElectionParams(params);
  const factory = getFactory(options);
  const viem = tryViem();
  const viemParams = toViemParams(params);

  if (viem && options.walletClient) {
    const account = options.walletClient.account || options.account;
    let hash;
    let simulated = null;
    if (options.publicClient && typeof options.publicClient.simulateContract === "function") {
      const sim = await options.publicClient.simulateContract({
        address: factory.address,
        abi: FACTORY_ABI,
        functionName: "createElection",
        args: [viemParams],
        account,
      });
      simulated = sim.result;
      hash = await options.walletClient.writeContract(sim.request);
    } else {
      hash = await options.walletClient.writeContract({
        address: factory.address,
        abi: FACTORY_ABI,
        functionName: "createElection",
        args: [viemParams],
        account,
        chain: options.walletClient.chain,
      });
    }
    let receipt = null;
    if (options.publicClient && typeof options.publicClient.waitForTransactionReceipt === "function") {
      receipt = await options.publicClient.waitForTransactionReceipt({ hash });
    }
    const created = await resolveCreatedElection(factory, viem, receipt, simulated);
    return { hash, receipt, factory: factory.address, ...created };
  }

  if (viem && typeof viem.encodeFunctionData === "function") {
    const data = viem.encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createElection",
      args: [viemParams],
    });
    if (!options.account) {
      return { data, to: factory.address, encoded: true };
    }
    const hash = await ethSendTransaction(factory.rpcUrl, {
      to: factory.address,
      data,
      from: options.account,
    });
    let receipt = null;
    try {
      receipt = await rpc(factory.rpcUrl, "eth_getTransactionReceipt", [hash]);
    } catch {
      receipt = null;
    }
    const created = await resolveCreatedElection(factory, viem, receipt, null);
    return { hash, receipt, factory: factory.address, ...created };
  }

  throw new Error(
    "createElection: encoding ElectionParams (dynamic ABI tuple) requires the optional `viem` peer dependency. Install viem, or pass walletClient/publicClient.",
  );
}

function groth16ToArgs(proof) {
  if (!proof) throw new Error("submitVote: proof required");
  // snarkjs JSON (pi_a/pi_b/pi_c) swaps G2 limbs. Solidity-ordered a/b/c does not.
  return snarkjsProofToSolidity(proof);
}

function envelopePublicInputs(envelope) {
  if (Array.isArray(envelope.publicInputs) && envelope.publicInputs.length === 5) {
    return envelope.publicInputs.map(toBigInt);
  }
  return serializePublicInputs({
    root: envelope.root,
    disqRoot: envelope.disqRoot,
    nullifier: envelope.nullifier,
    ballotHash: envelope.ballotHash,
    electionId: envelope.electionId,
  });
}

/**
 * Submit a vote to BallotInbox. Relayer/bundler is msg.sender on chain.
 *
 * @param {string|ChainClientOptions} inboxAddressOrOpts
 * @param {VoteEnvelope} envelope
 * @param {ChainClientOptions} [opts]
 */
async function submitVote(inboxAddressOrOpts, envelope, opts) {
  const options =
    typeof inboxAddressOrOpts === "string"
      ? { inboxAddress: inboxAddressOrOpts, ...(opts || {}) }
      : { ...(inboxAddressOrOpts || {}), ...(opts || {}) };

  const inbox = padAddress(options.inboxAddress || options.to);
  const rpcUrl = options.rpcUrl || process.env.ZK_VOTING_RPC_URL || "http://127.0.0.1:8545";
  const viem = tryViem();

  if (!envelope) throw new Error("submitVote: VoteEnvelope required");
  const electionId = toBigInt(envelope.electionId);
  const publicInputs = envelopePublicInputs(envelope);
  const pts = groth16ToArgs(envelope.proof);
  const encryptedBallot = envelope.encryptedBallot || "0x";
  const args = [electionId, pts.a, pts.b, pts.c, publicInputs, encryptedBallot];

  if (viem && options.walletClient) {
    const hash = await options.walletClient.writeContract({
      address: inbox,
      abi: INBOX_ABI,
      functionName: "submitVote",
      args,
      account: options.walletClient.account || options.account,
      chain: options.walletClient.chain,
    });
    return { hash, inbox };
  }

  if (viem && typeof viem.encodeFunctionData === "function") {
    const data = viem.encodeFunctionData({
      abi: INBOX_ABI,
      functionName: "submitVote",
      args,
    });
    if (!options.account) {
      return { data, to: inbox, encoded: true };
    }
    const hash = await ethSendTransaction(rpcUrl, {
      to: inbox,
      data,
      from: options.account,
    });
    return { hash, inbox };
  }

  throw new Error(
    "submitVote: encoding Groth16 + dynamic uint256[] / bytes requires the optional `viem` peer. Install viem, or pass a walletClient.",
  );
}

async function getElectionAddress(factoryAddressOrOpts, electionId, opts) {
  const factory = getFactory(factoryAddressOrOpts, opts);
  return factory.getElection(electionId);
}

async function closedBallotCount(inboxAddress, electionId, opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.ZK_VOTING_RPC_URL || "http://127.0.0.1:8545";
  const viem = tryViem();
  const inbox = padAddress(inboxAddress);
  if (viem && opts.publicClient) {
    return opts.publicClient.readContract({
      address: inbox,
      abi: INBOX_ABI,
      functionName: "closedBallotCount",
      args: [toBigInt(electionId)],
    });
  }
  const raw = await ethCall(rpcUrl, {
    to: inbox,
    data: calldataUint256("closedBallotCount(uint256)", electionId),
  });
  return decodeUintWord(raw);
}

async function nullifierUsed(inboxAddress, electionId, nullifier, opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.ZK_VOTING_RPC_URL || "http://127.0.0.1:8545";
  const inbox = padAddress(inboxAddress);
  const raw = await ethCall(rpcUrl, {
    to: inbox,
    data: calldataTwoUint256("nullifierUsed(uint256,uint256)", electionId, nullifier),
  });
  return decodeUintWord(raw) !== 0n;
}

const l1 = require("./l1");

module.exports = {
  ZK_VOTING_CHAIN_ID,
  FACTORY_ABI,
  INBOX_ABI,
  PARTY_REGISTRY_ABI,
  ELECTION_ABI,
  rpc,
  ethCall,
  ethSendTransaction,
  getFactory,
  createElection,
  decodeElectionCreated,
  submitVote,
  getElectionAddress,
  closedBallotCount,
  nullifierUsed,
  serializePublicInputs,
  encodePacked,
  encodeEgBallot,
  digestEgBallot,
  ballotDigest,
  padAddress,
  ...l1,
};
