/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Phase-2 ceremony tooling. The toy transcript uses published entropy.
 * A passing run is not a ceremony, and it does not mark keys trusted.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  TOY_BEACON_HASH,
  assertBeaconParams,
  assertEntropy,
  assertExportDir,
  assertParticipantName,
  parseContributionHash,
  parseVerifiedContributions,
  readTranscript,
  runToy,
  stripSnarkjsLog,
  verifyTranscript,
} from "./ceremony.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "ceremony.mjs");
const REPO = path.resolve(path.dirname(SCRIPT), "../..");
const BUILD = path.join(REPO, "circuits", "build");

const CONTRIBUTE_LOG = `
[INFO]  snarkJS: Contribution Hash:
		dafdf484 ed1c37c1 93fd6efb 701dd657
		7118b581 86ac4062 9c143734 840f107f
		30fbd9aa 0372a1e8 a489e0c9 f850fe5e
		d12fa1ec 8e40850a 20d15e1a 7211da4d
`;

const VERIFY_LOG = `
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #2 bob:
		3a7fc491 6ac18e7c 3209e2b4 07dbfcad
		28804e5b ab605f04 1fbe4654 afe6178d
		e2969c88 4d03df2c 7a5e4d16 0a78eaa5
		3a1b2fa4 fb27f641 56b0c80c cbeaaec5
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #1 alice:
		dafdf484 ed1c37c1 93fd6efb 701dd657
		7118b581 86ac4062 9c143734 840f107f
		30fbd9aa 0372a1e8 a489e0c9 f850fe5e
		d12fa1ec 8e40850a 20d15e1a 7211da4d
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: ZKey Ok!
`;

const BEACON_LOG = `
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #3 toy-beacon:
		1bc508b1 21ba7c81 82b404ee bf9aa0d8
		73fa4138 ae4acbfb 027e422d 5d046b16
		e5d2275b 235a76d3 df9750eb d4e8bb59
		ea50a543 530f5260 7a7973ed 960a2ea8
[INFO]  snarkJS: Beacon generator: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
[INFO]  snarkJS: Beacon iterations Exp: 10
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #2 bob:
		3a7fc491 6ac18e7c 3209e2b4 07dbfcad
		28804e5b ab605f04 1fbe4654 afe6178d
		e2969c88 4d03df2c 7a5e4d16 0a78eaa5
		3a1b2fa4 fb27f641 56b0c80c cbeaaec5
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #1 alice:
		dafdf484 ed1c37c1 93fd6efb 701dd657
		7118b581 86ac4062 9c143734 840f107f
		30fbd9aa 0372a1e8 a489e0c9 f850fe5e
		d12fa1ec 8e40850a 20d15e1a 7211da4d
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: ZKey Ok!
`;

test("snarkjs contribution hashes parse with the log prefix stripped", () => {
  const hash = parseContributionHash(CONTRIBUTE_LOG);
  assert.equal(
    hash,
    "dafdf484ed1c37c193fd6efb701dd6577118b58186ac40629c143734840f107f30fbd9aa0372a1e8a489e0c9f850fe5ed12fa1ec8e40850a20d15e1a7211da4d",
  );
  const found = parseVerifiedContributions(VERIFY_LOG);
  assert.equal(found.length, 2);
  assert.equal(found[0].name, "alice");
  assert.equal(found[1].name, "bob");
  assert.equal(found[0].hash, hash);
  assert.equal(found[1].beacon, null);
  const beaconed = parseVerifiedContributions(BEACON_LOG);
  assert.equal(beaconed.length, 3);
  assert.equal(beaconed[2].name, "toy-beacon");
  assert.equal(beaconed[2].beacon.hash, TOY_BEACON_HASH);
  assert.equal(beaconed[2].beacon.iterations, 10);
  assert.equal(beaconed[0].beacon, null);
  assert.match(stripSnarkjsLog("[INFO]  snarkJS: ZKey Ok!\n"), /ZKey Ok!/);
});

test("beacon parameters and names stay inside the snarkjs rules", () => {
  assert.equal(assertBeaconParams(TOY_BEACON_HASH, 10).iterations, 10);
  assert.throws(() => assertBeaconParams("abc", 10), /hexadecimal/);
  assert.throws(() => assertBeaconParams(TOY_BEACON_HASH, 9), /10 to 63/);
  assert.throws(() => assertBeaconParams("zz", 10), /hexadecimal/);
  assert.equal(assertParticipantName("Final Beacon"), "Final Beacon");
  assert.throws(() => assertParticipantName("has:colon"), /name/);
  assert.throws(() => assertEntropy("short", { published: false }), /32/);
});

