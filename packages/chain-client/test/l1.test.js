/**
 * @fileoverview L1 tally-hash helpers (no network, no keys).
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  computeTallyHash,
  sumCounts,
  l1SkipReason,
  l1Configured,
  readL1Env,
  publicCertification,
  postTallyHash,
  encodePostResult,
  asBytes32,
  ZERO_HASH,
  certificationId,
  publicIdHash,
  jurisdictionBytes32,
  identityDomain,
  IDENTITY_DOMAIN_STRING,
  hasCertifiedIdentity,
} = require("../l1");

describe("computeTallyHash", () => {
  test("matches packed keccak256 of uint256 words (Solidity abi.encodePacked)", () => {
    const hash = computeTallyHash([2, 0]);
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    // keccak256(uint256(2) || uint256(0)) — same as Tally.sol countsHash.
    assert.equal(
      hash,
      "0xabbb5caa7dda850e60932de0934eb1f9d0f59695050f761dc64e443e5030a569",
    );
    assert.equal(computeTallyHash(["2", 0n]), hash);
  });

  test("empty counts throw", () => {
    assert.throws(() => computeTallyHash([]), /non-empty/);
  });

  test("sumCounts", () => {
    assert.equal(sumCounts([2, 0, 5]), 7n);
  });
});

describe("L1 env skip", () => {
  test("fully unset is a graceful no-op reason", () => {
    const env = {};
    assert.equal(l1SkipReason({ env }), "L1 env unset");
    assert.equal(l1Configured({ env }), false);
    const parsed = readL1Env(env);
    assert.equal(parsed.rpcUrl, "");
    assert.equal(parsed.mirrorAddress, "");
    assert.equal(parsed.privateKey, "");
  });

  test("explicit empty env does not inherit process.env L1_*", () => {
    assert.equal(l1SkipReason({ env: {} }), "L1 env unset");
    assert.equal(l1Configured({ env: {} }), false);
  });

  test("does not treat L2 PRIVATE_KEY as a publisher key", () => {
    const env = { PRIVATE_KEY: "0x" + "ab".repeat(32) };
    assert.equal(readL1Env(env).privateKey, "");
    assert.equal(l1SkipReason({ env }), "L1 env unset");
  });

  test("partial env names the missing pieces", () => {
    const env = { L1_RPC: "http://127.0.0.1:8545" };
    const reason = l1SkipReason({ env });
    assert.match(reason, /incomplete/);
    assert.match(reason, /L1_TALLY_MIRROR_ADDRESS/);
    assert.match(reason, /L1_PUBLISHER_PRIVATE_KEY/);
  });

  test("walletClient + mirror is enough (no private key in CI)", () => {
    const opts = {
      env: {},
      mirrorAddress: "0x" + "11".repeat(20),
      walletClient: { writeContract: async () => "0xhash" },
    };
    assert.equal(l1SkipReason(opts), null);
    assert.equal(l1Configured(opts), true);
  });
});

describe("postTallyHash", () => {
  test("no-ops when L1 env is unset", async () => {
    const result = await postTallyHash({
      env: {},
      electionId: 1,
      counts: [2, 0],
    });
    assert.equal(result.skipped, true);
    assert.equal(result.posted, false);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "L1 env unset");
    assert.equal(result.resultHash, computeTallyHash([2, 0]));
  });

  test("posts via mocked walletClient (no RPC, no mainnet keys)", async () => {
    const calls = [];
    const walletClient = {
      writeContract: async (req) => {
        calls.push(req);
        return "0x" + "ab".repeat(32);
      },
    };
    const factory = "0x" + "11".repeat(20);
    const result = await postTallyHash({
      env: {},
      mirrorAddress: "0x" + "22".repeat(20),
      walletClient,
      electionId: 7,
      counts: [2, 0],
      totalBallots: 2,
      l2StateRoot: ZERO_HASH,
      factory,
      jurisdictionId: "north",
    });
    assert.equal(result.posted, true);
    assert.equal(result.status, "posted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].functionName, "postCertifiedResult");
    assert.equal(calls[0].args[0].electionId, 7n);
    assert.equal(calls[0].args[0].resultHash, computeTallyHash([2, 0]));
    assert.equal(calls[0].args[0].totalBallots, 2n);
    assert.equal(asBytes32(calls[0].args[0].l2StateRoot), ZERO_HASH);
  });

  test("refuses legacy uint256 postResult when factory is missing", async () => {
    await assert.rejects(
      () =>
        postTallyHash({
          env: {},
          mirrorAddress: "0x" + "22".repeat(20),
          walletClient: { writeContract: async () => "0x" + "ab".repeat(32) },
          electionId: 7,
          counts: [2, 0],
        }),
      /factory and jurisdictionId required/,
    );
  });

  test("AlreadyPosted is not thrown", async () => {
    const walletClient = {
      writeContract: async () => {
        const err = new Error("execution reverted: AlreadyPosted");
        err.shortMessage = "AlreadyPosted";
        throw err;
      },
    };
    const result = await postTallyHash({
      env: {},
      mirrorAddress: "0x" + "22".repeat(20),
      walletClient,
      electionId: 7,
      counts: [1, 1],
      factory: "0x" + "11".repeat(20),
      jurisdictionId: "north",
    });
    assert.equal(result.status, "already_posted");
    assert.equal(result.alreadyPosted, true);
    assert.equal(result.posted, false);
  });

  test("AlreadyPosted via custom-error selector (viem ABI miss)", async () => {
    const walletClient = {
      writeContract: async () => {
        const err = new Error(
          'The contract function "postResult" reverted with the following signature:\n0xe9f155db',
        );
        err.shortMessage =
          'The contract function "postResult" reverted with the following signature:\n0xe9f155db';
        err.cause = { signature: "0xe9f155db", data: "0xe9f155db" };
        throw err;
      },
    };
    const result = await postTallyHash({
      env: {},
      mirrorAddress: "0x" + "22".repeat(20),
      walletClient,
      electionId: 7,
      counts: [1, 1],
      factory: "0x" + "11".repeat(20),
      jurisdictionId: "north",
    });
    assert.equal(result.status, "already_posted");
    assert.equal(result.alreadyPosted, true);
  });

  test("short-circuits when resultHashOf is already set (no write)", async () => {
    const writes = [];
    const existing = computeTallyHash([1, 1]);
    const result = await postTallyHash({
      env: {},
      mirrorAddress: "0x" + "22".repeat(20),
      walletClient: {
        writeContract: async (req) => {
          writes.push(req);
          return "0x" + "cd".repeat(32);
        },
      },
      publicClient: {
        readContract: async () => existing,
      },
      electionId: 7,
      counts: [1, 1],
      factory: "0x" + "11".repeat(20),
      jurisdictionId: "north",
    });
    assert.equal(result.status, "already_posted");
    assert.equal(result.resultHash, existing);
    assert.equal(writes.length, 0);
  });
});

describe("publicCertification", () => {
  test("strips nothing secret and normalizes status", () => {
    const pub = publicCertification({
      posted: true,
      status: "posted",
      txHash: "0xabc",
      privateKey: "do-not-leak",
      resultHash: computeTallyHash([1]),
    });
    assert.equal(pub.posted, true);
    assert.equal(pub.txHash, "0xabc");
    assert.equal(pub.privateKey, undefined);
  });
});

describe("encodePostResult", () => {
  test("encodes postResult calldata when viem is present", async () => {
    let viem;
    try {
      viem = require("viem");
    } catch {
      return;
    }
    if (!viem || typeof viem.encodeFunctionData !== "function") return;
    const { functionSelector } = require("@zk-voting/proof-helpers");
    const data = await encodePostResult({
      electionId: 1,
      resultHash: computeTallyHash([2, 0]),
      totalBallots: 2,
      l2StateRoot: ZERO_HASH,
    });
    assert.match(data, /^0x[0-9a-f]+$/);
    assert.equal(data.slice(0, 10), functionSelector("postResult(uint256,bytes32,uint256,bytes32)"));
  });
});

describe("election identity (L1 slot)", () => {
  test("certificationId differs for the same uint256 on two factories", () => {
    const j = jurisdictionBytes32("demo");
    const a = certificationId(`0x${"11".repeat(20)}`, 1, j);
    const b = certificationId(`0x${"22".repeat(20)}`, 1, j);
    assert.match(a, /^0x[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });

  test("certificationId matches Solidity abi.encode(DOMAIN, factory, electionId, jurisdictionId)", () => {
    let viem;
    try {
      viem = require("viem");
    } catch {
      return;
    }
    if (!viem?.encodeAbiParameters || !viem?.keccak256) return;
    const factory = `0x${"11".repeat(20)}`;
    const electionId = 7n;
    const jurisdictionId = jurisdictionBytes32("demo");
    const domain = identityDomain();
    const encoded = viem.encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [domain, factory, electionId, jurisdictionId],
    );
    assert.equal(certificationId(factory, 7, jurisdictionId), viem.keccak256(encoded));
    assert.equal(hasCertifiedIdentity({ factory, jurisdictionId }), true);
    assert.equal(hasCertifiedIdentity({ factory: `0x${"00".repeat(20)}`, jurisdictionId }), false);
  });

  test("publicIdHash is keccak of the lowercase UUID string, not the L1 key", () => {
    const uuid = "3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01";
    const hash = publicIdHash(uuid);
    assert.equal(hash, publicIdHash(uuid.toUpperCase()));
    const slot = certificationId(`0x${"11".repeat(20)}`, 1, jurisdictionBytes32("demo"));
    assert.notEqual(hash, slot);
    assert.equal(identityDomain(), require("@zk-voting/proof-helpers").keccak256(IDENTITY_DOMAIN_STRING));
  });

  test("postTallyHash with factory+jurisdiction uses postCertifiedResult", async () => {
    const calls = [];
    const walletClient = {
      writeContract: async (req) => {
        calls.push(req);
        return `0x${"ab".repeat(32)}`;
      },
    };
    const factory = `0x${"11".repeat(20)}`;
    const result = await postTallyHash({
      env: {},
      mirrorAddress: `0x${"22".repeat(20)}`,
      walletClient,
      electionId: 7,
      counts: [2, 0],
      totalBallots: 2,
      factory,
      jurisdictionId: "north",
      publicId: "3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01",
    });
    assert.equal(result.posted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].functionName, "postCertifiedResult");
    const cert = calls[0].args[0];
    assert.equal(cert.factory.toLowerCase(), factory);
    assert.equal(cert.electionId, 7n);
    assert.equal(cert.jurisdictionId, jurisdictionBytes32("north"));
    assert.equal(cert.publicIdHash, publicIdHash("3f1c0a6e-9b2d-4e11-8c7a-1a2b3c4d5e01"));
    assert.equal(result.certificationId, certificationId(factory, 7, jurisdictionBytes32("north")));
  });
});
