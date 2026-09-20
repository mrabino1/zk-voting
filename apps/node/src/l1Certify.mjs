// NOT FOR PROFIT — civic public good, not a commercial product.
// Optional L1TallyMirror.postResult after a Node tally. No-op when L1 env is unset.

import { createRequire } from 'node:module';

import { chainElectionId, l1IdentityOf } from './electionIds.mjs';

const require = createRequire(import.meta.url);
const {
  computeTallyHash,
  l1SkipReason,
  l1Configured,
  postTallyHash,
  publicCertification,
  readResultHash,
  alreadyPostedError,
  hasCertifiedIdentity,
  ZERO_HASH,
} = require('@zk-voting/chain-client');

export {
  computeTallyHash,
  l1SkipReason,
  l1Configured,
  publicCertification,
  ZERO_HASH,
  l1IdentityOf,
  chainElectionId,
};

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

export function certifyArgsForElection(election, extra = {}, config = {}) {
  const identity = l1IdentityOf(election, config);
  return {
    electionId: identity.electionId,
    identity,
    factory: identity.factory,
    jurisdictionId: identity.jurisdictionId,
    publicId: identity.publicId,
    publicIdHash: identity.publicIdHash,
    electionAddress: identity.electionAddress,
    ballotSpecHash: identity.ballotSpecHash,
    ...extra,
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
     * `electionId` must be the on-chain uint256, never the public UUID.
     */
    async certifyTally({
      electionId,
      counts,
      totalBallots,
      l2StateRoot,
      resultHash,
      factory,
      jurisdictionId,
      publicId,
      publicIdHash,
      electionAddress,
      ballotSpecHash,
      identity,
    }) {
      const hash = resultHash || computeTallyHash(counts);
      const skip = this.skipReason();
      const ident = identity || {
        factory: factory || null,
        jurisdictionId: jurisdictionId || null,
        publicId: publicId || null,
        publicIdHash: publicIdHash || null,
        electionAddress: electionAddress || null,
        ballotSpecHash: ballotSpecHash || null,
      };
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
          ...ident,
        });
      }
      if (!hooks.postFn && !hasCertifiedIdentity(ident)) {
        return publicCertification({
          posted: false,
          skipped: false,
          status: 'failed',
          error: 'shared ElectionFactory not pinned; refusing uint256 L1 postResult',
          resultHash: hash,
          totalBallots,
          l2StateRoot: l2StateRoot || ZERO_HASH,
          electionId: String(electionId),
          ...ident,
        });
      }
      const pinned = String(ident.pinnedFactory || '').trim();
      const fac = String(ident.factory || '').trim();
      if (
        !hooks.postFn &&
        pinned &&
        fac &&
        pinned.toLowerCase() !== fac.toLowerCase()
      ) {
        return publicCertification({
          posted: false,
          skipped: false,
          status: 'failed',
          error: 'election factory is not the pinned shared ElectionFactory',
          resultHash: hash,
          totalBallots,
          l2StateRoot: l2StateRoot || ZERO_HASH,
          electionId: String(electionId),
          ...ident,
        });
      }
      try {
        const raw = hooks.postFn
          ? await hooks.postFn({
              electionId,
              counts,
              totalBallots,
              l2StateRoot,
              resultHash: hash,
              ...ident,
            })
          : await postTallyHash({
              ...options,
              electionId,
              counts,
              resultHash: hash,
              totalBallots,
              l2StateRoot,
              factory: ident.factory,
              jurisdictionId: ident.jurisdictionId,
              publicId: ident.publicId,
              publicIdHash: ident.publicIdHash,
              electionAddress: ident.electionAddress,
              ballotSpecHash: ident.ballotSpecHash,
            });
        return publicCertification({
          ...ident,
          ...raw,
          resultHash: raw.resultHash || hash,
          totalBallots: raw.totalBallots ?? totalBallots,
          electionId: String(raw.electionId ?? electionId),
          factory: raw.factory || ident.factory,
          jurisdictionId: raw.jurisdictionId || ident.jurisdictionId,
          publicIdHash: raw.publicIdHash || ident.publicIdHash,
          certificationId: raw.certificationId || ident.certificationId,
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
            ...ident,
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
          ...ident,
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
