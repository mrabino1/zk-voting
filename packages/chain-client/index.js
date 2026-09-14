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
  toBigInt,
  toHex32,
  hexToBytes,
  bytesToHex,
  functionSelector,
  encodePacked,
} = require("@zk-voting/proof-helpers");
const { REPUBLIC_CHAIN_ID } = require("@zk-voting/types");

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
        ],
      },
    ],
    outputs: [
      { name: "electionId", type: "uint256" },
      { name: "election", type: "address" },
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
    name: "acceptedBallots",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
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
async function rpc(rpcUrl, method, params, id = 1) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    throw new Error(`rpc ${method}: HTTP ${res.status}`);
  }
  const body = await res.json();
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
 *   Civic Republic L2 sequencer listens on :8546 and is not this EVM.
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
  const rpcUrl = options.rpcUrl || process.env.REPUBLIC_RPC_URL || "http://127.0.0.1:8545";
  const chainId = options.chainId || Number(process.env.REPUBLIC_CHAIN_ID || REPUBLIC_CHAIN_ID);
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
  };
}

/**
 * Create an election via ElectionFactory.createElection.
 *
 * @param {string|ChainClientOptions} factoryAddressOrOpts
 * @param {ElectionParams} params
 * @param {ChainClientOptions} [opts]
 * @returns {Promise<{hash?: string, electionId?: bigint, election?: string, result?: unknown}>}
 */
async function createElection(factoryAddressOrOpts, params, opts) {
  const options = normalizeOptions(factoryAddressOrOpts, opts);
  assertElectionParams(params);
  const factory = getFactory(options);
  const viem = tryViem();
  const viemParams = toViemParams(params);

  if (viem && options.walletClient) {
    const account = options.walletClient.account || options.account;
    const hash = await options.walletClient.writeContract({
      address: factory.address,
      abi: FACTORY_ABI,
      functionName: "createElection",
      args: [viemParams],
      account,
      chain: options.walletClient.chain,
    });
    let receipt = null;
    if (options.publicClient && typeof options.publicClient.waitForTransactionReceipt === "function") {
      receipt = await options.publicClient.waitForTransactionReceipt({ hash });
    }
    return { hash, receipt, factory: factory.address };
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
    return { hash, factory: factory.address };
  }

  throw new Error(
    "createElection: encoding ElectionParams (dynamic ABI tuple) requires the optional `viem` peer dependency. Install viem, or pass walletClient/publicClient.",
  );
}

function groth16ToArgs(proof) {
  if (!proof) throw new Error("submitVote: proof required");
  const a = proof.a || proof.pi_a;
  const b = proof.b || proof.pi_b;
  const c = proof.c || proof.pi_c;
  if (!a || !b || !c) throw new Error("submitVote: proof must have a, b, c (or pi_a/pi_b/pi_c)");
  return {
    a: [toBigInt(a[0]), toBigInt(a[1])],
    b: [
      [toBigInt(b[0][0]), toBigInt(b[0][1])],
      [toBigInt(b[1][0]), toBigInt(b[1][1])],
    ],
    c: [toBigInt(c[0]), toBigInt(c[1])],
  };
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
  const rpcUrl = options.rpcUrl || process.env.REPUBLIC_RPC_URL || "http://127.0.0.1:8545";
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

async function acceptedBallots(inboxAddress, electionId, opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.REPUBLIC_RPC_URL || "http://127.0.0.1:8545";
  const viem = tryViem();
  const inbox = padAddress(inboxAddress);
  if (viem && opts.publicClient) {
    return opts.publicClient.readContract({
      address: inbox,
      abi: INBOX_ABI,
      functionName: "acceptedBallots",
      args: [toBigInt(electionId)],
    });
  }
  const raw = await ethCall(rpcUrl, {
    to: inbox,
    data: calldataUint256("acceptedBallots(uint256)", electionId),
  });
  return decodeUintWord(raw);
}

async function nullifierUsed(inboxAddress, electionId, nullifier, opts = {}) {
  const rpcUrl = opts.rpcUrl || process.env.REPUBLIC_RPC_URL || "http://127.0.0.1:8545";
  const inbox = padAddress(inboxAddress);
  const raw = await ethCall(rpcUrl, {
    to: inbox,
    data: calldataTwoUint256("nullifierUsed(uint256,uint256)", electionId, nullifier),
  });
  return decodeUintWord(raw) !== 0n;
}

module.exports = {
  REPUBLIC_CHAIN_ID,
  FACTORY_ABI,
  INBOX_ABI,
  ELECTION_ABI,
  rpc,
  ethCall,
  ethSendTransaction,
  getFactory,
  createElection,
  submitVote,
  getElectionAddress,
  acceptedBallots,
  nullifierUsed,
  serializePublicInputs,
  encodePacked,
  padAddress,
};
