// NOT FOR PROFIT — civic public good, not a commercial product.
// Canonical ballot JSON: question options may carry supporting metadata
// (summary, body, links, optional image). Empty optional fields are omitted
// so older `{ id, label }` elections keep a stable keccak preimage.
// The hashed object is what clerks store; the public info DTO fills defaults.

import { keccak256, stringToHex } from 'viem';

import { electionState, STATE_NAMES } from './electionState.mjs';
import { HttpError } from './http.mjs';

export const MAX_OPTION_LINKS = 8;
export const MAX_URL_LENGTH = 2048;
export const MAX_SUMMARY_LENGTH = 500;
export const MAX_BODY_LENGTH = 20000;
export const MAX_LABEL_LENGTH = 200;
export const MAX_PROMPT_LENGTH = 2000;

const PUBLIC_OPTION_KEYS = ['id', 'label', 'summary', 'body', 'imageUrl', 'links'];
const CLERK_PRIVATE_KEYS = [
  'createdBy',
  'operatorInbox',
  'me',
  'eligibleTree',
  'disqualificationTree',
  'identityLinks',
  'registrations',
  'clerkNotes',
  'internalNotes',
  'notes',
];

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeHttpUrl(value, { required = false, field = 'url' } = {}) {
  const s = String(value || '').trim();
  if (!s) {
    if (required) throw new HttpError(400, `${field} required`);
    return '';
  }
  if (s.length > MAX_URL_LENGTH) throw new HttpError(400, `${field} is too long`);
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new HttpError(400, `${field} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, `${field} must be http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, `${field} must not include credentials`);
  }
  return parsed.toString();
}

function clipText(value, max, field) {
  const s = String(value ?? '').trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ label: string, url: string }}
 */
export function normalizeLink(raw, index = 0) {
  if (typeof raw === 'string') {
    const url = canonicalizeHttpUrl(raw, { required: true, field: `links[${index}].url` });
    return { label: `Link ${index + 1}`, url };
  }
  if (!raw || typeof raw !== 'object') {
    throw new HttpError(400, `links[${index}] must be { label, url }`);
  }
  const url = canonicalizeHttpUrl(raw.url || raw.href, {
    required: true,
    field: `links[${index}].url`,
  });
  const label =
    clipText(raw.label || raw.title || '', MAX_LABEL_LENGTH, `links[${index}].label`) || url;
  return { label, url };
}

export function normalizeLinks(links) {
  if (links == null || links === '') return [];
  if (!Array.isArray(links)) throw new HttpError(400, 'links must be an array');
  if (links.length > MAX_OPTION_LINKS) {
    throw new HttpError(400, `at most ${MAX_OPTION_LINKS} links per option`);
  }
  return links.map((link, i) => normalizeLink(link, i));
}

/**
 * Normalize one ballot option. Plain strings and `{ id, label }` stay valid.
 * Optional metadata is stored only when non-empty so the canonical hash of a
 * legacy option is unchanged.
 *
 * @param {unknown} raw
 * @param {number} index
 */
export function normalizeOption(raw, index = 0) {
  const asString = typeof raw === 'string' || typeof raw === 'number';
  const obj = asString ? { label: String(raw) } : raw;
  if (obj == null || typeof obj !== 'object') {
    throw new HttpError(400, `options[${index}] is invalid`);
  }
  const id = String(obj.id || obj.value || `o${index + 1}`).trim() || `o${index + 1}`;
  const label =
    clipText(obj.label || obj.name || (asString ? String(raw) : ''), MAX_LABEL_LENGTH, 'option label') ||
    `Option ${index + 1}`;
  const option = { id, label };
  const summary = clipText(obj.summary || obj.blurb || '', MAX_SUMMARY_LENGTH, 'summary');
  const body = clipText(obj.body || obj.description || obj.text || '', MAX_BODY_LENGTH, 'body');
  const imageUrl = canonicalizeHttpUrl(obj.imageUrl || obj.image || '', { field: 'imageUrl' });
  const links = normalizeLinks(obj.links);
  if (summary) option.summary = summary;
  if (body) option.body = body;
  if (imageUrl) option.imageUrl = imageUrl;
  if (links.length) option.links = links;
  return option;
}

