"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ballotDigest, digestEgBallot, encodeEgBallot, ciphertextHash } = require("../ballot-digest");
const { poseidonHashLeftRight } = require("../poseidon");

test("a 130-byte EG ballot is Poseidon(ct, 0), and options fold in order", () => {
  const primary = [1n, 2n, 3n, 4n];
  const bare = encodeEgBallot(...primary);
  assert.equal((bare.length - 2) / 2, 130);
  const ct = ciphertextHash(...primary);
  const n0 = poseidonHashLeftRight(ct, 0n);
  assert.equal(digestEgBallot(bare), n0);
  assert.notEqual(n0, ct);
  const options = [
    [5n, 6n, 7n, 8n],
    [9n, 10n, 11n, 12n],
  ];
  const longer = encodeEgBallot(...primary, options);
  assert.equal((longer.length - 2) / 2, 162 + 2 * 128);
  const expected = ballotDigest(...primary, options);
  assert.equal(digestEgBallot(longer), expected);
  const swapped = encodeEgBallot(...primary, [options[1], options[0]]);
  assert.notEqual(digestEgBallot(swapped), expected);
  assert.equal(digestEgBallot("0x4547"), null);
});
