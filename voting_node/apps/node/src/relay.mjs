// NOT FOR PROFIT — civic public good, not a commercial product.
// A poll and a vote are both relayed to BallotInbox when CHAIN_RPC is set.
// The interval batch is the same for both. Never writes passkey user id onto a ballot.
// The vote body is the relay envelope only. Identity, wallet, and plaintext
// choice keys are stripped before this function reads the body. Per-leaf
// exclusion is not decided from the POST (that would require the leaf).
// Open-window roots must still match. The chain publishes eligibleRoot as
// registered ∩ ¬currently-disqualified. The circuit proves membership in that
// root and only binds disqRoot; see docs/ARCHITECTURE.md.

import { keccak256, toHex } from 'viem';

import proofHelpers from '@zk-voting/proof-helpers';

import { ALLOW_REVOTE_CHAIN_CONFIGURED } from './config.mjs';
import { HttpError, sanitizeVoteBody, stripBallotPii } from './http.mjs';
import { isUnsafeObjectKey } from './safeKeys.mjs';
import { chainElectionId, electionMatchesRef } from './electionIds.mjs';
import { toBytes32, ZERO } from './merkle.mjs';
import { electionState } from './electionState.mjs';
import { isAggregateEnvelope, parseAggregateEnvelope } from './aggregateBallot.mjs';
import { assertVoteProof } from './voteProof.mjs';
import { nextPublishAt } from './disclosure.mjs';
import { electionDisclosurePolicy, publicVoteRecord } from './store.mjs';
import {
  buildReceiptPdf,
  mintHolderToken,
  presentHolderReceipt,
} from './receipts.mjs';
import { answersFromVoteBody, assertBallotAnswers, extractRankingPayload } from './ballot.mjs';

const { PUBLIC_INPUT_KEYS, publicInputsToHex } = proofHelpers;

/** One repair attempt per nullifier per minute, or per disclosure interval. */
const REPAIR_COOLDOWN_SECONDS = 60;
const repairAttemptAt = new Map();

/**
 * Drop marks whose cooldown has elapsed, and every mark for one election
 * once that election is tallied. The map stores the expiry time.
 */
export function expireRepairAttempts(now, electionId = null) {
  const at = Number(now) || Math.floor(Date.now() / 1000);
  const prefix = electionId == null ? null : `${String(electionId)}:`;
  for (const [key, until] of repairAttemptAt) {
    if (prefix && key.startsWith(prefix)) {
      repairAttemptAt.delete(key);
      continue;
    }
    if ((Number(until) || 0) <= at) repairAttemptAt.delete(key);
  }
}

function repairAllowed(electionId, nullifier, now, intervalSeconds) {
  const key = `${String(electionId)}:${String(nullifier)}`;
  const cooldown = Math.max(REPAIR_COOLDOWN_SECONDS, Number(intervalSeconds) || 0);
  const at = Number(now) || 0;
  expireRepairAttempts(at);
  const until = repairAttemptAt.get(key) || 0;
  if (until > at) return false;
  repairAttemptAt.set(key, at + cooldown);
  return true;
}

/** Vote circuit / BallotInbox instance: [eligibleRoot, disqRoot, nullifier, ballotHash, electionId]. */
export const VOTE_PUBLIC_INPUT_COUNT = PUBLIC_INPUT_KEYS.length;

