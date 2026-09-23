// NOT FOR PROFIT — civic public good, not a commercial product.
// Vote public inputs are the 5-signal instance:
// [eligibleRoot, disqRoot, nullifier, ballotHash, electionId].

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import proofHelpers from '@zk-voting/proof-helpers';

import { buildVoteRequestBody, mockVotePublicInputs } from '../public/vote.js';
import { HttpError, stripBallotPii } from '../src/http.mjs';
import { ZERO } from '../src/merkle.mjs';
import { hashBallot, parseVoteBody, VOTE_PUBLIC_INPUT_COUNT } from '../src/relay.mjs';

const { parsePublicInputs, publicInputsToHex, serializePublicInputs } = proofHelpers;

const ROOT = `0x${'11'.repeat(32)}`;
const DISQ = `0x${'22'.repeat(32)}`;
const NULLIFIER = `0x${'33'.repeat(32)}`;
const BALLOT = `0x${'44'.repeat(32)}`;
const ELECTION_ID = 7;
const ENCRYPTED = '0xc0ffee';

function spaBody(publicInputs) {
  return {
    nullifier: NULLIFIER,
    ballotHash: BALLOT,
    encryptedBallot: ENCRYPTED,
    proof: {
      mock: true,
      a: ['0x0', '0x0'],
      b: [
        ['0x0', '0x0'],
        ['0x0', '0x0'],
      ],
      c: ['0x0', '0x0'],
      publicInputs,
    },
  };
}

