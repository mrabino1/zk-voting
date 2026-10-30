// NOT FOR PROFIT — civic public good, not a commercial product.
// Multi-question ballots (“aspects”). Plurality tally is per-question.
// Ranked-choice / IRV is computed on this Node from accepted ranking envelopes.

import { hexToString } from 'viem';

import { HttpError } from './http.mjs';
import { ciphertextForTally } from './tallyOpen.mjs';
import { computeIrv, firstRoundCounts } from './irv.mjs';

export const BALLOT_METHODS = Object.freeze(['plurality', 'ranked_choice']);

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

/**
 * @param {unknown} value
 * @returns {'plurality'|'ranked_choice'}
 */
export function normalizeBallotMethod(value) {
  if (value == null || value === '') return 'plurality';
  const raw = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'plurality' || raw === 'fptp' || raw === 'first_past_the_post') return 'plurality';
  if (
    raw === 'ranked_choice' ||
    raw === 'ranked' ||
    raw === 'irv' ||
    raw === 'rcv' ||
    raw === 'instant_runoff'
  ) {
    return 'ranked_choice';
  }
  throw new HttpError(400, 'ballotMethod must be plurality or ranked_choice', { code: 'BALLOT_METHOD' });
}

/**
 * @param {object} question
 * @param {'plurality'|'ranked_choice'} [electionMethod]
 * @returns {'plurality'|'ranked_choice'}
 */
export function questionBallotMethod(question, electionMethod = 'plurality') {
  if (question?.ballotMethod != null && question.ballotMethod !== '') {
    return normalizeBallotMethod(question.ballotMethod);
  }
  const type = String(question?.type || '').toUpperCase();
  if (type === 'RANKED') return 'ranked_choice';
  if (type === 'YES_NO' || type === 'MULTI_CHOICE') return 'plurality';
  if (type === 'SINGLE_CHOICE' || type === 'MEASURE' || type === 'ARTICLE') {
    return normalizeBallotMethod(electionMethod);
  }
  return 'plurality';
}

export function isRankedQuestion(question, electionMethod = 'plurality') {
  return questionBallotMethod(question, electionMethod) === 'ranked_choice';
}

export function electionHasRanked(election) {
  const method = normalizeBallotMethod(election?.ballotMethod || 'plurality');
  return (election?.questions || []).some((q) => isRankedQuestion(q, method));
}

/** Attach `ballotMethod: "ranked_choice"` only on IRV questions (hash-safe elsewhere). */
export function withQuestionMethods(questions, electionMethod = 'plurality') {
  const method = normalizeBallotMethod(electionMethod);
  return (questions || []).map((q) => {
    if (!q || typeof q !== 'object') return q;
    const qMethod = questionBallotMethod(q, method);
    if (qMethod === 'ranked_choice') return { ...q, ballotMethod: 'ranked_choice' };
    if (q.ballotMethod == null) return q;
    const { ballotMethod: _ignored, ...rest } = q;
    return rest;
  });
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
 * RANKED questions are counted with IRV; plurality tally skips them in the L1 vector.
 *
 * @param {unknown} input
 * @param {'plurality'|'ranked_choice'|string} [electionMethod]
 */
export function normalizeQuestions(input, electionMethod = 'plurality') {
  if (input == null) {
    throw new HttpError(400, 'questions required');
  }
  if (!Array.isArray(input)) throw new HttpError(400, 'questions must be an array');
  if (!input.length) throw new HttpError(400, 'at least one question is required');

  const method = normalizeBallotMethod(electionMethod);
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
    if (isRankedQuestion(question, method)) question.ballotMethod = 'ranked_choice';
    return question;
  });
}

export function questionsFromBody(body, electionMethod = 'plurality') {
  const input = body?.questions ?? body?.aspects ?? body?.ballot?.questions;
  return normalizeQuestions(input, electionMethod);
}

/** Option slots that a plurality tally must fill, in ballot order. Ranked questions omitted. */
export function expectedCountLength(questions, electionMethod = 'plurality') {
  if (!Array.isArray(questions) || !questions.length) return 0;
  return pluralityQuestions(questions, electionMethod).reduce((n, q) => n + q.options.length, 0);
}

