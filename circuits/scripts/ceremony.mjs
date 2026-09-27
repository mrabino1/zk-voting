#!/usr/bin/env node
/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Groth16 phase-2 (circuit-specific) multi-party setup tooling:
 *   init → contribute → verify → beacon → export
 *
 * Running these commands does not perform a public ceremony and does not
 * make keys trusted. Every transcript this file writes has
 * ceremony "not-done", trusted false, attestation "none".
 * Do not deploy the export for a binding election.
 *
 * The committed Vote(4) fixture under circuits/fixtures/untrusted is a
 * separate local setup. This script does not refresh it.
 *
 * See docs/CEREMONY.md.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(SCRIPT_DIR, "..");
const REPO = path.resolve(CIRCUITS, "..");
const BUILD = path.join(CIRCUITS, "build");
const TOY_CIRCOM = path.join(CIRCUITS, "ceremony", "toy.circom");

export const TRANSCRIPT_SCHEMA = "republic.groth16.phase2.transcript.v1";
export const EXPORT_SCHEMA = "republic.groth16.phase2.export.v1";
export const SIDECAR_SCHEMA = "republic.groth16.phase2.contribution.v1";

const CIRCOM_VERSION = "2.2.2";
const CIRCOM_SHA256 = "f3d8d1fdbc123779b80e210c909ee941d7a1e130c70365524646b48b8b0fe9d5";
const CIRCOM_URL = `https://github.com/iden3/circom/releases/download/v${CIRCOM_VERSION}/circom-linux-amd64`;

const TOY_PHASE1_ENTROPY = "republic-toy-phase1-published-entropy-not-a-ceremony";
const TOY_ENTROPIES = [
  "republic-toy-contributor-1-published-entropy-not-a-ceremony",
  "republic-toy-contributor-2-published-entropy-not-a-ceremony",
  "republic-toy-contributor-3-published-entropy-not-a-ceremony",
];
export const TOY_BEACON_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOY_BEACON_NAME = "republic-toy-beacon";

const UNTRUSTED_NOTE =
  "Produced by circuits/scripts/ceremony.mjs. A transcript of this shape is not evidence that a public ceremony took place. Keys stay untrusted until a real ceremony is attested in a reviewed commit. Do not deploy the exported verifier for a binding election.";

const BEACON_NOTE =
  "This script does not fetch public randomness. A hash supplied by the coordinator is not, by itself, a random beacon and does not complete a ceremony.";

function log(msg) {
  console.log(msg);
}

export function stripSnarkjsLog(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\[(DEBUG|INFO|WARN|ERROR)\]\s+snarkJS:\s*/g, "");
}

function wordsToHex(block) {
  const hex = String(block).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 128) {
    throw new Error(`expected a 64-byte snarkjs hash, got ${hex.length / 2} bytes`);
  }
  return hex;
}

const HASH_BLOCK = "((?:[ \\t]*[0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8} [0-9a-fA-F]{8}\\n){4})";

export function parseContributionHash(text) {
  const clean = stripSnarkjsLog(text);
  const re = new RegExp(`Contribution Hash:\\s*\\n${HASH_BLOCK}`, "gi");
  let match;
  let last = null;
  while ((match = re.exec(clean))) last = match[1];
  if (!last) throw new Error("snarkjs did not print a Contribution Hash");
  return wordsToHex(last);
}

export function parseCircuitHash(text) {
  const clean = stripSnarkjsLog(text);
  const re = new RegExp(`Circuit [Hh]ash:\\s*\\n${HASH_BLOCK}`, "g");
  let match;
  let last = null;
  while ((match = re.exec(clean))) last = match[1];
  return last ? wordsToHex(last) : null;
}

export function parseVerifiedContributions(text) {
  const clean = stripSnarkjsLog(text);
  if (!/ZKey Ok!/.test(clean)) {
    throw new Error("snarkjs verify did not report ZKey Ok!");
  }
  const found = [];
  for (const section of clean.split(/-{5,}/)) {
    const match = section.match(
      new RegExp(
        `contribution #(\\d+)(?: ([^\\n:]+))?:\\s*\\n${HASH_BLOCK}`,
        "i",
      ),
    );
    if (!match) continue;
    const beaconHash = section.match(/Beacon generator:\s*([0-9a-fA-F]+)/);
    const iterations = section.match(/Beacon iterations Exp:\s*(\d+)/);
    found.push({
      index: Number(match[1]),
      name: (match[2] || "").trim(),
      hash: wordsToHex(match[3]),
      beacon: beaconHash
        ? {
            hash: beaconHash[1].toLowerCase(),
            iterations: iterations ? Number(iterations[1]) : null,
          }
        : null,
    });
  }
  found.sort((a, b) => a.index - b.index);
  for (let i = 0; i < found.length; i++) {
    if (found[i].index !== i + 1) {
      throw new Error(`snarkjs contribution index gap at #${found[i].index}`);
    }
  }
  return found;
}