function firstDefined(...values) {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function optionalBytes32(value) {
  if (value == null || value === '') return null;
  try {
    return toBytes32(value);
  } catch {
    throw new HttpError(400, 'invalid bytes32 value');
  }
}

function sameBytes32(a, b) {
  return toBytes32(a) === toBytes32(b);
}

/** Circuit / BallotInbox order: [root, disqRoot, nullifier, ballotHash, electionId]. */
function asInputList({ root, disqRoot, nullifier, ballotHash, electionId }) {
  try {
    return publicInputsToHex({
      root: root || ZERO,
      disqRoot: disqRoot || ZERO,
      nullifier,
      ballotHash,
      electionId,
    });
  } catch (err) {
    throw new HttpError(400, err.message || 'invalid publicInputs');
  }
}

function toEncryptedHex(encryptedBallot) {
  if (typeof encryptedBallot === 'string' && encryptedBallot.startsWith('0x')) {
    return encryptedBallot;
  }
  if (typeof encryptedBallot === 'string') {
    return toHex(Buffer.from(encryptedBallot, 'utf8'));
  }
  throw new HttpError(400, 'encryptedBallot required');
}

/** BN254 scalar field modulus r (Groth16 public inputs must be < r). */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Ballot hash bound as vote public input 3.
 * An AG envelope contributes the 32-byte Poseidon tag (the contracts bind that
 * tag, not keccak of the whole blob). A canonical EG ballot is the ordered-vector
 * Poseidon digest. Every other ciphertext stays `uint256(keccak256(ciphertext)) % r`.
 */
export function hashBallot(encryptedBallot) {
  const hex = toEncryptedHex(encryptedBallot);
  if (isAggregateEnvelope(hex)) {
    return parseAggregateEnvelope(hex).ballotHash;
  }
  const eg = proofHelpers.digestEgBallot(hex);
  if (eg != null) return toHex(eg, { size: 32 });
  const h = BigInt(keccak256(hex));
  return toHex(h % SNARK_SCALAR_FIELD, { size: 32 });
}

export function parseVoteBody(body, electionOrId, roots = {}) {
  const election = typeof electionOrId === 'object' && electionOrId ? electionOrId : null;
  const electionId = election ? String(election.id) : String(electionOrId);
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'JSON body required');
  }
  body = sanitizeVoteBody(body);
  const proof = body.proof;
  if (proof == null) throw new HttpError(400, 'proof required');
  const encryptedBallot = body.encryptedBallot;
  if (encryptedBallot == null || encryptedBallot === '') {
    throw new HttpError(400, 'encryptedBallot required');
  }

  let publicInputs = body.publicInputs ?? proof.publicInputs;
  if (publicInputs == null && body.nullifier != null) {
    publicInputs = {
      root: firstDefined(body.root, body.eligibleRoot),
      disqRoot: firstDefined(body.disqRoot, body.disqualificationRoot),
      nullifier: body.nullifier,
      ballotHash: body.ballotHash,
      electionId: body.electionId ?? electionId,
    };
  }
  if (publicInputs == null) throw new HttpError(400, 'publicInputs required');

  let root;
  let disqRoot;
  let nullifier;
  let ballotHash;
  let eid;
  if (Array.isArray(publicInputs)) {
    if (publicInputs.length < VOTE_PUBLIC_INPUT_COUNT) {
      throw new HttpError(
        400,
        'publicInputs must be [eligibleRoot, disqRoot, nullifier, ballotHash, electionId]',
        { code: 'INVALID_PUBLIC_INPUTS' },
      );
    }
    [root, disqRoot, nullifier, ballotHash, eid] = publicInputs;
  } else if (typeof publicInputs === 'object') {
    root = firstDefined(publicInputs.root, publicInputs.eligibleRoot);
    disqRoot = firstDefined(publicInputs.disqRoot, publicInputs.disqualificationRoot);
    nullifier = publicInputs.nullifier;
    ballotHash = publicInputs.ballotHash;
    eid = publicInputs.electionId;
  } else {
    throw new HttpError(400, 'publicInputs required');
  }
  root = firstDefined(root, body.root, body.eligibleRoot, roots.root, roots.eligibleRoot);
  disqRoot = firstDefined(
    disqRoot,
    body.disqRoot,
    body.disqualificationRoot,
    roots.disqRoot,
    roots.disqualificationRoot,
  );
  if (nullifier == null || nullifier === '') nullifier = body.nullifier;
  if (ballotHash == null || ballotHash === '') ballotHash = body.ballotHash;
  if (nullifier == null || nullifier === '') {
    throw new HttpError(400, 'nullifier required');
  }
  if (eid != null && eid !== '') {
    const matches = election
      ? electionMatchesRef(election, eid)
      : String(eid) === String(electionId);
    if (!matches) {
      throw new HttpError(400, 'electionId mismatch');
    }
  }
  if (ballotHash == null || ballotHash === '') {
    ballotHash = hashBallot(encryptedBallot);
  }
  return {
    proof: stripBallotPii(proof),
    root,
    disqRoot,
    nullifier,
    ballotHash,
    encryptedBallot: toEncryptedHex(encryptedBallot),
  };
}