export function pluralityQuestions(questions, electionMethod = 'plurality') {
  const method = normalizeBallotMethod(electionMethod);
  return (questions || []).filter((q) => isPluralityType(q.type) && !isRankedQuestion(q, method));
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
export function parseTallyCounts(body, questions, acceptedBallots, electionMethod = 'plurality') {
  const accepted = Number(acceptedBallots) || 0;
  const plurality = pluralityQuestions(questions, electionMethod);
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
    if (isRankedType(q.type) || isRankedQuestion(q, election?.ballotMethod || 'plurality')) {
      const stored = Array.isArray(election.tally.questions)
        ? election.tally.questions.find(
            (row) => String(row.questionId || row.id) === String(q.id),
          )
        : null;
      const computed =
        stored &&
        (stored.tallied === true ||
          stored.winner != null ||
          Array.isArray(stored.rounds));
      if (computed) {
        const first = stored.rounds?.[0]?.counts || null;
        return {
          ...base,
          tallyMethod: 'irv',
          ballotMethod: 'ranked_choice',
          tallied: true,
          winner: stored.winner ?? null,
          winnerLabel: stored.winnerLabel || stored.winner || null,
          exhausted: stored.exhausted ?? null,
          tieBroken: Boolean(stored.tieBroken),
          rounds: stored.rounds || [],
          counts: Array.isArray(stored.counts) ? stored.counts : [],
          undervotes: stored.exhausted ?? null,
          options: (q.options || []).map((o) => ({
            id: o.id,
            label: o.label,
            count: first ? Number(first[o.id]) || 0 : null,
          })),
        };
      }
      return {
        ...base,
        tallyMethod: 'irv',
        ballotMethod: 'ranked_choice',
        tallied: false,
        note: 'Ranked-choice / IRV was not computed for this question.',
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
      ballotMethod: 'plurality',
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
    countsHash: election.tally.countsHash || null,
    l1: election.tally.l1 || null,
    ballotMethod: election.tally.ballotMethod || election.ballotMethod || 'plurality',
    ...(election.tally.excluded?.count
      ? { excluded: { count: election.tally.excluded.count, reasons: election.tally.excluded.reasons || [] } }
      : {}),
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
    rankedChoice: isRankedType(q.type) || q.ballotMethod === 'ranked_choice',
    ballotMethod: q.ballotMethod || (isRankedType(q.type) ? 'ranked_choice' : 'plurality'),
  }));
}

function optionIdSet(question) {
  return new Set((question.options || []).map((o) => String(o.id)));
}

/**
 * Normalize one ranked answer to an ordered unique option-id list.
 * @param {object} answer
 * @param {object} question
 * @returns {string[]}
 */
