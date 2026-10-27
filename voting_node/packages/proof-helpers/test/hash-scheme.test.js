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
  poseidonHashLeftRight,
  snarkjsProofToSolidity,
  identityCommitment,
  computeNullifier,
  createTree,
  insertLeaf,
  merkleProof,
  verifyInclusion,
  buildVoteWitness,
  voteWitnessToSnarkInput,
  verifyDisqNonMembership,
  disqGap,
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

  test("poseidon matches circomlib Poseidon(2)", () => {
    const known = 7853200120776062878684798364095072458815029376092732009249414926327459813530n;
    assert.equal(poseidonHashLeftRight(1n, 2n), known);
    assert.equal(hashLeftRight(1n, 2n, HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1), "0x" + known.toString(16).padStart(64, "0"));
    assert.equal(normalizeHashScheme("poseidon"), HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1);
    assert.notEqual(poseidonHashLeftRight(1n, 2n), standInHashLeftRight(1n, 2n));
  });

  test("snarkjs G2 limbs are swapped for Solidity", () => {
    const proof = {
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
        ["1", "0"],
      ],
      pi_c: ["7", "8", "1"],
    };
    const sol = snarkjsProofToSolidity(proof);
    assert.deepEqual(sol.b, [
      [4n, 3n],
      [6n, 5n],
    ]);
    const already = snarkjsProofToSolidity({
      a: ["1", "2"],
      b: [
        ["4", "3"],
        ["6", "5"],
      ],
      c: ["7", "8"],
    });
    assert.deepEqual(already.b, [
      [4n, 3n],
      [6n, 5n],
    ]);
  });

  test("env flags: mock by default, proving path disables mock", () => {
    assert.equal(provingPathEnabled({}), false);
    assert.equal(useMockVerifier({}), true);
    assert.equal(resolveHashScheme({}), HASH_SCHEMES.KECCAK_DEV_V1);
    assert.equal(provingPathEnabled({ ZK_VOTING_PROVING_PATH: "1" }), true);
    assert.equal(useMockVerifier({ ZK_VOTING_PROVING_PATH: "1" }), false);
    assert.equal(resolveHashScheme({ ZK_VOTING_PROVING_PATH: "1" }), HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1);
    assert.equal(useMockVerifier({ ZK_VOTING_USE_MOCK_VERIFIER: "0" }), false);
    assert.equal(
      resolveHashScheme({ ZK_VOTING_HASH_SCHEME: "standin-v0" }),
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

  test("poseidon witness inclusion is non-degenerate", () => {
    const scheme = HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1;
    const w = buildVoteWitness({ depth: 4, scheme });
    assert.equal(w.pathElements.length, 4);
    assert.equal(w.disqPathElements.length, 4);
    assert.notEqual(w.root, w.leaf);
    assert.equal(verifyInclusion(w.leaf, w.pathElements, w.pathIndices, w.root, scheme), true);
    assert.equal(
      verifyDisqNonMembership(
        w.leaf,
        w.disqLow,
        w.disqNext,
        w.disqPathElements,
        w.disqPathIndices,
        w.disqRoot,
        scheme,
      ),
      true,
    );
    assert.equal(w.disqLow, 0n);
    assert.equal(w.disqNext, 0n);
    assert.equal(w.nullifier, computeNullifier(3n, 1n, scheme));
    assert.equal(w.choice, 0n);
    assert.equal(w.choiceRandomness, 9n);
    assert.equal(w.ballotHash, poseidonHashLeftRight(0n, 9n));
    const snark = voteWitnessToSnarkInput(w);
    assert.equal(snark.choice, "0");
    assert.equal(snark.choiceRandomness, "9");
  });

  test("a disqualified voter's non-membership proof fails", () => {
    const scheme = HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1;
    const voter = identityCommitment(2n, 3n, scheme);
    const other = identityCommitment(11n, 13n, scheme);
    assert.notEqual(voter, other);
    assert.throws(
      () =>
        buildVoteWitness({
          depth: 4,
          scheme,
          disqualifiedCommitments: [voter],
        }),
      /disqualified voter cannot prove non-membership/,
    );
    assert.equal(disqGap([voter], voter, scheme), null);

    const w = buildVoteWitness({
      depth: 4,
      scheme,
      disqualifiedCommitments: [other],
    });
    assert.equal(
      verifyDisqNonMembership(
        w.leaf,
        w.disqLow,
        w.disqNext,
        w.disqPathElements,
        w.disqPathIndices,
        w.disqRoot,
        scheme,
      ),
      true,
    );
    assert.equal(
      verifyDisqNonMembership(
        other,
        w.disqLow,
        w.disqNext,
        w.disqPathElements,
        w.disqPathIndices,
        w.disqRoot,
        scheme,
      ),
      false,
      "the disqualified commitment is a chain boundary, not a gap",
    );
    assert.equal(disqGap([other], other, scheme), null);
  });

  test("vote witness public inputs match serializePublicInputs order", () => {
    const w = buildVoteWitness({ depth: 20, scheme: HASH_SCHEMES.STANDIN_V0 });
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
