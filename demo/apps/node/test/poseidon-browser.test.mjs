// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { poseidonHashLeftRight as browserPoseidon } from '../public/poseidon.js';
import helpers from '@zk-voting/proof-helpers';

const { poseidonHashLeftRight: helperPoseidon } = helpers;

const CIRCOMLIB_1_2 = 7853200120776062878684798364095072458815029376092732009249414926327459813530n;

describe('browser poseidon matches the vote-circuit helper', () => {
  test('Poseidon(1, 2) is the circomlib vector', () => {
    assert.equal(browserPoseidon(1n, 2n), CIRCOMLIB_1_2);
    assert.equal(browserPoseidon(1n, 2n), helperPoseidon(1n, 2n));
    assert.equal(browserPoseidon(0n, 0n), helperPoseidon(0n, 0n));
    assert.equal(browserPoseidon(2n, 3n), helperPoseidon(2n, 3n));
  });
});
