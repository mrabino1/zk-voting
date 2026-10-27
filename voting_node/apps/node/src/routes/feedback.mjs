// NOT FOR PROFIT — civic public good, not a commercial product.
// POST /api/feedback delivers one visitor message to the platform super admin.

import { Router } from 'express';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_INBOX_WARNING,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_NAME_MAX,
  FEEDBACK_SES_WARNING,
  FEEDBACK_USER_UNAVAILABLE,
  createFeedbackRateLimiter,
  currentTermsAcceptance,
  feedbackClientIp,
  feedbackDeliveryMode,
  feedbackNowMs,
  parseFeedbackSubmission,
  resolvePlatformOperatorEmail,
  retryCopy,
} from '../feedback.mjs';
import { renderFeedbackEmail } from '../feedbackMail.mjs';
import { noteDemoAbuse } from '../demoPurge.mjs';
import { asyncHandler } from '../http.mjs';
import { getTermsDocument } from '../terms.mjs';

function requestMeta(req) {
  const agent = String(req.get('user-agent') || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 200);
  const language = String(req.get('accept-language') || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 80);
  return { userAgent: agent, acceptLanguage: language };
}

export function feedbackRouter(deps) {
  const limiter = createFeedbackRateLimiter();
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const doc = getTermsDocument();
      const inbox = resolvePlatformOperatorEmail(deps.store);
      res.json({
        nfp: true,
        categories: FEEDBACK_CATEGORIES,
        messageMax: FEEDBACK_MESSAGE_MAX,
        nameMax: FEEDBACK_NAME_MAX,
        minSubmitMs: deps.config.feedbackMinSubmitMs,
        rateWindowSeconds: deps.config.feedbackRateWindowSeconds,
        maxPerWindow: 1,
        assignmentRequired: true,
        inboxConfigured: Boolean(inbox),
        termsVersion: String(doc.version),
        termsPdfSha256: doc.pdfSha256,
        termsMarkdownSha256: doc.markdownSha256,
      });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const now = feedbackNowMs(deps.config);
      const rawSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
      if (rawSize > deps.config.feedbackMaxBodyBytes) {
        res.status(413).json({
          error: 'Feedback is too large.',
          nfp: true,
          code: 'PAYLOAD_TOO_LARGE',
        });
        return;
      }

      const parsed = parseFeedbackSubmission(req.body, deps.config, now);
      if (!parsed.ok) {
        if (parsed.code === 'HONEYPOT' && req.user?.id) {
          noteDemoAbuse(deps.store, deps.config, req.user.id, 'HONEYPOT');
        }
        res.status(parsed.status).json({
          error: parsed.error,
          nfp: true,
          code: parsed.code,
          ...(parsed.fields?.length ? { fields: parsed.fields } : {}),
        });
        return;
      }

      const ip = feedbackClientIp(req, deps.config);
      const windowMs = deps.config.feedbackRateWindowSeconds * 1000;
      const retryAfterSeconds = limiter.retryAfterSeconds(ip, now, windowMs);
      if (retryAfterSeconds > 0) {
        if (req.user?.id) noteDemoAbuse(deps.store, deps.config, req.user.id, 'RATE_LIMITED');
        const copy = retryCopy(retryAfterSeconds);
        res.set('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          error: copy.error,
          nfp: true,
          code: 'RATE_LIMITED',
          retryAfterSeconds,
          minutes: copy.minutes,
        });
        return;
      }

      const to = resolvePlatformOperatorEmail(deps.store);
      if (!to) {
        console.warn(FEEDBACK_INBOX_WARNING);
        res.status(503).json({
          error: FEEDBACK_USER_UNAVAILABLE,
          nfp: true,
          code: 'FEEDBACK_UNAVAILABLE',
        });
        return;
      }

      const mode = feedbackDeliveryMode(deps.config);
      if (mode === 'unconfigured') {
        console.warn(FEEDBACK_SES_WARNING);
        res.status(503).json({
          error: FEEDBACK_USER_UNAVAILABLE,
          nfp: true,
          code: 'FEEDBACK_UNAVAILABLE',
        });
        return;
      }

      const acceptance = currentTermsAcceptance(now);
      const meta = requestMeta(req);
      const rendered = renderFeedbackEmail({
        ...parsed.value,
        acceptance,
        userAgent: meta.userAgent,
        acceptLanguage: meta.acceptLanguage,
      });

      try {
        await deps.mailer.send({
          to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          replyTo: parsed.value.replyTo || undefined,
          meta: {
            purpose: 'feedback',
            delivery: mode,
            category: parsed.value.category,
            acceptedAt: acceptance.acceptedAt,
            termsVersion: acceptance.termsVersion,
            termsPdfSha256: acceptance.termsPdfSha256,
          },
        });
      } catch (err) {
        console.warn(
          `[zk-voting] feedback refused: SES send failed (${err?.name || 'Error'}). The message was not sent.`,
        );
        res.status(503).json({
          error: FEEDBACK_USER_UNAVAILABLE,
          nfp: true,
          code: 'FEEDBACK_UNAVAILABLE',
        });
        return;
      }

      limiter.commit(ip, now);
      console.info(
        `[zk-voting] feedback accepted at=${acceptance.acceptedAt} termsVersion=${acceptance.termsVersion} termsPdfSha256=${acceptance.termsPdfSha256}`,
      );
      res.json({
        ok: true,
        nfp: true,
        acceptedAt: acceptance.acceptedAt,
        termsVersion: acceptance.termsVersion,
        termsPdfSha256: acceptance.termsPdfSha256,
      });
    }),
  );

  return router;
}
