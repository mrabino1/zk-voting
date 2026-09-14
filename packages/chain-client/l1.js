/**
 * @fileoverview Ethereum L1 tally certification via L1TallyMirror.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * After the Node (or L2 Tally contract) posts per-option counts, an operator
 * may copy `keccak256(abi.encodePacked(counts))` to L1 `L1TallyMirror.postResult`.
 * That hash is the same `countsHash` emitted by `Tally.TallyPosted`.
 *
 * When L1 RPC / mirror address / publisher key are unset, every write is a
 * documented no-op. CI must not supply mainnet keys.
 */

"use strict";

const { toBigInt, toHex32, encodePacked, keccak256, functionSelector } = require("@zk-voting/proof-helpers");

function padAddress(addr) {
  const hex = String(addr).replace(/^0x/i, "").toLowerCase().padStart(40, "0");
  if (hex.length !== 40) throw new Error(`bad address: ${addr}`);
  return `0x${hex}`;
}

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

async function ethCall(rpcUrl, tx, blockTag = "latest") {
  const params = [{ to: padAddress(tx.to), data: tx.data }];
  if (tx.from) params[0].from = padAddress(tx.from);
  return rpc(rpcUrl, "eth_call", [params[0], blockTag]);
}

async function ethSendTransaction(rpcUrl, tx) {
  const payload = { to: padAddress(tx.to), data: tx.data };
  if (tx.from) payload.from = padAddress(tx.from);
  if (tx.gas) payload.gas = tx.gas;
  return rpc(rpcUrl, "eth_sendTransaction", [payload]);
}

const ZERO_HASH = `0x${"00".repeat(32)}`;

