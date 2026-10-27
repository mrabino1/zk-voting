// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { allowVoteFields, publicFieldsForTx } from '../sequencer/state.mjs';

describe('L2 vote allowlist', () => {
  test('a vote drops the identity commitment and refuses answers', () => {
    assert.throws(
      () =>
        allowVoteFields({
          type: 'vote',
          electionId: '7',
          nullifier: '0x1',
          ballotHash: '0x2',
          identityCommitment: '0xabc',
        }),
      /identityCommitment/,
    );
    assert.throws(
      () => allowVoteFields({ type: 'vote', electionId: '7', nullifier: '0x1', answers: [{ ranking: ['a'] }] }),
      /answers/,
    );
    const clean = allowVoteFields({
      type: 'vote',
      electionId: '7',
      nullifier: '0x1',
      ballotHash: '0x2',
      sender: '0x1111111111111111111111111111111111111111',
      note: 'drop me',
    });
    assert.equal(clean.sender, undefined);
    assert.equal(clean.note, undefined);
    assert.equal(clean.electionId, '7');
    assert.equal(clean.nullifier, '0x1');
    const view = publicFieldsForTx({
      hash: '0xab',
      civic: { type: 'vote', electionId: '7', nullifier: '0x1', identityCommitment: '0xabc' },
    });
    assert.equal(view.identityCommitment, undefined);
    assert.equal(view.nullifier != null, true);
  });
});