export function assertBeaconParams(hash, iterations) {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]+$/.test(hash) || hash.length % 2 !== 0) {
    throw new Error("beacon hash must be an even-length hexadecimal string");
  }
  const bytes = hash.length / 2;
  if (bytes < 1 || bytes >= 256) {
    throw new Error("beacon hash must be 1 to 255 bytes");
  }
  const n = Number(iterations);
  if (!Number.isInteger(n) || n < 10 || n > 63) {
    throw new Error("beacon iterations exponent must be an integer from 10 to 63");
  }
  return { hash: hash.toLowerCase(), iterations: n };
}

export function assertParticipantName(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9._-])?$/.test(name.replace(/ /g, "")) ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name) ||
    name.endsWith(" ") ||
    name.includes("  ")
  ) {
    throw new Error(
      "participant name must be 1-64 characters: letters, digits, space, dot, underscore, or hyphen",
    );
  }
  return name;
}

export function assertEntropy(entropy, { published }) {
  if (typeof entropy !== "string" || entropy.length < 32) {
    const how = published
      ? "Pass --published-entropy with at least 32 characters."
      : "Set REPUBLIC_CEREMONY_ENTROPY to at least 32 characters. It is not written to the transcript.";
    throw new Error(`entropy must be at least 32 characters. ${how}`);
  }
  if (entropy.includes("\n") || entropy.includes("\r") || entropy.includes("\0")) {
    throw new Error("entropy must be a single line");
  }
  return entropy;
}

export function assertExportDir(outDir) {
  const resolved = path.resolve(outDir);
  const banned = [
    path.join(REPO, "smart-contracts", "src"),
    path.join(REPO, "circuits", "fixtures"),
  ];
  for (const root of banned) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      throw new Error(`refusing to export into ${path.relative(REPO, root) || root}`);
    }
  }
  if (path.basename(resolved) === "VoteVerifier.sol") {
    throw new Error("refusing to overwrite VoteVerifier.sol");
  }
  return resolved;
}

function which(bin) {
  const found = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  const p = (found.stdout || "").trim();
  return found.status === 0 && p ? p : "";
}

function snarkjsBin() {
  const local = path.join(REPO, "node_modules", ".bin", "snarkjs");
  if (fs.existsSync(local)) return local;
  const onPath = which("snarkjs");
  if (onPath) return onPath;
  throw new Error("snarkjs is not installed. From the repo root: npm install");
}

function run(cmd, args, { redactEntropy = false } = {}) {
  const display = args.map((arg) =>
    redactEntropy && (String(arg).startsWith("--entropy=") || String(arg).startsWith("-e="))
      ? "--entropy=<redacted>"
      : arg,
  );
  log(`$ ${path.basename(cmd)} ${display.join(" ")}`);
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${path.basename(cmd)} exited ${result.status}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return combined;
}

