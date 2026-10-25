// NOT FOR PROFIT — civic public good, not a commercial product.
// Token-poll HTTP API. Mounted only when POLLS_ENABLED=1.
// Ballot acceptance does not require a Republic account.

import { Router } from 'express';

import { requireAuth, requireSuperAdmin } from '../auth.mjs';
import { asyncHandler } from '../http.mjs';
import { uuidParam } from '../recordIds.mjs';
import {
  buildPollAuditorPack,
  castBallot,
  createPoll,
  disclosedBallots,
  getPollView,
  listPolls,
  pollOutcomePdf,
  resultsView,
  schedulePoll,
  tallyPoll,
  typedDataFor,
  updatePoll,
  weightView,
} from '../polls.mjs';

function tallyActor(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated', nfp: true });
    return;
  }
  next();
}

export function pollsRouter(deps) {
  const router = Router();
  router.param('id', uuidParam('id'));

  router.post(
    '/',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const created = await createPoll(deps, req.user, req.body || {});
      res.status(201).json(created);
    }),
  );

  router.patch(
    '/:id',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      res.json(await updatePoll(deps, req.user, req.params.id, req.body || {}));
    }),
  );

  router.post(
    '/:id/schedule',
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      res.json(await schedulePoll(deps, req.user, req.params.id));
    }),
  );

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ nfp: true, binding: false, polls: listPolls(deps) });
    }),
  );

  router.get(
    '/:id/weight',
    asyncHandler(async (req, res) => {
      res.json(await weightView(deps, req.params.id, req.query.address));
    }),
  );

  router.get(
    '/:id/typed-data',
    asyncHandler(async (req, res) => {
      const choices = String(req.query.choices || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      res.json(typedDataFor(deps, req.params.id, req.query.address, choices, req.query.issuedAt));
    }),
  );

  router.post(
    '/:id/ballots',
    asyncHandler(async (req, res) => {
      const body = { ...(req.body || {}), pollId: req.params.id };
      res.status(201).json(await castBallot(deps, body));
    }),
  );

  router.post(
    '/:id/tally',
    tallyActor,
    asyncHandler(async (req, res) => {
      res.json(await tallyPoll(deps, req.user, req.params.id));
    }),
  );

  router.get(
    '/:id/results',
    asyncHandler(async (req, res) => {
      res.json(resultsView(deps, req.params.id));
    }),
  );

  router.get(
    '/:id/artifacts',
    asyncHandler(async (req, res) => {
      res.json(buildPollAuditorPack(deps, req.params.id));
    }),
  );

  router.get(
    '/:id/ballots.json',
    asyncHandler(async (req, res) => {
      res.json(disclosedBallots(deps, req.params.id));
    }),
  );

  router.get(
    '/:id/outcome.pdf',
    asyncHandler(async (req, res) => {
      const pdf = pollOutcomePdf(deps, req.params.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="token-poll-outcome.pdf"');
      res.send(pdf);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      res.json(getPollView(deps, req.params.id));
    }),
  );

  return router;
}
