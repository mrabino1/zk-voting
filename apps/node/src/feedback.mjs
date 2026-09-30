// NOT FOR PROFIT — civic public good, not a commercial product.
// Public feedback is emailed to the platform super admin. It is not a ballot
// and it is not stored as a personal-data record.

import { normalizeEmail, userEmail } from './identity.mjs';
import { isPlatformOperator } from './roles.mjs';

export const FEEDBACK_CATEGORIES = Object.freeze([
  'general',
  'accessibility',
  'privacy',
  'defect',
  'suggestion',
  'other',
]);

export const FEEDBACK_USER_UNAVAILABLE =
  'Feedback cannot be sent right now. The host has not finished mail setup. Nothing was saved.';

export const FEEDBACK_OPERATOR_WARNING =
  'Platform super admin has no email. Set the primary email or contact email on the platform_super_admin person (the domain operator). Feedback is refused until that address exists.';

export const FEEDBACK_SES_WARNING =
  'AWS SES is not configured for feedback. Set SES_FROM_ADDRESS and AWS_REGION (SES_DRY_RUN=1 captures mail without sending). Feedback was not delivered.';

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5000;

export function stripControls(value, { keepNewlines = false, max = 4000 } = {}) {
  let s = String(value ?? '');
  if (keepNewlines) {
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.replace(/[\u2028\u2029]/g, '\n');
  } else {
    s = s.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, '');
  }
  s = s.trim();
  if (max != null && s.length > max) s = s.slice(0, max);
  return s;
}

function validEmail(value) {
  try {
    return normalizeEmail(value);
  } catch {
    return null;
  }
}

/**
 * Destination for operator mail. Prefer the seeded super admin's primary
 * email, then that person's contact email, then any other super admin.
 * Never returns a voter address.
 */
