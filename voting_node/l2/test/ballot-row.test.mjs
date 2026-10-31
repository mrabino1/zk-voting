import assert from "node:assert/strict";
import test from "node:test";

import { replacementWitness, rowBallotHash, settlementRow } from "../prover/ballotRow.mjs";

test("a settlement row keeps the previous ciphertext off the transaction", () => {
  const row = settlementRow({
    submissionId: 7n,
    primary: [1n, 2n, 3n, 4n],
    oneHot: new Array(12).fill(0n),
    options: [{ point: [5n, 6n, 7n, 8n], oneHot: new Array(12).fill(1n) }],
    sumProof: [1n, 2n, 3n, 4n, 5n],
    oldSubmissionId: 4n,
  });
  assert.equal(row.oldSubmissionId, 4n);
  assert.equal("isFirst" in row, false);
  assert.equal("oldC1X" in row, false);
  assert.equal("oldOptions" in row, false);
  assert.equal(row.options.length, 1);
  const witness = replacementWitness({
    oldPrimary: [9n, 8n, 7n, 6n],
    oldOptions: [[1n, 1n, 1n, 1n]],
    voterKey: 11n,
    oldSubmissionId: 4n,
  });
  assert.equal(witness.oldC1x, 9n);
  assert.equal(witness.isFirst, 0n);
  assert.equal(typeof rowBallotHash(row), "bigint");
});
