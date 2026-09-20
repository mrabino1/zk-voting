// NOT FOR PROFIT — civic public good, not a commercial product.
// Queue role-promotion mail on the Node. Optional MAIL_WEBHOOK_URL delivery.
// Never ingest these messages onto civic L2.

import { randomUUID } from 'node:crypto';

import { HttpError } from './http.mjs';
import { isPromotionRole, renderPromotionEmail } from './mailTemplates.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseContactEmail(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return '';
  if (raw.length > 254 || !EMAIL_RE.test(raw)) {
    throw new HttpError(400, 'invalid contact email');
  }
  return raw;
}

export function publicMailSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    templateId: record.templateId,
    role: record.role,
    userId: record.userId || null,
    handle: record.meta?.handle || null,
    to: record.to || null,
    from: record.from,
    subject: record.subject,
    status: record.status,
    error: record.error || null,
    createdAt: record.createdAt,
    sentAt: record.sentAt || null,
    meta: record.meta || {},
  };
}

export function publicMailResult(result) {
  if (!result) return null;
  return {
    skipped: Boolean(result.skipped),
    reason: result.reason || null,
    mail: publicMailSummary(result.mail),
    notificationId: result.notification?.id || null,
  };
}

async function postWebhook(url, payload, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'republic-node-mailer',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mail webhook ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
  }
}

export function createMailer({ config, store, sendFn, fetchImpl } = {}) {
  async function enqueue(record) {
    return store.enqueueMail(record);
  }

  async function deliver(record) {
    if (!record.to) {
      record.status = 'unsent_no_address';
      await store.persist();
      return record;
    }
    const webhookUrl = String(config?.mailWebhookUrl || '').trim();
    const sender =
      sendFn ||
      (webhookUrl
        ? (payload) => postWebhook(webhookUrl, payload, fetchImpl)
        : null);
    if (!sender) {
      record.status = 'queued';
      await store.persist();
      return record;
    }
    try {
      await sender({
        nfp: true,
        kind: 'role_promoted',
        templateId: record.templateId,
        role: record.role,
        to: record.to,
        from: record.from,
        subject: record.subject,
        text: record.text,
        html: record.html,
        userId: record.userId,
        handle: record.meta?.handle || null,
        meta: record.meta || {},
      });
      record.status = 'sent';
      record.sentAt = new Date().toISOString();
      record.error = null;
    } catch (err) {
      record.status = 'failed';
      record.error = err?.message || String(err);
    }
    await store.persist();
    return record;
  }

  async function notifyRolePromotion({
    user,
    role,
    created = true,
    grantedBy,
    jurisdiction,
    election,
    contactEmail,
  } = {}) {
    if (!created) {
      return { skipped: true, reason: 'already_granted' };
    }
    if (!isPromotionRole(role)) {
      return { skipped: true, reason: 'not_a_promotion' };
    }
    if (!user) {
      return { skipped: true, reason: 'no_user' };
    }

    if (contactEmail) {
      await store.setContactEmail(user.id, contactEmail);
    }
    const fresh = store.getUser(user.id) || user;
    const copy = renderPromotionEmail(role, {
      handle: fresh.handle,
      jurisdictionId: jurisdiction?.id || '',
      jurisdictionName: jurisdiction?.name || '',
      electionId: election ? String(election.id) : '',
      electionTitle: election?.title || '',
      grantedByHandle: grantedBy?.handle || '',
      publicBaseUrl: config?.publicBaseUrl,
    });
    if (!copy) {
      return { skipped: true, reason: 'unknown_template' };
    }

    const notification = await store.addNotification({
      userId: fresh.id,
      type: 'role_promoted',
      title: copy.notificationTitle,
      body: copy.notificationBody,
      electionId: election?.id || null,
    });

    const record = {
      id: randomUUID(),
      templateId: copy.templateId,
      role,
      userId: fresh.id,
      to: String(fresh.contactEmail || '').trim().toLowerCase() || null,
      from: config?.mailFrom || 'Republic civic elections <noreply@localhost>',
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
      status: 'queued',
      error: null,
      createdAt: new Date().toISOString(),
      sentAt: null,
      meta: {
        handle: fresh.handle,
        grantedByHandle: grantedBy?.handle || null,
        jurisdictionId: jurisdiction?.id || null,
        jurisdictionName: jurisdiction?.name || null,
        electionId: election ? String(election.id) : null,
        electionTitle: election?.title || null,
      },
    };
    await enqueue(record);
    await deliver(record);
    return { skipped: false, reason: null, mail: record, notification };
  }

  return {
    notifyRolePromotion,
    deliver,
    parseContactEmail,
  };
}
