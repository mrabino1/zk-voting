/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * The ballot page's flow, as plain data so it can be tested without a browser:
 * which path a ballot takes (civic vote on L1, poll on this node, or a sample),
 * the steps a voter walks through, and what still blocks a live ballot.
 */

import { isRollupVote } from "./rollup-vote.js";

/**
 * How this ballot is counted. A civic vote is encrypted to the guardians and only the final
 * sum is decrypted on L1; a poll is counted by this node and may show interim results.
 */
export function ballotPath(election, source) {
  if (source === "sample") {
    return {
      kind: "sample",
      title: "Sample ballot",
      body: "Practice only. Nothing you mark here is counted.",
    };
  }
  if (isRollupVote(election)) {
    return {
      kind: "civic",
      title: "Civic vote, settled on Ethereum",
      body:
        "Your choice is encrypted in this browser. Nobody decrypts a single ballot: after the cutoff the guardians decrypt only the final sum, and the L1 contract checks it.",
    };
  }
  return {
    kind: "poll",
    title: "Poll, counted by this node",
    body:
      "Your choice is encrypted in this browser and counted by this node. Polls can show interim results, so their privacy is weaker than a civic vote's.",
  };
}

const STEP_ORDER = ["ballot", "pin", "passkey", "receipt"];

/**
 * The voter's steps. `step` is the page step ("ballot", "pin" or "receipt"); `busy` on the
 * PIN step means the passkey and relay are running. Without a PIN (a signed-out sample) the
 * PIN step is left out.
 */
export function voteSteps(step, { busy = false, withPin = true } = {}) {
  const labels = {
    ballot: "Mark your ballot",
    pin: "Tap your vote PIN",
    passkey: "Confirm with your passkey",
    receipt: "Keep your receipt",
  };
  let current = step === "receipt" ? "receipt" : step === "pin" ? (busy ? "passkey" : "pin") : busy ? "passkey" : "ballot";
  const order = STEP_ORDER.filter((s) => withPin || s !== "pin");
  if (!order.includes(current)) current = "ballot";
  const at = order.indexOf(current);
  return order.map((id, i) => ({ id, label: labels[id], state: i < at ? "done" : i === at ? "current" : "todo" }));
}

/**
 * What still has to happen before a live ballot can be cast, in the order a voter does it.
 * An empty list means the ballot can go. A sample ballot is never blocked.
 */
export function voteBlockers({ source, signedIn, pinBound, publicRecord, electionId }) {
  if (source === "sample") return [];
  const out = [];
  const register = `/register${electionId != null ? `?election=${encodeURIComponent(electionId)}` : ""}`;
  if (!signedIn) {
    out.push({ id: "signin", text: "Sign in.", href: "/signin", cta: "Sign in" });
  }
  if (!publicRecord) {
    out.push({ id: "passkey", text: "Create a passkey on this device.", href: register, cta: "Register" });
  } else if (publicRecord.staleWrap) {
    out.push({
      id: "passkey",
      text: "This device has an old (v1) passkey wrap. Reset it on the register page and create a new passkey.",
      href: register,
      cta: "Reset passkey",
    });
  }
  if (signedIn && !pinBound) {
    out.push({ id: "pin", text: "Set a vote PIN. You tap it on a shuffled keypad when you cast.", href: "/register", cta: "Set vote PIN" });
  }
  return out;
}
