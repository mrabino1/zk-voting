/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * Civic vote on the rollup (smart-contracts/docs/ROLLUP.md), the browser's part:
 *   1. GET /api/elections/:id/rollup/ballot-context: L1 election id, chain, rollup, joint key, options.
 *   2. The passkey wallet gives the nullifier Poseidon(nullifierSecret, l1ElectionId).
 *   3. encryptBallot: one exponential-ElGamal ciphertext per option under the guardians' joint key,
 *      with proofs that each is 0 or 1 and that they sum to 1. Only the final sum is ever decrypted.
 *   4. POST /vote with the vote pass and no cookies; the node relays to the L2 operator.
 *   5. GET /rollup/receipts/:nullifier: pending → committed (batch, L1 tx) → executed.
 * Nothing here returns or stores the choice.
 */

import * as bc from "./ballot-crypto.js";

/** True when this election's ballots go to the rollup instead of the node. */
export function isRollupVote(election) {
  return election?.chainMode === "rollup" && election?.rollupElectionId != null;
}

export async function loadBallotContext(api, electionId) {
  const ctx = await api(`/api/elections/${encodeURIComponent(electionId)}/rollup/ballot-context`);
  if (!ctx || ctx.electionId == null || !Array.isArray(ctx.options)) {
    throw new Error("The node did not return a ballot context for this vote.");
  }
  if (ctx.status !== "scheduled") {
    throw new Error(`This vote is ${ctx.status} on L1 and does not take ballots.`);
  }
  return ctx;
}

/**
 * The selected option's position in the L1 option list. A rollup vote has one question; a
 * ballot with no selection is refused rather than counted for the first option.
 */
export function rollupChoiceIndex(answers, context) {
  const list = Array.isArray(answers) ? answers : [];
  if (list.length !== 1) throw new Error("A civic vote on the rollup has exactly one question.");
  const a = list[0] || {};
  const selected = a.ranking?.[0] ?? a.optionIds?.[0] ?? a.optionId ?? a.choice;
  if (selected == null || selected === "") throw new Error("Choose an option before casting your ballot.");
  if (Array.isArray(a.optionIds) && a.optionIds.length > 1) throw new Error("Choose exactly one option.");
  const index = context.options.findIndex((o) => String(o.id) === String(selected));
  if (index < 0) throw new Error("That option is not on this ballot.");
  if (index >= Number(context.optionCount)) throw new Error("The ballot and the L1 election disagree on the options.");
  return index;
}

/** Encrypt and prove the ballot. Returns the JSON body fields for POST /vote (no vote pass). */
export function encryptRollupBallot({ context, choice, nullifier }) {
  const ctx = bc.contextOf({ chainId: BigInt(context.chainId), rollup: context.rollup });
  const ballot = bc.encryptBallot({
    ctx,
    electionId: BigInt(context.electionId),
    jointKey: bc.fromJSONSafe(context.jointKey),
    optionCount: Number(context.optionCount),
    choice,
  });
  return bc.toJSONSafe({ nullifier: BigInt(nullifier), ciphertexts: ballot.ciphertexts, proof: ballot.proof });
}

export async function fetchRollupReceipt(api, electionId, nullifier) {
  try {
    return await api(`/api/elections/${encodeURIComponent(electionId)}/rollup/receipts/${encodeURIComponent(nullifier)}`);
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

/** Plain-language status of a rollup receipt. Never mentions the choice. */
export function describeRollupReceipt(r) {
  if (!r) return "The operator has no record of this ballot yet.";
  switch (r.status) {
    case "pending":
      return "Received by the operator. It goes into the next batch on L1; batches are grouped to save gas, so this can take up to about ten minutes, and always happens before the vote closes.";
    case "committed":
      return `In batch ${r.batchNumber}, committed to L1${r.l1Tx ? ` (transaction ${short(r.l1Tx)})` : ""}. Awaiting execution.`;
    case "executed":
    case "settled":
      return `Settled on L1 in batch ${r.batchNumber}. It is in the encrypted sum.`;
    case "rejected":
      return `Rejected by the batch: ${r.reason || "no reason given"}. This ballot is not counted. Contact the election office with this receipt.`;
    default:
      return `Status: ${r.status}.`;
  }
}

function short(hex) {
  const s = String(hex);
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}
