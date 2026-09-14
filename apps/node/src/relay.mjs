// NOT FOR PROFIT — civic public good, not a commercial product.
// Relays a vote proof to BallotInbox when CHAIN_RPC is set; otherwise accepts
// into the local store for demo. Never writes passkey user id onto a ballot.

import { keccak256, toHex } from 'viem';

import { HttpError, stripBallotPii } from './http.mjs';
import { toBytes32 } from './merkle.mjs';
import { electionState } from './electionState.mjs';

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

function asInputList(publicInputs, electionId, { root, nullifier, ballotHash }) {
  if (Array.isArray(publicInputs) && publicInputs.length >= 4) {
    return publicInputs.slice(0, 4);
  }
  return [root || toBytes32(0), nullifier, ballotHash, electionId];
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
      nullifier: body.nullifier,
      ballotHash: body.ballotHash,
      electionId: body.electionId ?? electionId,
    };
  }
  if (publicInputs == null) throw new HttpError(400, 'publicInputs required');

  let root;
  let nullifier;
  let ballotHash;
  let eid;
  if (Array.isArray(publicInputs)) {
    [root, nullifier, ballotHash, eid] = publicInputs;
  } else if (typeof publicInputs === 'object') {
    root = publicInputs.root;
    nullifier = publicInputs.nullifier;
    ballotHash = publicInputs.ballotHash;
    eid = publicInputs.electionId;
  } else {
    throw new HttpError(400, 'publicInputs required');
  }
  if (nullifier == null || nullifier === '') nullifier = body.nullifier;
  if (ballotHash == null || ballotHash === '') ballotHash = body.ballotHash;
  if (nullifier == null || nullifier === '') {
    throw new HttpError(400, 'nullifier required');
  }
  if (eid != null && String(eid) !== String(electionId)) {
    throw new HttpError(400, 'electionId mismatch');
  }
  // ballotHash is a commitment from the proof / client. It is not required to
  // equal keccak(encryptedBallot); the ciphertext is opaque.
  if (ballotHash == null || ballotHash === '') {
    ballotHash = hashBallot(encryptedBallot);
  }
  const inputs = asInputList(publicInputs, electionId, { root, nullifier, ballotHash });
  return {
    proof: stripBallotPii(proof),
    root,
    nullifier,
    ballotHash,
    encryptedBallot: toEncryptedHex(encryptedBallot),
    publicInputs: inputs,
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

/**
 * Relay a ballot. Intentionally ignores req.user / passkey identity so the
 * Node cannot write "this user voted for X" even if the client sends it.
 */
export async function relayVote({ store, explorer, chain, electionId, body }) {
  const election = store.requireElection(electionId);
  const parsed = parseVoteBody(body, election.id);
  assertVoteWindow(election);
  if (store.nullifierUsed(election.id, parsed.nullifier)) {
    throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
  }

  if (chain.isConfigured()) {
    await chain.submitVote({
      electionId: election.id,
      proof: parsed.proof,
      publicInputs: parsed.publicInputs,
      encryptedBallot: parsed.encryptedBallot,
    });
  }

  const vote = await store.acceptVote(
    {
      nullifier: parsed.nullifier,
      ballotHash: parsed.ballotHash,
      electionId: election.id,
      relayer: 'node',
    },
    { encryptedBallot: parsed.encryptedBallot },
  );

  await explorer.append('vote', {
    nullifier: vote.nullifier,
    ballotHash: vote.ballotHash,
    electionId: vote.electionId,
    relayer: 'node',
  });

  return { ok: true, vote };
}
