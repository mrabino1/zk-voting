// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import {
  FEEDBACK_OPERATOR_WARNING,
  FEEDBACK_SES_WARNING,
  FEEDBACK_USER_UNAVAILABLE,
  clientAddress,
  createFeedbackLimiter,
  feedbackAcceptanceLog,
  feedbackDeliveryMode,
  feedbackRefusalLog,
  parseFeedbackBody,
  publicFeedbackStatus,
  resolveOperatorInbox,
  stripControls,
} from '../feedback.mjs';
import { renderFeedbackEmail } from '../feedbackMail.mjs';
import { HttpError, asyncHandler } from '../http.mjs';
import { getTermsDocument } from '../terms.mjs';

export function feedbackRouter(deps) {
  const { store, config, mailer } = deps;
  const router = Router();
  const limiter = createFeedbackLimiter({
    windowMs: Number(config.feedbackWindowMs ?? 15 * 60 * 1000),
    max: Number(config.feedbackMaxPerWindow ?? 5),
    now: () => Date.now(),
  });
  const maxBytes = Number(config.feedbackMaxBodyBytes ?? 16 * 1024);

  router.get(
    '/feedback',
    asyncHandler(async (req, res) => {
      const doc = getTermsDocument();
      res.json(publicFeedbackStatus({ config, store, user: req.user, terms: doc }));
    }),
  );

  router.post(
    '/feedback',
    asyncHandler(async (req, res) => {
      const declared = Number(req.headers['content-length'] || 0);
      const measured = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
      if ((declared && declared > maxBytes) || measured > maxBytes) {
        throw new HttpError(413, 'That message is too large.', { code: 'FEEDBACK_BODY' });
      }

      const limit = limiter.check(clientAddress(req));
      if (!limit.ok) {
        res.set('Retry-After', String(limit.retryAfter));
        throw new HttpError(429, 'Too many messages from this network. Try again later.', {
          code: 'FEEDBACK_RATE_LIMIT',
          retryAfter: limit.retryAfter,
        });
      }

      const parsed = parseFeedbackBody(req.body, config, Date.now());
      if (!parsed.ok) {
        throw new HttpError(parsed.status, parsed.error, { code: parsed.code });
      }

      const inbox = resolveOperatorInbox(store, config);
      if (!inbox) {
        console.warn(feedbackRefusalLog(FEEDBACK_OPERATOR_WARNING));
        throw new HttpError(503, FEEDBACK_USER_UNAVAILABLE, {
          code: 'FEEDBACK_NOT_CONFIGURED',
          operatorWarning: FEEDBACK_OPERATOR_WARNING,
        });
      }

      const delivery = feedbackDeliveryMode(config);
      if (delivery.mode === 'unavailable') {
        console.warn(feedbackRefusalLog(FEEDBACK_SES_WARNING));
        throw new HttpError(503, FEEDBACK_USER_UNAVAILABLE, {
          code: 'FEEDBACK_SES_UNAVAILABLE',
          operatorWarning: FEEDBACK_SES_WARNING,
        });
      }

      const doc = getTermsDocument();
      const acceptedAt = new Date().toISOString();
      const requestMeta = {
        method: 'POST',
        path: '/api/feedback',
        userAgent: stripControls(req.get('user-agent') || '', { max: 180 }),
        acceptLanguage: stripControls(req.get('accept-language') || '', { max: 80 }),
        contentLength: measured,
      };
      const rendered = renderFeedbackEmail({
        ...parsed.value,
        acceptedAt,
        termsVersion: doc.version,
        termsHash: doc.pdfSha256,
        markdownSha256: doc.markdownSha256,
        request: requestMeta,
      });

      await mailer.send({
        to: inbox.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: parsed.value.replyTo || undefined,
        meta: {
          purpose: 'feedback',
          category: parsed.value.category,
          termsVersion: doc.version,
          termsHash: doc.pdfSha256,
          markdownSha256: doc.markdownSha256,
          acceptedAt,
        },
      });

      console.info(
        feedbackAcceptanceLog({
          category: parsed.value.category,
          termsVersion: doc.version,
          termsHash: doc.pdfSha256,
          acceptedAt,
        }),
      );

      res.status(201).json({
        ok: true,
        nfp: true,
        delivered: delivery.mode,
        acceptedAt,
        termsVersion: doc.version,
        termsHash: doc.pdfSha256,
      });
    }),
  );

  return router;
}
