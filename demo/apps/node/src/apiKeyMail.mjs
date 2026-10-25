// NOT FOR PROFIT — civic public good, not a commercial product.
// Transactional notice when a person mints an API key. The secret is never
// included. If the person did not create the key, they contact support.

import { brandName } from './branding.mjs';
import { randomUUID } from 'node:crypto';

import { apiKeyLevelLabel, formatApiKeyExpiry } from './apiKeys.mjs';
import { emailHint, userEmail } from './identity.mjs';
import { escapeHtml } from './mailTemplates.mjs';
import { publicMailSummary } from './promotionMail.mjs';

export const API_KEY_CREATED_TEMPLATE_ID = 'api_key.created';

function singleLine(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

function baseUrl(config) {
  return String(config?.publicBaseUrl || '').trim().replace(/\/+$/, '');
}

function absoluteOrPath(config, path) {
  const base = baseUrl(config);
  return base ? `${base}${path}` : path;
}

export function apiKeyNoticeAddress(user) {
  if (!user) return '';
  const contact = String(user.contactEmail || '').trim();
  if (contact) return contact.toLowerCase();
  return userEmail(user) || '';
}

export function describeApiKeyTemplate() {
  return {
    id: API_KEY_CREATED_TEMPLATE_ID,
    label: 'API key created',
    headline: `An API key was created on your ${brandName()} account`,
    subject: `An API key was created on your ${brandName()} account`,
  };
}

/** Strip a personal API key if one was ever copied into a label or name. */
export function redactApiKeyMaterial(value) {
  return String(value ?? '').replace(/rk_[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/**
 * @param {object} input
 * @param {string} input.handle
 * @param {string} input.keyName
 * @param {string} input.level
 * @param {string} input.expiryLabel
 * @param {string} input.createdAt
 * @param {string} input.profileUrl
 * @param {string} input.supportUrl
 */
export function renderApiKeyCreatedEmail(input) {
  const handle = redactApiKeyMaterial(singleLine(input.handle) || 'there');
  const keyName = redactApiKeyMaterial(singleLine(input.keyName) || 'API key');
  const levelLabel = apiKeyLevelLabel(input.level);
  const expiryLabel = singleLine(input.expiryLabel) || 'never';
  const createdAt = singleLine(input.createdAt);
  const profileUrl = singleLine(input.profileUrl) || '/me';
  const supportUrl = singleLine(input.supportUrl) || '/feedback';
  const subject = `An API key was created on your ${brandName()} account`;
  const headline = subject;

  const text = [
    'NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    `Hello ${handle},`,
    '',
    `An API key was created on your ${brandName()} account.`,
    `Name: ${keyName}`,
    `Authorization: ${levelLabel}`,
    `Expiration: ${expiryLabel}`,
    `Created at: ${createdAt}`,
    '',
    'The key itself is not in this email. It was shown once, on your profile, and it cannot be shown again.',
    '',
    `If you created this key, you can review its name or revoke it at ${profileUrl}.`,
    '',
    `If you did not create this API key, contact support as soon as possible: ${supportUrl}`,
    'Then sign in and revoke any key you do not recognize. A key you did not create can act as you, up to the authorization listed above.',
    '',
    'This message is not a vote receipt. Ballot choice is never included.',
    'API-key mail is stored on the Node. It is never written to civic L2 transactions.',
    '',
    `— ${brandName()}`,
  ].join('\n');

  const row = (label, value) =>
    `<tr><th align="left" style="padding:6px 12px 6px 0;font-size:14px;color:#333333;vertical-align:top;">${escapeHtml(label)}</th><td style="padding:6px 0;font-size:14px;color:#111111;">${escapeHtml(value)}</td></tr>`;

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
          <p style="margin:0 0 4px;font-size:13px;letter-spacing:0.04em;">${escapeHtml(brandName())}</p>
          <h1 style="margin:0;font-size:22px;line-height:1.3;">${escapeHtml(headline)}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">Hello ${escapeHtml(handle)},</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">An API key was created on your ${escapeHtml(brandName())} account.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            ${row('Name', keyName)}
            ${row('Authorization', levelLabel)}
            ${row('Expiration', expiryLabel)}
            ${row('Created at', createdAt)}
          </table>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">The key itself is not in this email. It was shown once, on your profile, and it cannot be shown again.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">If you created this key, you can review or revoke it on your profile.</p>
          <p style="margin:0 0 16px;">
            <a href="${escapeHtml(profileUrl)}" style="display:inline-block;background:#13294b;color:#f4f1ea;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:4px;">Review API keys</a>
          </p>
          <p style="margin:0 0 12px;font-size:16px;line-height:1.5;font-weight:700;">If you did not create this API key, contact support as soon as possible.</p>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.5;">A key you did not create can act as you, up to the authorization listed above. Sign in and revoke any key you do not recognize.</p>
          <p style="margin:0 0 16px;">
            <a href="${escapeHtml(supportUrl)}" style="display:inline-block;background:#8a1c1c;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:4px;">Contact support</a>
          </p>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.45;color:#444444;">This message is not a vote receipt. Ballot choice is never included. API-key mail is stored on the Node and is never written to civic L2 transactions.</p>
        </td>
      </tr>
    </table>
    <p style="margin:16px 4px 0;font-size:12px;line-height:1.45;color:#444444;">Civic public good. Not a commercial product. No token. No fees to voters.</p>
  </div>
</body>
</html>`;

  return {
    templateId: API_KEY_CREATED_TEMPLATE_ID,
    subject,
    text: redactApiKeyMaterial(text),
    html: redactApiKeyMaterial(html),
    notificationTitle: 'API key created',
    notificationBody: redactApiKeyMaterial(
      `An API key named ${keyName} (${levelLabel}) was created on your account. If you did not create it, contact support as soon as possible.`,
    ),
  };
}

/**
 * Send the api_key.created template through the transactional mailer and
 * keep a copy on the Node outbox. Missing address skips the send. The key
 * itself is already stored; a mail failure does not roll the key back.
 */
export async function deliverApiKeyCreatedNotice(deps, { user, apiKey } = {}) {
  const { store, config, mailer } = deps;
  const to = apiKeyNoticeAddress(user);
  const rendered = renderApiKeyCreatedEmail({
    handle: user?.handle,
    keyName: apiKey?.name,
    level: apiKey?.level,
    expiryLabel: formatApiKeyExpiry(apiKey),
    createdAt: apiKey?.createdAt,
    profileUrl: absoluteOrPath(config, '/me'),
    supportUrl: absoluteOrPath(config, '/feedback'),
  });
  const record = {
    id: randomUUID(),
    role: null,
    templateId: rendered.templateId,
    status: 'queued',
    to: to || '',
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    createdAt: new Date().toISOString(),
  };

  await store.addNotification({
    userId: user?.id,
    type: 'api_key_created',
    title: rendered.notificationTitle,
    body: rendered.notificationBody,
  });

  if (!to) {
    record.status = 'skipped';
    record.skipReason = 'no_contact_email';
    await store.saveMail(record);
    return {
      skipped: true,
      reason: 'no_contact_email',
      mail: publicMailSummary(record),
    };
  }

  await store.saveMail(record);
  try {
    if (mailer?.send) {
      await mailer.send({
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        meta: { purpose: 'api-key-created', templateId: rendered.templateId, keyId: apiKey?.id },
      });
    }
    record.status = 'sent';
  } catch (err) {
    record.status = 'failed';
    record.error = String(err?.message || err).slice(0, 300);
  }

  const webhook = String(config?.mailWebhookUrl || '').trim();
  if (webhook && record.status === 'sent') {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          nfp: true,
          templateId: record.templateId,
          to: record.to,
          subject: record.subject,
          text: record.text,
          html: record.html,
        }),
      });
      if (!res.ok) record.status = 'failed';
    } catch (err) {
      record.status = 'failed';
      record.error = String(err?.message || err).slice(0, 300);
    }
  }

  await store.saveMail(record);
  return {
    skipped: false,
    status: record.status,
    to,
    toHint: emailHint(to),
    mail: publicMailSummary(record),
  };
}