function runSnarkjs(args) {
  return run(snarkjsBin(), args, { redactEntropy: true });
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function zkeyFileName(index) {
  return `zkey_${String(index).padStart(4, "0")}.zkey`;
}

function copyIntoDir(src, dest) {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  if (!fs.existsSync(from)) throw new Error(`missing file: ${from}`);
  if (from === to) return to;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return to;
}

function sealTranscript(transcript) {
  transcript.ceremony = "not-done";
  transcript.trusted = false;
  transcript.attestation = "none";
  transcript.publicCeremony = false;
  transcript.nfp = true;
  return transcript;
}

function writeTranscript(dir, transcript) {
  writeJson(path.join(dir, "transcript.json"), sealTranscript(transcript));
}

export function readTranscript(dir) {
  const file = path.join(dir, "transcript.json");
  if (!fs.existsSync(file)) throw new Error(`missing transcript: ${file}`);
  const transcript = JSON.parse(fs.readFileSync(file, "utf8"));
  if (transcript.schema !== TRANSCRIPT_SCHEMA) {
    throw new Error(`unknown transcript schema: ${transcript.schema}`);
  }
  if (transcript.ceremony !== "not-done") {
    throw new Error(
      `refusing transcript that claims ceremony=${JSON.stringify(transcript.ceremony)}. Ceremony is not done.`,
    );
  }
  if (transcript.trusted !== false) {
    throw new Error("refusing transcript that claims trusted keys. Keys stay untrusted.");
  }
  if (transcript.attestation !== "none") {
    throw new Error("refusing transcript with an attestation. This tooling does not record one.");
  }
  if (transcript.publicCeremony !== false) {
    throw new Error("refusing transcript that claims a public ceremony took place.");
  }
  if (transcript.protocol !== "groth16" || transcript.phase !== 2) {
    throw new Error("transcript is not a groth16 phase-2 record");
  }
  return transcript;
}

function r1csPath(dir) {
  return path.join(dir, "circuit.r1cs");
}

function ptauPath(dir) {
  return path.join(dir, "phase2.ptau");
}

function verifyZkeyAgainstCircuit(dir, zkeyPath) {
  const output = runSnarkjs(["zkey", "verify", r1csPath(dir), ptauPath(dir), zkeyPath]);
  return parseVerifiedContributions(output);
}

function assertPrivatePrefix(found, contributions) {
  if (found.length < contributions.length) {
    throw new Error(
      `zkey has ${found.length} contributions; transcript records ${contributions.length}`,
    );
  }
  for (let i = 0; i < contributions.length; i++) {
    const got = found[i];
    const expected = contributions[i];
    if (got.hash !== expected.contributionHash) {
      throw new Error(`contribution #${i + 1} hash does not match the transcript`);
    }
    if (got.name !== expected.name) {
      throw new Error(
        `contribution #${i + 1} name ${JSON.stringify(got.name)} does not match transcript ${JSON.stringify(expected.name)}`,
      );
    }
    if (got.beacon) {
      throw new Error(`contribution #${i + 1} is a beacon; private contributions must not be`);
    }
  }
}

async function expectFileHash(file, expected) {
  if (!fs.existsSync(file)) throw new Error(`missing file: ${file}`);
  const got = await sha256File(file);
  if (got !== expected) {
    throw new Error(`sha256 mismatch for ${path.basename(file)}`);
  }
  return got;
}

function assertHashEncoding(label, hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{128}$/.test(hex)) {
    throw new Error(`${label} is not a 64-byte hex hash`);
  }
}

export async function initCeremony({
  dir,
  r1cs,
  ptau,
  circuit,
  phase1 = "untrusted-local",
  phase1Note = "",
  publishedPhase1Entropy = null,
}) {
  const root = path.resolve(dir);
  if (root === REPO || root === CIRCUITS) {
    throw new Error("refusing to use the repository root as a ceremony directory");
  }
  if (!["untrusted-local", "external"].includes(phase1)) {
    throw new Error('phase1 must be "untrusted-local" or "external"');
  }
  const note = String(phase1Note || "").trim();
  if (phase1 === "external" && !note) {
    throw new Error("--phase1-note is required when --phase1 external (which public ptau file this is)");
  }
  if (publishedPhase1Entropy != null) {
    assertEntropy(publishedPhase1Entropy, { published: true });
  }
  const circuitName = assertParticipantName(circuit);
  if (fs.existsSync(path.join(root, "transcript.json"))) {
    throw new Error(`transcript already exists in ${root}`);
  }
  fs.mkdirSync(root, { recursive: true });
  copyIntoDir(r1cs, r1csPath(root));
  copyIntoDir(ptau, ptauPath(root));
  const setupZkey = path.join(root, zkeyFileName(0));
  const setupLog = runSnarkjs(["groth16", "setup", r1csPath(root), ptauPath(root), setupZkey]);
  const transcript = {
    schema: TRANSCRIPT_SCHEMA,
    nfp: true,
    license: "AGPL-3.0-or-later",
    protocol: "groth16",
    curve: "bn128",
    phase: 2,
    ceremony: "not-done",
    trusted: false,
    attestation: "none",
    publicCeremony: false,
    note: UNTRUSTED_NOTE,
    circuit: {
      name: circuitName,
      r1cs: "circuit.r1cs",
      r1csSha256: await sha256File(r1csPath(root)),
      circuitHash: parseCircuitHash(setupLog),
    },
    ptau: {
      file: "phase2.ptau",
      sha256: await sha256File(ptauPath(root)),
      phase1,
      phase1Note:
        note ||
        "Local or unattested powers-of-tau prepared for phase 2. Not a public phase-1 ceremony.",
      ...(publishedPhase1Entropy
        ? { publishedPhase1Entropy }
        : {}),
    },
    setup: {
      zkey: zkeyFileName(0),
      sha256: await sha256File(setupZkey),
    },
    contributions: [],
    beacon: null,
  };
  writeTranscript(root, transcript);
  log(`initialized ${root}`);
  log("Ceremony: not-done. This initial zkey still contains phase-2 toxic waste until contributions and a beacon.");
  return readTranscript(root);
}

