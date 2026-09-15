// NOT FOR PROFIT — civic public good, not a commercial product.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { keccak256, stringToHex } from 'viem';

import {
  canonicalBallotSpec,
  hashBallotSpec,
  normalizeOption,
  normalizeQuestions,
  presentPublicBallotInfo,
  presentPublicOptionInfo,
  publicOption,
  resolveBallotSpecHash,
  stableStringify,
} from '../src/ballotSpec.mjs';
import { HttpError } from '../src/http.mjs';

/** Snapshot of the pre-metadata normalizer so hashes of `{id,label}` stay stable. */
function legacyNormalizeQuestions(input) {
  return input.map((q, i) => ({
    id: String(q.id || `q${i + 1}`),
    type: String(q.type || 'YES_NO'),
    prompt: String(q.prompt || q.title || `Question ${i + 1}`),
    options: Array.isArray(q.options)
      ? q.options.map((o, j) => ({
          id: String(o.id || `o${j + 1}`),
          label: String(o.label || o.name || String(o)),
        }))
      : q.type === 'YES_NO' || !q.type
        ? [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ]
        : [],
  }));
}

function legacyHash(title, questions) {
  return keccak256(stringToHex(stableStringify({ title, questions: legacyNormalizeQuestions(questions) })));
}

describe('ballotSpec normalize + hash', () => {
  test('plain string options become {id,label} and match the legacy hash', () => {
    const input = [
      {
        type: 'YES_NO',
        prompt: 'Shall the measure be adopted?',
        options: ['No', 'Yes'],
      },
    ];
    const canonical = canonicalBallotSpec({ title: 'Demo', questions: input });
    assert.deepEqual(canonical.questions[0].options, [
      { id: 'o1', label: 'No' },
      { id: 'o2', label: 'Yes' },
    ]);
    assert.equal(hashBallotSpec({ title: 'Demo', questions: input }), legacyHash('Demo', input));
  });

  test('{id,label} only does not grow extra keys and keeps the legacy hash', () => {
    const input = [
      {
        id: 'q1',
        type: 'SINGLE_CHOICE',
        prompt: 'Mayor',
        options: [
          { id: 'jane', label: 'Jane Doe' },
          { id: 'alex', label: 'Alex Rivera' },
        ],
      },
    ];
    const opts = normalizeQuestions(input)[0].options;
    assert.deepEqual(Object.keys(opts[0]).sort(), ['id', 'label']);
    assert.equal(hashBallotSpec({ title: 'Mayor race', questions: input }), legacyHash('Mayor race', input));
  });

  test('YES_NO without options still defaults to yes/no', () => {
    const questions = normalizeQuestions([{ type: 'YES_NO', prompt: 'Adopt the measure?' }]);
    assert.deepEqual(questions[0].options, [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ]);
    assert.equal(
      hashBallotSpec({ title: 'Demo general', questions: [{ type: 'YES_NO', prompt: 'Adopt the measure?' }] }),
      legacyHash('Demo general', [{ type: 'YES_NO', prompt: 'Adopt the measure?' }]),
    );
  });

  test('empty summary/body/links are omitted from the hashed object', () => {
    const option = normalizeOption({
      id: 'o1',
      label: 'Jane Doe',
      summary: '  ',
      body: '',
      links: [],
    });
    assert.deepEqual(option, { id: 'o1', label: 'Jane Doe' });
  });

  test('metadata is kept, key order does not change the hash, and body changes the hash', () => {
    const a = {
      title: 'Council',
      questions: [
        {
          id: 'q1',
          type: 'SINGLE_CHOICE',
          prompt: 'City Council',
          options: [
            {
              links: [{ url: 'https://example.org/jane', label: 'Campaign site' }],
              summary: 'Incumbent.',
              label: 'Jane Doe',
              id: 'o1',
              body: 'Served one term.',
            },
          ],
        },
      ],
    };
    const b = {
      title: 'Council',
      questions: [
        {
          prompt: 'City Council',
          type: 'SINGLE_CHOICE',
          id: 'q1',
          options: [
            {
              id: 'o1',
              label: 'Jane Doe',
              summary: 'Incumbent.',
              body: 'Served one term.',
              links: [{ label: 'Campaign site', url: 'https://example.org/jane' }],
            },
          ],
        },
      ],
    };
    const ha = hashBallotSpec(a);
    const hb = hashBallotSpec(b);
    assert.equal(ha, hb);
    const changed = hashBallotSpec({
      ...a,
      questions: [
        {
          ...a.questions[0],
          options: [{ ...a.questions[0].options[0], body: 'Served two terms.' }],
        },
      ],
    });
    assert.notEqual(changed, ha);
  });

  test('javascript: and credentialed URLs are rejected', () => {
    assert.throws(
      () => normalizeOption({ id: 'o1', label: 'x', links: [{ label: 'x', url: 'javascript:alert(1)' }] }),
      (err) => err instanceof HttpError && err.status === 400,
    );
    assert.throws(
      () => normalizeOption({ id: 'o1', label: 'x', imageUrl: 'https://user:pass@evil.example/x.png' }),
      (err) => err instanceof HttpError && err.status === 400,
    );
  });

  test('mismatched client ballotSpecHash is rejected', () => {
    assert.throws(
      () =>
        resolveBallotSpecHash({
          title: 'Demo',
          questions: [{ type: 'YES_NO', prompt: '?' }],
          ballotSpecHash: '0x' + '00'.repeat(32),
        }),
      (err) => err instanceof HttpError && err.extra?.code === 'SPEC_HASH_MISMATCH',
    );
  });

  test('public DTO fills empty metadata and never copies clerk-only fields', () => {
    const election = {
      id: 9,
      title: 'Local',
      jurisdictionId: 'demo',
      startTime: 1,
      cutoffTime: 9,
      ballotSpecHash: '0xabc',
      createdBy: 'clerk-uuid',
      clerkNotes: 'do not publish',
      questions: [
        {
          id: 'q1',
          type: 'SINGLE_CHOICE',
          prompt: 'Council',
          options: ['Pat Lee', { id: 'o2', label: 'Sam Okonkwo', summary: 'Teacher.', secret: 'nope' }],
        },
      ],
    };
    const info = presentPublicBallotInfo(election, 2);
    assert.equal(info.createdBy, undefined);
    assert.equal(info.clerkNotes, undefined);
    assert.equal(info.nfp, true);
    assert.equal(info.questions[0].options[0].label, 'Pat Lee');
    assert.equal(info.questions[0].options[0].summary, '');
    assert.equal(info.questions[0].options[0].links.length, 0);
    assert.equal(info.questions[0].options[1].summary, 'Teacher.');
    assert.equal(info.questions[0].options[1].secret, undefined);
    const one = presentPublicOptionInfo(election, 'q1', 'o2', 2);
    assert.equal(one.option.label, 'Sam Okonkwo');
    assert.equal(one.question.prompt, 'Council');
    assert.equal(presentPublicOptionInfo(election, 'q1', 'missing', 2), null);
  });

  test('publicOption accepts a bare string', () => {
    assert.deepEqual(publicOption('Yes', 0).label, 'Yes');
    assert.equal(publicOption('Yes', 0).id, 'o1');
  });
});
