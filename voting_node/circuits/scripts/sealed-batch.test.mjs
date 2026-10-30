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

test("legacy vote public word is the voter id; sealed public word is the submission id", () => {
  const legacy = read("vote_lib.circom");
  assert.match(legacy, /voterId\.b <== electionId/);
  assert.match(legacy, /voterId\.out === nullifier/);
  assert.match(legacy, /sealedId\.a <== voterId\.out/);
  assert.match(legacy, /sealedId\.b <== ballotHash/);
  assert.doesNotMatch(legacy, /sealedId\.out === nullifier/);
  const sealed = read("vote_sealed_body.circom");
  assert.match(sealed, /sealedId\.out === nullifier/);
  assert.doesNotMatch(sealed, /voterId\.out === nullifier/);
  assert.match(sealed, /BallotMembership/);
  assert.match(sealed, /boundRoot/);
});

test("per-ballot proof selects membership or non-membership at the bound root", () => {
  const src = read("per_ballot_lib.circom");
  assert.match(src, /selected === boundRoot/);
  assert.match(src, /MerkleTreeInclusionProof/);
  assert.match(src, /gapOk === 1/);
  assert.match(src, /hourlyGate <== isReplacement \* hourlyContribution/);
  assert.match(read("per_ballot.circom"), /PerBallot\(20\)/);
  assert.match(read("mains/per_ballot_test.circom"), /PerBallot\(4\)/);
});

test("batch transition uses the merkle ballot set and binds products", () => {
  const src = read("batch_transition_lib.circom");
  assert.match(src, /step === stepAcc\[n\]/);
  assert.match(src, /finalGate === 0/);
  assert.match(src, /running\[n\] === ballotSetRoot/);
  assert.match(src, /hourlyAcc\[n\] === nextHourly/);
  assert.match(src, /finalAcc\[n\] === nextFinal/);
  assert.match(src, /tagAcc\[n\] === tagHash/);
  assert.match(src, /pointAcc\[8\] === pointTag/);
  assert.match(src, /secret\[i\] <== voter\[i\]\.out/);
  assert.match(src, /hashAcc\[16\] === dataHash/);
  assert.doesNotMatch(src, /rootAcc\[n\] === ballotSetRoot/);
  assert.match(read("batch_transition.circom"), /BatchTransition\(4, 4\)/);
  assert.match(read("mains/batch_transition_prod.circom"), /BatchTransition\(4, 20\)/);
});

test("aggregate tally binds version 2 and keeps the share private", () => {
  const src = read("tally_aggregate.circom");
  assert.match(src, /version === 2/);
  assert.match(src, /signal input witnessShare/);
  assert.match(src, /public \[version, electionId, acceptedCount, countsHash, ballotRoot, aggregateHash, tallyKeyHash\]/);
  assert.doesNotMatch(src, /public \[.*witnessShare/);
});

test("circom compiles the sealed circuits at both depths", () => {
  const found = spawnSync("circom", ["--version"], { encoding: "utf8" });
  if (found.status !== 0) {
    const code = found.error && found.error.code;
    throw new Error(code === "ENOENT" ? "circom is not installed; refusing a silent pass" : found.stderr || found.stdout);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-circom-"));
  const files = [
    "per_ballot.circom",
    "mains/per_ballot_test.circom",
    "batch_transition.circom",
    "mains/batch_transition_prod.circom",
    "vote_sealed.circom",
    "mains/vote_sealed_smoke.circom",
    "tally_aggregate.circom",
  ];
  for (const file of files) {
    const out = path.join(dir, path.basename(file).replace(".circom", ".r1cs"));
    const run = spawnSync("circom", [path.join(ROOT, file), "--r1cs", "--output", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, `${file}\n${run.stderr || run.stdout}`);
    assert.equal(fs.existsSync(out), true, file);
  }
});