function contributionRecord({ index, name, entropyPolicy, entropy, zkey, zkeySha256, contributionHash }) {
  const record = {
    index,
    name,
    kind: "contribute",
    entropyPolicy,
    zkey,
    zkeySha256,
    contributionHash,
  };
  if (entropyPolicy === "published") record.publishedEntropy = entropy;
  return record;
}

export async function contributeInDir({ dir, name, entropy, entropyPolicy }) {
  const participant = assertParticipantName(name);
  const policy = entropyPolicy === "published" ? "published" : "private";
  const secret = assertEntropy(entropy, { published: policy === "published" });
  const root = path.resolve(dir);
  const transcript = readTranscript(root);
  if (transcript.beacon) throw new Error("beacon already applied; refusing another contribution");
  const prevIndex = transcript.contributions.length;
  const nextIndex = prevIndex + 1;
  const prevName = prevIndex === 0 ? transcript.setup.zkey : transcript.contributions[prevIndex - 1].zkey;
  const nextName = zkeyFileName(nextIndex);
  const nextPath = path.join(root, nextName);
  if (fs.existsSync(nextPath)) throw new Error(`refusing to overwrite ${nextName}`);
  const output = runSnarkjs([
    "zkey",
    "contribute",
    path.join(root, prevName),
    nextPath,
    `--name=${participant}`,
    `--entropy=${secret}`,
  ]);
  const contributionHash = parseContributionHash(output);
  transcript.contributions.push(
    contributionRecord({
      index: nextIndex,
      name: participant,
      entropyPolicy: policy,
      entropy: secret,
      zkey: nextName,
      zkeySha256: await sha256File(nextPath),
      contributionHash,
    }),
  );
  writeTranscript(root, transcript);
  log(`contribution #${nextIndex} ${participant}`);
  log(`hash ${contributionHash}`);
  if (policy === "published") {
    log("Published drill entropy is recorded in the transcript. This is not a private contribution.");
  } else {
    log("Entropy was not written to the transcript.");
  }
  log("Ceremony: not-done. Keys remain untrusted.");
  return transcript.contributions[transcript.contributions.length - 1];
}