describe('vote public inputs (5-signal)', () => {
  test('proof-helpers serialize to [root, disqRoot, nullifier, ballotHash, electionId]', () => {
    const serialized = serializePublicInputs({
      root: ROOT,
      disqRoot: DISQ,
      nullifier: NULLIFIER,
      ballotHash: BALLOT,
      electionId: ELECTION_ID,
    });
    assert.equal(serialized.length, 5);
    assert.equal(VOTE_PUBLIC_INPUT_COUNT, 5);
    const parsed = parsePublicInputs(serialized);
    assert.equal(parsed.root, BigInt(ROOT));
    assert.equal(parsed.disqRoot, BigInt(DISQ));
    assert.equal(parsed.nullifier, BigInt(NULLIFIER));
    assert.equal(parsed.ballotHash, BigInt(BALLOT));
    assert.equal(parsed.electionId, BigInt(ELECTION_ID));
  });

  test('SPA mock builder emits five inputs including disqRoot', () => {
    const inputs = mockVotePublicInputs({
      eligibleRoot: ROOT,
      disqRoot: DISQ,
      nullifier: NULLIFIER,
      ballotHash: BALLOT,
      electionId: ELECTION_ID,
    });
    assert.deepEqual(inputs, [ROOT, DISQ, NULLIFIER, BALLOT, String(ELECTION_ID)]);
    const parsed = parsePublicInputs(inputs);
    assert.equal(parsed.disqRoot, BigInt(DISQ));
    assert.equal(parsed.nullifier, BigInt(NULLIFIER));
  });

  test('SPA mock builder defaults missing roots to zero', () => {
    const inputs = mockVotePublicInputs({
      nullifier: NULLIFIER,
      ballotHash: BALLOT,
      electionId: '9',
    });
    assert.equal(inputs[0], ZERO);
    assert.equal(inputs[1], ZERO);
    assert.equal(inputs.length, 5);
  });

  test('parseVoteBody accepts the SPA 5-signal array', () => {
    const inputs = mockVotePublicInputs({
      eligibleRoot: ROOT,
      disqRoot: DISQ,
      nullifier: NULLIFIER,
      ballotHash: BALLOT,
      electionId: ELECTION_ID,
    });
    const parsed = parseVoteBody(spaBody(inputs), ELECTION_ID);
    assert.equal(parsed.root, ROOT);
    assert.equal(parsed.disqRoot, DISQ);
    assert.equal(parsed.nullifier, NULLIFIER);
    assert.equal(parsed.ballotHash, BALLOT);
    const named = parsePublicInputs([
      parsed.root,
      parsed.disqRoot,
      parsed.nullifier,
      parsed.ballotHash,
      ELECTION_ID,
    ]);
    assert.equal(named.disqRoot, BigInt(DISQ));
    assert.equal(named.electionId, BigInt(ELECTION_ID));
  });

  test('parseVoteBody rejects a 4-signal array so nullifier is not read as disqRoot', () => {
    assert.throws(
      () =>
        parseVoteBody(
          spaBody([ROOT, NULLIFIER, BALLOT, String(ELECTION_ID)]),
          ELECTION_ID,
        ),
      (err) => {
        assert.equal(err instanceof HttpError, true);
        assert.equal(err.status, 400);
        assert.equal(err.extra.code, 'INVALID_PUBLIC_INPUTS');
        return true;
      },
    );
  });

  test('object publicInputs fill disqRoot from the live election when omitted', () => {
    const parsed = parseVoteBody(
      {
        proof: { accept: true },
        publicInputs: { nullifier: '99', electionId: ELECTION_ID, root: ROOT },
        encryptedBallot: ENCRYPTED,
      },
      ELECTION_ID,
      { root: ROOT, disqRoot: DISQ },
    );
    assert.equal(parsed.root, ROOT);
    assert.equal(parsed.disqRoot, DISQ);
    assert.equal(parsed.nullifier, '99');
    assert.equal(parsed.ballotHash, hashBallot(ENCRYPTED));
    const named = parsePublicInputs(
      publicInputsToHex({
        root: parsed.root,
        disqRoot: parsed.disqRoot,
        nullifier: parsed.nullifier,
        ballotHash: parsed.ballotHash,
        electionId: ELECTION_ID,
      }),
    );
    assert.equal(named.nullifier, 99n);
    assert.equal(named.disqRoot, BigInt(DISQ));
  });

  test('vote envelope drops plaintext answers, leaf, and wallet identifiers', () => {
    const body = buildVoteRequestBody({
      electionId: 7,
      nullifier: NULLIFIER,
      ballotHash: BALLOT,
      encryptedBallot: ENCRYPTED,
      pinToken: 'pin-1',
      userOpHash: '0x' + 'ab'.repeat(32),
      proof: { mock: true, publicInputs: [ROOT, DISQ, NULLIFIER, BALLOT, String(ELECTION_ID)] },
      answers: [{ optionIds: ['yes'] }],
      identityCommitment: '0xabc',
      address: '0x1111111111111111111111111111111111111111',
      credentialId: 'cred',
    });
    assert.deepEqual(Object.keys(body).sort(), [
      'ballotHash',
      'electionId',
      'encryptedBallot',
      'nullifier',
      'pinToken',
      'proof',
      'userOpHash',
    ]);
    assert.equal(body.answers, undefined);
    assert.equal(body.identityCommitment, undefined);
    assert.equal(body.address, undefined);
    assert.equal(body.credentialId, undefined);

    const stripped = stripBallotPii({
      ...body,
      answers: [{ optionIds: ['yes'] }],
      identityCommitment: '0xabc',
      address: '0x1111111111111111111111111111111111111111',
      credentialId: 'cred',
      choice: 1,
      userId: 'user-1',
      userOp: { sender: '0x1111111111111111111111111111111111111111', hash: '0x' + 'cd'.repeat(32) },
      proof: { ...body.proof, answers: ['yes'], userId: 'user-1' },
    });
    assert.equal(stripped.answers, undefined);
    assert.equal(stripped.identityCommitment, undefined);
    assert.equal(stripped.address, undefined);
    assert.equal(stripped.credentialId, undefined);
    assert.equal(stripped.choice, undefined);
    assert.equal(stripped.userId, undefined);
    assert.equal(stripped.userOp.sender, undefined);
    assert.equal(stripped.userOp.hash, '0x' + 'cd'.repeat(32));
    assert.equal(stripped.proof.answers, undefined);
    assert.equal(stripped.proof.userId, undefined);
    assert.equal(stripped.pinToken, 'pin-1');
    assert.equal(stripped.encryptedBallot, ENCRYPTED);
    assert.deepEqual(stripped.proof.publicInputs, body.proof.publicInputs);
  });

  test('object publicInputs leave omitted disqRoot unset so the relay can bind the election root', () => {
    const parsed = parseVoteBody(
      {
        proof: { accept: true },
        publicInputs: { nullifier: 1, electionId: ELECTION_ID },
        encryptedBallot: ENCRYPTED,
      },
      ELECTION_ID,
    );
    assert.equal(parsed.disqRoot, undefined);
    assert.equal(parsed.root, undefined);
  });
});
