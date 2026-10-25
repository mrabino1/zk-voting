// NOT FOR PROFIT — civic public good, not a commercial product.
// Official outcome PDF issue, subscribe, verify, and admin template.

import { Router } from 'express';

import { requireAuth, requireRole } from '../auth.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { publishDue } from '../electionState.mjs';
import {
  deliverOutcomeReportToUser,
  dispatchOfficialOutcomeReports,
  lookupOutcomeReport,
  OUTCOME_REPORT_PDF_FILENAME,
  presentOutcomeReport,
  presentOutcomeReportTemplate,
  previewOutcomeReportPdf,
  sanitizeOutcomeReportTemplate,
  subscribeVoterToOutcome,
} from '../outcomeReports.mjs';

import { uuidParam } from '../recordIds.mjs';

export function outcomeReportsRouter(deps) {
  const router = Router();
  router.param('id', uuidParam('id'));
  router.param('electionId', uuidParam('electionId'));

  router.get(
    '/outcomes/reports',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      await dispatchOfficialOutcomeReports(deps);
      const electionId = req.query.electionId || req.query.election || req.query.id;
      const rows = electionId
        ? [deps.store.getOutcomeReportForElection(electionId)].filter(Boolean)
        : deps.store.listOutcomeReports();
      res.json({
        nfp: true,
        schema: 'zk-voting.outcome-report.v1',
        reports: rows.map((row) =>
          presentOutcomeReport(row, {
            electionTitle: deps.store.getElection(row.electionId)?.title,
          }),
        ),
      });
    }),
  );

  router.get(
    '/outcomes/reports/:id/pdf',
    asyncHandler(async (req, res) => {
      await dispatchOfficialOutcomeReports(deps, { electionId: req.params.id }).catch(() => null);
      const row =
        deps.store.getOutcomeReport(req.params.id) ||
        deps.store.getOutcomeReportForElection(req.params.id);
      if (!row?.pdf) throw new HttpError(404, 'official outcome report not found');
      const pdf = Buffer.from(row.pdf, 'base64');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${OUTCOME_REPORT_PDF_FILENAME}"`);
      res.setHeader('X-Pdf-SHA256', row.pdfSha256);
      res.setHeader('X-Pdf-Protected', 'true');
      res.setHeader('X-Pdf-Modify', 'false');
      if (row.integrity) res.setHeader('X-Pdf-Integrity', row.integrity);
      res.send(pdf);
    }),
  );

  router.get(
    '/outcomes/reports/:id',
    asyncHandler(async (req, res) => {
      await dispatchOfficialOutcomeReports(deps, { electionId: req.params.id }).catch(() => null);
      const row =
        deps.store.getOutcomeReport(req.params.id) ||
        deps.store.getOutcomeReportForElection(req.params.id);
      if (!row) throw new HttpError(404, 'official outcome report not found');
      res.json(
        presentOutcomeReport(row, {
          electionTitle: deps.store.getElection(row.electionId)?.title,
          verifyUrl: row.verifyUrl,
        }),
      );
    }),
  );

  router.post(
    '/outcomes/verify',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const body = req.body || {};
      const result = lookupOutcomeReport(deps, body, body);
      res.json(result);
    }),
  );

  router.get(
    '/admin/outcome-report-template',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (_req, res) => {
      res.json({
        nfp: true,
        template: presentOutcomeReportTemplate(deps.store.getOutcomeReportTemplate()),
      });
    }),
  );

  router.patch(
    '/admin/outcome-report-template',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const next = sanitizeOutcomeReportTemplate(req.body || {}, deps.store.getOutcomeReportTemplate());
      await deps.store.updateOutcomeReportTemplate(next);
      res.json({
        ok: true,
        nfp: true,
        template: presentOutcomeReportTemplate(deps.store.getOutcomeReportTemplate()),
      });
    }),
  );

  router.post(
    '/admin/outcome-report-template/preview',
    requireAuth,
    requireRole('platform_admin'),
    asyncHandler(async (req, res) => {
      const artifact = await previewOutcomeReportPdf(deps, {
        electionId: req.body?.electionId,
        template: req.body || {},
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="zk-voting-outcome-preview.pdf"`);
      res.setHeader('X-Pdf-SHA256', artifact.pdfSha256);
      res.setHeader('X-Pdf-Protected', 'true');
      res.setHeader('X-Pdf-Modify', 'false');
      res.setHeader('X-Pdf-Preview', 'true');
      res.send(artifact.pdf);
    }),
  );

  router.get(
    '/me/outcome-subscriptions',
    requireAuth,
    asyncHandler(async (req, res) => {
      await dispatchOfficialOutcomeReports(deps);
      const elections = deps.store.listElections();
      const rows = elections.map((election) => {
        const sub = deps.store.findOutcomeSubscription(req.user.id, election.id);
        const report = deps.store.getOutcomeReportForElection(election.id);
        return {
          electionId: String(election.id),
          electionTitle: election.title,
          startTime: election.startTime,
          cutoffTime: election.cutoffTime,
          subscribed: sub ? sub.subscribed !== false : false,
          source: sub?.source || null,
          votedDefault: sub?.source === 'vote-default',
          reportId: report?.id || null,
          reportIssued: Boolean(report),
          pdfSha256: report?.pdfSha256 || null,
        };
      });
      res.json({
        nfp: true,
        defaultSubscribeOnVote: true,
        unsubscribeByException: true,
        subscriptions: rows.filter((r) => r.source || r.subscribed || r.reportIssued),
        all: rows,
      });
    }),
  );

  router.put(
    '/me/outcome-subscriptions/:electionId',
    requireAuth,
    asyncHandler(async (req, res) => {
      const election = deps.store.requireElection(req.params.electionId);
      const subscribed = req.body?.subscribed !== false && req.body?.subscribed !== 0;
      const row = await deps.store.upsertOutcomeSubscription({
        userId: req.user.id,
        electionId: election.id,
        subscribed,
        source: subscribed ? 'manual' : 'exception',
      });
      if (subscribed) {
        await deliverOutcomeReportToUser(deps, { user: req.user, electionId: election.id });
      }
      res.json({ ok: true, nfp: true, subscription: row });
    }),
  );

  router.post(
    '/me/outcome-subscriptions',
    requireAuth,
    asyncHandler(async (req, res) => {
      const electionId = req.body?.electionId || req.body?.id;
      if (!electionId) throw new HttpError(400, 'electionId required');
      const election = deps.store.requireElection(electionId);
      const row = await subscribeVoterToOutcome(deps.store, {
        userId: req.user.id,
        electionId: election.id,
        source: 'manual',
      });
      await deliverOutcomeReportToUser(deps, { user: req.user, electionId: election.id });
      res.status(201).json({ ok: true, nfp: true, subscription: row });
    }),
  );

  return router;
}
