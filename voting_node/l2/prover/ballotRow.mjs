// Settlement row for RollupSettlement. The transaction object carries the new
// ciphertext and oldSubmissionId. Previous ciphertexts stay on the witness.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ballotDigest, encodeEgBallot } = require("../../packages/proof-helpers/index.js");

function coords(point) {
  if (Array.isArray(point)) return point.map((n) => BigInt(n));
  return [BigInt(point.c1X), BigInt(point.c1Y), BigInt(point.c2X), BigInt(point.c2Y)];
}

/**
 * ABI row. No previous ciphertext and no isFirst field.
 * oldSubmissionId 0 is a first ballot.
 */
export function settlementRow({ submissionId, primary, oneHot, options = [], sumProof, oldSubmissionId = 0n }) {
  const [c1X, c1Y, c2X, c2Y] = coords(primary);
  return {
    submissionId: BigInt(submissionId),
    c1X,
    c1Y,
    c2X,
    c2Y,
    oldSubmissionId: BigInt(oldSubmissionId),
    oneHot,
    options: options.map((option) => {
      const [x1, y1, x2, y2] = coords(option.point ?? option);
      return { c1X: x1, c1Y: y1, c2X: x2, c2Y: y2, oneHot: option.oneHot };
    }),
    sumProof,
  };
}

/** Private batch witness. The contract never sees these coordinates. */
export function replacementWitness({ oldPrimary, oldOptions = [], voterKey, oldSubmissionId }) {
  const [oldC1x, oldC1y, oldC2x, oldC2y] = oldPrimary ? coords(oldPrimary) : [0n, 0n, 0n, 0n];
  return {
    voterKey: BigInt(voterKey),
    oldSubmissionId: BigInt(oldSubmissionId),
    isFirst: BigInt(oldSubmissionId) === 0n ? 1n : 0n,
    oldC1x,
    oldC1y,
    oldC2x,
    oldC2y,
    oldOptionN: BigInt(oldOptions.length),
    oldOptions: oldOptions.map(coords),
  };
}

export function rowBallotHash(row) {
  return ballotDigest(
    row.c1X,
    row.c1Y,
    row.c2X,
    row.c2Y,
    row.options.map((option) => [option.c1X, option.c1Y, option.c2X, option.c2Y]),
  );
}

export function rowEnvelope(row) {
  return encodeEgBallot(
    row.c1X,
    row.c1Y,
    row.c2X,
    row.c2Y,
    row.options.map((option) => [option.c1X, option.c1Y, option.c2X, option.c2Y]),
  );
}
