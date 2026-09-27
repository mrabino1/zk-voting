// NOT FOR PROFIT — civic public good, not a commercial product.
// Role-promotion mail stays on the Node. It is never a civic L2 transaction.

import { randomUUID } from 'node:crypto';

import { publicMailSummary } from './mailer.mjs';
import { renderPromotionEmail } from './mailTemplates.mjs';

/**
 * Queue one promotion notice when a grant is new and the person exists.
 * Re-grants and unknown handles do not append the outbox or call the webhook.
 */
export async function deliverPromotionMail(store, config, { created, user, role, vars = {} } = {}) {
  if (!created) return { skipped: true, reason: 'already_granted' };
  if (!user) return { skipped: true, reason: 'no_user' };
  const rendered = renderPromotionEmail(role, {
    handle: user.handle,
    publicBaseUrl: config?.publicBaseUrl,
    grantedByHandle: vars.grantedByHandle || '',
    jurisdictionId: vars.jurisdictionId || '',
    jurisdictionName: vars.jurisdictionName || '',
    electionId: vars.electionId || '',
    electionTitle: vars.electionTitle || '',
  });
  if (!rendered) return { skipped: true, reason: 'not_a_promotion' };
  const record = {
    id: randomUUID(),
    templateId: rendered.templateId,
    role: rendered.role,
    to: user.contactEmail || '',
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    status: 'sent',
    createdAt: new Date().toISOString(),
    userId: user.id,
  };
  await store.recordMail(record);
  await store.addNotification({
    userId: user.id,
    type: 'role_promoted',
    title: rendered.notificationTitle,
    body: rendered.notificationBody,
    electionId: vars.electionId || null,
  });
  const webhook = String(config?.mailWebhookUrl || '').trim();
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nfp: true,
        templateId: record.templateId,
        to: record.to,
        text: record.text,
        html: record.html,
      }),
    });
  }
  return { skipped: false, mail: publicMailSummary(record) };
}
