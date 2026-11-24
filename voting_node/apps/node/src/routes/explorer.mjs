// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { presentElection, publishDue } from '../electionState.mjs';
import { refsOf } from '../electionIds.mjs';
import { uuidParam } from '../recordIds.mjs';

export function explorerRouter(deps) {
  const { explorer, config, store, rollup } = deps;
  const router = Router();
  router.param('id', uuidParam('id'));

  // Rollup batches, read from the L2 operator. Public: the same data is in L1 pubdata.
  // No live ballot count: the operator's pending-ballot figure is not passed on.
  router.get(
    '/rollup',
    asyncHandler(async (req, res) => {
      if (!rollup?.enabled) {
        res.json({ nfp: true, configured: false, status: null, batches: [] });
        return;
      }
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
      let status = null;
      let batches = [];
      let error = null;
      try {
        const [st, list] = await Promise.all([rollup.client.l2Status(), rollup.client.l2Batches(limit)]);
        if (st) {
          const { pendingBallots: _hidden, ...rest } = st;
          status = rest;
        }
        batches = Array.isArray(list?.batches) ? list.batches : [];
      } catch (err) {
        error = err.message || 'the L2 operator is unreachable';
      }
      res.json({ nfp: true, configured: true, status, batches, error });
    }),
  );

  router.get(
    '/disclosure',
    asyncHandler(async (_req, res) => {
      const { now, interval, view } = await publishDue(deps);
      res.json({
        nfp: true,
        chainId: explorer.chain.chainId || config.chainId,
        disclosure: view || explorer.publicDisclosure(now, interval),
      });
    }),
  );

  router.get(
    '/blocks',
    asyncHandler(async (req, res) => {
      const { now, interval, view } = await publishDue(deps);
      let blocks = explorer.listBlocks();
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const before = req.query.before != null && req.query.before !== '' ? Number(req.query.before) : null;
      if (Number.isInteger(before) && before > 0) {
        blocks = blocks.filter((b) => b.number < before);
      }
      blocks = blocks.slice(0, limit);
      res.json({
        nfp: true,
        chainId: explorer.chain.chainId || config.chainId,
        head: explorer.headNumber(),
        blocks,
        disclosure: view || explorer.publicDisclosure(now, interval),
      });
    }),
  );

  router.get(
    '/blocks/:n',
    asyncHandler(async (req, res) => {
      const { now, interval, view } = await publishDue(deps);
      const n = req.params.n === 'latest' ? explorer.headNumber() : Number(req.params.n);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid block number');
      const block = explorer.getBlock(n);
      if (!block) throw new HttpError(404, 'block not found');
      res.json({
        nfp: true,
        chainId: explorer.chain.chainId || config.chainId,
        block,
        disclosure: view || explorer.publicDisclosure(now, interval),
      });
    }),
  );

  router.get(
    '/txs/:hash',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const tx = explorer.getTx(req.params.hash);
      if (!tx) throw new HttpError(404, 'tx not found');
      res.json({ nfp: true, tx });
    }),
  );

  router.get(
    '/nullifiers/:value',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const tx = explorer.findByNullifier(req.params.value);
      if (!tx) throw new HttpError(404, 'nullifier not found');
      res.json({ nfp: true, tx, nullifier: tx.nullifier, ballotHash: tx.ballotHash });
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const q = String(req.query.q || '');
      const result = explorer.search(q);
      res.json({ nfp: true, query: q, ...result });
    }),
  );

  router.get(
    '/elections/:id',
    asyncHandler(async (req, res) => {
      await publishDue(deps);
      const election = store.requireElection(req.params.id);
      const allowed = refsOf(election);
      const result = explorer.search(`election:${election.id}`);
      const extra = Object.values(explorer.chain.txs)
        .map((t) => explorer.presentTx(t))
        .filter((t) => t && allowed.has(String(t.electionId)));
      const seen = new Set((result.txs || []).map((t) => t.hash));
      for (const tx of extra) {
        if (tx.hash && !seen.has(tx.hash)) result.txs.push(tx);
      }
      const presented = presentElection(election, deps);
      const txs = result.txs || [];
      res.json({
        nfp: true,
        election: presented,
        txs,
        disclosure: presented.disclosure,
      });
    }),
  );

  return router;
}
