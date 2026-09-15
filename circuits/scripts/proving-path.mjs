#!/usr/bin/env node
/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Local proving-path scaffolding: compile Circom, run an UNTRUSTED
 * powers-of-tau + Groth16 setup, export a verifier, optionally prove a demo
 * vote/tally witness.
 *
 * This is NOT a ceremony. Anyone who ran `setup` knows the toxic waste.
 * Do not use these keys for a binding election. HASH_SCHEME is
 * republic.hash.standin-v0 until Poseidon is vendored.
 *
 * Commands: status | compile | setup | export | prove | test | all | help
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const helpers = require("../../packages/proof-helpers/index.js");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS = path.resolve(SCRIPT_DIR, "..");
const REPO = path.resolve(CIRCUITS, "..");
const BUILD = path.join(CIRCUITS, "build");
const HASH_SCHEME = helpers.HASH_SCHEMES.STANDIN_V0;
const PTAU_POWER = Number(process.env.REPUBLIC_PTAU_POWER || 12);
const UNTRUSTED_ENTROPY = "republic-local-untrusted-dev-only-not-a-ceremony";

function log(msg) {
  console.log(msg);
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function which(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return r.status === 0 && p ? p : "";
}

function snarkjsBin() {
  const local = path.join(REPO, "node_modules", ".bin", "snarkjs");
  if (fs.existsSync(local)) return local;
  const w = which("snarkjs");
  if (w) return w;
  return "";
}

function run(cmd, args, opts = {}) {
  const cwd = opts.cwd || CIRCUITS;
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: opts.stdio || "inherit",
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed with status ${r.status}`);
  }
  return r;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toolStatus() {
  const circom = which("circom");
  const snarkjs = snarkjsBin();
  return {
    circom: circom || null,
    snarkjs: snarkjs || null,
    hashScheme: HASH_SCHEME,
    ceremony: "not-done",
    mockVerifierDefault: helpers.useMockVerifier(),
    provingPath: helpers.provingPathEnabled(),
    buildDir: BUILD,
    voteR1cs: fs.existsSync(path.join(BUILD, "vote.r1cs")),
    voteZkey: fs.existsSync(path.join(BUILD, "vote_final.zkey")),
    tallyZkey: fs.existsSync(path.join(BUILD, "tally_final.zkey")),
    voteVkey: fs.existsSync(path.join(BUILD, "vote_verification_key.json")),
  };
}

function printStatus() {
  const s = toolStatus();
  log("Republic proving path — IN PROGRESS (not a ceremony)");
  log(`HASH_SCHEME=${s.hashScheme}`);
  log(`CEREMONY=${s.ceremony}`);
  log(`REPUBLIC_PROVING_PATH=${s.provingPath ? "1" : "0"}`);
  log(`REPUBLIC_USE_MOCK_VERIFIER=${s.mockVerifierDefault ? "1" : "0"} (unit tests keep MockVerifier)`);
  log(`circom=${s.circom || "(not on PATH)"}`);
  log(`snarkjs=${s.snarkjs || "(not installed — npm install snarkjs)"}`);
  log(`vote.r1cs=${s.voteR1cs}`);
  log(`vote_final.zkey=${s.voteZkey}`);
  log("");
  log("Exact local commands (UNTRUSTED ptau; keys stay out of git):");
  log("  npm run circuits:status");
  log("  npm run circuits:compile");
  log("  npm run circuits:setup     # local powers-of-tau + groth16; NOT a ceremony");
  log("  npm run circuits:export    # writes circuits/build/*verifier*.sol, not VoteVerifier.sol");
  log("  npm run circuits:prove      # demo witness + groth16 verify");
  log("  REPUBLIC_PROVING_PATH=1 forge script script/DeployLocal.s.sol");
  log("");
  log("Install Circom 2 if compile is needed: https://docs.circom.io/getting-started/installation/");
  log("Do not copy zkeys into git. Do not overwrite smart-contracts/src/zk/VoteVerifier.sol.");
}

function requireCircom() {
  const c = which("circom");
  if (!c) {
    fail(
      "circom is not on PATH. Install Circom 2: https://docs.circom.io/getting-started/installation/\n" +
        "Then: npm run circuits:compile",
    );
  }
  return c;
}

function requireSnarkjs() {
  const s = snarkjsBin();
  if (!s) {
    fail("snarkjs is not installed. From the repo root: npm install snarkjs --save-dev");
  }
  return s;
}

function compile() {
  const circom = requireCircom();
  ensureDir(BUILD);
  run(circom, ["vote.circom", "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  run(circom, ["tally.circom", "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  log("compiled vote.circom and tally.circom → circuits/build/");
}

function setup() {
  const snarkjs = requireSnarkjs();
  if (!fs.existsSync(path.join(BUILD, "vote.r1cs"))) compile();
  ensureDir(BUILD);
  const ptau0 = path.join(BUILD, `pot${PTAU_POWER}_0000.ptau`);
  const ptau1 = path.join(BUILD, `pot${PTAU_POWER}_0001.ptau`);
  const ptauFinal = path.join(BUILD, `pot${PTAU_POWER}_final.ptau`);

  log(`UNTRUSTED local powers-of-tau (power=${PTAU_POWER}). Toxic waste is known. NOT a ceremony.`);
  run(snarkjs, ["powersoftau", "new", "bn128", String(PTAU_POWER), ptau0, "-v"]);
  run(snarkjs, [
    "powersoftau",
    "contribute",
    ptau0,
    ptau1,
    "--name=republic-local-untrusted",
    `-e=${UNTRUSTED_ENTROPY}`,
    "-v",
  ]);
  run(snarkjs, ["powersoftau", "prepare", "phase2", ptau1, ptauFinal, "-v"]);

  for (const name of ["vote", "tally"]) {
    const r1cs = path.join(BUILD, `${name}.r1cs`);
    const z0 = path.join(BUILD, `${name}_0000.zkey`);
    const zFinal = path.join(BUILD, `${name}_final.zkey`);
    run(snarkjs, ["groth16", "setup", r1cs, ptauFinal, z0]);
    run(snarkjs, [
      "zkey",
      "contribute",
      z0,
      zFinal,
      "--name=republic-local-untrusted",
      `-e=${UNTRUSTED_ENTROPY}`,
    ]);
  }
  log("groth16 setup complete (UNTRUSTED). zkeys are gitignored.");
}

function prependUntrustedHeader(file, circuitName) {
  const body = fs.readFileSync(file, "utf8");
  if (body.includes("LOCAL UNTRUSTED SETUP")) return;
  const header = [
    "// LOCAL UNTRUSTED SETUP — not a ceremony. Do not use for a binding election.",
    `// HASH_SCHEME=${HASH_SCHEME}`,
    `// circuit=${circuitName}`,
    "// Generated by circuits/scripts/proving-path.mjs export. Not committed.",
    "// NOT FOR PROFIT — civic public good, not a commercial product.",
    "",
  ].join("\n");
  fs.writeFileSync(file, header + body);
}

