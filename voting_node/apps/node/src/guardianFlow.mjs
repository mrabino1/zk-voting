// NOT FOR PROFIT — civic public good, not a commercial product.
// Admin-facing guardian ceremony. Secret shares never land on the Node:
// deals carry Feldman commitments and shares encrypted to each guardian.

import { HttpError } from './http.mjs';
import { aggregateCiphertexts, aggregateOptionId, isAggregateEnvelope } from './aggregateBallot.mjs';
import { ciphertextForTally, withoutExcludedEnvelopes } from './tallyOpen.mjs';
import { isTallyEnvelope } from './tallyCrypto.mjs';
import { expectedVerificationKey, jointPublicKey, pointToHex } from './guardians/index.mjs';
import { pointFromHex, pointXBytes } from './guardians/p256.mjs';
import { verifyPartial } from './guardians/threshold.mjs';

function fail(status, message, code) {
  throw new HttpError(status, message, { code });
}

function normalizePoint(hex) {
  try {
    return pointToHex(pointFromHex(hex));
  } catch (err) {
    fail(400, err.message, err.code || 'BAD_POINT');
  }
}

export async function enrollGuardian(store, electionId, body) {
  const transportPublicKey = normalizePoint(body?.transportPublicKey);
  return store.enrollGuardian(electionId, {
    guardianId: body?.guardianId,
    label: body?.label,
    transportPublicKey,
  });
}

export async function acceptDeal(store, electionId, body) {
  const election = store.requireElection(electionId);
  const ceremony = election.tallyCeremony;
  if (!ceremony) fail(400, 'election has no guardian ceremony', 'NO_CEREMONY');
  const index = Number(body?.index);
  if (!Array.isArray(body?.commitments) || body.commitments.length !== ceremony.threshold) {
    fail(400, `commitments must be ${ceremony.threshold} P-256 points`, 'BAD_SHARE');
  }
  const commitments = body.commitments.map((point) => normalizePoint(point));
  const roster = ceremony.roster || [];
  const incoming = body?.encryptedShares;
  if (!incoming || typeof incoming !== 'object') fail(400, 'encryptedShares required', 'BAD_SHARE');
  const encryptedShares = {};
  for (const member of roster) {
    const ct = incoming[String(member.index)] ?? incoming[member.index];
    if (typeof ct !== 'string' || !isTallyEnvelope(ct)) {
      fail(400, `encrypted share for guardian ${member.index} is missing`, 'BAD_SHARE');
    }
    encryptedShares[String(member.index)] = ct;
  }
  await store.saveGuardianDeal(electionId, { index, commitments, encryptedShares });
  const bucket = store.guardianMaterial(electionId);
  if (bucket.deals.length === ceremony.guardians) {
    let joint;
    try {
      joint = jointPublicKey(bucket.deals);
    } catch (err) {
      fail(400, err.message, err.code || 'BAD_SHARE');
    }
    const raw = joint.toRawBytes(false);
    const verificationKeys = {};
    for (const member of ceremony.roster) {
      verificationKeys[String(member.index)] = pointToHex(expectedVerificationKey(bucket.deals, member.index));
    }
    await store.markCeremonyReady(electionId, {
      publicKey: `0x${Buffer.from(raw).toString('hex')}`,
      publicKeyX: `0x${Buffer.from(pointXBytes(joint)).toString('hex')}`,
      publicKeyY: `0x${Buffer.from(raw.subarray(33, 65)).toString('hex')}`,
      verificationKeys,
    });
  }
  return store.requireElection(electionId);
}

export async function acceptPartials(store, electionId, body) {
  const election = store.requireElection(electionId);
  const ceremony = election.tallyCeremony;
  if (!ceremony || ceremony.status !== 'ready') {
    fail(409, 'guardian public key is not ready', 'CEREMONY_INCOMPLETE');
  }
  const index = Number(body?.index);
  if (!(ceremony.roster || []).some((g) => g.index === index)) {
    fail(400, 'unknown guardian index', 'UNKNOWN_GUARDIAN');
  }
  if (!Array.isArray(body?.partials) || body.partials.length === 0) {
    fail(400, 'partials required', 'BAD_PARTIAL');
  }
  const partials = body.partials.map((row) => ({
    ballotHash: String(row?.ballotHash || ''),
    point: String(row?.point || ''),
    proof: {
      A: String(row?.proof?.A || ''),
      B: String(row?.proof?.B || ''),
      z: String(row?.proof?.z || ''),
    },
  }));
  const envelopes = withoutExcludedEnvelopes(
    store.listEnvelopes(electionId),
    typeof store.excludedNullifiers === 'function' ? store.excludedNullifiers(electionId) : [],
  ).envelopes;
  const tallyCiphertexts = envelopes.map((env) => ciphertextForTally(env));
  if (tallyCiphertexts.some((ciphertext) => !isAggregateEnvelope(ciphertext))) {
    fail(400, 'accepted ballots are not AG aggregate envelopes', 'PER_BALLOT_OPEN_DISABLED');
  }
  let product;
  try {
    product = aggregateCiphertexts(tallyCiphertexts);
  } catch (err) {
    fail(400, err.message, err.code || 'BAD_ENVELOPE');
  }
  for (const row of partials) {
    const option = /^aggregate:(\d+)$/.exec(row.ballotHash);
    if (!option) {
      fail(400, 'per-ballot decryption partials are refused', 'PER_BALLOT_PARTIAL');
    }
    const slot = Number(option[1]);
    const summed = product.options[slot];
    if (!summed) fail(400, 'partial does not match an aggregate option', 'BAD_PARTIAL');
    const ok = verifyPartial({
      partial: { ...row, ballotHash: aggregateOptionId(slot) },
      electionId: election.id,
      index,
      jointPublicKey: ceremony.publicKey,
      expectedY: ceremony.verificationKeys[String(index)],
      ephemeral: summed.c1Hex,
    });
    if (!ok) {
      fail(400, `partial decryption from guardian ${index} is not valid`, 'BAD_PARTIAL');
    }
  }
  await store.saveGuardianPartials(electionId, { index, partials });
  return { index, count: partials.length };
}
