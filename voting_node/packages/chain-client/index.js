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

module.exports = {
  ROLLUP_ABI,
  GUARDIANS_ABI,
  ERRORS_ABI,
  ELECTION_STATUS,
  decodeElectionInfo,
};