export function parseRanking(answer, question) {
  const allowed = optionIdSet(question);
  if (!answer || typeof answer !== 'object') return [];
  let ids = [];
  if (Array.isArray(answer.ranking)) {
    ids = answer.ranking.map((id) => String(id));
  } else if (answer.ranks && typeof answer.ranks === 'object' && !Array.isArray(answer.ranks)) {
    const entries = Object.entries(answer.ranks).map(([id, rank]) => ({
      id: String(id),
      rank: Number(rank),
    }));
    if (entries.some((e) => !Number.isInteger(e.rank) || e.rank < 1)) {
      throw new HttpError(400, 'ranks must be positive integers', { code: 'RANKING_INVALID' });
    }
    const seenRank = new Set();
    for (const e of entries) {
      if (seenRank.has(e.rank)) {
        throw new HttpError(400, 'duplicate rank number', { code: 'RANKING_INVALID' });
      }
      seenRank.add(e.rank);
    }
    entries.sort((a, b) => a.rank - b.rank);
    ids = entries.map((e) => e.id);
  } else if (Array.isArray(answer.optionIds)) {
    ids = answer.optionIds.map((id) => String(id));
  } else if (answer.optionId != null && answer.optionId !== '') {
    ids = [String(answer.optionId)];
  }
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!id) continue;
    if (!allowed.has(id)) {
      throw new HttpError(400, `unknown option ${id} on question ${question.id}`, { code: 'RANKING_INVALID' });
    }
    if (seen.has(id)) {
      throw new HttpError(400, `duplicate ranking for option ${id} on question ${question.id}`, {
        code: 'RANKING_INVALID',
      });
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Every aspect must appear once. Blank optionIds / ranking is an undervote.
 * RANKED answers may use `ranking`, `ranks`, or ordered `optionIds`.
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
    if (isRankedType(q.type) || isRankedQuestion(q)) {
      parseRanking(row, q);
      continue;
    }
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

/**
 * Rankings used for a JSON-demo envelope. Plaintext `answers` on the vote
 * body are ignored so the Node does not join a choice field to the request.
 * A ciphertext that is still UTF-8 JSON (or hex of that JSON) can be decoded.
 */
export function answersFromVoteBody(_body, encryptedBallot) {
  const decoded = decodeBallotEnvelope(encryptedBallot);
  if (Array.isArray(decoded?.answers)) return decoded.answers;
  if (Array.isArray(decoded)) return decoded;
  return null;
}

export const extractAnswers = answersFromVoteBody;
export const decodeBallotJson = decodeBallotEnvelope;

function parsePluralityOptionIds(answer, question) {
  const allowed = optionIdSet(question);
  const ids = Array.isArray(answer?.optionIds)
    ? answer.optionIds.map((id) => String(id))
    : answer?.optionId != null && answer.optionId !== ''
      ? [String(answer.optionId)]
      : [];
  const unique = [];
  const seen = new Set();
  for (const id of ids) {
    if (!id) continue;
    if (!allowed.has(id)) {
      throw new HttpError(400, `unknown option ${id} on question ${question.id}`, { code: 'CHOICE_INVALID' });
    }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const max = Number(question.maxSelections) || 1;
  if (unique.length > max) {
    throw new HttpError(400, `too many options on question ${question.id}`, { code: 'CHOICE_INVALID' });
  }
  return unique;
}

/**
 * Validate answers against the ballot spec. Ranked questions may be blank
 * (undervote). Returns a compact payload stored on the operator envelope.
 *
 * @param {object} election
 * @param {object[]} answers
 */
export function validateBallotAnswers(election, answers) {
  const method = normalizeBallotMethod(election.ballotMethod || 'plurality');
  const questions = election.questions || [];
  if (!Array.isArray(answers)) {
    throw new HttpError(400, 'answers must be an array', { code: 'RANKING_INVALID' });
  }
  const byId = new Map(questions.map((q) => [String(q.id), q]));
  const payload = [];
  for (const question of questions) {
    const found =
      answers.find((a) => a && String(a.questionId || a.id) === String(question.id)) || null;
    if (isRankedQuestion(question, method)) {
      payload.push({
        questionId: question.id,
        ranking: found ? parseRanking(found, question) : [],
      });
    } else if (found) {
      payload.push({
        questionId: question.id,
        optionIds: parsePluralityOptionIds(found, question),
      });
    }
  }
  for (const answer of answers) {
    const qid = answer && (answer.questionId || answer.id);
    if (qid != null && !byId.has(String(qid))) {
      throw new HttpError(400, `unknown question ${qid}`, { code: 'RANKING_INVALID' });
    }
  }
  return payload;
}

/**
 * Ranked elections must present a ranking (possibly empty undervotes).
 * @param {object} election
 * @param {object} body
 * @param {string} encryptedBallot
 */
export function extractRankingPayload(election, body, encryptedBallot) {
  if (!electionHasRanked(election)) return null;
  const answers = extractAnswers(body, encryptedBallot);
  if (!answers) return null;
  return validateBallotAnswers(election, answers);
}

function rankingsForQuestion(question, ballots) {
  const qid = String(question.id);
  return ballots.map((ballot) => {
    const row = (ballot || []).find((a) => String(a.questionId) === qid);
    if (!row) return [];
    if (Array.isArray(row.ranking)) return row.ranking.map(String);
    if (Array.isArray(row.optionIds)) return row.optionIds.map(String);
    return [];
  });
}

/**
 * Build FPTP-shaped concatenated counts plus IRV transcripts for ranked
 * questions. Callers that also have plurality aspects should post the
 * plurality-only L1 vector separately (`parseTallyCounts`).
 *
 * @param {object} election
 * @param {object[][]} ballots compact ranking payloads, one per accepted ballot
 */
export function tallyBallots(election, ballots) {
  const method = normalizeBallotMethod(election.ballotMethod || 'plurality');
  const questions = election.questions || [];
  const counts = [];
  const transcripts = [];
  let ranked = 0;
  let plurality = 0;

  for (const question of questions) {
    const qMethod = questionBallotMethod(question, method);
    const optionIds = (question.options || []).map((o) => String(o.id));
    const lists = rankingsForQuestion(question, ballots);

    if (qMethod === 'ranked_choice') {
      ranked += 1;
      const irv = computeIrv(optionIds, lists);
      const first = firstRoundCounts(optionIds, lists);
      counts.push(...first.counts);
      const winnerOpt = (question.options || []).find((o) => String(o.id) === String(irv.winner));
      transcripts.push({
        questionId: question.id,
        prompt: question.prompt,
        ballotMethod: 'ranked_choice',
        winner: irv.winner,
        winnerLabel: winnerOpt ? winnerOpt.label : irv.winner,
        exhausted: irv.exhausted,
        tieBroken: irv.tieBroken,
        rounds: irv.rounds,
      });
    } else {
      plurality += 1;
      const fptp = firstRoundCounts(optionIds, lists);
      counts.push(...fptp.counts);
      transcripts.push({
        questionId: question.id,
        prompt: question.prompt,
        ballotMethod: 'plurality',
        winner: null,
        counts: Object.fromEntries(optionIds.map((id, i) => [id, fptp.counts[i]])),
      });
    }
  }

  const ballotMethod = ranked && plurality ? 'mixed' : ranked ? 'ranked_choice' : 'plurality';
  return {
    counts,
    ballotMethod,
    questions: transcripts,
  };
}

/**
 * Decode stored envelopes into compact ballot payloads.
 * @param {object[]} envelopes
 */
export function payloadsFromEnvelopes(envelopes) {
  const out = [];
  for (const env of envelopes || []) {
    const ranking = env.tallyRankingPayload ?? env.rankingPayload;
    if (Array.isArray(ranking)) {
      out.push(ranking);
      continue;
    }
    const decoded = extractAnswers({}, ciphertextForTally(env));
    out.push(Array.isArray(decoded) ? decoded : []);
  }
  return out;
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