export function assertVoteWindow(election, now = Math.floor(Date.now() / 1000)) {
  const state = electionState(election, now);
  if (!election.rollFrozen) {
    throw new HttpError(400, 'roll not frozen', { code: 'ROLL_NOT_FROZEN', state });
  }
  if (now < election.startTime) {
    throw new HttpError(400, 'election not open yet', { code: 'NOT_OPEN', state });
  }
  if (now >= election.cutoffTime) {
    throw new HttpError(400, 'election closed', { code: 'CLOSED', state });
  }
  if (election.tally) {
    throw new HttpError(400, 'election already tallied', { code: 'TALLIED', state });
  }
}

function assertBoundRoots(election, parsed, store) {
  const roots = store.votingRoots(election);
  const root = optionalBytes32(parsed.root) || roots.eligibleRoot;
  const disqRoot = optionalBytes32(parsed.disqRoot) || roots.disqualificationRoot;
  if (!sameBytes32(root, roots.eligibleRoot)) {
    throw new HttpError(400, 'eligible root does not match the open-window eligible set', {
      code: 'ELIGIBLE_ROOT_MISMATCH',
    });
  }
  if (!sameBytes32(disqRoot, roots.disqualificationRoot)) {
    throw new HttpError(400, 'disqualification root does not match', {
      code: 'DISQUALIFICATION_ROOT_MISMATCH',
    });
  }
  return { root, disqRoot };
}

/**
 * Relay a ballot. Intentionally ignores req.user / passkey identity so the
 * Node cannot write "this user voted for X" even if the client sends it.
 * The leaf, wallet, and plaintext answers are not fields of this request.
 */
/** Coarsen a server timestamp to the start of its disclosure bucket (default 1 hour). */
export function coarseAcceptedAt(ts, intervalSeconds) {
  const bucket = Number(intervalSeconds) > 0 ? Math.floor(Number(intervalSeconds)) : 3600;
  return Math.floor(Number(ts) / bucket) * bucket;
}

