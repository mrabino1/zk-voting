/**
 * @fileoverview Client constants for the one ZK-Voting L1 contract, ZkVotingRollup.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * The ABIs in ./abi are copied from the Foundry build by scripts/export-rollup-abi.mjs and
 * checked against it by test/abi.test.js. See smart-contracts/docs/ROLLUP.md.
 */

"use strict";

const ROLLUP_ABI = require("./abi/ZkVotingRollup.json");
const GUARDIANS_ABI = require("./abi/Guardians.json");

/** IZkVotingRollup.Status, in enum order. */
const ELECTION_STATUS = Object.freeze([
  "none",
  "keygen",
  "scheduled",
  "closing",
  "closed",
  "finalized",
  "withheld",
  "halted",
]);

/** Errors the rollup can raise, including those bubbled up from the Guardians library. */
const ERRORS_ABI = [...ROLLUP_ABI, ...GUARDIANS_ABI].filter((item) => item.type === "error");

const ELECTION_INFO_FIELDS = [
  "jurisdictionId",
  "configHash",
  "ballotSpecHash",
  "startTime",
  "cutoffTime",
  "createdAt",
  "optionCount",
  "threshold",
  "guardianCount",
  "minBallots",
  "ballotCount",
  "status",
  "viaDesert",
  "clerk",
  "registrar",
  "officer",
  "jointKeyX",
  "jointKeyY",
];

/**
 * Normalize `election(id)` (a viem tuple object or array) into plain JSON-safe fields,
 * with `status` as a name from ELECTION_STATUS.
 */
function decodeElectionInfo(info) {
  const get = (name, i) => (Array.isArray(info) ? info[i] : info[name]);
  const out = {};
  ELECTION_INFO_FIELDS.forEach((name, i) => {
    const v = get(name, i);
    out[name] = typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;
  });
  out.status = ELECTION_STATUS[Number(get("status", 11))] || "none";
  out.jointKey = [String(get("jointKeyX", 16)), String(get("jointKeyY", 17))];
  delete out.jointKeyX;
  delete out.jointKeyY;
  return out;
}

/**
 * Anvil's dev keys (the public "test … junk" mnemonic, accounts 0–9). Anyone can sign with
 * them, so a key on this list is refused on any chain other than 31337.
 */
const ANVIL_DEV_KEYS = Object.freeze([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
]);

const LOCAL_CHAIN_ID = 31337;

function isAnvilDevKey(key) {
  const k = String(key || "").trim().toLowerCase();
  return ANVIL_DEV_KEYS.includes(k.startsWith("0x") ? k : `0x${k}`);
}

/** Throw when a public dev key would sign on a chain other than the local one. */
function assertKeyAllowedOnChain(key, chainId, name = "key") {
  if (key && isAnvilDevKey(key) && Number(chainId) !== LOCAL_CHAIN_ID) {
    throw new Error(`${name} is a public Anvil dev key; it is allowed only on chain ${LOCAL_CHAIN_ID} (got ${chainId})`);
  }
}

/**
 * Read a deployment record written by DeployLocal.s.sol or Deploy.s.sol
 * (`deployments/local.json`, `deployments/<chainId>.json`).
 * @returns {null | { rollup: string, chainId: number, jurisdictionId: string|null, operator: string|null, clerk: string|null }}
 */
function readDeployment(file) {
  if (!file) return null;
  const fs = require("node:fs");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot read deployment record ${file}: ${err.message}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(raw.rollup || ""))) {
    throw new Error(`deployment record ${file} has no rollup address`);
  }
  return {
    rollup: raw.rollup,
    chainId: Number(raw.chainId),
    jurisdictionId: raw.jurisdictionId || null,
    operator: raw.operator || null,
    clerk: raw.clerk || null,
  };
}

module.exports = {
  ROLLUP_ABI,
  GUARDIANS_ABI,
  ERRORS_ABI,
  ELECTION_STATUS,
  decodeElectionInfo,
  ANVIL_DEV_KEYS,
  LOCAL_CHAIN_ID,
  isAnvilDevKey,
  assertKeyAllowedOnChain,
  readDeployment,
};
