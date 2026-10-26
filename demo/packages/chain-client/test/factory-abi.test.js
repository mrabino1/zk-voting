/**
 * @fileoverview Factory ABI surface for the per-election party registry.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { CLEARANCE_INBOX_ABI, FACTORY_ABI, INBOX_ABI, PARTY_REGISTRY_ABI } = require("../index.js");

describe("external party factory ABI", () => {
  test("ElectionFactory exposes getPartyRegistry", () => {
    const fn = FACTORY_ABI.find((item) => item.type === "function" && item.name === "getPartyRegistry");
    assert.ok(fn);
    assert.equal(fn.inputs[0].type, "uint256");
    assert.equal(fn.outputs[0].type, "address");
  });

  test("default INBOX_ABI does not expose submitVoteWithClearance (plaintext commitment in calldata)", () => {
    assert.equal(
      INBOX_ABI.some((item) => item.type === "function" && item.name === "submitVoteWithClearance"),
      false,
    );
  });

  test("submitVoteWithClearance is only in the explicit opt-in CLEARANCE_INBOX_ABI", () => {
    const fn = CLEARANCE_INBOX_ABI.find(
      (item) => item.type === "function" && item.name === "submitVoteWithClearance",
    );
    assert.ok(fn);
    assert.equal(fn.inputs[fn.inputs.length - 2].name, "identityCommitment");
    assert.equal(fn.inputs[fn.inputs.length - 1].name, "mustAttestIds");
  });

  test("party registry ABI includes live gates", () => {
    const names = PARTY_REGISTRY_ABI.filter((item) => item.type === "function").map((item) => item.name);
    assert.ok(names.includes("hasActiveGates"));
    assert.ok(names.includes("isRejected"));
    assert.ok(names.includes("partyCount"));
  });
});
