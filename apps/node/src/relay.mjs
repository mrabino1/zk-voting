// NOT FOR PROFIT — civic public good, not a commercial product.
// Relays a vote proof to BallotInbox when CHAIN_RPC is set; otherwise accepts
// into the local store for demo. Never writes passkey user id onto a ballot.
// When CHAIN_RPC is unset, the Node rejects ballots whose identityCommitment is
// not in registered ∩ ¬currently-disqualified (the circuit still may not prove
// non-disqualification; see docs/ARCHITECTURE.md).

import { keccak256, toHex } from 'viem';

import { HttpError, stripBallotPii } from './http.mjs';
import { toBytes32 } from './merkle.mjs';
import { electionState } from './electionState.mjs';
import { isDisclosed, nextPublishAt } from './disclosure.mjs';
import { publicVoteRecord } from './store.mjs';
import { extractRankingPayload } from './ballot.mjs';

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
  return [root, disqRoot, nullifier, ballotHash, electionId];
}

export function parseVoteBody(body, electionId) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'JSON body required');
  }
  const proof = body.proof;
  if (proof == null) throw new HttpError(400, 'proof required');
  const encryptedBallot = body.encryptedBallot;
  if (encryptedBallot == null || encryptedBallot === '') {
    throw new HttpError(400, 'encryptedBallot required');
  }

  let publicInputs = body.publicInputs ?? proof.publicInputs;
  if (publicInputs == null && body.nullifier != null) {
    publicInputs = {
      root: body.root,
      disqRoot: body.disqRoot ?? body.disqualificationRoot,
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
    if (publicInputs.length >= 5) {
      [root, disqRoot, nullifier, ballotHash, eid] = publicInputs;
    } else {
      [root, nullifier, ballotHash, eid] = publicInputs;
    }
  } else if (typeof publicInputs === 'object') {
    root = publicInputs.root;
    disqRoot = publicInputs.disqRoot ?? publicInputs.disqualificationRoot;
    nullifier = publicInputs.nullifier;
    ballotHash = publicInputs.ballotHash;
    eid = publicInputs.electionId;
  } else {
    throw new HttpError(400, 'publicInputs required');
  }
  if (nullifier == null || nullifier === '') nullifier = body.nullifier;
  if (ballotHash == null || ballotHash === '') ballotHash = body.ballotHash;
  if (disqRoot == null || disqRoot === '') {
    disqRoot = body.disqRoot ?? body.disqualificationRoot;
  }
  if (nullifier == null || nullifier === '') {
    throw new HttpError(400, 'nullifier required');
  }
  if (eid != null && String(eid) !== String(electionId)) {
    throw new HttpError(400, 'electionId mismatch');
  }
  if (ballotHash == null || ballotHash === '') {
    ballotHash = hashBallot(encryptedBallot);
  }
  const identityCommitment = body.identityCommitment ?? body.commitment ?? null;
  return {
    proof: stripBallotPii(proof),
    root,
    disqRoot,
    nullifier,
    ballotHash,
    identityCommitment,
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
 * identityCommitment is checked then discarded; it is never persisted on the vote.
 */
export async function relayVote({ store, explorer, chain, electionId, body, now, intervalSeconds }) {
  const election = store.requireElection(electionId);
  const parsed = parseVoteBody(body, election.id);
  const ts = now ?? Math.floor(Date.now() / 1000);
  const interval = Number(intervalSeconds) || 0;
  assertVoteWindow(election, ts);
  if (store.nullifierUsed(election.id, parsed.nullifier)) {
    throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
  }

  const chainConfigured = Boolean(chain?.isConfigured?.());
  const hasCommitment = parsed.identityCommitment != null && parsed.identityCommitment !== '';
  if (!chainConfigured || hasCommitment) {
    store.assertCanVote(election.id, parsed.identityCommitment);
  }

  const bound = assertBoundRoots(election, parsed, store);
  const publicInputs = asInputList({
    root: bound.root,
    disqRoot: bound.disqRoot,
    nullifier: parsed.nullifier,
    ballotHash: parsed.ballotHash,
    electionId: election.id,
  });

  if (chainConfigured) {
    await chain.submitVote({
      electionId: election.id,
      proof: parsed.proof,
      publicInputs,
      encryptedBallot: parsed.encryptedBallot,
    });
  }

  const rankingPayload = extractRankingPayload(election, body, parsed.encryptedBallot);

  const vote = await store.acceptVote(
    {
      nullifier: parsed.nullifier,
      ballotHash: parsed.ballotHash,
      electionId: election.id,
      relayer: 'node',
      acceptedAt: ts,
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
  return {
    ok: true,
    vote: publicVoteRecord(vote),
    published,
    nextPublishAt: nextPublishAt(ts, interval),
  };
}
