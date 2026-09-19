// NOT FOR PROFIT — civic public good, not a commercial product.
// Public election-outcomes monitor API. Separate from /api/elections/:id/results
// and /api/receipts. Never returns how a person voted.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { publishDue } from '../electionState.mjs';
import { presentOutcomeDetail, presentOutcomesIndex } from '../outcomes.mjs';

export function outcomesRouter(deps) {
  const router = Router();

  router.get(
    '/outcomes',
    asyncHandler(async (_req, res) => {
      const { now } = await publishDue(deps);
      res.json(presentOutcomesIndex(deps, { now }));
    }),
  );

  router.get(
    '/outcomes/:id',
    asyncHandler(async (req, res) => {
      const { now } = await publishDue(deps);
      const election = deps.store.getElection(req.params.id);
      if (!election) throw new HttpError(404, 'election not found');
      res.json(presentOutcomeDetail(election, deps, { now }));
    }),
  );

  return router;
}
