// NOT FOR PROFIT — civic public good, not a commercial product.
// Ballot methods and ranking validation. On-chain v1 keeps the method
// inside ballotSpecHash (ElectionParams has no method enum).

import { HttpError } from './http.mjs';
import { normalizeOption } from './ballotSpec.mjs';
import { computeIrv, firstRoundCounts } from './irv.mjs';

export const BALLOT_METHODS = Object.freeze(['plurality', 'ranked_choice']);

export const QUESTION_TYPES = Object.freeze([
  'YES_NO',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'RANKED',
  'MEASURE',
  'ARTICLE',
]);

const TYPE_ALIASES = Object.freeze({
  RANKED_CHOICE: 'RANKED',
  IRV: 'RANKED',
  RCV: 'RANKED',
  YESNO: 'YES_NO',
  YES_NO_QUESTION: 'YES_NO',
  SINGLE: 'SINGLE_CHOICE',
  MULTI: 'MULTI_CHOICE',
  FPTP: 'SINGLE_CHOICE',
});

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
 * @param {unknown} value
 * @param {string} [fallback]
 */
export function normalizeQuestionType(value, fallback = 'YES_NO') {
  const raw = String(value || fallback || 'YES_NO')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return TYPE_ALIASES[raw] || raw || fallback;
}

/**
 * @param {object} question
 * @param {'plurality'|'ranked_choice'} electionMethod
 * @returns {'plurality'|'ranked_choice'}
 */
export function questionBallotMethod(question, electionMethod = 'plurality') {
  if (question?.ballotMethod != null && question.ballotMethod !== '') {
    return normalizeBallotMethod(question.ballotMethod);
  }
  const type = normalizeQuestionType(question?.type, 'SINGLE_CHOICE');
  if (type === 'RANKED') return 'ranked_choice';
  if (type === 'YES_NO' || type === 'MULTI_CHOICE') return 'plurality';
  if (type === 'SINGLE_CHOICE' || type === 'MEASURE' || type === 'ARTICLE') return electionMethod;
  return 'plurality';
}

export function isRankedQuestion(question, electionMethod = 'plurality') {
  return questionBallotMethod(question, electionMethod) === 'ranked_choice';
}

export function electionHasRanked(election) {
  const method = normalizeBallotMethod(election?.ballotMethod || 'plurality');
  return (election?.questions || []).some((q) => isRankedQuestion(q, method));
}

/**
 * Canonical questions for storage and `ballotSpecHash`. Option metadata
 * (`summary`, `body`, `links`) is omitted when empty so `{id,label}` hashes
 * stay stable. `ballotMethod` is stored only when the question is IRV so
 * plurality elections keep the same keccak preimage as option-metadata v1.
 *
 * @param {unknown} input
 * @param {'plurality'|'ranked_choice'} [electionMethod]
 */
export function normalizeQuestions(input, electionMethod = 'plurality') {
  if (!input) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'questions must be an array');
  const method = normalizeBallotMethod(electionMethod);
  return input.map((q, i) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new HttpError(400, 'each question must be an object');
    }
    const type = normalizeQuestionType(q.type, method === 'ranked_choice' ? 'RANKED' : 'YES_NO');
    let options = Array.isArray(q.options)
      ? q.options.map((o, j) => normalizeOption(o, j))
      : type === 'YES_NO' || (!q.type && method === 'plurality')
        ? [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ]
        : [];
    if (type === 'YES_NO' && options.length === 0) {
      options = [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ];
    }
    const ids = new Set();
    for (const opt of options) {
      if (ids.has(opt.id)) {
        throw new HttpError(400, `duplicate option id ${opt.id} on question ${q.id || i + 1}`);
      }
      ids.add(opt.id);
    }
    const ballotMethod = questionBallotMethod({ ...q, type }, method);
    if (ballotMethod === 'ranked_choice' && options.length < 2) {
      throw new HttpError(400, 'ranked_choice questions need at least two options', { code: 'RANKED_OPTIONS' });
    }
    const question = {
      id: String(q.id || `q${i + 1}`),
      type,
      prompt: String(q.prompt || q.title || q.text || `Question ${i + 1}`),
      options,
    };
    const description = q.description ? String(q.description) : '';
    if (description) question.description = description;
    if (q.maxSelections != null || q.max != null || type === 'MULTI_CHOICE') {
      question.maxSelections = Number(q.maxSelections ?? q.max ?? 2) || 1;
    }
    if (ballotMethod === 'ranked_choice') question.ballotMethod = 'ranked_choice';
    return question;
  });
}

export function expectedCountLength(questions) {
  if (!questions?.length) return 0;
  return questions.reduce((n, q) => n + Math.max(q.options?.length || 0, 1), 0);
}

function utf8FromHex(hex) {
  const s = String(hex || '');
  const h = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (!h || h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) return null;
  try {
    return Buffer.from(h, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * @param {unknown} encryptedBallot
 * @returns {object|null}
 */
export function decodeBallotJson(encryptedBallot) {
  if (encryptedBallot == null) return null;
  if (typeof encryptedBallot === 'object' && !Array.isArray(encryptedBallot)) return encryptedBallot;
  if (typeof encryptedBallot !== 'string') return null;
  const raw = encryptedBallot.startsWith('0x') ? utf8FromHex(encryptedBallot) : encryptedBallot;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pull answer objects from the vote body or a JSON (demo) ciphertext.
 * @param {object} body
 * @param {string} [encryptedBallot]
 * @returns {object[]|null}
 */
export function extractAnswers(body, encryptedBallot) {
  if (Array.isArray(body?.answers)) return body.answers;
  if (Array.isArray(body?.ballot?.answers)) return body.ballot.answers;
  const decoded = decodeBallotJson(encryptedBallot ?? body?.encryptedBallot);
  if (Array.isArray(decoded)) return decoded;
  if (Array.isArray(decoded?.answers)) return decoded.answers;
  return null;
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

function parsePluralityOptionIds(answer, question) {
  const allowed = optionIdSet(question);
  const ids = Array.isArray(answer?.optionIds)
    ? answer.optionIds.map((id) => String(id))
    : answer?.optionId != null
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
  if (!answers) {
    throw new HttpError(400, 'ranked ballot answers required', { code: 'RANKING_REQUIRED' });
  }
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
 * questions. Plurality questions stay first-past-the-post option counts.
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
    if (Array.isArray(env.rankingPayload)) {
      out.push(env.rankingPayload);
      continue;
    }
    const decoded = extractAnswers({}, env.encryptedBallot);
    out.push(Array.isArray(decoded) ? decoded : []);
  }
  return out;
}