export async function contributeStandalone({ input, output, name, entropy, entropyPolicy }) {
  const participant = assertParticipantName(name);
  const policy = entropyPolicy === "published" ? "published" : "private";
  const secret = assertEntropy(entropy, { published: policy === "published" });
  const inPath = path.resolve(input);
  const outPath = path.resolve(output);
  if (!fs.existsSync(inPath)) throw new Error(`missing zkey: ${inPath}`);
  if (fs.existsSync(outPath)) throw new Error(`refusing to overwrite ${outPath}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const snarkLog = runSnarkjs([
    "zkey",
    "contribute",
    inPath,
    outPath,
    `--name=${participant}`,
    `--entropy=${secret}`,
  ]);
  const contributionHash = parseContributionHash(snarkLog);
  const sidecar = {
    schema: SIDECAR_SCHEMA,
    ceremony: "not-done",
    trusted: false,
    attestation: "none",
    publicCeremony: false,
    name: participant,
    kind: "contribute",
    entropyPolicy: policy,
    contributionHash,
    zkeySha256: await sha256File(outPath),
    inputSha256: await sha256File(inPath),
    note: "Not a ceremony attestation. The coordinator must accept this zkey, which re-verifies it against the transcript.",
  };
  if (policy === "published") sidecar.publishedEntropy = secret;
  const sidecarPath = `${outPath}.contribution.json`;
  writeJson(sidecarPath, sidecar);
  log(`wrote ${outPath}`);
  log(`hash ${contributionHash}`);
  log(`sidecar ${sidecarPath}`);
  log("Ceremony: not-done. Send the new zkey to the coordinator. Do not send entropy.");
  return sidecar;
}

export async function acceptContribution({ dir, zkey, entropyPolicy = "private", publishedEntropy = null }) {
  const policy = entropyPolicy === "published" ? "published" : "private";
  if (policy === "published") assertEntropy(publishedEntropy, { published: true });
  const root = path.resolve(dir);
  const transcript = readTranscript(root);
  if (transcript.beacon) throw new Error("beacon already applied; refusing to accept another contribution");
  const incoming = path.resolve(zkey);
  if (!fs.existsSync(incoming)) throw new Error(`missing zkey: ${incoming}`);
  const found = verifyZkeyAgainstCircuit(root, incoming);
  const expected = transcript.contributions.length + 1;
  if (found.length !== expected) {
    throw new Error(`incoming zkey has ${found.length} contributions; expected ${expected}`);
  }
  assertPrivatePrefix(found, transcript.contributions);
  const added = found[found.length - 1];
  if (added.beacon) throw new Error("refusing to accept a beacon as a private contribution");
  if (!added.name) throw new Error("incoming contribution has no participant name");
  const nextName = zkeyFileName(expected);
  const dest = path.join(root, nextName);
  if (fs.existsSync(dest)) throw new Error(`refusing to overwrite ${nextName}`);
  fs.copyFileSync(incoming, dest);
  transcript.contributions.push(
    contributionRecord({
      index: expected,
      name: added.name,
      entropyPolicy: policy,
      entropy: publishedEntropy,
      zkey: nextName,
      zkeySha256: await sha256File(dest),
      contributionHash: added.hash,
    }),
  );
  writeTranscript(root, transcript);
  log(`accepted contribution #${expected} ${added.name}`);
  log(`hash ${added.hash}`);
  log("Ceremony: not-done. Keys remain untrusted.");
  return transcript.contributions[transcript.contributions.length - 1];
}

export async function applyBeacon({ dir, hash, iterations = 10, name = "Final Beacon", coordinatorNote = "" }) {
  const params = assertBeaconParams(hash, iterations);
  const beaconName = assertParticipantName(name);
  const root = path.resolve(dir);
  const transcript = readTranscript(root);
  if (transcript.beacon) throw new Error("beacon already applied");
  if (transcript.contributions.length < 2) {
    throw new Error("need at least 2 phase-2 contributions before a beacon");
  }
  const prev = path.join(root, transcript.contributions[transcript.contributions.length - 1].zkey);
  const dest = path.join(root, "zkey_final.zkey");
  if (fs.existsSync(dest)) throw new Error("refusing to overwrite zkey_final.zkey");
  const output = runSnarkjs([
    "zkey",
    "beacon",
    prev,
    dest,
    params.hash,
    String(params.iterations),
    `--name=${beaconName}`,
  ]);
  if (!fs.existsSync(dest)) throw new Error("beacon did not write zkey_final.zkey");
  const note = String(coordinatorNote || "").trim();
  transcript.beacon = {
    name: beaconName,
    hash: params.hash,
    iterationsExp: params.iterations,
    contributionHash: parseContributionHash(output),
    zkey: "zkey_final.zkey",
    zkeySha256: await sha256File(dest),
    source: "coordinator-supplied",
    note: BEACON_NOTE,
    ...(note ? { coordinatorNote: note } : {}),
  };
  writeTranscript(root, transcript);
  log(`beacon hash ${transcript.beacon.contributionHash}`);
  log("Ceremony: not-done. A coordinator-supplied beacon hash is not a completed ceremony.");
  return transcript.beacon;
}

export async function verifyTranscript(dir) {
  const root = path.resolve(dir);
  const transcript = readTranscript(root);
  await expectFileHash(r1csPath(root), transcript.circuit.r1csSha256);
  await expectFileHash(ptauPath(root), transcript.ptau.sha256);
  await expectFileHash(path.join(root, transcript.setup.zkey), transcript.setup.sha256);

  const seen = new Set();
  for (const contribution of transcript.contributions) {
    assertHashEncoding(`contribution #${contribution.index}`, contribution.contributionHash);
    if (seen.has(contribution.contributionHash)) {
      throw new Error(`duplicate contribution hash at #${contribution.index}`);
    }
    seen.add(contribution.contributionHash);
    if (contribution.kind !== "contribute") {
      throw new Error(`contribution #${contribution.index} is not kind=contribute`);
    }
    if (contribution.entropyPolicy !== "private" && contribution.entropyPolicy !== "published") {
      throw new Error(`contribution #${contribution.index} has an unknown entropy policy`);
    }
  }

  const setupFound = verifyZkeyAgainstCircuit(root, path.join(root, transcript.setup.zkey));
  if (setupFound.length !== 0) {
    throw new Error("setup zkey contains contributions; expected the groth16 setup output");
  }

  for (let i = 0; i < transcript.contributions.length; i++) {
    const contribution = transcript.contributions[i];
    if (contribution.index !== i + 1) {
      throw new Error(`contribution index ${contribution.index} is out of order`);
    }
    const zkeyPath = path.join(root, contribution.zkey);
    await expectFileHash(zkeyPath, contribution.zkeySha256);
    const found = verifyZkeyAgainstCircuit(root, zkeyPath);
    if (found.length !== i + 1) {
      throw new Error(`${contribution.zkey} has ${found.length} contributions; expected ${i + 1}`);
    }
    assertPrivatePrefix(found, transcript.contributions.slice(0, i + 1));
  }

  if (transcript.beacon) {
    assertBeaconParams(transcript.beacon.hash, transcript.beacon.iterationsExp);
    assertHashEncoding("beacon", transcript.beacon.contributionHash);
    const finalPath = path.join(root, transcript.beacon.zkey);
    await expectFileHash(finalPath, transcript.beacon.zkeySha256);
    const found = verifyZkeyAgainstCircuit(root, finalPath);
    if (found.length !== transcript.contributions.length + 1) {
      throw new Error("final zkey contribution count does not match the transcript");
    }
    assertPrivatePrefix(found, transcript.contributions);
    const beacon = found[found.length - 1];
    if (!beacon.beacon) throw new Error("final zkey is missing a beacon contribution");
    if (beacon.hash !== transcript.beacon.contributionHash) {
      throw new Error("beacon contribution hash does not match the transcript");
    }
    if (beacon.name !== transcript.beacon.name) {
      throw new Error("beacon name does not match the transcript");
    }
    if (beacon.beacon.hash !== transcript.beacon.hash.toLowerCase()) {
      throw new Error("beacon generator hash does not match the transcript");
    }
    if (beacon.beacon.iterations !== transcript.beacon.iterationsExp) {
      throw new Error("beacon iteration exponent does not match the transcript");
    }
  }

  const summary = {
    ok: true,
    ceremony: "not-done",
    trusted: false,
    contributions: transcript.contributions.length,
    beacon: Boolean(transcript.beacon),
  };
  log("Transcript verification passed.");
  log(`contributions: ${summary.contributions}`);
  log(`beacon: ${summary.beacon ? "recorded (coordinator-supplied; not fetched here)" : "not applied"}`);
  log("ceremony: not-done");
  log("trusted: false");
  log("Do not deploy these keys for a binding election.");
  return summary;
}

function untrustedSolidityBanner(circuitName) {
  return [
    "// UNTRUSTED GROTH16 VERIFIER — ceremony not done.",
    "// Do not deploy this for a binding election.",
    "// Exported by circuits/scripts/ceremony.mjs from a phase-2 transcript.",
    "// A transcript, including the CI toy, is not a public ceremony.",
    `// circuit=${circuitName}`,
    "// NOT FOR PROFIT — civic public good, not a commercial product.",
    "",
  ].join("\n");
}

export async function exportArtifacts({ dir, out }) {
  const root = path.resolve(dir);
  const outDir = assertExportDir(out || path.join(root, "export"));
  const transcript = readTranscript(root);
  if (!transcript.beacon) {
    throw new Error("refusing to export before a beacon finalization");
  }
  await verifyTranscript(root);
  fs.mkdirSync(outDir, { recursive: true });
  const base = transcript.circuit.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const zkeyOut = path.join(outDir, `${base}_final.zkey`);
  const vkeyOut = path.join(outDir, `${base}_verification_key.json`);
  const solOut = path.join(outDir, `${base}_Groth16Verifier.sol`);
  const manifestOut = path.join(outDir, "EXPORT.json");
  fs.copyFileSync(path.join(root, transcript.beacon.zkey), zkeyOut);
  runSnarkjs(["zkey", "export", "verificationkey", zkeyOut, vkeyOut]);
  runSnarkjs(["zkey", "export", "solidityverifier", zkeyOut, solOut]);
  const solidity = fs.readFileSync(solOut, "utf8");
  if (!solidity.includes("UNTRUSTED GROTH16 VERIFIER")) {
    fs.writeFileSync(solOut, untrustedSolidityBanner(transcript.circuit.name) + solidity);
  }
  const manifest = {
    schema: EXPORT_SCHEMA,
    nfp: true,
    license: "AGPL-3.0-or-later",
    ceremony: "not-done",
    trusted: false,
    attestation: "none",
    publicCeremony: false,
    circuit: transcript.circuit.name,
    zkey: path.basename(zkeyOut),
    zkeySha256: await sha256File(zkeyOut),
    verificationKey: path.basename(vkeyOut),
    verificationKeySha256: await sha256File(vkeyOut),
    solidityVerifier: path.basename(solOut),
    soliditySha256: await sha256File(solOut),
    note: UNTRUSTED_NOTE,
  };
  writeJson(manifestOut, manifest);
  log(`exported ${outDir}`);
  log("Ceremony: not-done. The Solidity verifier is marked untrusted.");
  log("Do not copy it onto smart-contracts/src/zk/VoteVerifier.sol.");
  return {
    dir: outDir,
    zkey: zkeyOut,
    verificationKey: vkeyOut,
    solidity: solOut,
    manifest: manifestOut,
  };
}

async function ensureCircom() {
  const onPath = which("circom");
  if (onPath) return onPath;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "circom is not on PATH. Install Circom 2.2.x: https://docs.circom.io/getting-started/installation/",
    );
  }
  const dest = path.join(BUILD, "bin", "circom");
  if (fs.existsSync(dest)) {
    const got = await sha256File(dest);
    if (got === CIRCOM_SHA256) return dest;
    fs.rmSync(dest);
  }
  log(`downloading circom ${CIRCOM_VERSION} (linux-amd64)`);
  const response = await fetch(CIRCOM_URL);
  if (!response.ok) throw new Error(`circom download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== CIRCOM_SHA256) {
    throw new Error(`circom sha256 mismatch: ${got}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes, { mode: 0o755 });
  return dest;
}

