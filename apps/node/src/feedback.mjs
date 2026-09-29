// NOT FOR PROFIT — civic public good, not a commercial product.
// Public /feedback: validate, rate-limit, and address the platform operator.
// The message body is not written to the JSON store and is not logged.

import { normalizeEmail, userEmail } from './identity.mjs';
import { getTermsDocument } from './terms.mjs';

export const FEEDBACK_PATH = '/feedback';
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_NAME_MAX = 120;
export const FEEDBACK_MAX_PER_WINDOW = 1;

export const FEEDBACK_CATEGORIES = Object.freeze([
  'general',
  'accessibility',
  'privacy',
  'defect',
  'suggestion',
]);

export const FEEDBACK_CATEGORY_LABELS = Object.freeze({
  general: 'General',
  accessibility: 'Accessibility',
  privacy: 'Privacy',
  defect: 'Something is broken',
  suggestion: 'Suggestion',
});

export const FEEDBACK_USER_UNAVAILABLE =
  'Feedback cannot be delivered right now. Please try again later.';

export const FEEDBACK_INBOX_WARNING =
  '[republic] feedback refused: the platform super admin has no contact email and no sign-in email. Set one on that person so /feedback can be delivered. The message was not sent.';

export const FEEDBACK_SES_WARNING =
  '[republic] feedback refused: AWS SES is not configured. Set SES_FROM_ADDRESS and AWS_REGION. SES_DRY_RUN=1 with both still captures the message and does not call SES. The message was not sent.';

export function stripControls(value, { keepNewlines = false } = {}) {
  const raw = String(value ?? '');
  if (keepNewlines) {
    return raw
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }
  return raw.replace(/[\u0000-\u001F\u007F]/g, '');
}

export function feedbackNowMs(config) {
  if (config && typeof config.feedbackNowMs === 'function') {
    const n = Number(config.feedbackNowMs());
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

export function normalizeClientIp(value) {
  let ip = stripControls(value).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  ip = ip.split(',')[0].trim();
  return ip.slice(0, 80);
}

export function feedbackClientIp(req, config) {
  if (config && typeof config.feedbackClientIp === 'function') {
    const custom = normalizeClientIp(config.feedbackClientIp(req));
    if (custom) return custom;
  }
  const peer = req?.ip || req?.socket?.remoteAddress || '';
  return normalizeClientIp(peer) || 'unknown';
}

/**
 * One accepted submission per IP per window. The map lives on the app
 * instance so other visitors, and other Node processes, do not share it.
 */
export function createFeedbackRateLimiter() {
  const acceptedAt = new Map();
  return {
    retryAfterSeconds(ip, nowMs, windowMs) {
      const prev = acceptedAt.get(ip);
      if (prev == null) return 0;
      const elapsed = nowMs - prev;
      if (elapsed >= windowMs) return 0;
      return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
    },
    commit(ip, nowMs) {
      acceptedAt.set(ip, nowMs);
    },
  };
}

export function retryCopy(retryAfterSeconds) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfterSeconds) / 60));
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return {
    minutes,
    error: `You can send another message in about ${minutes} ${unit}`,
  };
}

/**
 * Platform super admin inbox: contact email, then the sign-in email.
 * No address means fail closed.
 */
export function resolvePlatformOperatorEmail(store) {
  const users = typeof store?.listUsers === 'function' ? store.listUsers() : [];
  const supers = users.filter((user) => user && user.role === 'platform_super_admin');
  for (const user of supers) {
    const contact = String(user.contactEmail || '').trim();
    if (contact) {
      try {
        return normalizeEmail(contact);
      } catch {
        /* fall through to the sign-in email */
      }
    }
    const identity = userEmail(user);
    if (identity) return identity;
  }
  return null;
}

