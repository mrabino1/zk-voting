// NOT FOR PROFIT — civic public good, not a commercial product.
// Email + PDF vote receipts and the public paste-to-verify portal API.
// Never returns a candidate, option, or ballot opening.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { publishDue } from '../electionState.mjs';
import {
  emailReceipt,
  lookupReceipt,
  publicReceiptMetrics,
  receiptPdfForToken,
} from '../receipts.mjs';

export function receiptsRouter(deps) {
  const router = Router();

  router.get(
    '/receipts/metrics',
    asyncHandler(async (req, res) => {
      const { now, interval, view } = await publishDue(deps);
      const electionId = req.query.electionId || req.query.election || req.query.id;
      const election = electionId ? deps.store.getElection(electionId) : null;
      if (electionId && !election) throw new HttpError(404, 'election not found');
      res.json(publicReceiptMetrics(election, deps, { now, interval, view }));
    }),
  );

  router.post(
    '/receipts/verify',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const body = req.body || {};
      const result = lookupReceipt(deps, body.proof || body.receipt || body.text, body);
      res.json(result);
    }),
  );

  router.post(
    '/receipts/email',
    asyncHandler(async (req, res) => {
      const result = await emailReceipt(deps, req, req.body || {});
      res.json(result);
    }),
  );

  router.post(
    '/receipts/pdf',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const artifact = await receiptPdfForToken(deps, body.proof || body.receipt || body.text, body);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      res.setHeader('X-Pdf-SHA256', artifact.pdfSha256);
      res.setHeader('X-Pdf-Protected', 'true');
      res.setHeader('X-Pdf-Modify', 'false');
      res.setHeader('X-Receipts-Prove-Choice', 'false');
      if (artifact.integrity) res.setHeader('X-Pdf-Integrity', artifact.integrity);
      res.send(artifact.pdf);
    }),
  );

  return router;
}
