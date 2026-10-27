/**
 * @fileoverview Factory ABI surface for the per-election party registry.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { FACTORY_ABI, INBOX_ABI, PARTY_REGISTRY_ABI } = require("../index.js");

describe("external party factory ABI", () => {
  test("ElectionFactory exposes getPartyRegistry", () => {
    const fn = FACTORY_ABI.find((item) => item.type === "function" && item.name === "getPartyRegistry");
    assert.ok(fn);
    assert.equal(fn.inputs[0].type, "uint256");
    assert.equal(fn.outputs[0].type, "address");
  });

  test("INBOX_ABI has no commitment-next-to-nullifier entry point", () => {
    const names = INBOX_ABI.filter((item) => item.type === "function").map((item) => item.name);
    assert.equal(names.includes("submitVoteWithClearance"), false);
    assert.equal(names.includes("submitVote"), true);
    const batch = INBOX_ABI.find((item) => item.type === "function" && item.name === "submitVoteBatch");
    assert.ok(batch);
    assert.equal(
      batch.inputs.some((input) => input.name === "identityCommitment"),
      false,
    );
  });

  test("party registry ABI includes live gates", () => {
    const names = PARTY_REGISTRY_ABI.filter((item) => item.type === "function").map((item) => item.name);
    assert.ok(names.includes("hasActiveGates"));
    assert.ok(names.includes("isRejected"));
    assert.ok(names.includes("partyCount"));
  });
});
