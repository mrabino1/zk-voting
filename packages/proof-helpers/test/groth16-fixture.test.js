/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Verifies the committed untrusted Vote(4) Groth16 fixture.
 * Missing keys or snarkjs fail the test. This is not MockVerifier.acceptAll.
 * The fixture is not a ceremony.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const FIXTURE = path.resolve(__dirname, "../../../circuits/fixtures/untrusted");

test("untrusted Vote(4) Poseidon proof verifies and rejects a tampered input", async () => {
  const vkeyPath = path.join(FIXTURE, "vote_smoke_verification_key.json");
  const proofPath = path.join(FIXTURE, "vote_smoke_proof.json");
  const pubPath = path.join(FIXTURE, "vote_smoke_public.json");
  for (const p of [vkeyPath, proofPath, pubPath]) {
    assert.ok(
      fs.existsSync(p),
      `GROTH16_KEYS_MISSING: ${p}. Run npm run circuits:smoke. Not accept-all.`,
    );
  }
  let snarkjs;
  try {
    snarkjs = require("snarkjs");
  } catch (err) {
    assert.fail(`snarkjs is not installed (${err.message}). Cannot verify the real Groth16 fixture.`);
  }
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  const pub = JSON.parse(fs.readFileSync(pubPath, "utf8"));
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(pub.length, 5);
  assert.equal(await snarkjs.groth16.verify(vkey, pub, proof), true);
  const tampered = pub.slice();
  tampered[0] = (BigInt(tampered[0]) + 1n).toString();
  assert.equal(await snarkjs.groth16.verify(vkey, tampered, proof), false);
  const curve = await snarkjs.curves.getCurveFromName(vkey.curve || "bn128");
  await curve.terminate();
});
