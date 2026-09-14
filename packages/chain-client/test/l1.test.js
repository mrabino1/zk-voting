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
    const result = await postTallyHash({
      env: {},
      mirrorAddress: "0x" + "22".repeat(20),
      walletClient,
      electionId: 7,
      counts: [2, 0],
      totalBallots: 2,
      l2StateRoot: ZERO_HASH,
    });
    assert.equal(result.posted, true);
    assert.equal(result.status, "posted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].functionName, "postResult");
    assert.equal(calls[0].args[0], 7n);
    assert.equal(calls[0].args[1], computeTallyHash([2, 0]));
    assert.equal(calls[0].args[2], 2n);
    assert.equal(asBytes32(calls[0].args[3]), ZERO_HASH);
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
    });
    assert.equal(result.status, "already_posted");
    assert.equal(result.alreadyPosted, true);
    assert.equal(result.posted, false);
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
