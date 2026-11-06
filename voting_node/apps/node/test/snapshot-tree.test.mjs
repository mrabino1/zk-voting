// NOT FOR PROFIT — Poseidon snapshot membership. Not a secret ballot.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SNAPSHOT_DEPTH,
  buildSnapshotTree,
  fieldToHex,
  proofForAddress,
  snapshotRootOf,
  verifySnapshotProof,
} from '../src/snapshotTree.mjs';
import { resolveVotingToken, tokenChainAllowed } from '../src/tokenSource.mjs';

describe('poseidon vote snapshot', () => {
  test('an empty tree still has a root and no leaf verifies', () => {
    const tree = buildSnapshotTree([]);
    assert.equal(tree.depth, SNAPSHOT_DEPTH);
    assert.equal(tree.leaves.length, 0);
    const root = fieldToHex(tree.root);
    assert.equal(snapshotRootOf([]), root);
    assert.equal(
      verifySnapshotProof({
        address: '0x0000000000000000000000000000000000000001',
        weight: 1n,
        pathElements: Array(SNAPSHOT_DEPTH).fill('0'),
        pathIndices: Array(SNAPSHOT_DEPTH).fill(0),
        root,
      }),
      false,
    );
  });

  test('a sorted leaf proves, and a forged weight does not', () => {
    const rows = [
      { address: '0x000000000000000000000000000000000000000b', weight: 5n },
      { address: '0x000000000000000000000000000000000000000a', weight: 9n },
    ];
    const proof = proofForAddress(rows, rows[0].address);
    assert.ok(proof);
    assert.equal(proof.weight, '5');
    assert.equal(verifySnapshotProof(proof), true);
    assert.equal(proof.root, snapshotRootOf(rows));
    assert.equal(verifySnapshotProof({ ...proof, weight: '4' }), false);
    const other = proofForAddress(rows, rows[1].address);
    assert.equal(other.index === proof.index, false);
    assert.equal(verifySnapshotProof(other), true);
  });

  test('only Ethereum mainnet is a production token chain', () => {
    assert.equal(tokenChainAllowed(1, { production: true }), true);
    assert.equal(tokenChainAllowed(31337, { production: true }), false);
    assert.equal(tokenChainAllowed(31337, { production: false }), true);
    assert.equal(tokenChainAllowed(10, { production: false }), false);
    assert.equal(tokenChainAllowed(100, { production: false }), false);
    assert.equal(tokenChainAllowed(27427, { production: false }), false);
    const local = resolveVotingToken({
      address: '0x1111111111111111111111111111111111111111',
      chainId: 31337,
      production: false,
    });
    assert.equal(local.configured, true);
    assert.equal(local.chainId, 31337);
    const mainnet = resolveVotingToken({
      address: '0x1111111111111111111111111111111111111111',
      chainId: 10,
      production: false,
    });
    assert.equal(mainnet.configured, false);
    assert.equal(mainnet.reason, 'not_ethereum_l1');
    assert.equal(mainnet.chainId, 1);
  });
});
