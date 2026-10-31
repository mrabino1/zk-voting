/**
 * Real Groth16 proofs for the indexed per-ballot circuit at depth 4.
 * A first ballot verifies. A second first ballot for the same key has no witness.
 * A re-vote replacement verifies. Local keys are not a ceremony.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  cipherHash,
  createTree,
  emptyRoot,
  gapWitness,
  insert,
  replace,
  rootOf,
  voterKey,
} from "../../apps/node/src/indexedBallotSet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LEVELS = 4;

function run(cmd, args, cwd) {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}\n${out.stderr || out.stdout}`);
  }
  return out;
}

function witnessInput(fields) {
  const input = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) input[key] = value.map((n) => n.toString());
    else input[key] = value.toString();
  }
  return input;
}

function buildInput({ secret, electionId, points, isReplacement, boundRoot, gap, oldPoints, ballot }) {
  return witnessInput({
    nullifierSecret: secret,
    electionId,
    c1x: points[0],
    c1y: points[1],
    c2x: points[2],
    c2y: points[3],
    isReplacement,
    boundRoot,
    low: gap.low,
    nextKey: gap.nextKey,
    predCipher: gap.predCipher,
    oldC1x: oldPoints[0],
    oldC1y: oldPoints[1],
    oldC2x: oldPoints[2],
    oldC2y: oldPoints[3],
    pathElements: gap.path.pathElements,
    pathIndices: gap.path.pathIndices,
    ballotHash: ballot,
  });
}

test("first ballot proves, a second first has no witness, a re-vote proves", { timeout: 600_000 }, () => {
  const found = spawnSync("circom", ["--version"], { encoding: "utf8" });
  if (found.status !== 0) throw new Error("circom is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexed-proof-"));
  run("circom", [path.join(ROOT, "mains/per_ballot_test.circom"), "--r1cs", "--wasm", "--output", dir], dir);
  const r1cs = path.join(dir, "per_ballot_test.r1cs");
  const wasm = path.join(dir, "per_ballot_test_js", "per_ballot_test.wasm");
  const ptau0 = path.join(dir, "pot14_0000.ptau");
  const ptau1 = path.join(dir, "pot14_0001.ptau");
  const ptau = path.join(dir, "pot14_final.ptau");
  const zkey0 = path.join(dir, "per_0000.zkey");
  const zkey = path.join(dir, "per_final.zkey");
  const vkey = path.join(dir, "verification_key.json");
  run("snarkjs", ["powersoftau", "new", "bn128", "14", ptau0], dir);
  run("snarkjs", ["powersoftau", "contribute", ptau0, ptau1, "--name=indexed", "-e=indexed-ballot-entropy"], dir);
  run("snarkjs", ["powersoftau", "prepare", "phase2", ptau1, ptau], dir);
  run("snarkjs", ["groth16", "setup", r1cs, ptau, zkey0], dir);
  run("snarkjs", ["zkey", "contribute", zkey0, zkey, "--name=indexed", "-e=indexed-ballot-phase2"], dir);
  run("snarkjs", ["zkey", "export", "verificationkey", zkey, vkey], dir);

  const secret = 42n;
  const electionId = 7n;
  const key = voterKey(secret, electionId);
  const tree = createTree(LEVELS);
  assert.equal(rootOf(tree), emptyRoot(LEVELS));
  const firstPoints = [1n, 2n, 3n, 4n];
  const firstCipher = cipherHash(...firstPoints);
  const firstGap = gapWitness(tree, key);
  assert.equal(firstGap.open, true);
  const firstInput = buildInput({
    secret,
    electionId,
    points: firstPoints,
    isReplacement: 0n,
    boundRoot: firstGap.root,
    gap: { ...firstGap, predCipher: firstGap.predCipher },
    oldPoints: [0n, 0n, 0n, 0n],
    ballot: firstCipher,
  });
  const firstJson = path.join(dir, "first.json");
  const firstWtns = path.join(dir, "first.wtns");
  const firstProof = path.join(dir, "first-proof.json");
  const firstPublic = path.join(dir, "first-public.json");
  fs.writeFileSync(firstJson, JSON.stringify(firstInput));
  run("snarkjs", ["wtns", "calculate", wasm, firstJson, firstWtns], dir);
  run("snarkjs", ["groth16", "prove", zkey, firstWtns, firstProof, firstPublic], dir);
  run("snarkjs", ["groth16", "verify", vkey, firstPublic, firstProof], dir);
  const firstPub = JSON.parse(fs.readFileSync(firstPublic, "utf8")).map((s) => BigInt(s));
  assert.deepEqual(new Set(firstPub), new Set([electionId, firstCipher, firstGap.root]));

  insert(tree, key, firstCipher);
  const secondPoints = [5n, 6n, 7n, 8n];
  const secondCipher = cipherHash(...secondPoints);
  const blocked = gapWitness(tree, key);
  assert.equal(blocked.open, false);
  const secondJson = path.join(dir, "second.json");
  fs.writeFileSync(
    secondJson,
    JSON.stringify(
      buildInput({
        secret,
        electionId,
        points: secondPoints,
        isReplacement: 0n,
        boundRoot: blocked.root,
        gap: blocked,
        oldPoints: [0n, 0n, 0n, 0n],
        ballot: secondCipher,
      }),
    ),
  );
  const rejected = spawnSync("snarkjs", ["wtns", "calculate", wasm, secondJson, path.join(dir, "second.wtns")], {
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0, "a second first ballot must be unsatisfiable");

  const member = replace(tree, key, secondCipher);
  const replJson = path.join(dir, "repl.json");
  const replWtns = path.join(dir, "repl.wtns");
  const replProof = path.join(dir, "repl-proof.json");
  const replPublic = path.join(dir, "repl-public.json");
  fs.writeFileSync(
    replJson,
    JSON.stringify(
      buildInput({
        secret,
        electionId,
        points: secondPoints,
        isReplacement: 1n,
        boundRoot: blocked.root,
        gap: {
          low: key,
          nextKey: member.nextKey,
          predCipher: 0n,
          path: member.path,
        },
        oldPoints: firstPoints,
        ballot: secondCipher,
      }),
    ),
  );
  run("snarkjs", ["wtns", "calculate", wasm, replJson, replWtns], dir);
  run("snarkjs", ["groth16", "prove", zkey, replWtns, replProof, replPublic], dir);
  run("snarkjs", ["groth16", "verify", vkey, replPublic, replProof], dir);
  const replPub = JSON.parse(fs.readFileSync(replPublic, "utf8")).map((s) => BigInt(s));
  assert.deepEqual(new Set(replPub), new Set([electionId, secondCipher, blocked.root]));
});
