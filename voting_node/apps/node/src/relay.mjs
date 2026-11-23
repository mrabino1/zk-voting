// NOT FOR PROFIT — civic public good, not a commercial product.
// Off-chain ballots on this node: polls (and votes not on the rollup). Civic votes on the
// rollup go through src/rollup/service.mjs instead. Never writes passkey user id onto a ballot.
// The vote body is the relay envelope only. Identity, wallet, and plaintext
// choice keys are stripped before this function reads the body. Per-leaf
// exclusion is not decided from the POST (that would require the leaf).
// Open-window roots must still match. The chain publishes eligibleRoot as
// registered ∩ ¬currently-disqualified. The circuit proves membership in that
// root and only binds disqRoot; see docs/ARCHITECTURE.md.

import { keccak256, toHex } from 'viem';

import proofHelpers from '@zk-voting/proof-helpers';

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
import { answersFromVoteBody, assertBallotAnswers, electionHasRanked, extractRankingPayload } from './ballot.mjs';
import { isRankingEnvelope, parseRankingEnvelope, rankingEnvelopeBytes, rankingHash } from '../public/ranked-envelope.js';
import { sealedRankingAllowed } from './rankedTally.mjs';

const { PUBLIC_INPUT_KEYS, publicInputsToHex } = proofHelpers;

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

/**
 * A ranked election with a guardian key takes the full ranking as a sealed
 * "RK" envelope next to the one-hot first-choice ciphertext. Only the shape is
 * checked here; the node cannot read it before guardians open it.
 */
export async function sealedRankingFromBody(election, body) {
  const raw = body?.encryptedRanking;
  const ranked = electionHasRanked(election);
  const allowed = ranked && sealedRankingAllowed(election);
  if (raw == null || raw === '') {
    if (allowed && election.tallyPubKey && election.tallyCeremony?.status === 'ready') {
      throw new HttpError(400, 'ranked ballots must include encryptedRanking', { code: 'RANKING_REQUIRED' });
    }
    return null;
  }
  if (!ranked) throw new HttpError(400, 'this election is not ranked', { code: 'RANKING_NOT_ALLOWED' });
  if (!allowed) {
    // Sealed vote without the opt-in: no ranking is accepted or stored.
    throw new HttpError(400, 'sealed ranked choice is not enabled for this vote', { code: 'RANKING_NOT_ALLOWED' });
  }
  if (typeof raw !== 'string' || raw.length > 2 + 2 * 8192 || !isRankingEnvelope(raw)) {
    throw new HttpError(400, 'encryptedRanking must be an RK ranking envelope', { code: 'BAD_RANKING' });
  }
  const hexLen = (raw.startsWith('0x') || raw.startsWith('0X') ? raw.length - 2 : raw.length) / 2;
  if (hexLen !== rankingEnvelopeBytes(election.questions || [])) {
    // One fixed envelope size per election, so length never hints at a ranking.
    throw new HttpError(400, 'encryptedRanking is not this election\'s fixed envelope size', { code: 'BAD_RANKING' });
  }
  try {
    parseRankingEnvelope(raw);
  } catch {
    throw new HttpError(400, 'encryptedRanking must be an RK ranking envelope', { code: 'BAD_RANKING' });
  }
  const rankingEnvelope = raw.toLowerCase().startsWith('0x') ? `0x${raw.slice(2).toLowerCase()}` : `0x${raw.toLowerCase()}`;
  return { rankingEnvelope, rankingHash: await rankingHash(rankingEnvelope) };
}

export async function relayVote({ store, explorer, electionId, body, now, intervalSeconds, config, spentPassHash = null }) {
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
  const sealedRanking = await sealedRankingFromBody(election, envelope);
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
  const onChainId = chainElectionId(election);

  const bound = assertBoundRoots(election, parsed, store);
  const publicInputs = asInputList({
    root: bound.root,
    disqRoot: bound.disqRoot,
    nullifier: parsed.nullifier,
    ballotHash: parsed.ballotHash,
    electionId: onChainId,
  });

  // A second ballot under the same nullifier is refused unless allowRevote is on.
  // The spent-nullifier check runs before the proof so a replay does not pay for verification.
  const already = store.findVote(election.id, parsed.nullifier);
  const replacing = Boolean(already) && config?.allowRevote === true;
  if (already && !replacing) {
    throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
  }

  await assertVoteProof({ proof: parsed.proof, publicSignals: publicInputs, config });

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
  };
  const storedEnvelope = { encryptedBallot: parsed.encryptedBallot, ...(sealedRanking || {}) };
  const vote = replacing
    ? await store.replaceVote(storedBallot, storedEnvelope)
    : await store.acceptVote(storedBallot, storedEnvelope);

  let recorded = null;
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
  } catch (err) {
    // Published blocks stay. A replacement is not rolled back into a delete.
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
    ...(sealedRanking ? { rankingHash: sealedRanking.rankingHash } : {}),
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
