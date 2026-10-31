/**
 * @fileoverview Factory ABI surface for the per-election party registry.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { FACTORY_ABI, INBOX_ABI, PARTY_REGISTRY_ABI, decodeElectionCreated } = require("../index.js");

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

  test("INBOX_ABI carries sealed ranked batch methods and no per-ballot commit", () => {
    const names = INBOX_ABI.filter((item) => item.type === "function").map((item) => item.name);
    for (const n of ["submitVoteBatchRanked", "rankingRoot", "rankingCount"]) assert.equal(names.includes(n), true, n);
    assert.equal(names.includes("commitRanking"), false);
    assert.equal(names.includes("rankingHashOf"), false);
    const ranked = INBOX_ABI.find((item) => item.name === "submitVoteBatchRanked");
    assert.equal(ranked.inputs.at(-1).type, "bytes32[]");
    const ev = INBOX_ABI.find((item) => item.type === "event" && item.name === "RankingBatchCommitted");
    assert.deepEqual(ev.inputs.map((i) => i.name), ["electionId", "digest", "count", "rankingRoot"]);
  });

  test("ElectionCreated carries electionType and createElection sends it", () => {
    const created = FACTORY_ABI.find((item) => item.type === "event" && item.name === "ElectionCreated");
    assert.deepEqual(
      created.inputs.map((input) => input.name),
      ["electionId", "election", "jurisdictionId", "startTime", "cutoffTime", "electionType"],
    );
    const field = created.inputs[5];
    assert.equal(field.type, "uint8");
    assert.equal(field.indexed, false);
    const create = FACTORY_ABI.find((item) => item.type === "function" && item.name === "createElection");
    const names = create.inputs[0].components.map((component) => component.name);
    assert.equal(names[names.length - 1], "electionType");
    assert.equal(typeof decodeElectionCreated, "function");
  });

  test("party registry ABI includes live gates", () => {
    const names = PARTY_REGISTRY_ABI.filter((item) => item.type === "function").map((item) => item.name);
    assert.ok(names.includes("hasActiveGates"));
    assert.ok(names.includes("isRejected"));
    assert.ok(names.includes("partyCount"));
  });
});
