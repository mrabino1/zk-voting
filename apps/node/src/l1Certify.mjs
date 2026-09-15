// NOT FOR PROFIT — civic public good, not a commercial product.
// Optional L1TallyMirror.postResult after a Node tally. No-op when L1 env is unset.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeTallyHash,
  l1SkipReason,
  l1Configured,
  postTallyHash,
  publicCertification,
  readResultHash,
  alreadyPostedError,
  ZERO_HASH,
} = require('@zk-voting/chain-client');

export { computeTallyHash, l1SkipReason, l1Configured, publicCertification, ZERO_HASH };

function l1OptionsFromConfig(config) {
  return {
    rpcUrl: config.l1Rpc,
    mirrorAddress: config.l1TallyMirrorAddress,
    privateKey: config.l1PublisherPrivateKey,
    settlementAddress: config.l1SettlementAddress,
    chainId: config.l1ChainId,
    env: {},
  };
}

/**
 * @param {ReturnType<import('./config.mjs').getConfig>} config
 * @param {{ postFn?: Function, readFn?: Function }} [hooks] Test hooks; never used in production.
 */
export function createL1Certifier(config, hooks = {}) {
  const options = l1OptionsFromConfig(config);

  return {
    options,
    isConfigured() {
      return Boolean(hooks.postFn) || l1Configured(options);
    },
    skipReason() {
      if (hooks.postFn) return null;
      return l1SkipReason(options);
    },
    /**
     * Copy a tallied count vector to L1. Never throws for unset env.
     * On-chain failures are returned as `{ status: 'failed' }` so the Node tally still stands.
     */
    async certifyTally({ electionId, counts, totalBallots, l2StateRoot, resultHash }) {
      const hash = resultHash || computeTallyHash(counts);
      const skip = this.skipReason();
      if (skip) {
        return publicCertification({
          posted: false,
          skipped: true,
          status: 'skipped',
          reason: skip,
          resultHash: hash,
          totalBallots,
          l2StateRoot: l2StateRoot || ZERO_HASH,
          electionId: String(electionId),
        });
      }
      try {
        const raw = hooks.postFn
          ? await hooks.postFn({ electionId, counts, totalBallots, l2StateRoot, resultHash: hash })
          : await postTallyHash({
              ...options,
              electionId,
              counts,
              resultHash: hash,
              totalBallots,
              l2StateRoot,
            });
        return publicCertification({
          ...raw,
          resultHash: raw.resultHash || hash,
          totalBallots: raw.totalBallots ?? totalBallots,
          electionId: String(electionId),
        });
      } catch (err) {
        if (alreadyPostedError(err)) {
          return publicCertification({
            posted: false,
            skipped: false,
            alreadyPosted: true,
            status: 'already_posted',
            reason: 'AlreadyPosted',
            resultHash: hash,
            totalBallots,
            l2StateRoot: l2StateRoot || ZERO_HASH,
            electionId: String(electionId),
            mirror: options.mirrorAddress || null,
          });
        }
        return publicCertification({
          posted: false,
          skipped: false,
          status: 'failed',
          error: err.message || String(err),
          resultHash: hash,
          totalBallots,
          l2StateRoot: l2StateRoot || ZERO_HASH,
          electionId: String(electionId),
          mirror: options.mirrorAddress || null,
        });
      }
    },
    async read(electionId) {
      if (hooks.readFn) return hooks.readFn(electionId);
      if (!this.isConfigured()) {
        return { resultHash: ZERO_HASH, skipped: true, reason: this.skipReason() };
      }
      const resultHash = await readResultHash(options.mirrorAddress, electionId, options);
      return { resultHash, posted: resultHash && resultHash !== ZERO_HASH };
    },
  };
}