export async function runToy({ dir, power = 4, allowOutsideBuild = false } = {}) {
  const root = path.resolve(dir || path.join(BUILD, "ceremony-toy"));
  const buildRoot = path.resolve(BUILD);
  if (!allowOutsideBuild && root !== buildRoot && !root.startsWith(buildRoot + path.sep)) {
    throw new Error(
      `toy wipes its output directory. Refusing ${root}. Use circuits/build/ceremony-toy or pass --allow-wipe.`,
    );
  }
  const ptauPower = Number(power);
  if (!Number.isInteger(ptauPower) || ptauPower < 2 || ptauPower > 8) {
    throw new Error("toy ptau power must be an integer from 2 to 8");
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  log("UNTRUSTED toy phase-2 transcript. Published entropy. Not a ceremony. Not the vote circuit.");
  const circom = await ensureCircom();
  run(circom, [TOY_CIRCOM, "--r1cs", "--wasm", "--sym", "-o", root]);
  const pot0 = path.join(root, "pot_0000.ptau");
  const pot1 = path.join(root, "pot_0001.ptau");
  const phase2 = ptauPath(root);
  runSnarkjs(["powersoftau", "new", "bn128", String(ptauPower), pot0]);
  runSnarkjs([
    "powersoftau",
    "contribute",
    pot0,
    pot1,
    "--name=republic-toy-phase1",
    `--entropy=${TOY_PHASE1_ENTROPY}`,
  ]);
  runSnarkjs(["powersoftau", "prepare", "phase2", pot1, phase2]);
  await initCeremony({
    dir: root,
    r1cs: path.join(root, "toy.r1cs"),
    ptau: phase2,
    circuit: "ceremony-toy",
    phase1: "untrusted-local",
    phase1Note:
      "Toy powers-of-tau created in this command with published entropy. Not a phase-1 ceremony.",
    publishedPhase1Entropy: TOY_PHASE1_ENTROPY,
  });
  await contributeInDir({
    dir: root,
    name: "republic-toy-1",
    entropy: TOY_ENTROPIES[0],
    entropyPolicy: "published",
  });
  await contributeInDir({
    dir: root,
    name: "republic-toy-2",
    entropy: TOY_ENTROPIES[1],
    entropyPolicy: "published",
  });
  const tip = path.join(root, zkeyFileName(2));
  const incoming = path.join(root, "incoming-toy-3.zkey");
  await contributeStandalone({
    input: tip,
    output: incoming,
    name: "republic-toy-3",
    entropy: TOY_ENTROPIES[2],
    entropyPolicy: "published",
  });
  await acceptContribution({
    dir: root,
    zkey: incoming,
    entropyPolicy: "published",
    publishedEntropy: TOY_ENTROPIES[2],
  });
  await applyBeacon({
    dir: root,
    hash: TOY_BEACON_HASH,
    iterations: 10,
    name: TOY_BEACON_NAME,
    coordinatorNote: "Published constant used by CI. Not a random beacon.",
  });
  const verification = await verifyTranscript(root);
  const exported = await exportArtifacts({ dir: root, out: path.join(root, "export") });
  return {
    dir: root,
    transcript: readTranscript(root),
    verification,
    exported,
  };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[body] = true;
    else {
      flags[body] = next;
      i++;
    }
  }
  return { positional, flags };
}

