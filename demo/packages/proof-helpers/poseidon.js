/**
 * @fileoverview circomlib-compatible Poseidon(2) over bn254.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * HASH_SCHEME: zk-voting.hash.poseidon-bn254-x5-t3-v1
 *
 * Same permutation as iden3 circomlib `Poseidon(2)`: state width t=3,
 * x^5 S-box, 8 full rounds, 57 partial rounds. Constants are the
 * circomlib bn254 parameters (see poseidon-constants.json). This is the
 * hash the vote circuit uses. It is not a Groth16 ceremony.
 */

"use strict";

const CONSTANTS = require("./poseidon-constants.json");

const F = BigInt(CONSTANTS.field);
const N_ROUNDS_F = CONSTANTS.nRoundsF;
const N_ROUNDS_P = CONSTANTS.nRoundsP;
const C = CONSTANTS.C.map((x) => BigInt(x));
const M = CONSTANTS.M.map((row) => row.map((x) => BigInt(x)));

function mod(n) {
  const x = typeof n === "bigint" ? n : BigInt(n);
  if (x < 0n) throw new Error("poseidon: negative field element");
  return x % F;
}

function pow5(a) {
  const x2 = (a * a) % F;
  const x4 = (x2 * x2) % F;
  return (x4 * a) % F;
}

/**
 * Poseidon hash of 1..16 field elements. ZK-Voting HashLeftRight uses 2.
 * @param {Array<string|number|bigint>} inputs
 * @returns {bigint}
 */
function poseidon(inputs) {
  if (!Array.isArray(inputs) || inputs.length !== 2) {
    throw new Error("poseidon: ZK-Voting Poseidon(2) expects exactly 2 inputs");
  }
  const state = [0n, mod(inputs[0]), mod(inputs[1])];
  const total = N_ROUNDS_F + N_ROUNDS_P;
  for (let r = 0; r < total; r += 1) {
    for (let i = 0; i < 3; i += 1) {
      state[i] = (state[i] + C[r * 3 + i]) % F;
    }
    if (r < N_ROUNDS_F / 2 || r >= N_ROUNDS_F / 2 + N_ROUNDS_P) {
      for (let i = 0; i < 3; i += 1) state[i] = pow5(state[i]);
    } else {
      state[0] = pow5(state[0]);
    }
    const next = [0n, 0n, 0n];
    for (let i = 0; i < 3; i += 1) {
      let acc = 0n;
      for (let j = 0; j < 3; j += 1) {
        acc = (acc + M[i][j] * state[j]) % F;
      }
      next[i] = acc;
    }
    state[0] = next[0];
    state[1] = next[1];
    state[2] = next[2];
  }
  return state[0];
}

/**
 * HashLeftRight for zk-voting.hash.poseidon-bn254-x5-t3-v1.
 * @param {string|number|bigint} left
 * @param {string|number|bigint} right
 * @returns {bigint}
 */
function poseidonHashLeftRight(left, right) {
  return poseidon([left, right]);
}

module.exports = {
  F,
  poseidon,
  poseidonHashLeftRight,
};
