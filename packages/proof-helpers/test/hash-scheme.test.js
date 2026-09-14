/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  HASH_SCHEMES,
  SNARK_SCALAR_FIELD,
  keccakHashLeftRight,
  hashLeftRight,
  standInHashLeftRight,
  identityCommitment,
  computeNullifier,
  createTree,
  insertLeaf,
  merkleProof,
  verifyInclusion,
  buildVoteWitness,
  voteWitnessToSnarkInput,
  serializePublicInputs,
  provingPathEnabled,
  useMockVerifier,
  resolveHashScheme,
  normalizeHashScheme,
  encodePacked,
} = require("..");

describe("hash schemes", () => {
  test("stand-in matches circom a+b+a*b over Fr", () => {
    assert.equal(standInHashLeftRight(0n, 0n), 0n);
    assert.equal(standInHashLeftRight(1n, 2n), 5n);
    assert.equal(standInHashLeftRight(2n, 3n), 11n);
    const F = SNARK_SCALAR_FIELD;
    assert.equal(standInHashLeftRight(F - 1n, 2n), F - 1n);
    assert.equal(standInHashLeftRight(1n, 0n), 1n);
  });

  test("keccak-dev-v1 is still the default hashLeftRight", () => {
    const a = 1n;
    const b = 2n;
    assert.equal(hashLeftRight(a, b), keccakHashLeftRight(a, b));
    assert.equal(
      hashLeftRight(a, b, HASH_SCHEMES.KECCAK_DEV_V1),
      keccakHashLeftRight(a, b),
    );
  });

  test("keccak packed encoding is two 32-byte words", () => {
    const packed = encodePacked(["bytes32", "bytes32"], [
      "0x" + "00".repeat(31) + "01",
      "0x" + "00".repeat(31) + "02",
    ]);
    assert.equal(packed.length, 2 + 128);
  });

  test("poseidon is gated and throws until wired", () => {
    assert.throws(
      () => hashLeftRight(1n, 2n, HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1),
      /not wired/,
    );
    assert.equal(normalizeHashScheme("poseidon"), HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1);
  });

  test("env flags: mock by default, proving path disables mock", () => {
    assert.equal(provingPathEnabled({}), false);
    assert.equal(useMockVerifier({}), true);
    assert.equal(resolveHashScheme({}), HASH_SCHEMES.KECCAK_DEV_V1);
    assert.equal(provingPathEnabled({ REPUBLIC_PROVING_PATH: "1" }), true);
    assert.equal(useMockVerifier({ REPUBLIC_PROVING_PATH: "1" }), false);
    assert.equal(resolveHashScheme({ REPUBLIC_PROVING_PATH: "1" }), HASH_SCHEMES.STANDIN_V0);
    assert.equal(useMockVerifier({ REPUBLIC_USE_MOCK_VERIFIER: "0" }), false);
    assert.equal(
      resolveHashScheme({ REPUBLIC_HASH_SCHEME: "standin-v0" }),
      HASH_SCHEMES.STANDIN_V0,
    );
  });
});

describe("stand-in merkle (proving path)", () => {
  test("two-leaf tree has a non-degenerate first sibling", () => {
    const scheme = HASH_SCHEMES.STANDIN_V0;
    const tree = createTree(16, scheme);
    assert.equal(tree.currentRoot, 0n, "stand-in zeros collapse to 0");
    const leaf = identityCommitment(2n, 3n, scheme);
    const sibling = identityCommitment(5n, 7n, scheme);
    assert.equal(leaf, 11n);
    assert.equal(sibling, 47n);
    insertLeaf(tree, leaf);
    assert.equal(tree.currentRoot, leaf, "hash(leaf, 0) == leaf for stand-in");
    insertLeaf(tree, sibling);
    const proof = merkleProof(tree.leaves, 0, 16, scheme);
    assert.equal(proof.pathElements[0], sibling);
    assert.equal(proof.pathIndices[0], 0);
    assert.equal(proof.root, tree.currentRoot);
    assert.equal(proof.root, standInHashLeftRight(leaf, sibling));
    assert.equal(verifyInclusion(leaf, proof.pathElements, proof.pathIndices, proof.root, scheme), true);
  });

  test("vote witness public inputs match serializePublicInputs order", () => {
    const w = buildVoteWitness({ depth: 20 });
    assert.equal(w.scheme, HASH_SCHEMES.STANDIN_V0);
    assert.equal(w.pathElements.length, 20);
    const snark = voteWitnessToSnarkInput(w);
    assert.equal(snark.pathElements.length, 20);
    const pub = serializePublicInputs({
      root: w.root,
      disqRoot: w.disqRoot,
      nullifier: w.nullifier,
      ballotHash: w.ballotHash,
      electionId: w.electionId,
    });
    assert.equal(pub.length, 5);
    assert.equal(pub[0], w.root);
    assert.equal(pub[2], computeNullifier(3n, 1n, HASH_SCHEMES.STANDIN_V0));
  });
});
