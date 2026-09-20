// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { HttpError } from '../http.mjs';
import { requireAuth, requireRole } from '../auth.mjs';
import { publicMailSummary } from '../mailer.mjs';
import {
  listPromotionTemplates,
  renderPromotionTemplate,
  roleFromTemplateId,
  isPromotionRole,
} from '../mailTemplates.mjs';

export function mailRouter(deps) {
  const { store, config } = deps;
  const router = Router();

  router.get(
    '/mail/templates',
    requireAuth,
    requireRole('platform_admin'),
    (_req, res) => {
      res.json({
        nfp: true,
        templates: listPromotionTemplates(),
        note: 'Role-promotion mail is queued on the Node. It is never written to civic L2 transactions.',
      });
    },
  );

  router.get(
    '/mail/templates/:id',
    requireAuth,
    requireRole('platform_admin'),
    (req, res) => {
      const raw = decodeURIComponent(req.params.id);
      const role = isPromotionRole(raw) ? raw : roleFromTemplateId(raw);
      const rendered = renderPromotionTemplate(role ? `role_promoted.${role}` : raw, {
        handle: req.query.handle,
        jurisdictionId: req.query.jurisdictionId,
        jurisdictionName: req.query.jurisdictionName,
        electionId: req.query.electionId,
        electionTitle: req.query.electionTitle,
        grantedByHandle: req.query.grantedByHandle || req.user?.handle,
        publicBaseUrl: config.publicBaseUrl,
        sample: true,
      });
      if (!rendered) throw new HttpError(404, 'mail template not found');
      res.json({ nfp: true, template: rendered });
    },
  );

  router.get(
    '/mail/outbox',
    requireAuth,
    requireRole('platform_admin'),
    (_req, res) => {
      res.json({
        nfp: true,
        outbox: store.listMailOutbox().map(publicMailSummary),
      });
    },
  );

  router.get(
    '/mail/outbox/:id',
    requireAuth,
    requireRole('platform_admin'),
    (req, res) => {
      const record = store.getMail(req.params.id);
      if (!record) throw new HttpError(404, 'mail not found');
      res.json({
        nfp: true,
        mail: {
          ...publicMailSummary(record),
          text: record.text,
          html: record.html,
        },
      });
    },
  );

  return router;
}