export function normalizeQuestion(raw, index = 0) {
  const obj = typeof raw === 'string' ? { prompt: raw } : raw;
  if (obj == null || typeof obj !== 'object') {
    throw new HttpError(400, `questions[${index}] is invalid`);
  }
  const rawType = String(obj.type || 'YES_NO').trim().toUpperCase() || 'YES_NO';
  const type =
    rawType === 'RANKED_CHOICE' || rawType === 'IRV' || rawType === 'RCV' ? 'RANKED' : rawType;
  let options;
  if (Array.isArray(obj.options)) {
    options = obj.options.map((o, j) => normalizeOption(o, j));
  } else if (type === 'YES_NO' || !obj.type) {
    options = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  } else {
    options = [];
  }
  const question = {
    id: String(obj.id || `q${index + 1}`).trim() || `q${index + 1}`,
    type,
    prompt: clipText(obj.prompt || obj.title || obj.text || '', MAX_PROMPT_LENGTH, 'prompt') ||
      `Question ${index + 1}`,
    options,
  };
  const description = clipText(obj.description || obj.help || '', MAX_PROMPT_LENGTH, 'description');
  if (description) question.description = description;
  if (obj.maxSelections != null && obj.maxSelections !== '') {
    question.maxSelections = Number(obj.maxSelections);
  }
  if (obj.ballotMethod != null && obj.ballotMethod !== '') {
    const method = String(obj.ballotMethod).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (method && method !== 'plurality' && method !== 'fptp' && method !== 'first_past_the_post') {
      question.ballotMethod =
        method === 'ranked' || method === 'irv' || method === 'rcv' || method === 'instant_runoff'
          ? 'ranked_choice'
          : method;
    }
  }
  return question;
}

export function normalizeQuestions(input) {
  if (!input) return [];
  if (!Array.isArray(input)) throw new HttpError(400, 'questions must be an array');
  return input.map((q, i) => normalizeQuestion(q, i));
}

export function canonicalBallotSpec({ title, questions }) {
  return {
    title: String(title || '').trim(),
    questions: normalizeQuestions(questions),
  };
}

export function hashBallotSpec({ title, questions }) {
  const canonical = canonicalBallotSpec({ title, questions });
  return keccak256(stringToHex(stableStringify(canonical)));
}

export function resolveBallotSpecHash({ title, questions, ballotSpecHash }) {
  const computed = hashBallotSpec({ title, questions });
  if (ballotSpecHash) {
    const given = String(ballotSpecHash).trim().toLowerCase();
    if (given && given !== computed.toLowerCase()) {
      throw new HttpError(400, 'ballotSpecHash does not match canonical ballot JSON', {
        code: 'SPEC_HASH_MISMATCH',
        ballotSpecHash: computed,
      });
    }
  }
  return computed;
}

function lenientUrl(value) {
  try {
    return canonicalizeHttpUrl(value, { field: 'url' });
  } catch {
    return '';
  }
}

function lenientLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (let i = 0; i < links.length && out.length < MAX_OPTION_LINKS; i++) {
    try {
      out.push(normalizeLink(links[i], i));
    } catch {
      /* skip broken stored links rather than 500 the public page */
    }
  }
  return out;
}

/**
 * Public option DTO. Always includes the metadata keys (empty when absent)
 * so voter UIs do not branch on legacy shapes. Never copies unknown fields.
 */
