/**
 * @fileoverview Versioned HashLeftRight schemes for Republic proving path.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Single strategy toward Poseidon:
 *   1. keccak-dev-v1     — Foundry / Node unit tests (default, no ceremony)
 *   2. standin-v0        — Circom + local Groth16 until Poseidon is vendored
 *   3. poseidon-bn254-x5-t3-v1 — production target (throws until wired)
 *
 * Do not mix schemes in one Merkle tree or one proof.
 */

"use strict";

const HASH_SCHEMES = Object.freeze({
  STANDIN_V0: "republic.hash.standin-v0",
  KECCAK_DEV_V1: "republic.hash.keccak-dev-v1",
  POSEIDON_BN254_X5_T3_V1: "republic.hash.poseidon-bn254-x5-t3-v1",
});

const HASH_SCHEME_STATUS = Object.freeze({
  [HASH_SCHEMES.STANDIN_V0]: "circom-proving-path",
  [HASH_SCHEMES.KECCAK_DEV_V1]: "evm-unit-tests",
  [HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1]: "not-wired",
});

const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ALIASES = Object.freeze({
  "standin-v0": HASH_SCHEMES.STANDIN_V0,
  standin: HASH_SCHEMES.STANDIN_V0,
  "keccak-dev-v1": HASH_SCHEMES.KECCAK_DEV_V1,
  keccak: HASH_SCHEMES.KECCAK_DEV_V1,
  keccak256: HASH_SCHEMES.KECCAK_DEV_V1,
  poseidon: HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1,
  "poseidon-bn254-x5-t3-v1": HASH_SCHEMES.POSEIDON_BN254_X5_T3_V1,
});

function parseEnvFlag(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

function provingPathEnabled(env = process.env) {
  return parseEnvFlag(env.REPUBLIC_PROVING_PATH, false);
}

function useMockVerifier(env = process.env) {
  if (provingPathEnabled(env)) return false;
  return parseEnvFlag(env.REPUBLIC_USE_MOCK_VERIFIER, true);
}

function normalizeHashScheme(name) {
  if (name == null || name === "") return HASH_SCHEMES.KECCAK_DEV_V1;
  const s = String(name).trim();
  if (Object.values(HASH_SCHEMES).includes(s)) return s;
  const aliased = ALIASES[s.toLowerCase()];
  if (aliased) return aliased;
  throw new Error(`unknown hash scheme: ${name}`);
}

function resolveHashScheme(env = process.env) {
  if (env.REPUBLIC_HASH_SCHEME) return normalizeHashScheme(env.REPUBLIC_HASH_SCHEME);
  if (provingPathEnabled(env)) return HASH_SCHEMES.STANDIN_V0;
  return HASH_SCHEMES.KECCAK_DEV_V1;
}

function toField(value) {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n) throw new Error("toField: negative");
  return n % SNARK_SCALAR_FIELD;
}

/**
 * Circom Hasher(): (a + b + a*b) mod Fr.
 * hash(x, 0) === x, so all-zero Merkle siblings are degenerate.
 * @param {string|number|bigint} left
 * @param {string|number|bigint} right
 * @returns {bigint}
 */
function standInHashLeftRight(left, right) {
  const a = toField(left);
  const b = toField(right);
  return (a + b + a * b) % SNARK_SCALAR_FIELD;
}

module.exports = {
  HASH_SCHEMES,
  HASH_SCHEME_STATUS,
  SNARK_SCALAR_FIELD,
  parseEnvFlag,
  provingPathEnabled,
  useMockVerifier,
  normalizeHashScheme,
  resolveHashScheme,
  toField,
  standInHashLeftRight,
};