/** ses, dry-run, in-process capture, or unconfigured (fail closed). */
export function feedbackDeliveryMode(config = {}) {
  const sesReady = Boolean(config.sesFromAddress && config.awsRegion);
  if (sesReady && config.sesDryRun) return 'dry-run';
  if (sesReady) return 'ses';
  if (config.captureEmail || config.allowCaptureMailer) return 'capture';
  return 'unconfigured';
}

function affirmed(value) {
  if (value === true || value === 1) return true;
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

function fieldError(id, message) {
  return { id, message };
}

/**
 * Validate a feedback body. Honeypot, checkbox, and other rejections
 * return before the caller records a rate-limit hit.
 */
export function parseFeedbackSubmission(body, config, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION',
      error: 'Feedback was not sent.',
      fields: [],
    };
  }

  const honeypot = stripControls(body.website).trim();
  if (honeypot) {
    return {
      ok: false,
      status: 400,
      code: 'HONEYPOT',
      error: 'Feedback was not sent.',
      fields: [],
    };
  }

  const fields = [];
  if (!affirmed(body.assignmentAccepted)) {
    fields.push(
      fieldError(
        'feedback-assignment',
        "You must affirm that any and all feedback you submit becomes the property of the project's legal owner.",
      ),
    );
  }

  const category = stripControls(body.category).trim();
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    fields.push(fieldError('feedback-category', 'Choose a category.'));
  }

  let name = null;
  if (body.name != null && typeof body.name !== 'string') {
    fields.push(fieldError('feedback-name', 'Name is not valid.'));
  } else {
    name = stripControls(body.name).trim();
    if (name.length > FEEDBACK_NAME_MAX) {
      fields.push(fieldError('feedback-name', 'Name is too long.'));
    }
  }

  let message = '';
  if (body.message != null && typeof body.message !== 'string') {
    fields.push(fieldError('feedback-message', 'Enter a message.'));
  } else {
    message = stripControls(body.message, { keepNewlines: true }).trim();
    if (!message) fields.push(fieldError('feedback-message', 'Enter a message.'));
    else if ([...message].length > FEEDBACK_MESSAGE_MAX) {
      fields.push(fieldError('feedback-message', 'Message is too long.'));
    }
  }

  let replyTo = null;
  const replyRaw = body.replyTo == null ? '' : body.replyTo;
  if (replyRaw != null && String(replyRaw).trim() !== '') {
    if (typeof replyRaw !== 'string' || /[\u0000-\u001F\u007F]/.test(replyRaw)) {
      fields.push(fieldError('feedback-email', 'Reply-to email is not valid.'));
    } else {
      try {
        replyTo = normalizeEmail(replyRaw);
      } catch {
        fields.push(fieldError('feedback-email', 'Reply-to email is not valid.'));
      }
    }
  }

  const started = Number(body.startedAt);
  const minMs = Number(config?.feedbackMinSubmitMs ?? 3000);
  if (!Number.isFinite(started) || started > nowMs + 5000 || nowMs - started < minMs) {
    return {
      ok: false,
      status: 400,
      code: 'TOO_FAST',
      error: 'Please wait a moment and submit the form again.',
      fields: [],
    };
  }

  if (fields.length) {
    const assignment = fields.find((item) => item.id === 'feedback-assignment');
    return {
      ok: false,
      status: 400,
      code: assignment && fields.length === 1 ? 'ASSIGNMENT_REQUIRED' : 'VALIDATION',
      error: assignment && fields.length === 1 ? assignment.message : 'Feedback was not sent.',
      fields,
    };
  }

  return {
    ok: true,
    value: {
      name: name || '',
      replyTo,
      category,
      categoryLabel: FEEDBACK_CATEGORY_LABELS[category],
      message,
    },
  };
}

export function currentTermsAcceptance(nowMs) {
  const doc = getTermsDocument();
  return {
    acceptedAt: new Date(nowMs).toISOString(),
    termsVersion: String(doc.version),
    termsPdfSha256: doc.pdfSha256,
    termsMarkdownSha256: doc.markdownSha256,
  };
}
