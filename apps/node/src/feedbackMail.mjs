// NOT FOR PROFIT — civic public good, not a commercial product.
// Operator notice for /feedback. User text is escaped. This is not a vote receipt.

import { escapeHtml } from './mailTemplates.mjs';
import { FEEDBACK_CATEGORIES } from './feedback.mjs';

const CATEGORY_LABELS = Object.freeze({
  general: 'General',
  accessibility: 'Accessibility',
  privacy: 'Privacy',
  defect: 'Something is broken',
  suggestion: 'Suggestion',
  other: 'Other',
});

export function feedbackCategoryLabel(category) {
  return CATEGORY_LABELS[category] || 'General';
}

function textOrNone(value) {
  const s = String(value || '').trim();
  return s || '(not provided)';
}

/**
 * Republic-branded HTML and plain text. Every user-controlled string is
 * escaped in HTML. The subject uses the allow-listed category only.
 */
export function renderFeedbackEmail({
  category,
  message,
  name,
  replyTo,
  acceptedAt,
  termsVersion,
  termsHash,
  markdownSha256,
  request = {},
} = {}) {
  const safeCategory = FEEDBACK_CATEGORIES.includes(category) ? category : 'general';
  const label = feedbackCategoryLabel(safeCategory);
  const subject = `Republic feedback: ${label}`;
  const when = String(acceptedAt || '');
  const version = String(termsVersion || '');
  const hash = String(termsHash || '');
  const markdown = String(markdownSha256 || '');
  const method = String(request.method || 'POST');
  const path = String(request.path || '/api/feedback');
  const userAgent = String(request.userAgent || '');
  const acceptLanguage = String(request.acceptLanguage || '');
  const bytes = request.contentLength != null ? String(request.contentLength) : '';

  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'Republic feedback',
    `Category: ${label}`,
    `Name: ${textOrNone(name)}`,
    `Reply-to: ${textOrNone(replyTo)}`,
    `Submitted: ${when}`,
    '',
    'Message:',
    String(message || ''),
    '',
    'Acceptance',
    "The sender affirmed that any and all feedback becomes the property of the project's legal owner.",
    `acceptedAt: ${when}`,
    `termsVersion: ${version}`,
    `termsHash: ${hash}`,
    `markdownSha256: ${markdown}`,
    'hashOf: pdf-bytes',
    '',
    'Request',
    `method: ${method}`,
    `path: ${path}`,
    userAgent ? `userAgent: ${userAgent}` : '',
    acceptLanguage ? `acceptLanguage: ${acceptLanguage}` : '',
    bytes ? `contentLength: ${bytes}` : '',
    '',
    'This message is operator mail. It is not a vote receipt. It does not include a voter identity or any election data.',
    '',
    '— Republic',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');

  const row = (k, v) =>
    `<tr><th align="left" style="padding:6px 12px 6px 0;font-size:14px;color:#333333;vertical-align:top;">${escapeHtml(k)}</th><td style="padding:6px 0;font-size:14px;color:#111111;">${escapeHtml(v)}</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#e8e4d9;color:#111111;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px 12px 40px;">
    <p style="margin:0 0 12px;font-size:12px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#13294b;">NOT FOR PROFIT</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #c9c3b2;border-radius:4px;">
      <tr>
        <td style="background:#13294b;color:#f4f1ea;padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.04em;">Republic</p>
          <h1 style="margin:0;font-size:22px;line-height:1.3;">Feedback</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">A person sent feedback to the operator of this host. This is not a ballot.</p>
          <table role="presentation" cellpadding="0" cellspacing="0">
            ${row('Category', label)}
            ${row('Name', textOrNone(name))}
            ${row('Reply-to', textOrNone(replyTo))}
            ${row('Submitted', when)}
          </table>
          <h2 style="margin:20px 0 8px;font-size:16px;">Message</h2>
          <pre style="margin:0;white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111111;">${escapeHtml(message)}</pre>
          <h2 style="margin:20px 0 8px;font-size:16px;">Acceptance</h2>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.45;">The sender affirmed that any and all feedback becomes the property of the project's legal owner.</p>
          <table role="presentation" cellpadding="0" cellspacing="0">
            ${row('acceptedAt', when)}
            ${row('termsVersion', version)}
            ${row('termsHash', hash)}
            ${row('markdownSha256', markdown)}
            ${row('hashOf', 'pdf-bytes')}
          </table>
          <h2 style="margin:20px 0 8px;font-size:16px;">Request</h2>
          <table role="presentation" cellpadding="0" cellspacing="0">
            ${row('method', method)}
            ${row('path', path)}
            ${userAgent ? row('userAgent', userAgent) : ''}
            ${acceptLanguage ? row('acceptLanguage', acceptLanguage) : ''}
            ${bytes ? row('contentLength', bytes) : ''}
          </table>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.45;color:#444444;">This message is operator mail. It is not a vote receipt. It does not include a voter identity or any election data. Promotion and feedback mail are never written to civic L2 transactions.</p>
        </td>
      </tr>
    </table>
    <p style="margin:16px 4px 0;font-size:12px;line-height:1.45;color:#444444;">Civic public good. Not a commercial product. No token. No fees to voters.</p>
  </div>
</body>
</html>`;

  return { subject, text, html, category: safeCategory };
}
