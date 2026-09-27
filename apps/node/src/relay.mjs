// NOT FOR PROFIT — civic public good, not a commercial product.
// Relays a vote proof to BallotInbox when CHAIN_RPC is set; otherwise accepts
// into the local store for demo. Never writes passkey user id onto a ballot.
// The vote body is the relay envelope only. Identity, wallet, and plaintext
// choice keys are stripped before this function reads the body. Per-leaf
// exclusion is not decided from the POST (that would require the leaf).
// Open-window roots must still match. The chain publishes eligibleRoot as
// registered ∩ ¬currently-disqualified. The circuit proves membership in that
// root and only binds disqRoot; see docs/ARCHITECTURE.md.

import { keccak256, toHex } from 'viem';

import proofHelpers from '@zk-voting/proof-helpers';

import { HttpError, sanitizeVoteBody, stripBallotPii } from './http.mjs';
import { chainElectionId, electionMatchesRef } from './electionIds.mjs';
import { toBytes32, ZERO } from './merkle.mjs';
import { electionState } from './electionState.mjs';
import { isTallyEnvelope } from './tallyCrypto.mjs';
import { isDisclosed, nextPublishAt } from './disclosure.mjs';
import {
  issueAndStoreReceiptPdf,
  mintHolderToken,
  optionalUserOpHash,
  presentHolderReceipt,
} from './receipts.mjs';
import { publicVoteRecord } from './store.mjs';
import { answersFromVoteBody, assertBallotAnswers, extractRankingPayload } from './ballot.mjs';

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

export function hashBallot(encryptedBallot) {
  return keccak256(toEncryptedHex(encryptedBallot));
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
export async function relayVote({ store, explorer, chain, electionId, body, now, intervalSeconds, config }) {
  const election = store.requireElection(electionId);
  const envelope = sanitizeVoteBody(body);
  const parsed = parseVoteBody(envelope, election);
  const questions = election.questions || [];
  const answers = answersFromVoteBody(envelope, parsed.encryptedBallot);
  if (answers) assertBallotAnswers(questions, answers);
  const rankingPayload = extractRankingPayload(election, envelope, parsed.encryptedBallot);
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
    if (!isTallyEnvelope(parsed.encryptedBallot)) {
      throw new HttpError(400, 'opens_ballots ballots must be RTv1 tally envelopes', {
        code: 'BAD_ENVELOPE',
      });
    }
  }
  if (store.nullifierUsed(election.id, parsed.nullifier)) {
    throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
  }

  const chainConfigured = Boolean(chain?.isConfigured?.());

  const bound = assertBoundRoots(election, parsed, store);
  const publicInputs = asInputList({
    root: bound.root,
    disqRoot: bound.disqRoot,
    nullifier: parsed.nullifier,
    ballotHash: parsed.ballotHash,
    electionId: chainElectionId(election),
  });

  if (chainConfigured) {
    await chain.submitVote({
      electionId: chainElectionId(election),
      proof: parsed.proof,
      publicInputs,
      encryptedBallot: parsed.encryptedBallot,
    });
  }

  const holder = mintHolderToken();
  const vote = await store.acceptVote(
    {
      nullifier: parsed.nullifier,
      ballotHash: parsed.ballotHash,
      electionId: election.id,
      relayer: 'node',
      acceptedAt: ts,
      receiptTokenHash: holder.receiptTokenHash,
      userOpHash: optionalUserOpHash(envelope?.userOpHash || envelope?.userOp?.hash),
    },
    { encryptedBallot: parsed.encryptedBallot, rankingPayload },
  );

  await explorer.recordVote(
    {
      nullifier: vote.nullifier,
      ballotHash: vote.ballotHash,
      electionId: vote.electionId,
      relayer: 'node',
    },
    ts,
    interval,
  );

  const published = isDisclosed(vote.acceptedAt, ts, interval);
  const nextAt = nextPublishAt(ts, interval);
  const receiptRow = store.findReceiptForVote(vote.electionId, vote.nullifier);
  const artifact = await issueAndStoreReceiptPdf(
    { store, config: config || {} },
    {
      election,
      vote,
      receiptRow,
      token: holder.token,
    },
  );
  return {
    ok: true,
    vote: publicVoteRecord(vote),
    published,
    nextPublishAt: nextAt,
    receipt: presentHolderReceipt({
      election,
      vote: { ...vote, userOpHash: receiptRow?.userOpHash || null },
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
    if (POLL_BALLOT_BANNED.has(key)) continue;
    out[key] = value;
  }
  return out;
}
