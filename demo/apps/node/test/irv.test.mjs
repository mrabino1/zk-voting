// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeIrv, firstRoundCounts, hasMajority } from '../src/irv.mjs';
import {
  normalizeBallotMethod,
  normalizeQuestions,
  parseRanking,
  validateBallotAnswers,
  extractRankingPayload,
  tallyBallots,
} from '../src/ballot.mjs';
import { HttpError } from '../src/http.mjs';

describe('IRV winner computation', () => {
  test('majority is strict (> 50% of continuing)', () => {
    assert.equal(hasMajority(2, 4), false);
    assert.equal(hasMajority(3, 5), true);
  });

  test('majority in the first round', () => {
    const result = computeIrv(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['a'],
        ['b', 'a'],
      ],
    );
    assert.equal(result.winner, 'a');
    assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].counts.a, 3);
    assert.equal(result.rounds[0].eliminated, null);
  });

  test('eliminates last place and transfers (5-4-3)', () => {
    const ballots = [
      ...Array(5).fill(['a', 'b', 'c']),
      ...Array(4).fill(['b', 'c', 'a']),
      ...Array(3).fill(['c', 'a', 'b']),
    ];
    const result = computeIrv(['a', 'b', 'c'], ballots);
    assert.equal(result.winner, 'a');
    assert.equal(result.rounds.length, 2);
    assert.equal(result.rounds[0].eliminated, 'c');
    assert.equal(result.rounds[0].counts.a, 5);
    assert.equal(result.rounds[0].counts.b, 4);
    assert.equal(result.rounds[0].counts.c, 3);
    assert.equal(result.rounds[1].counts.a, 8);
    assert.equal(result.rounds[1].counts.b, 4);
    assert.equal(result.rounds[1].winner, 'a');
  });

  test('exhausted ballots drop out of the majority denominator', () => {
    const result = computeIrv(
      ['a', 'b', 'c'],
      [
        ['a'],
        ['a'],
        ['a'],
        ['b', 'a'],
        ['b', 'a'],
        ['c'],
      ],
    );
    assert.equal(result.rounds[0].eliminated, 'c');
    assert.equal(result.rounds[0].counts.c, 1);
    assert.equal(result.rounds[1].exhausted, 1);
    assert.equal(result.rounds[1].continuing, 5);
    assert.equal(result.rounds[1].counts.a, 3);
    assert.equal(result.winner, 'a');
  });

  test('last-place ties eliminate the lexicographically last id', () => {
    const result = computeIrv(
      ['a', 'b', 'c'],
      [
        ['a'],
        ['a'],
        ['a'],
        ['b'],
        ['b'],
        ['c', 'b'],
        ['c', 'b'],
      ],
    );
    assert.equal(result.rounds[0].counts.a, 3);
    assert.equal(result.rounds[0].counts.b, 2);
    assert.equal(result.rounds[0].counts.c, 2);
    assert.equal(result.rounds[0].eliminated, 'c');
    assert.equal(result.winner, 'b');
    assert.equal(result.rounds.at(-1).counts.b, 4);
  });

  test('first-round counts ignore exhausted undervotes', () => {
    const { counts, exhausted } = firstRoundCounts(
      ['a', 'b'],
      [['a'], [], ['b', 'a'], ['nope']],
    );
    assert.deepEqual(counts, [1, 1]);
    assert.equal(exhausted, 2);
  });
});

describe('ranking ballot validation', () => {
  const election = {
    ballotMethod: 'ranked_choice',
    questions: normalizeQuestions(
      [
        {
          id: 'q-office',
          type: 'RANKED',
          prompt: 'City council',
          options: [
            { id: 'a', label: 'Alex' },
            { id: 'b', label: 'Blair' },
            { id: 'c', label: 'Casey' },
          ],
        },
      ],
      'ranked_choice',
    ),
  };

  test('accepts an ordered ranking and a ranks map', () => {
    assert.deepEqual(parseRanking({ ranking: ['b', 'a'] }, election.questions[0]), ['b', 'a']);
    assert.deepEqual(parseRanking({ ranks: { c: 1, a: 2 } }, election.questions[0]), ['c', 'a']);
  });

  test('rejects duplicate and unknown options', () => {
    assert.throws(() => parseRanking({ ranking: ['a', 'a'] }, election.questions[0]), HttpError);
    assert.throws(() => parseRanking({ ranking: ['z'] }, election.questions[0]), HttpError);
    assert.throws(() => parseRanking({ ranks: { a: 1, b: 1 } }, election.questions[0]), HttpError);
  });

  test('empty ranking is an undervote', () => {
    const payload = validateBallotAnswers(election, [{ questionId: 'q-office', ranking: [] }]);
    assert.deepEqual(payload[0].ranking, []);
  });

  test('extractRankingPayload reads rankings from ciphertext, not plaintext answers', () => {
    assert.equal(
      extractRankingPayload(
        election,
        { answers: [{ questionId: 'q-office', ranking: ['a'] }], identityCommitment: '0x1' },
        '0xc0ffee',
      ),
      null,
    );
    const hex = '0x' + Buffer.from(JSON.stringify({ answers: [{ questionId: 'q-office', ranking: ['a', 'c'] }] }), 'utf8').toString('hex');
    const payload = extractRankingPayload(election, { answers: [{ questionId: 'q-office', ranking: ['b'] }] }, hex);
    assert.deepEqual(payload[0].ranking, ['a', 'c']);
  });

  test('plurality default does not require answers', () => {
    const plurality = {
      ballotMethod: 'plurality',
      questions: normalizeQuestions([{ type: 'YES_NO', prompt: '?' }], 'plurality'),
    };
    assert.equal(extractRankingPayload(plurality, {}, '0xab'), null);
    assert.equal(normalizeBallotMethod(undefined), 'plurality');
  });

  test('tallyBallots stores winner plus round transcript', () => {
    const ballots = [
      [{ questionId: 'q-office', ranking: ['a', 'b', 'c'] }],
      [{ questionId: 'q-office', ranking: ['a', 'b', 'c'] }],
      [{ questionId: 'q-office', ranking: ['a', 'b', 'c'] }],
      [{ questionId: 'q-office', ranking: ['a', 'b', 'c'] }],
      [{ questionId: 'q-office', ranking: ['a', 'b', 'c'] }],
      [{ questionId: 'q-office', ranking: ['b', 'c', 'a'] }],
      [{ questionId: 'q-office', ranking: ['b', 'c', 'a'] }],
      [{ questionId: 'q-office', ranking: ['b', 'c', 'a'] }],
      [{ questionId: 'q-office', ranking: ['b', 'c', 'a'] }],
      [{ questionId: 'q-office', ranking: ['c', 'a', 'b'] }],
      [{ questionId: 'q-office', ranking: ['c', 'a', 'b'] }],
      [{ questionId: 'q-office', ranking: ['c', 'a', 'b'] }],
    ];
    const tally = tallyBallots(election, ballots);
    assert.equal(tally.ballotMethod, 'ranked_choice');
    assert.deepEqual(tally.counts, [5, 4, 3]);
    assert.equal(tally.questions[0].winner, 'a');
    assert.equal(tally.questions[0].rounds[0].eliminated, 'c');
  });
});
