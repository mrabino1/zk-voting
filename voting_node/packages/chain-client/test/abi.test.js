// NOT FOR PROFIT — civic public good, not a commercial product.
// The shipped ABIs must equal the Foundry build. In CI (CI=true) a missing build fails.
"use strict";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { ROLLUP_ABI, ELECTION_STATUS, decodeElectionInfo } = require("..");

const out = path.resolve(__dirname, "../../../../smart-contracts/out");
const artifact = (file, name) => path.join(out, file, `${name}.json`);
const built = existsSync(artifact("ZkVotingRollup.sol", "ZkVotingRollup"));
const skip = built || process.env.CI === "true" ? false : "no Foundry build (run forge build)";

test("abi/ matches the Foundry build", { skip }, () => {
  for (const [file, name] of [
    ["ZkVotingRollup.sol", "ZkVotingRollup"],
    ["Guardians.sol", "Guardians"],
  ]) {
    const want = JSON.parse(readFileSync(artifact(file, name), "utf8")).abi;
    const have = require(`../abi/${name}.json`);
    assert.deepEqual(have, want, `abi/${name}.json is stale: node scripts/export-rollup-abi.mjs`);
  }
});

test("the ABI has the lifecycle the node and operator call", () => {
  const names = new Set(ROLLUP_ABI.filter((i) => i.type === "function").map((i) => i.name));
  for (const fn of [
    "createElection",
    "commitGuardian",
    "finalizeKey",
    "registerVoters",
    "disqualify",
    "forceBallot",
    "closeElection",
    "commitBatch",
    "verifyBatch",
    "executeBatches",
    "activateDesertMode",
    "desertClose",
    "postDecryptionShares",
    "finalizeResult",
    "election",
    "result",
  ]) {
    assert.ok(names.has(fn), fn);
  }
});

test("decodeElectionInfo names the status and keeps big values exact", () => {
  const info = decodeElectionInfo({
    jurisdictionId: "0x01",
    configHash: "0x02",
    ballotSpecHash: "0x03",
    startTime: 10n,
    cutoffTime: 20n,
    createdAt: 5n,
    optionCount: 3,
    threshold: 2,
    guardianCount: 3,
    minBallots: 5,
    ballotCount: 0,
    status: 4,
    viaDesert: false,
    clerk: "0xc",
    registrar: "0xr",
    officer: "0xo",
    jointKeyX: 2n ** 200n,
    jointKeyY: 7n,
  });
  assert.equal(info.status, "closed");
  assert.equal(ELECTION_STATUS[4], "closed");
  assert.equal(info.startTime, 10);
  assert.deepEqual(info.jointKey, [(2n ** 200n).toString(), "7"]);
});
