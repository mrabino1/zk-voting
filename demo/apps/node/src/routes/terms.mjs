// NOT FOR PROFIT — civic public good, not a commercial product.
// Public Terms of Use: page data, PDF download, accept (email PDF), view log.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { userEmail } from '../identity.mjs';
import { isAcceptedTermsFlag, requireAcceptedTerms } from '../terms.mjs';

export function termsApiRouter(deps) {
  const { store, terms } = deps;
  const router = Router();

  router.get(
    '/terms',
    asyncHandler(async (req, res) => {
      const doc = terms.publicView();
      const mine = req.user ? store.latestTermsAcceptance(req.user.id) : null;
      res.json({
        ...doc,
        accepted: Boolean(mine && mine.pdfSha256 === doc.pdfSha256),
        acceptance: mine ? terms.publicRecord(mine) : null,
        emailMfaVendor: 'ses',
      });
    }),
  );

  router.get(
    '/terms.pdf',
    asyncHandler(async (_req, res) => {
      const doc = terms.document();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
      res.setHeader('X-Pdf-SHA256', doc.pdfSha256);
      res.setHeader('X-Markdown-SHA256', doc.markdownSha256);
      res.send(doc.pdf);
    }),
  );

  router.post(
    '/terms/view',
    asyncHandler(async (req, res) => {
      if (!req.user) {
        res.json({ nfp: true, recorded: false, ...terms.publicView() });
        return;
      }
      const { record } = await terms.view({
        user: req.user,
        sessionId: req.sessionId,
        source: 'page',
      });
      res.json({
        nfp: true,
        recorded: Boolean(record),
        view: terms.publicRecord(record),
        ...terms.publicView(),
      });
    }),
  );

  router.post(
    '/terms/accept',
    asyncHandler(async (req, res) => {
      if (!req.user) {
        throw new HttpError(401, 'sign in to accept the Terms');
      }
      requireAcceptedTerms(req.body || {});
      const { record, document } = await terms.accept({
        user: req.user,
        email: userEmail(req.user),
        sessionId: req.sessionId,
        source: req.body?.source || 'page',
        emailPdf: req.body?.emailPdf !== false,
      });
      res.json({
        nfp: true,
        ok: true,
        emailed: Boolean(record.emailed),
        emailSkipped: record.emailSkipped || null,
        pdfSha256: document.pdfSha256,
        markdownSha256: document.markdownSha256,
        termsVersion: document.version,
        acceptance: terms.publicRecord(record),
      });
    }),
  );

  return router;
}

export function termsPdfRouter(deps) {
  const { terms } = deps;
  const router = Router();
  router.get(
    ['/terms.pdf', '/legal/republic-terms.pdf'],
    asyncHandler(async (_req, res) => {
      const doc = terms.document();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
      res.setHeader('X-Pdf-SHA256', doc.pdfSha256);
      res.setHeader('X-Markdown-SHA256', doc.markdownSha256);
      res.send(doc.pdf);
    }),
  );
  return router;
}

export { isAcceptedTermsFlag };
