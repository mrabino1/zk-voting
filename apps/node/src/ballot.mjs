// NOT FOR PROFIT — civic public good, not a commercial product.
// Multi-question ballots (“aspects”). Plurality tally is per-question.
// Ranked-choice / IRV is stored on the spec but not computed here.

import { hexToString } from 'viem';

import { HttpError } from './http.mjs';

export const QUESTION_TYPES = Object.freeze([
  'YES_NO',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'MEASURE',
  'ARTICLE',
  'RANKED',
]);

const PLURALITY_TYPES = new Set(['YES_NO', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'MEASURE', 'ARTICLE']);

const TYPE_ALIASES = Object.freeze({
  YES_NO: 'YES_NO',
  YN: 'YES_NO',
  REFERENDUM: 'YES_NO',
  SINGLE_CHOICE: 'SINGLE_CHOICE',
  SINGLE: 'SINGLE_CHOICE',
  PLURALITY: 'SINGLE_CHOICE',
  OFFICE: 'SINGLE_CHOICE',
  MULTI_CHOICE: 'MULTI_CHOICE',
  MULTI: 'MULTI_CHOICE',
  MEASURE: 'MEASURE',
  ARTICLE: 'ARTICLE',
  RANKED: 'RANKED',
  RANKED_CHOICE: 'RANKED',
  IRV: 'RANKED',
  RCV: 'RANKED',
});

export const QUESTION_TYPE_LABELS = Object.freeze({
  YES_NO: 'Yes / No',
  SINGLE_CHOICE: 'Single choice',
  MULTI_CHOICE: 'Multi choice',
  MEASURE: 'Measure',
  ARTICLE: 'Article',
  RANKED: 'Ranked choice',
});