test("export cannot land on the production verifier or the committed fixture", () => {
  assert.throws(
    () => assertExportDir(path.join(REPO, "smart-contracts/src/zk")),
    /smart-contracts\/src/,
  );
  assert.throws(
    () => assertExportDir(path.join(REPO, "circuits/fixtures/untrusted")),
    /circuits\/fixtures/,
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "republic-ceremony-export-"));
  assert.equal(assertExportDir(tmp), path.resolve(tmp));
});

test("the cli refuses flags that would claim a ceremony", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "verify", "--dir", "unused", "--claim-ceremony"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /cannot mark keys trusted|ceremony/i);
});

test("toy multi-contributor transcript verifies and stays untrusted", { timeout: 120_000 }, async () => {
  const dir = path.join(BUILD, "ceremony-toy-test");
  const { transcript, verification, exported } = await runToy({ dir, power: 4 });
  assert.equal(verification.ok, true);
  assert.equal(verification.ceremony, "not-done");
  assert.equal(verification.trusted, false);
  assert.equal(verification.contributions, 3);
  assert.equal(verification.beacon, true);
  assert.equal(transcript.ceremony, "not-done");
  assert.equal(transcript.trusted, false);
  assert.equal(transcript.attestation, "none");
  assert.equal(transcript.publicCeremony, false);
  assert.equal(transcript.contributions.length, 3);
  assert.deepEqual(
    transcript.contributions.map((entry) => entry.name),
    ["republic-toy-1", "republic-toy-2", "republic-toy-3"],
  );
  for (const entry of transcript.contributions) {
    assert.equal(entry.entropyPolicy, "published");
    assert.match(entry.publishedEntropy, /not-a-ceremony/);
  }
  assert.equal(transcript.ptau.phase1, "untrusted-local");
  assert.match(transcript.ptau.publishedPhase1Entropy, /not-a-ceremony/);
  assert.equal(transcript.beacon.hash, TOY_BEACON_HASH);
  assert.equal(transcript.beacon.iterationsExp, 10);
  assert.match(transcript.beacon.coordinatorNote, /Not a random beacon/);
  assert.match(transcript.note, /not evidence that a public ceremony/);

  const solidity = fs.readFileSync(exported.solidity, "utf8");
  assert.match(solidity, /UNTRUSTED GROTH16 VERIFIER — ceremony not done/);
  assert.match(solidity, /contract Groth16Verifier/);
  const manifest = JSON.parse(fs.readFileSync(exported.manifest, "utf8"));
  assert.equal(manifest.ceremony, "not-done");
  assert.equal(manifest.trusted, false);
  assert.equal(manifest.publicCeremony, false);
  const vkey = JSON.parse(fs.readFileSync(exported.verificationKey, "utf8"));
  assert.equal(vkey.protocol, "groth16");
  assert.equal(fs.existsSync(exported.zkey), true);

  const claimed = path.join(BUILD, "ceremony-toy-claimed");
  fs.cpSync(dir, claimed, { recursive: true });
  const claimedTranscript = JSON.parse(fs.readFileSync(path.join(claimed, "transcript.json"), "utf8"));
  claimedTranscript.ceremony = "done";
  claimedTranscript.trusted = true;
  fs.writeFileSync(path.join(claimed, "transcript.json"), JSON.stringify(claimedTranscript));
  await assert.rejects(() => verifyTranscript(claimed), /Ceremony is not done|trusted keys/);

  const mismatched = path.join(BUILD, "ceremony-toy-mismatch");
  fs.cpSync(dir, mismatched, { recursive: true });
  const mismatchedTranscript = JSON.parse(fs.readFileSync(path.join(mismatched, "transcript.json"), "utf8"));
  mismatchedTranscript.contributions[0].contributionHash = "ab".repeat(64);
  fs.writeFileSync(path.join(mismatched, "transcript.json"), JSON.stringify(mismatchedTranscript));
  await assert.rejects(() => verifyTranscript(mismatched), /hash/);

  assert.equal(readTranscript(dir).ceremony, "not-done");
});