export async function relayVote({ store, explorer, chain, electionId, body, now, intervalSeconds, config, spentPassHash = null }) {
  const election = store.requireElection(electionId);
  const envelope = sanitizeVoteBody(body);
  const parsed = parseVoteBody(envelope, election);
  const questions = election.questions || [];
  const answers = answersFromVoteBody(envelope, parsed.encryptedBallot);
  if (answers && !(config || {}).allowPlaintextBallots) {
    // A JSON "ciphertext" is the voter's choices in the clear next to the
    // nullifier. The shipped client always encrypts; refuse anything else.
    throw new HttpError(400, 'plaintext ballots are refused: encryptedBallot must be ciphertext', {
      code: 'PLAINTEXT_BALLOT',
    });
  }
  if (answers) assertBallotAnswers(questions, answers);
  // Validate a plaintext ranking when the fixture flag allows one, then drop
  // it. The envelope row does not keep a per-ballot opening.
  extractRankingPayload(election, envelope, parsed.encryptedBallot);
  const ts = now ?? Math.floor(Date.now() / 1000);
  const interval = Number(intervalSeconds) || 0;
  assertVoteWindow(election, ts);
  if (
    election.tallyScheme === 'opens_ballots' ||
    election.tallyScheme === 1 ||
    election.tallyScheme === '1'
  ) {
    if (election.tallyCeremony?.status !== 'ready' || !election.tallyPubKey) {
      throw new HttpError(409, 'guardian ceremony is not ready', { code: 'CEREMONY_INCOMPLETE' });
    }
    if (!isAggregateEnvelope(parsed.encryptedBallot)) {
      throw new HttpError(
        400,
        'opens_ballots ballots must be AG aggregate envelopes; per-ballot ECIES openings are refused',
        { code: 'PER_BALLOT_OPEN_DISABLED' },
      );
    }
  }
  const chainConfigured = Boolean(chain?.isConfigured?.());
  const onChainId = chainElectionId(election);

  const bound = assertBoundRoots(election, parsed, store);
  const publicInputs = asInputList({
    root: bound.root,
    disqRoot: bound.disqRoot,
    nullifier: parsed.nullifier,
    ballotHash: parsed.ballotHash,
    electionId: onChainId,
  });

  // A second proof is rejected unless allowRevote is on. That flag stays
  // off until the inbox can store the latest ballot. A replacement is not
  // submitted again and does not rewrite a published block.
  // The spent-nullifier check runs before the proof so a replay does not
  // pay for verification, and so a mined proof cannot be re-queued.
  const already = store.findVote(election.id, parsed.nullifier);
  const replacing = Boolean(already) && config?.allowRevote === true;
  if (replacing && chainConfigured) {
    // TODO(#113): remove this refusal once the inbox contracts accept a replacement ballot.
    throw new HttpError(503, ALLOW_REVOTE_CHAIN_CONFIGURED, { code: 'ALLOW_REVOTE_CHAIN_CONFIGURED' });
  }
  if (already && !replacing) {
    // Repair only a stored ballot the queue and the chain have both forgotten.
    // A ballot already marked queued is left alone. Repairs are rate-limited.
    // Anything queued, in flight, spent, or already recorded is a 409.
    const payload = typeof store.chainBallotPayload === 'function'
      ? store.chainBallotPayload(election.id, parsed.nullifier)
      : null;
    const markedQueued = Boolean(payload?.chainQueuedAt || payload?.chainTxHash);
    if (
      !markedQueued
      && payload
      && chainConfigured
      && interval > 0
      && typeof chain.nullifierChainState === 'function'
      && repairAllowed(election.id, parsed.nullifier, ts, interval)
    ) {
      const state = await chain.nullifierChainState(onChainId, parsed.nullifier);
      const absent = state
        && !state.queued
        && !state.inFlight
        && !state.spent
        && !state.chainRecord
        && !state.deadLetter
        && state.spentKnown !== false;
      if (absent && payload) {
        try {
          await chain.submitVote({
            electionId: onChainId,
            proof: payload.proof,
            publicInputs: payload.publicInputs,
            encryptedBallot: payload.encryptedBallot,
            startTime: payload.startTime,
            cutoffTime: payload.cutoffTime,
            now: ts,
          });
          if (typeof store.markChainBallotQueued === 'function') {
            await store.markChainBallotQueued(election.id, parsed.nullifier, ts);
          }
        } catch (err) {
          if (!(config || {}).quiet) {
            console.warn(`[zk-voting] could not queue an already accepted ballot: ${err.message || err}`);
          }
        }
      }
    }
    throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
  }

  await assertVoteProof({ proof: parsed.proof, publicSignals: publicInputs, config });

  const chainBallot = {
    electionId: onChainId,
    proof: parsed.proof,
    publicInputs,
    encryptedBallot: parsed.encryptedBallot,
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    now: ts,
  };

  // Interval 0 is one transaction, not a durable queue. It has to succeed
  // before the node records the ballot. A positive interval records first
  // and enqueues after, so a ballot the node rejects is not left on the queue.
  if (chainConfigured && interval <= 0 && !replacing) {
    await chain.submitVote(chainBallot);
  }

  const holder = mintHolderToken();
  // No userOpHash: the passkey wallet's hash is bound to the smart-account
  // address, so storing it would let anyone with the roll join a ballot to a
  // person. Timestamps are coarsened to the disclosure bucket.
  const acceptedAt = coarseAcceptedAt(ts, interval);
  const nullifier = toBytes32(parsed.nullifier);
  const ballotHash = toBytes32(parsed.ballotHash);
  const artifact = buildReceiptPdf({
    election,
    vote: {
      nullifier,
      ballotHash,
      electionId: String(election.id),
      acceptedAt,
    },
    receipt: { tokenHash: holder.receiptTokenHash },
    token: holder.token,
    hmacSecret: (config || {}).receiptPdfSecret,
  });
  const storedBallot = {
    nullifier,
    ballotHash,
    electionId: election.id,
    relayer: 'node',
    acceptedAt,
    receiptTokenHash: holder.receiptTokenHash,
    spentPassHash,
    pdfSha256: artifact.pdfSha256,
    pdfIntegrity: artifact.integrity,
    ...(chainConfigured && interval > 0
      ? {
          chainPayload: {
            proof: parsed.proof,
            publicInputs,
            encryptedBallot: parsed.encryptedBallot,
            startTime: election.startTime,
            cutoffTime: election.cutoffTime,
          },
        }
      : {}),
  };
  const storedEnvelope = { encryptedBallot: parsed.encryptedBallot };
  const vote = replacing
    ? await store.replaceVote(storedBallot, storedEnvelope)
    : await store.acceptVote(storedBallot, storedEnvelope);

  let recorded = null;
  let addedToQueue = false;
  try {
    if (!replacing) recorded = await explorer.recordVote(
      {
        nullifier: vote.nullifier,
        ballotHash: vote.ballotHash,
        electionId: vote.electionId,
        relayer: 'node',
      },
      acceptedAt,
      interval,
    );
    if (!replacing && chainConfigured && interval > 0) {
      const outcome = await chain.submitVote(chainBallot);
      // A duplicate must not drop both copies. Replace the queued row and
      // succeed, or leave the stored ballot in place and ask for a retry.
      if (outcome?.duplicate) {
        const replaced = typeof chain.replaceQueuedVote === 'function'
          ? await chain.replaceQueuedVote(chainBallot)
          : null;
        if (!replaced?.replaced) {
          throw new HttpError(503, 'ballot queue is busy; retry', { code: 'CHAIN_QUEUE_BUSY', keepVote: true });
        }
      } else {
        addedToQueue = true;
      }
      if (typeof store.markChainBallotQueued === 'function') {
        await store.markChainBallotQueued(election.id, parsed.nullifier, ts);
      }
    }
  } catch (err) {
    // Interval 0 may already have published a block and mined a transaction.
    // Published blocks stay. A replacement is not rolled back into a delete.
    // A busy queue keeps this ballot: rolling it back would store it nowhere.
    // Only an unpublished queue ballot is rolled back.
    if (err instanceof HttpError && err.extra?.keepVote) throw err;
    if (addedToQueue && typeof chain.dropQueuedVote === 'function') {
      try {
        await chain.dropQueuedVote(onChainId, parsed.nullifier);
      } catch (undoErr) {
        if (!(config || {}).quiet) {
          console.warn(`[zk-voting] could not roll back a queued ballot: ${undoErr.message || undoErr}`);
        }
      }
    }
    if (!replacing && interval > 0) {
      if (recorded?.sealed && typeof explorer.dropSealedVote === 'function') {
        try {
          await explorer.dropSealedVote(vote.nullifier);
        } catch (undoErr) {
          if (!(config || {}).quiet) {
            console.warn(`[zk-voting] could not roll back a sealed ballot: ${undoErr.message || undoErr}`);
          }
        }
      }
      try {
        await store.revertAcceptedVote({ electionId: election.id, nullifier: vote.nullifier, spentPassHash });
      } catch (undoErr) {
        if (!(config || {}).quiet) {
          console.warn(`[zk-voting] could not roll back an accepted ballot: ${undoErr.message || undoErr}`);
        }
      }
    }
    throw err;
  }

  const policy = electionDisclosurePolicy(election, config, ts);
  const published = store
    .listPublishedVotes(election.id, ts, policy.intervalSeconds, policy)
    .some((row) => String(row.nullifier) === String(vote.nullifier));
  const nextAt = nextPublishAt(ts, interval, policy.delaySeconds);
  // The public vote row keeps the first hash. The holder receipt uses the
  // hash of the ballot just accepted.
  const receiptVote = replacing ? { ...vote, ballotHash, acceptedAt } : vote;
  return {
    ok: true,
    vote: publicVoteRecord(vote),
    published,
    nextPublishAt: nextAt,
    receipt: presentHolderReceipt({
      election,
      vote: receiptVote,
      token: holder.token,
      published,
      nextPublishAt: nextAt,
      pdfSha256: artifact.pdfSha256,
      integrity: artifact.integrity,
      pdfProtected: true,
    }),
  };
}

const POLL_BALLOT_BANNED = new Set([
  'userId',
  'user_id',
  'nullifier',
  'pin',
  'passkeyUserId',
  'identityCommitment',
  'credentialId',
]);

/** Token-poll ballots have no identity gate. Drop any identity keys and leave the civic relay alone. */
export function relayTokenPollBallot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid ballot', { code: 'INVALID_CHOICES' });
  }
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (POLL_BALLOT_BANNED.has(key) || isUnsafeObjectKey(key)) continue;
    out[key] = value;
  }
  return out;
}
