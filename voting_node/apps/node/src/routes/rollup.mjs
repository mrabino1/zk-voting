// NOT FOR PROFIT — civic public good, not a commercial product.
// /api/elections/:id/rollup — civic votes on the ZK-Voting rollup (src/rollup/service.mjs).

import { Router } from 'express';

import { requireAuth, requireElectionRole } from '../auth.mjs';
import { asyncHandler } from '../http.mjs';

export function rollupRouter({ store, rollup }) {
  const router = Router({ mergeParams: true });
  const staff = (...roles) => [requireAuth, requireElectionRole(store, ...roles)];
  const ok = (res, body, status = 200) => res.status(status).json({ ...body, nfp: true });

  // Public: status, guardians, L1 election, result.
  router.get('/', asyncHandler(async (req, res) => ok(res, await rollup.view(req.params.id))));

  // Public: what a browser needs to encrypt a ballot.
  router.get('/ballot-context', asyncHandler(async (req, res) => ok(res, await rollup.ballotContext(req.params.id))));

  // Public: a voter checks their own ballot by nullifier.
  router.get(
    '/receipts/:nullifier',
    asyncHandler(async (req, res) => {
      const receipt = await rollup.receipt(req.params.id, req.params.nullifier);
      return receipt ? ok(res, receipt) : res.status(404).json({ error: 'no ballot under this nullifier', nfp: true });
    }),
  );

  router.post(
    '/prepare',
    ...staff('clerk', 'tally_operator'),
    asyncHandler(async (req, res) => ok(res, { rollup: await rollup.prepare(req.params.id, req.body || {}) })),
  );
  router.post(
    '/guardians',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, { guardian: await rollup.enrollGuardian(req.params.id, req.body || {}) }, 201)),
  );
  router.post(
    '/publish',
    ...staff('clerk'),
    asyncHandler(async (req, res) => ok(res, await rollup.publish(req.params.id, req.body || {}), 201)),
  );

  // Guardian ceremony relay. The bodies carry the guardians' own signatures or proofs.
  router.post(
    '/guardians/:index/commit',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, await rollup.commitGuardian(req.params.id, req.params.index, req.body))),
  );
  router.post(
    '/mailbox',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, await rollup.postShareMessage(req.params.id, req.body || {}), 201)),
  );
  router.get(
    '/mailbox/:index',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, { messages: rollup.inbox(req.params.id, req.params.index) })),
  );
  router.post(
    '/disputes/:action',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, await rollup.dispute(req.params.id, req.params.action, req.body))),
  );
  router.post(
    '/finalize-key',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) => ok(res, await rollup.finalizeKey(req.params.id))),
  );
  router.post(
    '/roll/sync',
    ...staff('registrar', 'clerk'),
    asyncHandler(async (req, res) => ok(res, await rollup.syncRoll(req.params.id))),
  );

  // After cutoff: close is permissionless on L1, so any signed-in user may trigger it here.
  router.post('/close', requireAuth, asyncHandler(async (req, res) => ok(res, await rollup.close(req.params.id))));
  router.post(
    '/guardians/:index/shares',
    ...staff('tally_operator'),
    asyncHandler(async (req, res) =>
      ok(res, await rollup.postShares(req.params.id, req.params.index, req.body?.shares)),
    ),
  );
  router.post('/finalize', requireAuth, asyncHandler(async (req, res) => ok(res, await rollup.finalize(req.params.id))));

  return router;
}
