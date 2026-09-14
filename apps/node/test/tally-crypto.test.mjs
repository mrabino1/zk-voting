// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TALLY_CRYPTO_SCHEME,
  countsEqual,
  decryptTallyEnvelope,
  encryptToTallyPub,
  generateDemoGuardian,
  histogramFromOpenings,
  isTallyEnvelope,
  openingIndexFromAnswers,
  packChoices,
  unpackChoices,
} from '../src/tallyCrypto.mjs';

describe('tally demo ECIES', () => {
  test('generate / encrypt / decrypt packed choices', async () => {
    const g = await generateDemoGuardian();
    assert.equal(g.production, false);
    assert.equal(g.threshold, 1);
    assert.equal(g.scheme, TALLY_CRYPTO_SCHEME);
    assert.match(g.publicKeyRaw, /^0x04/);
    const packed = packChoices([0, 2, 1]);
    const env = await encryptToTallyPub(g.publicKeyRaw, packed);
    assert.equal(isTallyEnvelope(env), true);
    const plain = await decryptTallyEnvelope(g.privateJwk, env);
    assert.deepEqual(unpackChoices(plain), [0, 2, 1]);
  });

  test('wrong private key cannot open the envelope', async () => {
    const a = await generateDemoGuardian();
    const b = await generateDemoGuardian();
    const env = await encryptToTallyPub(a.publicKeyRaw, packChoices([1]));
    await assert.rejects(() => decryptTallyEnvelope(b.privateJwk, env));
  });

  test('histogram and invented vector', () => {
    const derived = histogramFromOpenings([0, 0, 1, 0, 2], 3);
    assert.deepEqual(derived, [3, 1, 1]);
    assert.equal(countsEqual(derived, [3, 1, 1]), true);
    assert.equal(countsEqual(derived, [5, 0, 0]), false);
    assert.equal(derived.reduce((s, n) => s + n, 0), 5);
  });

  test('openingIndexFromAnswers uses first question option', () => {
    const questions = [
      {
        id: 'q1',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ];
    assert.equal(openingIndexFromAnswers([{ questionId: 'q1', optionIds: ['no'] }], questions), 1);
    assert.equal(openingIndexFromAnswers([{ questionId: 'q1', optionIds: ['yes'] }], questions), 0);
  });
});
