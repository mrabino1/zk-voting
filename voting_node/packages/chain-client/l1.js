/**
 * @fileoverview Ethereum L1 tally certification via L1TallyMirror.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * After the Node (or L2 Tally contract) posts per-option counts, an operator
 * may copy `keccak256(abi.encode(counts))` to L1
 * `L1TallyMirror.postCertifiedResult`. The L1 slot is
 * `(factory, electionId, jurisdictionId)` — not a public UUID and not a bare
 * uint256 — so a copied id cannot occupy the honest certification.
 * That hash is the same `countsHash` emitted by `Tally.TallyPosted`.
 *
 * When L1 RPC / mirror address / publisher key are unset, every write is a
 * documented no-op. CI must not supply mainnet keys.
 */

"use strict";

const { toBigInt, toHex32, encodePacked, keccak256, functionSelector } = require("@zk-voting/proof-helpers");

/** keccak256("zk-voting.election.identity.v1") — matches `ElectionIdentity.DOMAIN`. */
const IDENTITY_DOMAIN_STRING = "zk-voting.election.identity.v1";

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

const CERTIFICATION_COMPONENTS = [
  { name: "factory", type: "address" },
  { name: "electionId", type: "uint256" },
  { name: "jurisdictionId", type: "bytes32" },
  { name: "election", type: "address" },
  { name: "publicIdHash", type: "bytes32" },
  { name: "ballotSpecHash", type: "bytes32" },
  { name: "resultHash", type: "bytes32" },
  { name: "totalBallots", type: "uint256" },
  { name: "l2StateRoot", type: "bytes32" },
];

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
    name: "postCertifiedResult",
    stateMutability: "nonpayable",
    inputs: [{ name: "cert", type: "tuple", components: CERTIFICATION_COMPONENTS }],
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
    name: "resultHashOfIdentity",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "certificationIdOf",
    stateMutability: "view",
    inputs: [
      { name: "factory", type: "address" },
      { name: "electionId", type: "uint256" },
      { name: "jurisdictionId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "certificationsOfPublicId",
    stateMutability: "view",
    inputs: [{ name: "publicIdHash_", type: "bytes32" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "publicIdCollision",
    stateMutability: "view",
    inputs: [{ name: "publicIdHash_", type: "bytes32" }],
    outputs: [{ type: "bool" }],
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
    type: "function",
    name: "setJurisdictionPublisher",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jurisdictionId", type: "bytes32" },
      { name: "account", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setL2Factory",
    stateMutability: "nonpayable",
    inputs: [{ name: "factory_", type: "address" }],
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
  {
    type: "event",
    name: "ElectionIdentityCertified",
    inputs: [
      { name: "certificationId", indexed: true, type: "bytes32" },
      { name: "electionId", indexed: true, type: "uint256" },
      { name: "jurisdictionId", indexed: true, type: "bytes32" },
      { name: "factory", indexed: false, type: "address" },
      { name: "election", indexed: false, type: "address" },
      { name: "publicIdHash", indexed: false, type: "bytes32" },
      { name: "ballotSpecHash", indexed: false, type: "bytes32" },
      { name: "resultHash", indexed: false, type: "bytes32" },
      { name: "totalBallots", indexed: false, type: "uint256" },
      { name: "l2StateRoot", indexed: false, type: "bytes32" },
    ],
  },
  { type: "error", name: "AlreadyPosted", inputs: [] },
  { type: "error", name: "NotAuthorized", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ZeroResultHash", inputs: [] },
  { type: "error", name: "ZeroJurisdiction", inputs: [] },
  { type: "error", name: "ZeroFactory", inputs: [] },
  { type: "error", name: "WrongFactory", inputs: [] },
  { type: "error", name: "UnknownElection", inputs: [] },
  { type: "error", name: "ElectionMismatch", inputs: [] },
  { type: "error", name: "JurisdictionMismatch", inputs: [] },
  { type: "error", name: "BallotSpecMismatch", inputs: [] },
  { type: "error", name: "UseIdentityPost", inputs: [] },
  { type: "error", name: "FactoryAlreadyPinned", inputs: [] },
];

/** `keccak256("AlreadyPosted()")` — viem emits this when the ABI used to send the tx omitted the error. */
const ALREADY_POSTED_SELECTOR = "0xe9f155db";

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

function identityDomain() {
  return keccak256(IDENTITY_DOMAIN_STRING);
}

function zeroAddress() {
  return `0x${"00".repeat(20)}`;
}

/**
 * Node / chain jurisdiction id → bytes32. Matches `toJurisdictionBytes32`
 * (`keccak256(utf8(id))` unless already a 32-byte hex).
 * @param {string} id
 * @returns {`0x${string}`}
 */
function jurisdictionBytes32(id) {
  const s = String(id || "").trim();
  if (!s) return ZERO_HASH;
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  return keccak256(s);
}

/**
 * Canonical L1 slot. UUID is not this key.
 * `keccak256(abi.encode(DOMAIN, factory, electionId, jurisdictionId))`.
 */
function certificationId(factory, electionId, jurisdictionId) {
  const fac = factory && String(factory).trim() ? padAddress(factory) : zeroAddress();
  const encoded = `${identityDomain()}${toHex32(fac).slice(2)}${toHex32(
    electionId == null || electionId === "" ? 0 : electionId,
  ).slice(2)}${asBytes32(jurisdictionId).slice(2)}`;
  return keccak256(encoded);
}

/** keccak256 of the lowercase advertised UUID string. Attribute, not the L1 key. */
function publicIdHash(uuid) {
  if (uuid == null || String(uuid).trim() === "") return ZERO_HASH;
  return keccak256(String(uuid).trim().toLowerCase());
}

function isZeroAddress(value) {
  if (value == null || String(value).trim() === "") return true;
  const hex = String(value).replace(/^0x/i, "").toLowerCase();
  return hex.length === 0 || /^0+$/.test(hex);
}

function hasCertifiedIdentity(opts = {}) {
  const fac = String(opts.factory || "").trim();
  const j = String(opts.jurisdictionId || "").trim();
  if (!fac || isZeroAddress(fac)) return false;
  if (!j || isZeroHash(j)) return false;
  return true;
}

/**
 * Solidity `keccak256(abi.encode(uint256[] counts))`. The encoding is the
 * array offset, the length, then each word. Matches `Tally.submitTally`.
 *
 * @param {Array<string|number|bigint>} counts
 * @returns {`0x${string}`}
 */
function computeTallyHash(counts) {
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new Error("computeTallyHash: non-empty counts[] required");
  }
  const values = counts.map((n) => toBigInt(n));
  const words = [32n, BigInt(values.length), ...values];
  return keccak256(encodePacked(words.map(() => "uint256"), words));
}

function sumCounts(counts) {
  if (!Array.isArray(counts)) return 0n;
  return counts.reduce((acc, n) => acc + toBigInt(n), 0n);
}

function coalesceStr(explicit, fallback) {
  if (explicit !== undefined && explicit !== null) return String(explicit).trim();
  return fallback ? String(fallback).trim() : "";
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
  const env = readL1Env(Object.prototype.hasOwnProperty.call(opts, "env") ? opts.env : process.env);
  return {
    rpcUrl: coalesceStr(opts.rpcUrl !== undefined ? opts.rpcUrl : opts.l1Rpc, env.rpcUrl),
    mirrorAddress: coalesceStr(
      opts.mirrorAddress !== undefined ? opts.mirrorAddress : opts.tallyMirrorAddress,
      env.mirrorAddress,
    ),
    privateKey: coalesceStr(opts.privateKey, env.privateKey),
    settlementAddress: coalesceStr(opts.settlementAddress, env.settlementAddress),
    chainId: opts.chainId || env.chainId || 0,
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    account: opts.account,
    l2StateRoot: opts.l2StateRoot,
  };
}

function skipReasonFromNormalized(n) {
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

/**
 * @param {object} [opts]
 * @returns {string|null} Human-readable skip reason, or null if writes can proceed.
 */
function l1SkipReason(opts = {}) {
  return skipReasonFromNormalized(normalizeL1Options(opts));
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
    electionId: record.electionId != null ? String(record.electionId) : null,
    publicId: record.publicId || null,
    publicIdHash: record.publicIdHash || null,
    factory: record.factory || null,
    electionAddress: record.electionAddress || record.election || null,
    jurisdictionId: record.jurisdictionId || null,
    ballotSpecHash: record.ballotSpecHash || null,
    requestedHash: record.requestedHash || null,
    hashMismatch: Boolean(record.hashMismatch),
    certificationId: record.certificationId || null,
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

function certifiedArgs(args) {
  const factory = padAddress(args.factory);
  const electionId = toBigInt(args.electionId);
  const jurisdictionId = asBytes32(args.jurisdictionId);
  const election = args.election || args.electionAddress || zeroAddress();
  const pubHash = args.publicIdHash || (args.publicId ? publicIdHash(args.publicId) : ZERO_HASH);
  return {
    factory,
    electionId,
    jurisdictionId,
    election: padAddress(election),
    publicIdHash: asBytes32(pubHash),
    ballotSpecHash: asBytes32(args.ballotSpecHash),
    resultHash: asBytes32(args.resultHash),
    totalBallots: toBigInt(args.totalBallots),
    l2StateRoot: asBytes32(args.l2StateRoot),
    certificationId: certificationId(factory, electionId, jurisdictionId),
  };
}

async function encodePostCertifiedResult(args) {
  const viem = tryViem();
  if (!viem || typeof viem.encodeFunctionData !== "function") {
    throw new Error("encodePostCertifiedResult: optional `viem` peer is required");
  }
  const c = certifiedArgs(args);
  return viem.encodeFunctionData({
    abi: L1_TALLY_MIRROR_ABI,
    functionName: "postCertifiedResult",
    args: [
      {
        factory: c.factory,
        electionId: c.electionId,
        jurisdictionId: c.jurisdictionId,
        election: c.election,
        publicIdHash: c.publicIdHash,
        ballotSpecHash: c.ballotSpecHash,
        resultHash: c.resultHash,
        totalBallots: c.totalBallots,
        l2StateRoot: c.l2StateRoot,
      },
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

function collectErrorText(err) {
  const parts = [];
  let cur = err;
  for (let i = 0; i < 6 && cur; i += 1) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    for (const key of ["shortMessage", "message", "details", "signature", "data", "reason"]) {
      if (cur[key] != null) parts.push(String(cur[key]));
    }
    cur = cur.cause;
  }
  return parts.join(" ");
}

function alreadyPostedError(err) {
  const blob = collectErrorText(err);
  return /AlreadyPosted/i.test(blob) || blob.toLowerCase().includes(ALREADY_POSTED_SELECTOR);
}

/**
 * Post a tally hash to L1TallyMirror. No-ops when L1 env is unset.
 * When `factory` and `jurisdictionId` are set, posts `postCertifiedResult`
 * so two bodies that share a UUID or a uint256 do not share an L1 slot.
 *
 * @param {object} opts
 * @param {string|number|bigint} opts.electionId On-chain uint256, never the public UUID.
 * @param {Array<string|number|bigint>} [opts.counts] Used to compute resultHash when resultHash omitted.
 * @param {string} [opts.resultHash]
 * @param {string|number|bigint} [opts.totalBallots]
 * @param {string} [opts.l2StateRoot]
 * @param {string} [opts.factory]
 * @param {string} [opts.jurisdictionId] bytes32 hex or Node string id
 * @param {string} [opts.publicId] advertised UUID
 * @returns {Promise<object>}
 */
async function postTallyHash(opts = {}) {
  const n = normalizeL1Options(opts);
  const skip = skipReasonFromNormalized(n);
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

  if (!hasCertifiedIdentity(opts)) {
    throw new Error(
      "postTallyHash: factory and jurisdictionId required (legacy postResult collides on uint256)",
    );
  }
  const jRaw = String(opts.jurisdictionId || "").trim();
  const jid = /^0x[0-9a-fA-F]{64}$/.test(jRaw) ? jRaw.toLowerCase() : jurisdictionBytes32(jRaw);
  const cert = certifiedArgs({
    factory: opts.factory,
    electionId,
    jurisdictionId: jid,
    election: opts.election || opts.electionAddress,
    publicId: opts.publicId,
    publicIdHash: opts.publicIdHash,
    ballotSpecHash: opts.ballotSpecHash,
    resultHash,
    totalBallots,
    l2StateRoot,
  });

  const identityView = () => ({
    factory: cert.factory,
    jurisdictionId: cert.jurisdictionId,
    publicId: opts.publicId || null,
    publicIdHash: cert.publicIdHash,
    electionAddress: cert.election,
    ballotSpecHash: cert.ballotSpecHash,
    certificationId: cert.certificationId,
  });

  if (n.rpcUrl || n.publicClient) {
    try {
      const existing = await readResultHashOfIdentity(n.mirrorAddress, cert.certificationId, n);
      if (!isZeroHash(existing)) {
        const hashMismatch = existing.toLowerCase() !== resultHash.toLowerCase();
        return {
          posted: false,
          skipped: false,
          alreadyPosted: true,
          status: hashMismatch ? "already_posted_mismatch" : "already_posted",
          reason: hashMismatch ? "AlreadyPostedHashMismatch" : "AlreadyPosted",
          resultHash: existing,
          requestedHash: resultHash,
          hashMismatch,
          totalBallots: totalBallots.toString(),
          l2StateRoot,
          electionId: electionId.toString(),
          mirror: padAddress(n.mirrorAddress),
          settlement: n.settlementAddress ? padAddress(n.settlementAddress) : null,
          chainId: n.chainId || null,
          ...identityView(),
        };
      }
    } catch {
      // Mirror may be unreachable; attempt post and classify the revert.
    }
  }

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
        functionName: "postCertifiedResult",
        args: [
          {
            factory: cert.factory,
            electionId: cert.electionId,
            jurisdictionId: cert.jurisdictionId,
            election: cert.election,
            publicIdHash: cert.publicIdHash,
            ballotSpecHash: cert.ballotSpecHash,
            resultHash: cert.resultHash,
            totalBallots: cert.totalBallots,
            l2StateRoot: cert.l2StateRoot,
          },
        ],
        account: n.walletClient.account || n.account,
        chain: n.walletClient.chain,
      });
    } else if (viem && typeof viem.encodeFunctionData === "function") {
      const data = await encodePostCertifiedResult({ ...opts, ...args, factory: opts.factory });
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
          functionName: "postCertifiedResult",
          args: [
            {
              factory: cert.factory,
              electionId: cert.electionId,
              jurisdictionId: cert.jurisdictionId,
              election: cert.election,
              publicIdHash: cert.publicIdHash,
              ballotSpecHash: cert.ballotSpecHash,
              resultHash: cert.resultHash,
              totalBallots: cert.totalBallots,
              l2StateRoot: cert.l2StateRoot,
            },
          ],
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
          ...identityView(),
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
      ...identityView(),
    };
  } catch (err) {
    if (alreadyPostedError(err)) {
      let onChain = ZERO_HASH;
      try {
        onChain = await readResultHashOfIdentity(n.mirrorAddress, cert.certificationId, n);
      } catch {
        onChain = ZERO_HASH;
      }
      const stored = isZeroHash(onChain) ? resultHash : onChain;
      const hashMismatch = !isZeroHash(onChain) && onChain.toLowerCase() !== resultHash.toLowerCase();
      return {
        posted: false,
        skipped: false,
        alreadyPosted: true,
        status: hashMismatch ? "already_posted_mismatch" : "already_posted",
        reason: hashMismatch ? "AlreadyPostedHashMismatch" : "AlreadyPosted",
        resultHash: stored,
        requestedHash: resultHash,
        hashMismatch,
        totalBallots: totalBallots.toString(),
        l2StateRoot,
        electionId: electionId.toString(),
        mirror: padAddress(n.mirrorAddress),
        ...identityView(),
      };
    }
    throw err;
  }
}

async function readResultHashOfIdentity(mirrorAddress, id, opts = {}) {
  const n = normalizeL1Options(opts);
  const mirror = padAddress(mirrorAddress || n.mirrorAddress);
  const viem = tryViem();
  if (viem && n.publicClient) {
    return n.publicClient.readContract({
      address: mirror,
      abi: L1_TALLY_MIRROR_ABI,
      functionName: "resultHashOfIdentity",
      args: [asBytes32(id)],
    });
  }
  if (!n.rpcUrl) {
    throw new Error("readResultHashOfIdentity: L1_RPC unset");
  }
  const raw = await ethCall(n.rpcUrl, {
    to: mirror,
    data: `${functionSelector("resultHashOfIdentity(bytes32)")}${asBytes32(id).slice(2)}`,
  });
  return asBytes32(raw);
}

module.exports = {
  ZERO_HASH,
  IDENTITY_DOMAIN_STRING,
  L1_TALLY_MIRROR_ABI,
  ROLLUP_SETTLEMENT_VIEW_ABI,
  computeTallyHash,
  sumCounts,
  asBytes32,
  isZeroHash,
  identityDomain,
  jurisdictionBytes32,
  certificationId,
  publicIdHash,
  hasCertifiedIdentity,
  readL1Env,
  l1SkipReason,
  l1Configured,
  publicCertification,
  encodePostResult,
  encodePostCertifiedResult,
  readResultHash,
  readResultHashOfIdentity,
  readSettlementStateRoot,
  postTallyHash,
  alreadyPostedError,
  ALREADY_POSTED_SELECTOR,
};
