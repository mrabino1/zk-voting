// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assertBallotAnswers,
  buildBallotObject,
  canonicalQuestionType,
  expectedCountLength,
  normalizeQuestions,
  parseTallyCounts,
  presentTally,
  questionsFromBody,
} from '../src/ballot.mjs';
import { HttpError } from '../src/http.mjs';

function sampleAspects() {
  return [
    {
      id: 'measure',
      type: 'YES_NO',
      prompt: 'Adopt the library hours ordinance?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
    {
      id: 'council',
      type: 'SINGLE_CHOICE',
      prompt: 'City Council at-large',
      options: [
        { id: 'rivera', label: 'Alex Rivera' },
        { id: 'chen', label: 'Morgan Chen' },
        { id: 'okonkwo', label: 'Sam Okonkwo' },
      ],
    },
  ];
}

describe('ballot aspects', () => {
  test('normalizes mixed types and aliases aspects', () => {
    const questions = questionsFromBody({
      aspects: [
        { type: 'yn', prompt: 'Adopt?' },
        {
          type: 'office',
          prompt: 'Mayor',
          options: ['Ada', 'Bob'],
        },
        {
          type: 'MULTI_CHOICE',
          prompt: 'Board',
          maxSelections: 2,
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
          ],
        },
      ],
    });
    assert.equal(questions.length, 3);
    assert.equal(questions[0].type, 'YES_NO');
    assert.equal(questions[0].options.length, 2);
    assert.equal(questions[1].type, 'SINGLE_CHOICE');
    assert.equal(questions[1].options[0].id, 'ada');
    assert.equal(questions[2].maxSelections, 2);
    assert.equal(expectedCountLength(questions), 2 + 2 + 3);
  });

  test('stores RANKED but omits it from the plurality vector', () => {
    const questions = normalizeQuestions([
      { type: 'YES_NO', prompt: 'A?' },
      {
        type: 'RANKED_CHOICE',
        prompt: 'Rank candidates',
        options: ['Ada', 'Bob', 'Cam'],
      },
    ]);
    assert.equal(questions[1].type, 'RANKED');
    assert.equal(canonicalQuestionType('IRV'), 'RANKED');
    assert.equal(expectedCountLength(questions), 2);
  });

  test('rejects empty or duplicate questions', () => {
    assert.throws(() => normalizeQuestions([]), HttpError);
    assert.throws(
      () =>
        normalizeQuestions([
          { id: 'q1', type: 'YES_NO', prompt: 'A' },
          { id: 'q1', type: 'YES_NO', prompt: 'B' },
        ]),
      HttpError,
    );
  });

  test('plurality tally is per-question, not a global sum of every contest', () => {
    const questions = normalizeQuestions(sampleAspects());
    const accepted = 2;
    // Two ballots: Q1 yes/no split, Q2 rivera + chen. Global sum is 4, not 2.
    const flat = parseTallyCounts({ counts: [1, 1, 1, 1, 0] }, questions, accepted);
    assert.deepEqual(flat, [1, 1, 1, 1, 0]);

    const labeled = parseTallyCounts(
      {
        questions: [
          { id: 'measure', counts: [1, 1] },
          { id: 'council', counts: [1, 1, 0] },
        ],
      },
      questions,
      accepted,
    );
    assert.deepEqual(labeled, [1, 1, 1, 1, 0]);

    assert.throws(() => parseTallyCounts({ counts: [3, 0, 0, 0, 0] }, questions, accepted), (err) => {
      assert.equal(err.extra?.code, 'TALLY_MISMATCH');
      return true;
    });
  });

  test('presentTally labels options and undervotes per question', () => {
    const questions = normalizeQuestions(sampleAspects());
    const election = {
      questions,
      acceptedBallots: 2,
      tally: { counts: [2, 0, 1, 0, 0], postedAt: '2026-01-01T00:00:00.000Z' },
    };
    const view = presentTally(election, 2);
    assert.equal(view.questions.length, 2);
    assert.equal(view.questions[0].options[0].label, 'Yes');
    assert.equal(view.questions[0].options[0].count, 2);
    assert.equal(view.questions[0].undervotes, 0);
    assert.equal(view.questions[1].options[0].count, 1);
    assert.equal(view.questions[1].undervotes, 1);
    assert.equal(view.questions[1].prompt, 'City Council at-large');
  });

  test('ballot envelope must cover every aspect', () => {
    const questions = normalizeQuestions(sampleAspects());
    const answers = [
      { questionId: 'measure', optionIds: ['yes'] },
      { questionId: 'council', optionIds: ['chen'] },
    ];
    assertBallotAnswers(questions, answers);
    const ballot = buildBallotObject({
      electionId: 3,
      questions,
      answers,
      markedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(ballot.answers.length, 2);
    assert.equal(ballot.questions.length, 2);
    assert.throws(() => assertBallotAnswers(questions, [answers[0]]), (err) => {
      assert.equal(err.extra?.code, 'BALLOT_INCOMPLETE');
      return true;
    });
  });
});
