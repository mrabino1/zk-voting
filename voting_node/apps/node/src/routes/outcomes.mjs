// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election-outcomes monitor API. Separate from /api/elections/:id/results
// and /api/receipts. Never returns how a person voted.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { publishDue } from '../electionState.mjs';
import { presentOutcomeDetail, presentOutcomesIndex } from '../outcomes.mjs';
import { dispatchOfficialOutcomeReports } from '../outcomeReports.mjs';
import { rollupAudit } from '../rollup/audit.mjs';

import { uuidParam } from '../recordIds.mjs';

export function outcomesRouter(deps) {
  const router = Router();
  router.param('id', uuidParam('id'));

  router.get(
    '/outcomes',
    asyncHandler(async (_req, res) => {
      const { now } = await publishDue(deps);
      await dispatchOfficialOutcomeReports(deps, { now }).catch(() => null);
      res.json(presentOutcomesIndex(deps, { now }));
    }),
  );

  router.get(
    '/outcomes/:id',
    asyncHandler(async (req, res) => {
      const { now } = await publishDue(deps);
      const election = deps.store.getElection(req.params.id);
      if (!election) throw new HttpError(404, 'election not found');
      const detail = presentOutcomeDetail(election, deps, { now });
      // A civic vote is also audited from L1 itself (tools/auditor verify-rollup).
      const l1 = await rollupAudit(election, deps);
      if (l1) {
        detail.verification.l1 = l1;
        if (l1.ok === false) {
          detail.verification.ok = false;
          detail.verification.errors = [...detail.verification.errors, ...l1.errors.map((e) => `L1 audit: ${e}`)];
        }
      }
      res.json(detail);
    }),
  );

  return router;
}