const L1_TALLY_MIRROR_ABI = [
  {
    type: "function",
    name: "postResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "electionId", type: "uint256" },
      { name: "resultHash", type: "bytes32" },
      { name: "totalBallots", type: "uint256" },
      { name: "l2StateRoot", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resultHashOf",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "totalBallotsOf",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimedStateRoot",
    stateMutability: "view",
    inputs: [{ name: "electionId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "setPublisher",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "ElectionCertified",
    inputs: [
      { name: "electionId", indexed: true, type: "uint256" },
      { name: "resultHash", indexed: false, type: "bytes32" },
      { name: "totalBallots", indexed: false, type: "uint256" },
      { name: "l2StateRoot", indexed: false, type: "bytes32" },
    ],
  },
];

const ROLLUP_SETTLEMENT_VIEW_ABI = [
  {
    type: "function",
    name: "stateRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "batchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
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

function asBytes32(value) {
  if (value == null || value === "") return ZERO_HASH;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }
  return toHex32(value);
}

function isZeroHash(value) {
  if (value == null || value === "") return true;
  const hex = String(value).replace(/^0x/i, "").toLowerCase();
  return hex.length === 0 || /^0+$/.test(hex);
}

/**
 * Solidity `keccak256(abi.encodePacked(uint256[] counts))` — packed 32-byte
 * words, no length prefix. Matches `Tally.submitTally` `countsHash`.
 *
 * @param {Array<string|number|bigint>} counts
 * @returns {`0x${string}`}
 */
function computeTallyHash(counts) {
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new Error("computeTallyHash: non-empty counts[] required");
  }
  const types = counts.map(() => "uint256");
  const values = counts.map((n) => toBigInt(n));
  return keccak256(encodePacked(types, values));
}

function sumCounts(counts) {
  if (!Array.isArray(counts)) return 0n;
  return counts.reduce((acc, n) => acc + toBigInt(n), 0n);
}

/**
 * Read L1 env without throwing. Empty strings mean "not configured".
 * Does **not** fall back to the L2 prover `PRIVATE_KEY`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function readL1Env(env = process.env) {
  const src = env || {};
  const chainRaw = src.L1_CHAIN_ID;
  return {
    rpcUrl: String(src.L1_RPC || src.L1_RPC_URL || "").trim(),
    mirrorAddress: String(
      src.L1_TALLY_MIRROR_ADDRESS || src.TALLY_MIRROR_ADDRESS || src.TALLY_MIRROR || "",
    ).trim(),
    privateKey: String(src.L1_PUBLISHER_PRIVATE_KEY || src.L1_PRIVATE_KEY || "").trim(),
    settlementAddress: String(
      src.L1_SETTLEMENT_ADDRESS || src.SETTLEMENT_ADDRESS || src.SETTLEMENT || "",
    ).trim(),
    chainId: chainRaw ? Number(chainRaw) : 0,
  };
}

function normalizeL1Options(opts = {}) {
  const env = readL1Env(opts.env || process.env);
  return {
    rpcUrl: opts.rpcUrl || opts.l1Rpc || env.rpcUrl,
    mirrorAddress: opts.mirrorAddress || opts.tallyMirrorAddress || env.mirrorAddress,
    privateKey: opts.privateKey || env.privateKey,
    settlementAddress: opts.settlementAddress || env.settlementAddress,
    chainId: opts.chainId || env.chainId || 0,
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    account: opts.account,
    l2StateRoot: opts.l2StateRoot,
  };
}

/**
 * @param {object} [opts]
 * @returns {string|null} Human-readable skip reason, or null if writes can proceed.
 */
function l1SkipReason(opts = {}) {
  const n = normalizeL1Options(opts);
  const missing = [];
  if (!n.mirrorAddress) missing.push("L1_TALLY_MIRROR_ADDRESS");
  if (!n.walletClient) {
    if (!n.rpcUrl) missing.push("L1_RPC");
    if (!n.privateKey && !n.account) missing.push("L1_PUBLISHER_PRIVATE_KEY");
  }
  if (missing.length === 0) return null;
  if (missing.length >= 3) return "L1 env unset";
  return `L1 env incomplete (missing ${missing.join(", ")})`;
}

function l1Configured(opts = {}) {
  return l1SkipReason(opts) === null;
}

function publicCertification(record) {
  if (!record || typeof record !== "object") return null;
  return {
    status: record.status || (record.posted ? "posted" : record.skipped ? "skipped" : "unknown"),
    posted: Boolean(record.posted),
    skipped: Boolean(record.skipped),
    alreadyPosted: Boolean(record.alreadyPosted),
    reason: record.reason || null,
    error: record.error || null,
    resultHash: record.resultHash || null,
    totalBallots: record.totalBallots != null ? String(record.totalBallots) : null,
    l2StateRoot: record.l2StateRoot || null,
    txHash: record.txHash || record.hash || null,
    chainId: record.chainId || null,
    mirror: record.mirror || null,
    settlement: record.settlement || null,
  };
}

async function encodePostResult(args) {
  const viem = tryViem();
  if (!viem || typeof viem.encodeFunctionData !== "function") {
    throw new Error("encodePostResult: optional `viem` peer is required to ABI-encode postResult");
  }
  return viem.encodeFunctionData({
    abi: L1_TALLY_MIRROR_ABI,
    functionName: "postResult",
    args: [
      toBigInt(args.electionId),
      asBytes32(args.resultHash),
      toBigInt(args.totalBallots),
      asBytes32(args.l2StateRoot),
    ],
  });
}

function viewCalldataUint256(signature, value) {
  return `${functionSelector(signature)}${toHex32(value).slice(2)}`;
}

async function readResultHash(mirrorAddress, electionId, opts = {}) {
  const n = normalizeL1Options(opts);
  const mirror = padAddress(mirrorAddress || n.mirrorAddress);
  const rpcUrl = n.rpcUrl;
  const viem = tryViem();
  if (viem && n.publicClient) {
    return n.publicClient.readContract({
      address: mirror,
      abi: L1_TALLY_MIRROR_ABI,
      functionName: "resultHashOf",
      args: [toBigInt(electionId)],
    });
  }
  if (!rpcUrl) {
    throw new Error("readResultHash: L1_RPC unset");
  }
  const raw = await ethCall(rpcUrl, {
    to: mirror,
    data: viewCalldataUint256("resultHashOf(uint256)", electionId),
  });
  return asBytes32(raw);
}

async function readSettlementStateRoot(opts = {}) {
  const n = normalizeL1Options(opts);
  const settlement = n.settlementAddress;
  if (!settlement) return ZERO_HASH;
  const viem = tryViem();
  if (viem && n.publicClient) {
    return n.publicClient.readContract({
      address: padAddress(settlement),
      abi: ROLLUP_SETTLEMENT_VIEW_ABI,
      functionName: "stateRoot",
    });
  }
  if (!n.rpcUrl) return ZERO_HASH;
  const raw = await ethCall(n.rpcUrl, {
    to: padAddress(settlement),
    data: functionSelector("stateRoot()"),
  });
  return asBytes32(raw);
}

function alreadyPostedError(err) {
  const msg = String(err && (err.shortMessage || err.message || err) || "");
  return /AlreadyPosted/i.test(msg);
}

/**
 * Post a tally hash to L1TallyMirror. No-ops when L1 env is unset.
 *
 * @param {object} opts
 * @param {string|number|bigint} opts.electionId
 * @param {Array<string|number|bigint>} [opts.counts] Used to compute resultHash when resultHash omitted.
 * @param {string} [opts.resultHash]
 * @param {string|number|bigint} [opts.totalBallots]
 * @param {string} [opts.l2StateRoot]
 * @returns {Promise<object>}
 */
async function postTallyHash(opts = {}) {
  const n = normalizeL1Options(opts);
  const skip = l1SkipReason(n);
  if (skip) {
    return {
      posted: false,
      skipped: true,
      status: "skipped",
      reason: skip,
      resultHash: opts.resultHash || (opts.counts ? computeTallyHash(opts.counts) : null),
    };
  }

  const counts = opts.counts;
  const resultHash = asBytes32(opts.resultHash || computeTallyHash(counts));
  if (isZeroHash(resultHash)) {
    throw new Error("postTallyHash: refusing zero resultHash");
  }
  const electionId = toBigInt(opts.electionId);
  const totalBallots =
    opts.totalBallots != null ? toBigInt(opts.totalBallots) : counts ? sumCounts(counts) : 0n;

  let l2StateRoot = n.l2StateRoot || opts.l2StateRoot;
  if ((l2StateRoot == null || l2StateRoot === "") && n.settlementAddress) {
    try {
      l2StateRoot = await readSettlementStateRoot(n);
    } catch {
      l2StateRoot = ZERO_HASH;
    }
  }
  l2StateRoot = asBytes32(l2StateRoot);

  const args = {
    electionId,
    resultHash,
    totalBallots,
    l2StateRoot,
  };

  try {
    const viem = tryViem();
    let hash;
    if (n.walletClient) {
      hash = await n.walletClient.writeContract({
        address: padAddress(n.mirrorAddress),
        abi: L1_TALLY_MIRROR_ABI,
        functionName: "postResult",
        args: [args.electionId, args.resultHash, args.totalBallots, args.l2StateRoot],
        account: n.walletClient.account || n.account,
        chain: n.walletClient.chain,
      });
    } else if (viem && typeof viem.encodeFunctionData === "function") {
      const data = await encodePostResult(args);
      if (n.privateKey && viem.createWalletClient) {
        const accounts = require("viem/accounts");
        const pk = n.privateKey.startsWith("0x") ? n.privateKey : `0x${n.privateKey}`;
        const account = accounts.privateKeyToAccount(pk);
        const chainId = n.chainId || Number(await rpc(n.rpcUrl, "eth_chainId", []));
        const chain = viem.defineChain({
          id: chainId,
          name: "l1",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [n.rpcUrl] } },
        });
        const wallet = viem.createWalletClient({
          account,
          chain,
          transport: viem.http(n.rpcUrl),
        });
        hash = await wallet.writeContract({
          address: padAddress(n.mirrorAddress),
          abi: L1_TALLY_MIRROR_ABI,
          functionName: "postResult",
          args: [args.electionId, args.resultHash, args.totalBallots, args.l2StateRoot],
        });
        n.chainId = chainId;
      } else if (n.account) {
        hash = await ethSendTransaction(n.rpcUrl, {
          to: n.mirrorAddress,
          data,
          from: n.account,
        });
      } else {
        return {
          posted: false,
          skipped: false,
          status: "encoded",
          data,
          to: padAddress(n.mirrorAddress),
          resultHash,
          totalBallots: totalBallots.toString(),
          l2StateRoot,
          electionId: electionId.toString(),
        };
      }
    } else {
      throw new Error("postTallyHash: install optional `viem` peer, or pass walletClient");
    }

    let receipt = null;
    if (n.publicClient && typeof n.publicClient.waitForTransactionReceipt === "function" && hash) {
      receipt = await n.publicClient.waitForTransactionReceipt({ hash });
    }

    return {
      posted: true,
      skipped: false,
      status: "posted",
      txHash: hash,
      hash,
      receipt,
      resultHash,
      totalBallots: totalBallots.toString(),
      l2StateRoot,
      electionId: electionId.toString(),
      mirror: padAddress(n.mirrorAddress),
      settlement: n.settlementAddress ? padAddress(n.settlementAddress) : null,
      chainId: n.chainId || null,
    };
  } catch (err) {
    if (alreadyPostedError(err)) {
      return {
        posted: false,
        skipped: false,
        alreadyPosted: true,
        status: "already_posted",
        reason: "AlreadyPosted",
        resultHash,
        totalBallots: totalBallots.toString(),
        l2StateRoot,
        electionId: electionId.toString(),
        mirror: padAddress(n.mirrorAddress),
      };
    }
    throw err;
  }
}

module.exports = {
  ZERO_HASH,
  L1_TALLY_MIRROR_ABI,
  ROLLUP_SETTLEMENT_VIEW_ABI,
  computeTallyHash,
  sumCounts,
  asBytes32,
  isZeroHash,
  readL1Env,
  l1SkipReason,
  l1Configured,
  publicCertification,
  encodePostResult,
  readResultHash,
  readSettlementStateRoot,
  postTallyHash,
};