function slug(value, fallback) {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

export function canonicalQuestionType(raw) {
  const key = String(raw || 'YES_NO')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return TYPE_ALIASES[key] || null;
}

export function isPluralityType(type) {
  return PLURALITY_TYPES.has(String(type || '').toUpperCase());
}

export function isRankedType(type) {
  return String(type || '').toUpperCase() === 'RANKED';
}

function defaultOptions(type) {
  if (type === 'YES_NO' || type === 'MEASURE' || type === 'ARTICLE') {
    return [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }
  return [];
}

function normalizeOptions(raw, type, index) {
  const source = Array.isArray(raw) ? raw : [];
  const options = source.map((o, j) => {
    if (typeof o === 'string' || typeof o === 'number') {
      return { id: slug(o, `o${j + 1}`), label: String(o) };
    }
    const label = String(o?.label || o?.name || o?.title || o?.id || `Option ${j + 1}`);
    const id = slug(o?.id || o?.value || label, `q${index + 1}-o${j + 1}`);
    return { id, label };
  });
  if (!options.length) return defaultOptions(type);
  const seen = new Set();
  for (const opt of options) {
    if (seen.has(opt.id)) {
      throw new HttpError(400, `duplicate option id "${opt.id}" on question ${index + 1}`);
    }
    seen.add(opt.id);
  }
  return options;
}

/**
 * Canonical ballot questions. Accepts `questions` or `aspects`.
 * RANKED is stored for later IRV work; plurality tally skips it.
 */
export function normalizeQuestions(input) {
  if (input == null) {
    throw new HttpError(400, 'questions required');
  }
  if (!Array.isArray(input)) throw new HttpError(400, 'questions must be an array');
  if (!input.length) throw new HttpError(400, 'at least one question is required');

  const seen = new Set();
  return input.map((q, i) => {
    if (!q || typeof q !== 'object') {
      throw new HttpError(400, `question ${i + 1} must be an object`);
    }
    const type = canonicalQuestionType(q.type || q.kind || q.method);
    if (!type) {
      throw new HttpError(400, `unsupported question type "${q.type || q.kind || ''}"`, {
        code: 'QUESTION_TYPE',
        allowed: QUESTION_TYPES.slice(),
      });
    }
    const options = normalizeOptions(q.options || q.choices, type, i);
    if (options.length < 2) {
      throw new HttpError(400, `question ${i + 1} needs at least two options`);
    }
    let maxSelections = 1;
    if (type === 'MULTI_CHOICE') {
      maxSelections = Number(q.maxSelections ?? q.max ?? 2);
      if (!Number.isInteger(maxSelections) || maxSelections < 1) {
        throw new HttpError(400, `question ${i + 1} maxSelections must be a positive integer`);
      }
      if (maxSelections > options.length) maxSelections = options.length;
    } else if (type === 'RANKED') {
      maxSelections = options.length;
    }
    const id = slug(q.id || q.questionId || q.aspectId, `q${i + 1}`);
    if (seen.has(id)) throw new HttpError(400, `duplicate question id "${id}"`);
    seen.add(id);
    const question = {
      id,
      type,
      prompt: String(q.prompt || q.title || q.text || `Question ${i + 1}`).trim(),
      description: String(q.description || q.help || q.body || '').trim(),
      maxSelections,
      options,
    };
    if (!question.prompt) throw new HttpError(400, `question ${i + 1} needs a prompt`);
    return question;
  });
}

export function questionsFromBody(body) {
  const input = body?.questions ?? body?.aspects ?? body?.ballot?.questions;
  return normalizeQuestions(input);
}

/** Option slots that a plurality tally must fill, in ballot order. Ranked questions omitted. */
export function expectedCountLength(questions) {
  if (!Array.isArray(questions) || !questions.length) return 0;
  return questions.reduce((n, q) => n + (isPluralityType(q.type) ? q.options.length : 0), 0);
}

export function pluralityQuestions(questions) {
  return (questions || []).filter((q) => isPluralityType(q.type));
}

function asNonNegIntArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${label} must be a non-empty array of non-negative integers`);
  }
  const nums = value.map((n) => Number(n));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new HttpError(400, `${label} must be non-negative integers`);
  }
  return nums;
}

function assertPluralitySlice(question, slice, acceptedBallots) {
  if (slice.length !== question.options.length) {
    throw new HttpError(400, `counts length for "${question.id}" must be ${question.options.length}`, {
      code: 'TALLY_LENGTH',
      questionId: question.id,
      expected: question.options.length,
      actual: slice.length,
    });
  }
  const sum = slice.reduce((a, b) => a + b, 0);
  if (question.type === 'MULTI_CHOICE') {
    if (slice.some((n) => n > acceptedBallots)) {
      throw new HttpError(400, `option count on "${question.id}" exceeds acceptedBallots`, {
        code: 'TALLY_MISMATCH',
        questionId: question.id,
        acceptedBallots,
      });
    }
    const cap = question.maxSelections * acceptedBallots;
    if (sum > cap) {
      throw new HttpError(400, `sum(counts) for "${question.id}" exceeds maxSelections × acceptedBallots`, {
        code: 'TALLY_MISMATCH',
        questionId: question.id,
        sum,
        cap,
        acceptedBallots,
      });
    }
    return;
  }
  if (sum > acceptedBallots) {
    throw new HttpError(400, `sum(counts) for "${question.id}" must be <= acceptedBallots`, {
      code: 'TALLY_MISMATCH',
      questionId: question.id,
      sum,
      acceptedBallots,
    });
  }
}

/**
 * Accept either a flat plurality vector or per-question `{ questions: [{ id, counts }] }`.
 * Ranked aspects are skipped (IRV is another path).
 */
export function parseTallyCounts(body, questions, acceptedBallots) {
  const accepted = Number(acceptedBallots) || 0;
  const plurality = pluralityQuestions(questions);
  if (!plurality.length) {
    throw new HttpError(400, 'no plurality questions to tally (ranked-choice / IRV is a separate path)', {
      code: 'NO_PLURALITY',
    });
  }
  const expected = expectedCountLength(questions);

  const labeled = body?.questions || body?.aspects || body?.tally?.questions;
  if (Array.isArray(labeled) && labeled.length) {
    const byId = new Map();
    for (const row of labeled) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.questionId || row.id || '');
      if (!id) continue;
      if (isRankedType(row.type)) continue;
      byId.set(id, asNonNegIntArray(row.counts, `counts for ${id}`));
    }
    const flat = [];
    for (const q of plurality) {
      const slice = byId.get(q.id);
      if (!slice) {
        throw new HttpError(400, `missing counts for question "${q.id}"`, { code: 'TALLY_LENGTH', questionId: q.id });
      }
      assertPluralitySlice(q, slice, accepted);
      flat.push(...slice);
    }
    return flat;
  }

  const counts = asNonNegIntArray(body?.counts, 'counts');
  if (counts.length !== expected) {
    throw new HttpError(400, `counts length must be ${expected} (concatenated plurality options)`, {
      code: 'TALLY_LENGTH',
      expected,
      actual: counts.length,
    });
  }
  let offset = 0;
  for (const q of plurality) {
    const slice = counts.slice(offset, offset + q.options.length);
    assertPluralitySlice(q, slice, accepted);
    offset += q.options.length;
  }
  return counts;
}

export function presentTally(election, acceptedBallots) {
  if (!election?.tally) return null;
  const accepted =
    typeof acceptedBallots === 'number' ? acceptedBallots : Number(election.acceptedBallots) || 0;
  const questions = Array.isArray(election.questions) ? election.questions : [];
  const flat = Array.isArray(election.tally.counts) ? election.tally.counts.map((n) => Number(n)) : [];
  let offset = 0;
  const labeled = questions.map((q, index) => {
    const base = {
      index,
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      description: q.description || '',
      maxSelections: q.maxSelections,
    };
    if (isRankedType(q.type)) {
      return {
        ...base,
        tallyMethod: 'irv',
        tallied: false,
        note: 'Ranked-choice / IRV is not computed on this Node path.',
        counts: [],
        undervotes: null,
        options: (q.options || []).map((o) => ({ id: o.id, label: o.label, count: null })),
      };
    }
    const n = q.options.length;
    const slice = flat.slice(offset, offset + n);
    offset += n;
    const sum = slice.reduce((a, b) => a + b, 0);
    const undervotes = q.type === 'MULTI_CHOICE' ? null : Math.max(0, accepted - sum);
    return {
      ...base,
      tallyMethod: 'plurality',
      tallied: true,
      counts: slice,
      undervotes,
      options: q.options.map((o, i) => ({
        id: o.id,
        label: o.label,
        count: Number(slice[i]) || 0,
      })),
    };
  });
  return {
    counts: flat,
    questions: labeled,
    postedAt: election.tally.postedAt,
  };
}

export function presentAspects(election) {
  const questions = Array.isArray(election?.questions) ? election.questions : [];
  return questions.map((q, index) => ({
    index,
    id: q.id,
    type: q.type,
    typeLabel: QUESTION_TYPE_LABELS[q.type] || q.type,
    prompt: q.prompt,
    description: q.description || '',
    maxSelections: q.maxSelections,
    options: (q.options || []).map((o) => ({ id: o.id, label: o.label })),
    rankedChoice: isRankedType(q.type),
  }));
}

function optionIdSet(question) {
  return new Set((question.options || []).map((o) => o.id));
}

/**
 * Every aspect must appear once. Blank optionIds is an undervote.
 * RANKED answers are sealed in the envelope; this Node does not run IRV.
 */
export function assertBallotAnswers(questions, answers) {
  if (!Array.isArray(answers)) {
    throw new HttpError(400, 'answers must be an array covering every question', { code: 'BALLOT_INCOMPLETE' });
  }
  if (answers.length !== questions.length) {
    throw new HttpError(400, 'ballot envelope must include an answer for every aspect', {
      code: 'BALLOT_INCOMPLETE',
      expected: questions.length,
      actual: answers.length,
    });
  }
  const seen = new Set();
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const row = answers[i];
    if (!row || typeof row !== 'object') {
      throw new HttpError(400, `answer missing for question "${q.id}"`, { code: 'BALLOT_INCOMPLETE' });
    }
    const qid = String(row.questionId || row.id || '');
    if (qid && qid !== q.id) {
      throw new HttpError(400, `answer[${i}] questionId must be "${q.id}"`, { code: 'BALLOT_INCOMPLETE' });
    }
    if (seen.has(q.id)) {
      throw new HttpError(400, `duplicate answer for question "${q.id}"`, { code: 'BALLOT_INCOMPLETE' });
    }
    seen.add(q.id);
    const optionIds = Array.isArray(row.optionIds)
      ? row.optionIds.map((x) => String(x))
      : row.optionId != null && row.optionId !== ''
        ? [String(row.optionId)]
        : [];
    const allowed = optionIdSet(q);
    for (const oid of optionIds) {
      if (!allowed.has(oid)) {
        throw new HttpError(400, `unknown option "${oid}" on question "${q.id}"`, { code: 'BALLOT_OPTION' });
      }
    }
    if (new Set(optionIds).size !== optionIds.length) {
      throw new HttpError(400, `duplicate options on question "${q.id}"`, { code: 'BALLOT_OPTION' });
    }
    if (optionIds.length > q.maxSelections) {
      throw new HttpError(400, `question "${q.id}" allows at most ${q.maxSelections} selections`, {
        code: 'BALLOT_OPTION',
      });
    }
  }
}

export function decodeBallotEnvelope(encryptedBallot) {
  if (encryptedBallot == null || encryptedBallot === '') return null;
  let text = null;
  if (typeof encryptedBallot === 'string' && encryptedBallot.startsWith('0x')) {
    try {
      text = hexToString(encryptedBallot);
    } catch {
      return null;
    }
  } else if (typeof encryptedBallot === 'string') {
    text = encryptedBallot;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function answersFromVoteBody(body, encryptedBallot) {
  if (Array.isArray(body?.answers)) return body.answers;
  if (Array.isArray(body?.ballot?.answers)) return body.ballot.answers;
  const decoded = decodeBallotEnvelope(encryptedBallot);
  if (Array.isArray(decoded?.answers)) return decoded.answers;
  return null;
}

export function buildBallotObject({ electionId, ballotSpecHash, questions, answers, markedAt }) {
  return {
    electionId: String(electionId),
    ballotSpecHash: ballotSpecHash || null,
    questions: (questions || []).map((q) => ({ id: q.id, type: q.type })),
    answers,
    markedAt: markedAt || new Date().toISOString(),
  };
}
