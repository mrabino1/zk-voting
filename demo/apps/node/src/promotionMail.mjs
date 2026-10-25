// NOT FOR PROFIT — civic public good, not a commercial product.
// Role-promotion notices stay on the Node. They are never vote receipts
// and are never written onto civic L2 transactions.

import { randomUUID } from 'node:crypto';

import { normalizeEmail } from './identity.mjs';
import { renderPromotionEmail } from './mailTemplates.mjs';

export function publicMailSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    role: record.role,
    templateId: record.templateId,
    status: record.status,
    to: record.to,
    subject: record.subject,
    createdAt: record.createdAt,
  };
}

/**
 * Queue a promotion notice when a grant is new and the person has a contact
 * email. Re-grants and unknown handles skip without a second message.
 */
export async function deliverRolePromotion(
  deps,
  {
    role,
    user,
    created = false,
    skipReason = null,
    contactEmail,
    jurisdictionId,
    jurisdictionName,
    electionId,
    electionTitle,
    grantedByHandle,
  } = {},
) {
  const { store, config } = deps;
  if (!created) {
    return { skipped: true, reason: skipReason || 'already_granted' };
  }
  if (!user) {
    return { skipped: true, reason: skipReason || 'no_user' };
  }
  if (contactEmail != null && String(contactEmail).trim() !== '') {
    user.contactEmail = normalizeEmail(contactEmail);
    await store.persist();
  }
  const to = String(user.contactEmail || '').trim();
  if (!to) {
    return { skipped: true, reason: 'no_contact_email' };
  }
  const rendered = renderPromotionEmail(role, {
    handle: user.handle,
    jurisdictionId: jurisdictionId || '',
    jurisdictionName: jurisdictionName || '',
    electionId: electionId ? String(electionId) : '',
    electionTitle: electionTitle || '',
    grantedByHandle: grantedByHandle || '',
    publicBaseUrl: config.publicBaseUrl,
    sample: false,
  });
  if (!rendered) {
    return { skipped: true, reason: 'not_a_promotion' };
  }
  const record = {
    id: randomUUID(),
    role,
    templateId: rendered.templateId,
    status: 'queued',
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    createdAt: new Date().toISOString(),
  };
  await store.saveMail(record);
  await store.addNotification({
    userId: user.id,
    type: 'role_promoted',
    title: rendered.notificationTitle,
    body: rendered.notificationBody,
    electionId: electionId || null,
  });
  const webhook = String(config.mailWebhookUrl || '').trim();
  if (webhook) {
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
        role: record.role,
      }),
    });
    record.status = res.ok ? 'sent' : 'failed';
  } else {
    record.status = 'sent';
  }
  await store.saveMail(record);
  return { skipped: false, mail: publicMailSummary(record) };
}
