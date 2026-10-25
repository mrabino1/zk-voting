// NOT FOR PROFIT — civic public good, not a commercial product.
// Operator notice for /feedback. Not a vote receipt. No voter identity,
// no ballot choice, and no election record.

import { escapeHtml } from './mailTemplates.mjs';

function singleLine(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

function textBlock(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function htmlBlock(value) {
  return escapeHtml(textBlock(value)).replace(/\n/g, '<br>\n');
}

/**
 * Republic-branded feedback notice. Every visitor-supplied string is escaped
 * in HTML and stripped of control characters before it can reach a header.
 * @param {object} input
 */
export function renderFeedbackEmail(input) {
  const categoryLabel = singleLine(input.categoryLabel || input.category || 'General') || 'General';
  const name = singleLine(input.name);
  const replyTo = singleLine(input.replyTo);
  const message = textBlock(input.message);
  const acceptedAt = singleLine(input.acceptance?.acceptedAt);
  const termsVersion = singleLine(input.acceptance?.termsVersion);
  const termsPdfSha256 = singleLine(input.acceptance?.termsPdfSha256);
  const termsMarkdownSha256 = singleLine(input.acceptance?.termsMarkdownSha256);
  const userAgent = singleLine(input.userAgent).slice(0, 200);
  const acceptLanguage = singleLine(input.acceptLanguage).slice(0, 80);
  const subject = `Republic feedback (${categoryLabel})`;

  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    'A visitor sent feedback from /feedback. This is not a vote receipt.',
    'It does not include a voter identity, a ballot choice, or an election record.',
    '',
    `Category: ${categoryLabel}`,
    `Name: ${name || '(not given)'}`,
    `Reply-To: ${replyTo || '(not given)'}`,
    '',
    'Message:',
    message,
    '',
    'Assignment acceptance:',
    `Accepted at: ${acceptedAt}`,
    `Terms version: ${termsVersion}`,
    `Terms PDF SHA-256: ${termsPdfSha256}`,
    `Terms markdown SHA-256: ${termsMarkdownSha256}`,
    'The sender affirmed that this feedback becomes the property of the project legal owner.',
    '',
    'Request metadata:',
    `User-Agent: ${userAgent || '(none)'}`,
    `Accept-Language: ${acceptLanguage || '(none)'}`,
    '',
    'No obligation to use, credit, or compensate the sender.',
    'Civic public good. Not a commercial product. No token. No fees to voters.',
  ].join('\n');

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
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">A visitor sent feedback from /feedback. This is not a vote receipt. It does not include a voter identity, a ballot choice, or an election record.</p>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.45;"><strong>Category:</strong> ${escapeHtml(categoryLabel)}</p>
          <p style="margin:0 0 8px;font-size:14px;line-height:1.45;"><strong>Name:</strong> ${name ? escapeHtml(name) : '(not given)'}</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.45;"><strong>Reply-To:</strong> ${replyTo ? escapeHtml(replyTo) : '(not given)'}</p>
          <p style="margin:0 0 8px;font-size:14px;font-weight:700;">Message</p>
          <div style="margin:0 0 20px;padding:12px 14px;background:#f4f1ea;border:1px solid #c9c3b2;font-size:16px;line-height:1.5;">${htmlBlock(message)}</div>
          <p style="margin:0 0 8px;font-size:14px;font-weight:700;">Assignment acceptance</p>
          <p style="margin:0 0 6px;font-size:14px;line-height:1.45;">The sender affirmed that this feedback becomes the property of the project legal owner.</p>
          <p style="margin:0 0 6px;font-size:14px;line-height:1.45;">Accepted at: ${escapeHtml(acceptedAt)}</p>
          <p style="margin:0 0 6px;font-size:14px;line-height:1.45;">Terms version: ${escapeHtml(termsVersion)}</p>
          <p style="margin:0 0 6px;font-size:14px;line-height:1.45;word-break:break-all;">Terms PDF SHA-256: ${escapeHtml(termsPdfSha256)}</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.45;word-break:break-all;">Terms markdown SHA-256: ${escapeHtml(termsMarkdownSha256)}</p>
          <p style="margin:0 0 8px;font-size:14px;font-weight:700;">Request metadata</p>
          <p style="margin:0 0 6px;font-size:13px;line-height:1.45;color:#333333;">User-Agent: ${userAgent ? escapeHtml(userAgent) : '(none)'}</p>
          <p style="margin:0;font-size:13px;line-height:1.45;color:#333333;">Accept-Language: ${acceptLanguage ? escapeHtml(acceptLanguage) : '(none)'}</p>
        </td>
      </tr>
    </table>
    <p style="margin:16px 4px 0;font-size:12px;line-height:1.45;color:#444444;">No obligation to use, credit, or compensate the sender. Civic public good. Not a commercial product. No token. No fees to voters.</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}
