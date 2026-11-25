/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 *
 * Back-office guidance: where each election stands and the one thing an official
 * should do next. Pure functions, no DOM. Loaded as a classic script; exposes
 * globalThis.ZkVotingNextStep.
 *
 * The civic-vote rules follow ZkVotingRollup (smart-contracts/src/ZkVotingRollup.sol):
 *   - createElection needs now < startTime < cutoffTime, one question, 2–8 options.
 *   - The guardian key must be finalized before startTime; after that the only
 *     transition left from KeyGen is haltElection.
 *   - finalizeKey needs every live guardian committed + 1 h complaint window,
 *     or 1 day since creation, and no open share dispute.
 *   - registerVoters / disqualify only while Scheduled and before startTime.
 *   - closeElection only after cutoffTime; fewer than minBallots ballots → Withheld.
 *   - finalizeResult needs decryption shares from k guardians.
 * Polls follow the Node's own states: 0 Created, 1 RollFrozen, 2 Open, 3 Closed, 4 Tallied.
 */
(function (root) {
  "use strict";

  const HOUR = 3600;
  const DAY = 86400;
  /** Guardians.sol COMPLAINT_WINDOW + a margin for guardians to run their CLI. */
  const KEYGEN_LEAD_SECONDS = 2 * HOUR;

  function relative(seconds) {
    const s = Math.abs(Math.round(seconds));
    if (s < 90) return "under 2 minutes";
    if (s < 90 * 60) return Math.round(s / 60) + " minutes";
    if (s < 36 * HOUR) return Math.round(s / HOUR) + " hours";
    return Math.round(s / DAY) + " days";
  }

  function until(ts, now) {
    const d = Number(ts) - now;
    return d >= 0 ? "in " + relative(d) : relative(d) + " ago";
  }

  function isCivicVote(election) {
    return election?.electionTypeName === "vote" || Number(election?.electionType) === 1;
  }

  /**
   * One step. `tone`: "urgent" (voters are blocked or a deadline will be missed),
   * "action" (an official must act), "wait" (automatic or waiting on others), "done".
   * `section` is the back-office panel that holds the tool; `action` an optional
   * rollup button (data-ru-action) to highlight.
   */
  function step(tone, stage, text, section, cta, action) {
    return { tone, stage, text, section: section || null, cta: cta || null, action: action || null };
  }

  function pollStep(e, now) {
    const start = Number(e.startTime);
    const cutoff = Number(e.cutoffTime);
    const state = Number(e.state);
    const roll = Number(e.eligibleCount ?? e.participantCount ?? 0);
    if (state >= 4 || e.tally) return step("done", "Results published", "Final tally posted. Results are public.", null, null);
    if (now >= cutoff) {
      if (!e.rollFrozen) {
        return step(
          "urgent",
          "Ended without voting",
          "The voting window passed while the roll was never frozen, so no ballots could be cast. Create a new election with new dates.",
          "clerk",
          "Open clerk tools"
        );
      }
      return step("action", "Voting ended", "Voting has ended. Post the tally so results can publish.", "tally", "Post the tally");
    }
    if (!e.rollFrozen) {
      if (now >= start) {
        return step(
          "urgent",
          "Blocked: roll not frozen",
          "Voting was due to open " + until(start, now) + ", but the roll is not frozen. Voters cannot cast ballots until you freeze it.",
          "clerk",
          "Freeze the roll now"
        );
      }
      if (roll === 0) {
        return step(
          "action",
          "Building the roll",
          "No voters on the roll yet. Approve registration requests or add identity commitments, then freeze the roll before voting opens " + until(start, now) + ".",
          "registrar",
          "Add voters"
        );
      }
      return step(
        "action",
        "Building the roll",
        roll + " on the roll. Freeze the roll before voting opens " + until(start, now) + "; after that the roll cannot change.",
        "clerk",
        "Freeze the roll"
      );
    }
    if (now < start) return step("wait", "Ready", "Roll frozen. Voting opens automatically " + until(start, now) + ".", null, null);
    return step("wait", "Voting open", "Voting is open. It closes automatically " + until(cutoff, now) + ".", null, null);
  }

  function civicStep(e, view, now) {
    const start = Number(view?.l1?.startTime ?? e.startTime);
    const cutoff = Number(view?.l1?.cutoffTime ?? e.cutoffTime);
    const guardians = Array.isArray(view?.guardians) ? view.guardians : [];
    if (view && view.error) {
      return step("action", "Status unknown", "Could not read this vote's rollup status: " + view.error, "tally", "Open civic vote tools");
    }
    if (!view?.l1) {
      if (view && view.enabled === false && !view.published) {
        return step(
          "urgent",
          "Rollup not connected",
          "This node is not connected to the rollup (ROLLUP_ADDRESS, L1_RPC), so this civic vote cannot be published to L1. Voting is due to start " + until(start, now) + ".",
          "tally",
          "Open civic vote tools"
        );
      }
      if (now >= start) {
        return step(
          "urgent",
          "Missed start",
          "This vote was never published to L1 and its start time has passed. The contract only accepts a start time in the future: delete it and create it again with new dates.",
          "clerk",
          "Open clerk tools"
        );
      }
      const k = view?.threshold || (guardians.length ? Math.floor(guardians.length / 2) + 1 : 0);
      const lead = start - now < KEYGEN_LEAD_SECONDS ? " Leave the guardians at least 2 hours before the start to finish the key ceremony." : "";
      if (!guardians.length) {
        return step(
          start - now < KEYGEN_LEAD_SECONDS ? "urgent" : "action",
          "Not on L1 yet",
          "Enroll the guardians, set how many are needed to decrypt, then publish to L1. Voting starts " + until(start, now) + "." + lead,
          "tally",
          "Enroll guardians",
          null
        );
      }
      return step(
        start - now < KEYGEN_LEAD_SECONDS ? "urgent" : "action",
        "Not on L1 yet",
        guardians.length + " guardian" + (guardians.length === 1 ? "" : "s") + " enrolled (" + k + " needed to decrypt). Publish to L1 so the key ceremony can start; voting starts " + until(start, now) + "." + lead,
        "tally",
        "Publish to L1",
        "publish"
      );
    }
    const status = String(view.l1.status || "");
    const committed = guardians.filter((g) => g.committed && !g.excluded).length;
    const k = Number(view.l1.threshold || view.threshold || 0);
    const posted = guardians.filter((g) => g.sharesPosted).length;
    switch (status) {
      case "keygen":
        if (now >= start) {
          return step(
            "urgent",
            "Key not ready",
            "Voting was due to start " + until(start, now) + " but the guardian key was never finalized. The contract now only allows this vote to be halted.",
            "tally",
            "Open civic vote tools"
          );
        }
        if (committed >= k && k > 0) {
          return step(
            "action",
            "Key ceremony",
            committed + " of " + guardians.length + " guardians committed (" + k + " needed). Finalize the key before voting starts " + until(start, now) + ". The contract accepts it once every guardian has committed and an hour has passed, or a day after publishing.",
            "tally",
            "Finalize the key",
            "finalize-key"
          );
        }
        return step(
          start - now < KEYGEN_LEAD_SECONDS ? "urgent" : "wait",
          "Key ceremony",
          "Waiting on guardians: " + committed + " of " + guardians.length + " committed, " + k + " needed. Each guardian runs guardian:rollup commit. The key must be finalized before voting starts " + until(start, now) + ".",
          "tally",
          "See guardians"
        );
      case "scheduled":
        if (now < start) {
          return step(
            "wait",
            "Registration",
            "Key ready. The node copies the roll to L1 automatically (" + Number(view.rollSynced || 0) + " so far). New voters and disqualifications are accepted only until voting starts " + until(start, now) + ".",
            "registrar",
            "Add voters",
            "roll/sync"
          );
        }
        if (now < cutoff) {
          return step("wait", "Voting open", "Voting is open. It closes " + until(cutoff, now) + "; the roll is now fixed.", null, null);
        }
        return step("action", "Voting ended", "The cutoff has passed. The node closes the vote automatically; you can also close it now.", "tally", "Close the vote", "close");
      case "closing":
        return step("wait", "Counting", "Closing: waiting for the operator to process the last ballots on L1.", null, null);
      case "closed":
        return step(
          posted >= k && k > 0 ? "action" : "wait",
          "Decrypting",
          posted + " of " + k + " guardians needed have posted decryption shares (guardian:rollup decrypt)." + (posted >= k && k > 0 ? " Finalize the result now, or let the node do it." : ""),
          "tally",
          posted >= k && k > 0 ? "Finalize the result" : "See guardians",
          posted >= k && k > 0 ? "finalize" : null
        );
      case "finalized":
        return step("done", "Certified", "Result finalized and checked on L1.", null, null);
      case "withheld":
        return step(
          "done",
          "Withheld",
          "Fewer than " + Number(view.l1.minBallots || view.minBallots || 0) + " ballots were cast (the anonymity floor), so the totals are withheld and will never be decrypted.",
          null,
          null
        );
      case "halted":
        return step("done", "Halted", "Halted on L1: the key was not ready by the start time, or the rollup is frozen. It cannot resume.", null, null);
      default:
        return step("action", "Status unknown", "L1 reports status \"" + status + "\".", "tally", "Open civic vote tools");
    }
  }

  /**
   * @param {object} election row from GET /api/elections
   * @param {object|null} rollupView GET /api/elections/:id/rollup (civic votes only)
   * @param {number} [now] unix seconds
   */
  function nextStep(election, rollupView, now = Math.floor(Date.now() / 1000)) {
    return isCivicVote(election) ? civicStep(election, rollupView, now) : pollStep(election, now);
  }

  /** Plain-English meanings of ZkVotingRollup / Guardians custom errors. */
  const CONTRACT_ERRORS = {
    NotGovernor: "Only the rollup governor can do this.",
    NotPendingGovernor: "Only the nominated governor can accept.",
    NotOperator: "Only the L2 operator can do this.",
    NotJurisdictionAdmin: "This node's key is not the jurisdiction admin on L1.",
    NotClerk: "This node's key is not a clerk for the jurisdiction on L1.",
    NotRegistrar: "This node's key is not the registrar for this election on L1.",
    NotOfficer: "This node's key is not the disqualification officer for this election on L1.",
    ZeroAddress: "An address was empty.",
    MockVerifierOnLocalChainOnly: "The mock verifier is only allowed on a local test chain.",
    JurisdictionExists: "That jurisdiction already exists on L1.",
    UnknownJurisdiction: "L1 does not know this jurisdiction. Check JURISDICTION settings.",
    UnknownElection: "L1 does not know this election.",
    WrongStatus: "Not allowed at this stage of the election. Refresh to see its current status.",
    BadElectionConfig: "The contract rejected the setup: it needs 2–8 options, an anonymity floor of at least 1, and a start time in the future before the cutoff.",
    BadInput: "A value was malformed.",
    TooEarly: "Too early: the window for this step has not opened yet.",
    TooLate: "Too late: the window for this step has closed (for example, the roll can only change before voting starts).",
    DesertMode: "The rollup is frozen (desert mode). Only exits and desert closes are possible.",
    NotDesertMode: "The rollup is not in desert mode.",
    NoExpiredRequest: "No L1 request has expired, so desert mode cannot be activated.",
    BadDesertProof: "The desert state proof is invalid.",
    BadStoredBatch: "The operator's batch does not match the one stored on L1.",
    BadTimestamp: "The batch timestamp is out of range (more than 15 minutes off).",
    BatchNotCommitted: "That batch has not been committed to L1 yet.",
    BatchNotVerified: "That batch has not been verified on L1 yet.",
    CannotRevertExecuted: "An executed batch cannot be reverted.",
    InvalidProof: "The batch proof did not verify.",
    MalformedPubdata: "The operator's batch data is malformed.",
    MissingPriorityOps: "The batch skipped queued L1 requests (registrations, closes) it must include.",
    OnchainOpsMismatch: "The batch's on-chain operations do not match its data.",
    PriorityOpMismatch: "The batch's L1 requests do not match the queue.",
    CountMismatch: "The counts do not match the number of options or the ballot total.",
    DecryptionMismatch: "The counts do not match the guardians' decryption.",
    BadCommittee: "The guardian set or threshold is invalid (1–16 guardians, 1 ≤ k ≤ n).",
    NotMember: "That guardian is not in this committee, or was excluded.",
    AlreadyCommitted: "This guardian already committed.",
    BadCommitments: "The guardian's commitments are malformed.",
    BadPoint: "A key or commitment is not a valid curve point.",
    BadSchnorr: "The guardian's proof of knowledge is invalid.",
    BadSignature: "The guardian's signature is invalid.",
    ComplaintUnfounded: "The complaint failed: the share was valid.",
    ShareDoesNotOpen: "The revealed share does not match the commitments.",
    DisputeOpen: "A share dispute is still open. Wait for it to be resolved (up to 1 hour).",
    NoDispute: "There is no open dispute to resolve.",
    NotEnoughGuardians: "Fewer than k guardians have committed. Wait for more guardians.",
    BadShares: "The decryption shares are invalid.",
    SharesAlreadyPosted: "This guardian already posted decryption shares.",
    BadSubset: "Finalizing needs exactly k guardians who have posted shares.",
    START_PASSED: "The start time has passed. A civic vote must be published to L1 before it starts.",
    BAD_BALLOT_SHAPE: "A civic vote has exactly one question with 2 to 8 options.",
    NO_GUARDIANS: "Enroll guardians and set the threshold first.",
    NOT_PUBLISHED: "This vote is not on L1 yet. Publish it first.",
    THRESHOLD_NOT_MET: "Not enough guardians have posted decryption shares yet.",
    L1_UNREACHABLE: "The Ethereum node (L1 RPC) is unreachable. Check L1_RPC.",
    NO_L1_KEY: "This node has no L1 key (ROLLUP_PRIVATE_KEY).",
    L2_UNREACHABLE: "The L2 operator is unreachable.",
    L2_DEGRADED: "The L2 operator is running in degraded mode.",
  };

  function friendlyError(code) {
    if (!code) return "";
    const name = String(code).replace(/\(.*$/, "");
    return CONTRACT_ERRORS[name] || "";
  }

  /**
   * Checks a clerk can make before creating an election, so a civic vote is not
   * created in a shape the contract will refuse at publish time.
   * @returns {string[]} problems (blocking) and the key "warnings" on the array.
   */
  function checkNewElection({ civic, startTime, cutoffTime, questions }, now = Math.floor(Date.now() / 1000)) {
    const problems = [];
    const warnings = [];
    if (!(startTime < cutoffTime)) problems.push("The start must be before the cutoff.");
    if (civic) {
      if (startTime <= now) problems.push("A civic vote must start in the future: it is published to L1 before it opens.");
      else if (startTime - now < KEYGEN_LEAD_SECONDS) {
        warnings.push("Voting starts in " + relative(startTime - now) + ". Guardians need about 2 hours after publishing to finish the key ceremony; a later start is safer.");
      }
      const qs = Array.isArray(questions) ? questions : [];
      const q0 = qs[0] || {};
      const given = Array.isArray(q0.options) ? q0.options.length : 0;
      // The Node fills Yes / No when a YES_NO question arrives without options.
      const n = given === 0 && q0.type === "YES_NO" ? 2 : given;
      if (qs.length !== 1) problems.push("A civic vote has exactly one question (it has " + qs.length + ").");
      else if (n < 2 || n > 8) problems.push("A civic vote's question needs 2 to 8 options (it has " + n + ").");
    }
    problems.warnings = warnings;
    return problems;
  }

  const api = { nextStep, friendlyError, checkNewElection, isCivicVote, relative, until, CONTRACT_ERRORS };
  root.ZkVotingNextStep = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
