// NOT FOR PROFIT — civic public good, not a commercial product.
// Public, read-only: this L2's identity and an election outcome addressed by
// (l2Id, electionUuid), rebuilt from the local store, the L2, or L1.
// Never returns how a person voted, the L2 salt, or any key.
import { Router } from 'express';

import { asyncHandler, HttpError } from '../http.mjs';
import { publishDue } from '../electionState.mjs';
import { presentOutcomeDetail } from '../outcomes.mjs';
import { isUuid } from '../electionIds.mjs';
import {
  electionKeyFor,
  l2FundingStatus,
  publicL2Identity,
  readL2IdentityConfig,
  readOutcomeFromL1,
  readOutcomeFromL2,
} from '../l2Identity.mjs';

const SOURCES = new Set(['auto', 'local', 'l2', 'l1']);

export function l2ResultsRouter(deps, { env = process.env, fetchImpl = fetch } = {}) {
  const router = Router();

  router.get(
    '/l2/identity',
    asyncHandler(async (req, res) => {
      const cfg = await readL2IdentityConfig(env);
      const out = { ...publicL2Identity(cfg), nfp: true };
      if (req.query.funding === '1') out.funding = await l2FundingStatus(cfg, { fetchImpl });
      res.json(out);
    }),
  );

  router.get(
    '/l2/:l2Id/elections/:electionUuid/results',
    asyncHandler(async (req, res) => {
      const l2Id = String(req.params.l2Id || '').toLowerCase();
      const electionUuid = String(req.params.electionUuid || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(l2Id)) throw new HttpError(400, 'l2Id must be 0x + 32 bytes hex');
      if (!isUuid(electionUuid)) throw new HttpError(400, 'electionUuid must be a uuid');
      const source = String(req.query.source || 'auto');
      if (!SOURCES.has(source)) throw new HttpError(400, 'source must be auto, local, l2 or l1');

      const cfg = await readL2IdentityConfig(env);
      const local = cfg.l2Id && cfg.l2Id === l2Id;
      const base = {
        l2Id,
        electionUuid,
        electionKey: local ? electionKeyFor(cfg, electionUuid) : null,
        nfp: true,
      };

      const tryLocal = async () => {
        if (!local) return { status: 'other-l2', source: 'local' };
        const { now } = await publishDue(deps);
        const election = deps.store.getElection(electionUuid);
        if (!election) return { status: 'not-found', source: 'local' };
        return { status: 'ok', source: 'local', outcome: presentOutcomeDetail(election, deps, { now }) };
      };
      const tryL2 = () =>
        readOutcomeFromL2(cfg, { l2Id, electionUuid }, { fetchImpl }).catch((e) => ({
          status: 'l2-unreachable',
          source: 'l2',
          message: e.message,
        }));
      const tryL1 = () =>
        readOutcomeFromL1({ ...cfg }, { l2Id, electionUuid }, { fetchImpl }).catch((e) => ({
          status: 'l1-unreachable',
          source: 'l1',
          message: e.message,
        }));

      let result;
      if (source === 'local') result = await tryLocal();
      else if (source === 'l2') result = await tryL2();
      else if (source === 'l1') result = await tryL1();
      else {
        result = await tryLocal();
        if (result.status !== 'ok') result = await tryL2();
        if (result.status !== 'ok') result = await tryL1();
      }
      const code = result.status === 'ok' ? 200 : result.status === 'not-found' || result.status === 'other-l2' ? 404 : 503;
      res.status(code).json({ ...base, electionKey: base.electionKey || result.electionKey || null, ...result });
    }),
  );

  return router;
}