function exportVerifier() {
  const snarkjs = requireSnarkjs();
  for (const name of ["vote", "tally"]) {
    const zFinal = path.join(BUILD, `${name}_final.zkey`);
    if (!fs.existsSync(zFinal)) {
      fail(`missing ${zFinal} — run: npm run circuits:setup`);
    }
    const vkey = path.join(BUILD, `${name}_verification_key.json`);
    const sol = path.join(BUILD, `${name}_Groth16Verifier.sol`);
    run(snarkjs, ["zkey", "export", "verificationkey", zFinal, vkey]);
    run(snarkjs, ["zkey", "export", "solidityverifier", zFinal, sol]);
    prependUntrustedHeader(sol, name);
  }
  log("exported verification keys + Solidity verifiers under circuits/build/");
  log("Do NOT copy these over smart-contracts/src/zk/VoteVerifier.sol.");
  log("Deploy the generated contract, then Groth16VerifierAdapter(impl, 5).");
}

function writeDemoInputs() {
  ensureDir(BUILD);
  const witness = helpers.buildVoteWitness({ depth: 20 });
  const voteIn = helpers.voteWitnessToSnarkInput(witness);
  const votePath = path.join(BUILD, "vote_demo.input.json");
  const pubPath = path.join(BUILD, "vote_demo.public.json");
  fs.writeFileSync(votePath, JSON.stringify(voteIn, null, 2) + "\n");
  fs.writeFileSync(
    pubPath,
    JSON.stringify(
      {
        root: witness.root.toString(),
        disqRoot: witness.disqRoot.toString(),
        nullifier: witness.nullifier.toString(),
        ballotHash: witness.ballotHash.toString(),
        electionId: witness.electionId.toString(),
        hashScheme: HASH_SCHEME,
        untrusted: true,
      },
      null,
      2,
    ) + "\n",
  );
  const tallyPath = path.join(BUILD, "tally_demo.input.json");
  fs.writeFileSync(tallyPath, JSON.stringify(helpers.tallyDemoInput(), null, 2) + "\n");
  return { votePath, tallyPath, witness };
}