export function publicOption(raw, index = 0) {
  const asString = typeof raw === 'string' || typeof raw === 'number';
  const obj = asString ? { label: String(raw) } : raw && typeof raw === 'object' ? raw : {};
  let normalized;
  try {
    normalized = normalizeOption(raw, index);
  } catch {
    normalized = {
      id: String(obj.id || `o${index + 1}`),
      label: String(obj.label || obj.name || (asString ? String(raw) : '') || `Option ${index + 1}`),
    };
  }
  return {
    id: normalized.id,
    label: normalized.label,
    summary: normalized.summary || '',
    body: normalized.body || '',
    imageUrl: lenientUrl(normalized.imageUrl || ''),
    links: lenientLinks(normalized.links || []),
  };
}

export function publicQuestion(raw, index = 0) {
  const obj = raw && typeof raw === 'object' ? raw : { prompt: String(raw || '') };
  const options = Array.isArray(obj.options)
    ? obj.options.map((o, j) => publicOption(o, j))
    : String(obj.type || 'YES_NO').toUpperCase() === 'YES_NO'
      ? [
          publicOption({ id: 'yes', label: 'Yes' }, 0),
          publicOption({ id: 'no', label: 'No' }, 1),
        ]
      : [];
  const dto = {
    id: String(obj.id || `q${index + 1}`),
    type: String(obj.type || 'YES_NO'),
    prompt: String(obj.prompt || obj.title || obj.text || `Question ${index + 1}`),
    options,
  };
  if (obj.ballotMethod) dto.ballotMethod = String(obj.ballotMethod);
  if (obj.description) dto.description = String(obj.description);
  if (obj.maxSelections != null) dto.maxSelections = Number(obj.maxSelections);
  return dto;
}

export function publicQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q, i) => publicQuestion(q, i));
}

export function findQuestion(questions, questionId) {
  const list = Array.isArray(questions) ? questions : [];
  const key = String(questionId);
  return list.find((q, i) => String(q.id) === key || String(i) === key || `q${i + 1}` === key) || null;
}

export function findOption(question, optionId) {
  const list = Array.isArray(question?.options) ? question.options : [];
  const key = String(optionId);
  return list.find((o, i) => String(o.id) === key || String(i) === key || `o${i + 1}` === key) || null;
}

function stripPrivate(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const key of CLERK_PRIVATE_KEYS) delete out[key];
  return out;
}

/**
 * Safe public metadata for voter info pages. No clerk-only fields, no trees.
 */
export function presentPublicBallotInfo(election, now = Math.floor(Date.now() / 1000)) {
  if (!election) return null;
  const state = electionState(election, now);
  const dto = {
    id: election.id,
    title: election.title,
    jurisdictionId: election.jurisdictionId,
    metadataURI: election.metadataURI || '',
    startTime: election.startTime,
    cutoffTime: election.cutoffTime,
    ballotSpecHash: election.ballotSpecHash,
    ballotMethod: election.ballotMethod || 'plurality',
    questionCount: election.questionCount ?? (election.questions ? election.questions.length : 0),
    questions: publicQuestions(election.questions),
    state,
    stateName: STATE_NAMES[state],
    nfp: true,
  };
  return stripPrivate(dto);
}

export function presentPublicOptionInfo(election, questionId, optionId, now) {
  const info = presentPublicBallotInfo(election, now);
  if (!info) return null;
  const question = findQuestion(info.questions, questionId);
  if (!question) return null;
  const option = findOption(question, optionId);
  if (!option) return null;
  return {
    id: info.id,
    title: info.title,
    jurisdictionId: info.jurisdictionId,
    ballotSpecHash: info.ballotSpecHash,
    state: info.state,
    stateName: info.stateName,
    question: { id: question.id, type: question.type, prompt: question.prompt },
    option,
    nfp: true,
  };
}

export function optionHasSupportingInfo(option) {
  if (!option) return false;
  return Boolean(
    (option.summary && String(option.summary).trim()) ||
      (option.body && String(option.body).trim()) ||
      (option.imageUrl && String(option.imageUrl).trim()) ||
      (Array.isArray(option.links) && option.links.length),
  );
}

export { PUBLIC_OPTION_KEYS, CLERK_PRIVATE_KEYS };
