// NOT FOR PROFIT — civic public good, not a commercial product.

import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { publicElection } from '../electionState.mjs';

export function explorerRouter(deps) {
  const { explorer, config, store } = deps;
  const router = Router();

  router.get(
    '/blocks',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
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
      });
    }),
  );

  router.get(
    '/blocks/:n',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
      const n = req.params.n === 'latest' ? explorer.headNumber() : Number(req.params.n);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid block number');
      const block = explorer.getBlock(n);
      if (!block) throw new HttpError(404, 'block not found');
      res.json({ nfp: true, chainId: explorer.chain.chainId || config.chainId, block });
    }),
  );

  router.get(
    '/txs/:hash',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
      const tx = explorer.getTx(req.params.hash);
      if (!tx) throw new HttpError(404, 'tx not found');
      res.json({ nfp: true, tx });
    }),
  );

  router.get(
    '/nullifiers/:value',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
      const tx = explorer.findByNullifier(req.params.value);
      if (!tx) throw new HttpError(404, 'nullifier not found');
      res.json({ nfp: true, tx, nullifier: tx.nullifier, ballotHash: tx.ballotHash });
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
      const q = String(req.query.q || '');
      const result = explorer.search(q);
      res.json({ nfp: true, query: q, ...result });
    }),
  );

  router.get(
    '/elections/:id',
    asyncHandler(async (req, res) => {
      await explorer.refresh();
      const election = store.requireElection(req.params.id);
      const result = explorer.search(`election:${election.id}`);
      res.json({
        nfp: true,
        election: publicElection(election),
        txs: result.txs,
      });
    }),
  );

  return router;
}
