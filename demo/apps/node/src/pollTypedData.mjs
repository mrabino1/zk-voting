// NOT FOR PROFIT — civic public good, not a commercial product.
// EIP-712 domain for token polls. The signature proves control of the
// holding address. It is not an identity check and it is not a nullifier.

import { concat, encodeAbiParameters, keccak256, stringToHex } from 'viem';

import { stableStringify } from './ballotSpec.mjs';

export const SIGNAL_LABEL = 'Signal only · non-binding · NOT FOR PROFIT';
export const ABSTAIN_ID = 'abstain';
export const REPUBLIC_CHAIN_ID = 27427n;
export const POLL_SCHEMA = 'republic.auditor.poll.v1';
export const POLL_RECEIPT_SCHEMA = 'republic.receipt.poll.v1';

export const TOKEN_POLL_TYPES = {
  TokenPollBallot: [
    { name: 'pollDomain', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'voter', type: 'address' },
    { name: 'choices', type: 'uint16[]' },
    { name: 'ballotSpecHash', type: 'bytes32' },
    { name: 'republicChainId', type: 'uint256' },
    { name: 'issuedAt', type: 'uint64' },
  ],
};

export function pollDomainOf(nodeId, pollId) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
      ['republic:token-poll:v1', String(nodeId), String(pollId)],
    ),
  );
}

export function tokenPollTypedData({
  tokenChainId,
  pollDomain,
  token,
  voter,
  choiceIndexes,
  ballotSpecHash,
  issuedAt,
}) {
  return {
    domain: {
      name: 'Republic Token Poll',
      version: '1',
      chainId: Number(tokenChainId),
    },
    types: TOKEN_POLL_TYPES,
    primaryType: 'TokenPollBallot',
    message: {
      pollDomain,
      token,
      voter,
      choices: choiceIndexes.map((n) => Number(n)),
      ballotSpecHash,
      republicChainId: REPUBLIC_CHAIN_ID,
      issuedAt: BigInt(issuedAt),
    },
  };
}

export function canonicalPollParams(poll) {
  return {
    title: poll.title,
    options: (poll.options || []).map((o) => ({ id: o.id, label: o.label })),
    includeAbstain: true,
    pollType: poll.pollType,
    token: poll.token,
    tokenChainId: Number(poll.tokenChainId),
    startTime: Number(poll.startTime),
    cutoffTime: Number(poll.cutoffTime),
    quorum: poll.quorum || null,
    passThresholdBps: poll.passThresholdBps == null ? null : Number(poll.passThresholdBps),
    minBallotWeight: String(poll.minBallotWeight),
    privacyMode: 'public_weighted',
    jurisdictionId: String(poll.jurisdictionId),
    ballotSpecHash: poll.ballotSpecHash,
  };
}

export function hashCanonical(value) {
  return keccak256(stringToHex(stableStringify(value)));
}

export function choicesHashOf(choiceIndexes) {
  return hashCanonical(choiceIndexes.map((n) => Number(n)));
}

export function canonicalBallotRow(ballot) {
  return {
    voter: ballot.voter,
    choiceIndexes: ballot.choiceIndexes.map((n) => Number(n)),
    choices: ballot.choices,
    voteBlock: Number(ballot.voteBlock),
    provisionalWeight: String(ballot.provisionalWeight),
    finalWeight: ballot.finalWeight == null ? null : String(ballot.finalWeight),
    status: ballot.status,
    ballotDigest: ballot.ballotDigest,
  };
}

export function merkleRoot(rows) {
  let level = rows.map((row) => hashCanonical(row));
  if (!level.length) return keccak256(stringToHex('republic:token-poll:empty'));
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]];
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(keccak256(concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return level[0];
}

export function ballotsRootOf(ballots) {
  const rows = [...ballots]
    .map(canonicalBallotRow)
    .sort((a, b) => String(a.voter).toLowerCase().localeCompare(String(b.voter).toLowerCase()));
  return merkleRoot(rows);
}

/** Hash the public result. Caller omits resultHash, tallyAt, tallyBy, and l1TxHash. */
export function resultHashOf(publicResult) {
  return hashCanonical(publicResult);
}

export function dec(value) {
  return BigInt(value).toString();
}
