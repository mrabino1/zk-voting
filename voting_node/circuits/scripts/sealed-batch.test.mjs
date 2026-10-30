/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Source checks for the sealed-vote circuits, plus a compile when circom is installed.
 * A compile does not produce a ceremony. Local keys stay untrusted.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

test("vote public word is the once-only id and the sealed id is nested", () => {
  const src = read("vote_lib.circom");
  assert.match(src, /voterId\.b <== electionId/);
  assert.match(src, /voterId\.out === nullifier/);
  assert.match(src, /sealedId\.a <== voterId\.out/);
  assert.match(src, /sealedId\.b <== ballotHash/);
  assert.doesNotMatch(src, /sealedId\.out === nullifier/);
});

test("per-ballot proof selects membership or non-membership at the bound root", () => {
  const src = read("per_ballot.circom");
  assert.match(src, /public \[electionId, ballotHash, boundRoot, hourlyContribution, finalContribution\]/);
  assert.match(src, /hourlyGate <== isReplacement \* hourlyContribution/);
  assert.match(src, /selected === boundRoot/);
  assert.match(src, /MerkleTreeInclusionProof/);
  assert.match(src, /gapOk === 1/);
});

test("batch transition publishes four inputs and binds the unique-count step", () => {
  const src = read("batch_transition.circom");
  assert.match(src, /public \[prevStateRoot, newStateRoot, dataHash, batchIndex\]/);
  assert.match(src, /kindIsFinal\.in <== kind - 2/);
  assert.match(src, /finalGate <== kindIsFinal\.out \* step/);
  assert.match(src, /finalGate === 0/);
  assert.match(src, /step === stepAcc\[n\]/);
  assert.match(src, /rootAcc\[n\] === ballotSetRoot/);
  assert.match(src, /hashAcc\[16\] === dataHash/);
  assert.doesNotMatch(src, /signal activeSq;/);
});

test("aggregate tally binds version 2 and keeps the share private", () => {
  const src = read("tally_aggregate.circom");
  assert.match(src, /version === 2/);
  assert.match(src, /signal input witnessShare/);
  assert.match(src, /public \[version, electionId, acceptedCount, countsHash, ballotRoot, aggregateHash, tallyKeyHash\]/);
  assert.doesNotMatch(src, /public \[.*witnessShare/);
});

test("circom compiles the sealed circuits", () => {
  const found = spawnSync("circom", ["--version"], { encoding: "utf8" });
  if (found.status !== 0) {
    const code = found.error && found.error.code;
    throw new Error(code === "ENOENT" ? "circom is not installed; refusing a silent pass" : found.stderr || found.stdout);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-circom-"));
  for (const file of ["per_ballot.circom", "batch_transition.circom", "tally_aggregate.circom"]) {
    const out = path.join(dir, file.replace(".circom", ".r1cs"));
    const run = spawnSync("circom", [path.join(ROOT, file), "--r1cs", "--output", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(fs.existsSync(out), true);
  }
});