export function resolveOperatorInbox(store, config = {}) {
  const users = Array.isArray(store?.data?.users) ? store.data.users : [];
  const supers = users.filter((user) => user && user.role === 'platform_super_admin');
  const preferred = String(config.adminHandle || 'admin').trim().toLowerCase();
  const ordered = supers.slice().sort((a, b) => {
    const ap = String(a.handle || '').trim().toLowerCase() === preferred ? 0 : 1;
    const bp = String(b.handle || '').trim().toLowerCase() === preferred ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
  for (const user of ordered) {
    const primary = userEmail(user);
    if (primary) return { email: primary, source: 'primary', handle: user.handle || '' };
    const contact = validEmail(user.contactEmail);
    if (contact) return { email: contact, source: 'contact', handle: user.handle || '' };
  }
  return null;
}

export function feedbackDeliveryMode(config = {}) {
  const sesReady = Boolean(config.sesFromAddress && config.awsRegion);
  if (config.sesDryRun) return { mode: 'dry-run', sesReady };
  if (sesReady) return { mode: 'ses', sesReady };
  if (config.captureEmail || config.allowCaptureMailer) return { mode: 'captured', sesReady };
  return { mode: 'unavailable', sesReady };
}

export function createFeedbackLimiter({ windowMs = 15 * 60 * 1000, max = 5, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const id = String(key || 'unknown');
      const t = now();
      const list = (hits.get(id) || []).filter((ts) => t - ts < windowMs);
      if (list.length >= max) {
        const retryAfter = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
        hits.set(id, list);
        return { ok: false, retryAfter };
      }
      list.push(t);
      hits.set(id, list);
      return { ok: true };
    },
  };
}

export function clientAddress(req) {
  const raw = req?.ip || req?.socket?.remoteAddress || '';
  return stripControls(raw, { max: 80 }) || 'unknown';
}

/**
 * Validate a feedback body. Does not log and does not include the message
 * in the returned error text.
 */
export function parseFeedbackBody(body, config = {}, now = Date.now()) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const honeypot = stripControls(src.website ?? src.company ?? '', { max: 500 });
  if (honeypot) {
    return { ok: false, status: 400, code: 'HONEYPOT', error: 'Feedback could not be sent.' };
  }

  const minMs = Number(config.feedbackMinSubmitMs ?? 3000);
  const started = Number(src.startedAt);
  if (!Number.isFinite(started)) {
    return { ok: false, status: 400, code: 'FEEDBACK_TOO_FAST', error: 'Please wait a moment and try again.' };
  }
  const elapsed = now - started;
  if (elapsed < minMs || started > now + CLOCK_SKEW_MS || elapsed > MAX_AGE_MS) {
    return { ok: false, status: 400, code: 'FEEDBACK_TOO_FAST', error: 'Please wait a moment and try again.' };
  }

  const ownership = src.ownershipAccepted;
  const accepted =
    ownership === true ||
    ownership === 1 ||
    ['true', '1', 'on', 'yes'].includes(String(ownership || '').trim().toLowerCase());
  if (!accepted) {
    return {
      ok: false,
      status: 400,
      code: 'FEEDBACK_OWNERSHIP_REQUIRED',
      error: "Tick the box affirming that feedback becomes the property of the project's legal owner.",
    };
  }

  const category = stripControls(src.category, { max: 40 }).toLowerCase();
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    return { ok: false, status: 400, code: 'FEEDBACK_CATEGORY', error: 'Choose a category.' };
  }

  const maxChars = Number(config.feedbackMaxMessageChars ?? 4000);
  const messageRaw = stripControls(src.message, { keepNewlines: true, max: maxChars + 1 });
  if (!messageRaw) {
    return { ok: false, status: 400, code: 'FEEDBACK_MESSAGE', error: 'Enter a message.' };
  }
  if (messageRaw.length > maxChars) {
    return { ok: false, status: 400, code: 'FEEDBACK_MESSAGE_LENGTH', error: 'The message is too long.' };
  }

  const name = stripControls(src.name, { max: 120 });
  if (String(src.name || '').length > 0 && stripControls(src.name, { max: 10_000 }).length > 80) {
    return { ok: false, status: 400, code: 'FEEDBACK_NAME', error: 'That name is too long.' };
  }
  const nameCapped = name.slice(0, 80);

  let replyTo = '';
  const emailRaw = stripControls(src.email ?? src.replyTo, { max: 320 });
  if (emailRaw) {
    replyTo = validEmail(emailRaw) || '';
    if (!replyTo) {
      return { ok: false, status: 400, code: 'FEEDBACK_EMAIL', error: 'That reply-to email is not valid.' };
    }
  }

  return {
    ok: true,
    value: {
      category,
      message: messageRaw,
      name: nameCapped,
      replyTo,
      ownershipAccepted: true,
    },
  };
}

export function operatorMaySeeWarning(user) {
  return isPlatformOperator(user);
}

export function publicFeedbackStatus({ config, store, user, terms }) {
  const inbox = resolveOperatorInbox(store, config);
  const delivery = feedbackDeliveryMode(config);
  const deliveryConfigured = Boolean(inbox) && delivery.mode !== 'unavailable';
  const showWarning = operatorMaySeeWarning(user);
  let operatorWarning = null;
  if (showWarning && !inbox) operatorWarning = FEEDBACK_OPERATOR_WARNING;
  else if (showWarning && delivery.mode === 'unavailable') operatorWarning = FEEDBACK_SES_WARNING;
  return {
    nfp: true,
    path: '/feedback',
    categories: [...FEEDBACK_CATEGORIES],
    maxMessageChars: Number(config.feedbackMaxMessageChars ?? 4000),
    minSubmitMs: Number(config.feedbackMinSubmitMs ?? 3000),
    deliveryConfigured,
    termsVersion: terms?.version || null,
    termsHash: terms?.pdfSha256 || null,
    operatorWarning,
  };
}

/** Acceptance line for the server log. No message, name, email, or address. */
export function feedbackAcceptanceLog(record) {
  return `[republic] feedback acceptance category=${record.category} termsVersion=${record.termsVersion} termsHash=${record.termsHash} acceptedAt=${record.acceptedAt}`;
}

export function feedbackRefusalLog(reason) {
  return `[republic] feedback refused: ${reason}`;
}
