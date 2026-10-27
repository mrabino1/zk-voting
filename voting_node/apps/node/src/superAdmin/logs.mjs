// NOT FOR PROFIT — civic public good, not a commercial product.
// Process-local diagnostic log tail. Lines are redacted before they are kept.

import { redactText } from './redact.mjs';

export const LOG_LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);

const RANK = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

const MAX = 200;
const ring = [];
const watched = [];
let level = 'info';
let installed = false;

export function watchSecrets(list) {
  for (const item of list || []) {
    const text = String(item || '');
    if (text.length >= 4 && !watched.includes(text)) watched.push(text);
  }
}

export function getLogLevel() {
  return level;
}

export function setLogLevel(next) {
  const name = String(next || '').trim().toLowerCase();
  if (!LOG_LEVELS.includes(name)) {
    const err = new Error('logLevel must be error, warn, info, or debug');
    err.code = 'LOG_LEVEL';
    throw err;
  }
  level = name;
  return level;
}

export function levelAllows(messageLevel, current = level) {
  const have = RANK[current];
  const need = RANK[messageLevel];
  if (have == null || need == null) return false;
  return need <= have;
}

export function resetLogBuffer() {
  ring.length = 0;
}

export function recordLog(messageLevel, text, secrets = []) {
  const name = LOG_LEVELS.includes(messageLevel) ? messageLevel : 'info';
  if (!levelAllows(name)) return null;
  const line = {
    at: new Date().toISOString(),
    level: name,
    message: redactText(text, [...watched, ...secrets]).slice(0, 500),
  };
  ring.push(line);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  return line;
}

export function tailLogs(limit = 100) {
  const n = Math.min(MAX, Math.max(1, Number(limit) || 100));
  return {
    level,
    lines: ring.slice(-n),
  };
}

export function installConsoleCapture(secrets = []) {
  watchSecrets(secrets);
  if (installed) return;
  installed = true;
  for (const name of ['error', 'warn', 'info', 'log', 'debug']) {
    const original = console[name]?.bind(console);
    if (!original) continue;
    const messageLevel = name === 'log' ? 'info' : name;
    console[name] = (...args) => {
      try {
        recordLog(
          messageLevel,
          args.map((item) => (typeof item === 'string' ? item : safeBrief(item))).join(' '),
          secrets,
        );
      } catch {
        /* the diagnostic tail must not break logging */
      }
      original(...args);
    };
  }
}

function safeBrief(value) {
  if (value instanceof Error) return value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
