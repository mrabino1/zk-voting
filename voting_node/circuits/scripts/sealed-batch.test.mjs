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

test("vote submission id mixes the ballot hash", () => {
  const src = read("vote_lib.circom");
  assert.match(src, /submissionInner\.b <== electionId/);
  assert.match(src, /submissionId\.b <== ballotHash/);
  assert.match(src, /submissionId\.out === nullifier/);
  assert.doesNotMatch(src, /nullifierCheck\.nullifier === nullifier/);
});

test("per-ballot proof publishes the bound root and a zero hourly contribution on replacement", () => {
  const src = read("per_ballot.circom");
  assert.match(src, /public \[electionId, ballotHash, boundRoot, hourlyContribution, finalContribution\]/);
  assert.match(src, /hourlyGate <== isReplacement \* hourlyContribution/);
  assert.match(src, /uniqueStep <== 1 - isReplacement/);
});

test("final batch kind carries no turnout step and duplicate first ballots clash", () => {
  const src = read("batch_transition.circom");
  assert.match(src, /kindIsFinal\.in <== kind - 2/);
  assert.match(src, /finalGate <== kindIsFinal\.out \* step/);
  assert.match(src, /finalGate === 0/);
  assert.match(src, /bothFirst \* diffZero\.out/);
  assert.match(src, /clash === 0/);
});

test("aggregate tally binds version 2 and keeps the share private", () => {
  const src = read("tally_aggregate.circom");
  assert.match(src, /version === 2/);
  assert.match(src, /signal input witnessShare/);
  assert.match(src, /public \[version, electionId, acceptedCount, countsHash, ballotRoot, aggregateHash, tallyKeyHash\]/);
  assert.doesNotMatch(src, /public \[.*witnessShare/);
});

test("circom compiles the sealed circuits when the binary is present", () => {
  const found = spawnSync("circom", ["--version"], { encoding: "utf8" });
  if (found.status !== 0) {
    assert.equal(found.error && found.error.code, "ENOENT");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-circom-"));
  for (const file of ["per_ballot.circom", "batch_transition.circom", "tally_aggregate.circom"]) {
    const out = path.join(dir, file.replace(".circom", ".r1cs"));
    const run = spawnSync("circom", [path.join(ROOT, file), "--r1cs", "--output", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(fs.existsSync(out), true);
  }
});