function refuseCeremonyClaims(flags) {
  for (const key of ["trusted", "ceremony-done", "claim-ceremony", "ceremony"]) {
    if (key in flags) {
      throw new Error(
        `refusing --${key}. This tooling cannot mark keys trusted or record that a ceremony took place.`,
      );
    }
  }
}

function requiredFlag(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`missing --${key}`);
  }
  return String(value);
}

function entropyFromFlags(flags) {
  if (flags["published-entropy"]) {
    return {
      entropy: String(flags["published-entropy"]),
      entropyPolicy: "published",
    };
  }
  if (flags.entropy) {
    throw new Error(
      "Refusing --entropy for a private contribution; it would sit in the shell history. Export REPUBLIC_CEREMONY_ENTROPY, or pass --published-entropy for a public drill.",
    );
  }
  const envName = flags["entropy-env"] ? String(flags["entropy-env"]) : "REPUBLIC_CEREMONY_ENTROPY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error("--entropy-env must be an environment variable name");
  }
  return { entropy: process.env[envName] || "", entropyPolicy: "private" };
}

function help() {
  log(`Usage: node circuits/scripts/ceremony.mjs <command> [flags]

Groth16 phase-2 tooling. Ceremony status stays not-done. Keys stay untrusted.
Runbook: docs/CEREMONY.md

Commands:
  init         groth16 setup from an r1cs and a phase-2 ptau
  contribute   add one phase-2 contribution (--dir, or --in and --out)
  accept       coordinator: verify a participant zkey and append it
  verify       check every zkey in the transcript against the r1cs and ptau
  beacon       apply a coordinator-supplied beacon hash (not fetched here)
  export       copy the final zkey and write the verification key and Solidity verifier
  toy          untrusted 3-contributor drill on circuits/ceremony/toy.circom
  help

There is no flag that marks a ceremony complete.

init:
  --dir --r1cs --ptau --circuit <name>
  --phase1 untrusted-local|external
  --phase1-note <text>          required for external
  --published-phase1-entropy <text>

contribute:
  --dir <ceremony> --name <participant>
  --in <prev.zkey> --out <next.zkey> --name <participant>
  Entropy: REPUBLIC_CEREMONY_ENTROPY, or --published-entropy for a drill.

accept:
  --dir <ceremony> --zkey <participant.zkey>
  --entropy-policy published --published-entropy <text>   (drill only)

beacon:
  --dir --hash <hex> [--iterations 10] [--name "Final Beacon"] [--note <text>]

export:
  --dir [--out <directory>]
  Refuses smart-contracts/src and circuits/fixtures.

toy:
  [--dir circuits/build/ceremony-toy] [--power 4] [--allow-wipe]
`);
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  refuseCeremonyClaims(flags);
  const command = positional[0] || "help";
  if (command === "help" || command === "-h") {
    help();
    return;
  }
  if (command === "init") {
    await initCeremony({
      dir: requiredFlag(flags, "dir"),
      r1cs: requiredFlag(flags, "r1cs"),
      ptau: requiredFlag(flags, "ptau"),
      circuit: requiredFlag(flags, "circuit"),
      phase1: flags.phase1 ? String(flags.phase1) : "untrusted-local",
      phase1Note: flags["phase1-note"] ? String(flags["phase1-note"]) : "",
      publishedPhase1Entropy: flags["published-phase1-entropy"]
        ? String(flags["published-phase1-entropy"])
        : null,
    });
    return;
  }
  if (command === "contribute") {
    const name = requiredFlag(flags, "name");
    const { entropy, entropyPolicy } = entropyFromFlags(flags);
    if (flags.dir && (flags.in || flags.out)) {
      throw new Error("use either --dir or --in/--out");
    }
    if (flags.dir) {
      await contributeInDir({
        dir: String(flags.dir),
        name,
        entropy,
        entropyPolicy,
      });
      return;
    }
    await contributeStandalone({
      input: requiredFlag(flags, "in"),
      output: requiredFlag(flags, "out"),
      name,
      entropy,
      entropyPolicy,
    });
    return;
  }
  if (command === "accept") {
    const policy = flags["entropy-policy"] ? String(flags["entropy-policy"]) : "private";
    await acceptContribution({
      dir: requiredFlag(flags, "dir"),
      zkey: requiredFlag(flags, "zkey"),
      entropyPolicy: policy,
      publishedEntropy: flags["published-entropy"] ? String(flags["published-entropy"]) : null,
    });
    return;
  }
  if (command === "verify") {
    await verifyTranscript(requiredFlag(flags, "dir"));
    return;
  }
  if (command === "beacon") {
    await applyBeacon({
      dir: requiredFlag(flags, "dir"),
      hash: requiredFlag(flags, "hash"),
      iterations: flags.iterations === undefined ? 10 : flags.iterations,
      name: flags.name ? String(flags.name) : "Final Beacon",
      coordinatorNote: flags.note ? String(flags.note) : "",
    });
    return;
  }
  if (command === "export") {
    await exportArtifacts({
      dir: requiredFlag(flags, "dir"),
      out: flags.out ? String(flags.out) : undefined,
    });
    return;
  }
  if (command === "toy") {
    await runToy({
      dir: flags.dir ? String(flags.dir) : undefined,
      power: flags.power === undefined ? 4 : flags.power,
      allowOutsideBuild: Boolean(flags["allow-wipe"]),
    });
    return;
  }
  throw new Error(`unknown command ${command} (try help)`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