function prove() {
  const snarkjs = requireSnarkjs();
  if (!fs.existsSync(path.join(BUILD, "vote_final.zkey"))) {
    fail("missing zkeys — run: npm run circuits:setup");
  }
  const { votePath, tallyPath } = writeDemoInputs();
  const voteWasm = path.join(BUILD, "vote_js", "vote.wasm");
  const tallyWasm = path.join(BUILD, "tally_js", "tally.wasm");
  if (!fs.existsSync(voteWasm) || !fs.existsSync(tallyWasm)) compile();

  const voteProof = path.join(BUILD, "vote_demo.proof.json");
  const votePub = path.join(BUILD, "vote_demo.publicsignals.json");
  run(snarkjs, [
    "groth16",
    "fullprove",
    votePath,
    voteWasm,
    path.join(BUILD, "vote_final.zkey"),
    voteProof,
    votePub,
  ]);
  run(snarkjs, [
    "groth16",
    "verify",
    path.join(BUILD, "vote_verification_key.json"),
    votePub,
    voteProof,
  ]);

  const tallyProof = path.join(BUILD, "tally_demo.proof.json");
  const tallyPub = path.join(BUILD, "tally_demo.publicsignals.json");
  run(snarkjs, [
    "groth16",
    "fullprove",
    tallyPath,
    tallyWasm,
    path.join(BUILD, "tally_final.zkey"),
    tallyProof,
    tallyPub,
  ]);
  const tallyVkey = path.join(BUILD, "tally_verification_key.json");
  if (!fs.existsSync(tallyVkey)) exportVerifier();
  run(snarkjs, ["groth16", "verify", tallyVkey, tallyPub, tallyProof]);
  log("demo vote + tally Groth16 proofs verified (standin-v0, UNTRUSTED keys).");
}

function selfCheck() {
  const a = helpers.standInHashLeftRight(1n, 2n);
  if (a !== 5n) fail("stand-in vector 1,2 != 5");
  const w = helpers.buildVoteWitness({ depth: 20 });
  if (w.pathElements.length !== 20) fail("vote witness depth");
  if (
    !helpers.verifyInclusion(
      w.leaf,
      w.pathElements,
      w.pathIndices,
      w.root,
      helpers.HASH_SCHEMES.STANDIN_V0,
    )
  ) {
    fail("vote witness inclusion");
  }
  log("hash-scheme + vote-witness self-check ok (no ceremony required).");
}

function testCmd() {
  selfCheck();
  const required = helpers.provingPathEnabled();
  const s = toolStatus();
  if (!s.circom || !s.snarkjs) {
    if (required) {
      fail("REPUBLIC_PROVING_PATH=1 but circom/snarkjs are missing.");
    }
    log("circom/snarkjs not present — skipping compile/setup/prove (hash checks still ran).");
    log("Install tools, then: npm run circuits:all");
    return;
  }
  compile();
  setup();
  exportVerifier();
  prove();
}

function help() {
  log(`Usage: node circuits/scripts/proving-path.mjs <command>

Commands:
  status    Print proving-path status and exact commands
  compile   circom vote.circom + tally.circom
  setup     UNTRUSTED local powers-of-tau + groth16 setup (not a ceremony)
  export    Export verification keys + Solidity verifiers into circuits/build/
  prove     Demo witness, groth16 prove, verify
  test      Hash self-check; full groth16 if tools exist (required if REPUBLIC_PROVING_PATH=1)
  all       compile + setup + export + prove
  help      This text

HASH_SCHEME=${HASH_SCHEME}
Env: REPUBLIC_PROVING_PATH=1  REPUBLIC_USE_MOCK_VERIFIER=0  REPUBLIC_PTAU_POWER=12
`);
}

const cmd = process.argv[2] || "status";
try {
  if (cmd === "status") printStatus();
  else if (cmd === "compile") compile();
  else if (cmd === "setup") setup();
  else if (cmd === "export") exportVerifier();
  else if (cmd === "prove") {
    if (!fs.existsSync(path.join(BUILD, "vote_verification_key.json"))) exportVerifier();
    prove();
  } else if (cmd === "test") testCmd();
  else if (cmd === "all") {
    compile();
    setup();
    exportVerifier();
    prove();
  } else if (cmd === "help" || cmd === "-h" || cmd === "--help") help();
  else fail(`unknown command ${cmd} (try help)`);
} catch (err) {
  fail(err.message || String(err));
}
