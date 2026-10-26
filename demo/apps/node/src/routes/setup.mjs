// NOT FOR PROFIT — civic public good, not a commercial product.
// First-run setup API (/api/setup).
//
//   GET  /api/setup                    public status: does a super admin exist,
//                                      is setup finished, chain id and source
//   POST /api/setup/admin/begin        no super admin yet: passkey options for
//                                      the seeded super admin row
//   POST /api/setup/admin/finish       no super admin yet: verify the passkey,
//                                      claim the row (first finish wins)
//   PUT  /api/setup/chain-id           super admin, before setup is finished,
//                                      only when CHAIN_ID is not set in env
//   PUT  /api/setup/ceremony           super admin, before finish: is there a
//                                      public entropy ceremony, and its host
//   PUT  /api/setup/entropy            super admin, before finish: save the
//                                      closed ceremony's output or local
//                                      entropy (zke1 string), or skip
//   GET  /api/setup/entropy            super admin: the saved entropy value
//   POST /api/setup/complete           super admin: mark setup finished
//
// Once a super admin holds a sign-in factor, the admin endpoints answer 409
// SETUP_ADMIN_EXISTS for ever. When SETUP_TOKEN is set, the admin endpoints
// also require it (header x-setup-token or body.setupToken).

import { Router } from 'express';

import { requireSuperAdmin } from '../auth.mjs';
import { asyncHandler, HttpError } from '../http.mjs';
import { isClaimedPerson } from '../identity.mjs';
import { secretsEqual } from '../secureCompare.mjs';
import {
  ADMIN_HANDLE_RE,
  CHAIN_ID_PRESETS,
  chainIdInfo,
  hasClaimedSuperAdmin,
  parseChainId,
  readSetup,
  setupMeta,
  unclaimedSuperAdmin,
} from '../setup.mjs';
import { requireAcceptedTerms } from '../terms.mjs';
import {
  ENTROPY_MODES,
  entropyInfo,
  entropyPublic,
  normalizeCeremonyUrl,
  parseEntropyString,
} from '../entropy.mjs';

export function setupStatus({ config, store }, req) {
  const adminExists = hasClaimedSuperAdmin(store, isClaimedPerson);
  const setup = readSetup(store);
  const chain = chainIdInfo(config, store);
  const seed = unclaimedSuperAdmin(store, isClaimedPerson);
  const viewerIsSuper = Boolean(req?.user && req.user.role === 'platform_super_admin');
  const setupComplete = Boolean(setup.completedAt);
  return {
    nfp: true,
    needsAdmin: !adminExists,
    setupComplete,
    // The SPA sends a new visitor to /setup while no super admin exists, and
    // the super admin back to /setup until they finish the remaining steps.
    redirect: Boolean(config.firstRunRedirect) && (!adminExists || (viewerIsSuper && !setupComplete)),
    setupTokenRequired: !adminExists && Boolean(config.setupToken),
    suggestedHandle: !adminExists ? seed?.handle || config.adminHandle || 'admin' : null,
    chainId: { value: chain.chainId, source: chain.source, fixed: chain.fixed, env: 'CHAIN_ID' },
    chainIdPresets: CHAIN_ID_PRESETS,
    entropy: entropyPublic(entropyInfo(config, store)),
    completedAt: setup.completedAt || null,
  };
}

export function setupRouter(deps) {
  const { store, config, passkeys, mfa } = deps;
  const router = Router();

  function refuseIfAdminExists() {
    if (hasClaimedSuperAdmin(store, isClaimedPerson)) {
      throw new HttpError(409, 'a platform super admin already exists; first-run setup is closed', {
        code: 'SETUP_ADMIN_EXISTS',
      });
    }
  }

  function checkSetupToken(req) {
    if (!config.setupToken) return;
    const provided = req.get('x-setup-token') || req.body?.setupToken || '';
    if (!secretsEqual(config.setupToken, provided)) {
      throw new HttpError(403, 'setup token required', { code: 'SETUP_TOKEN_REQUIRED' });
    }
  }

  function seedRow() {
    let seed = unclaimedSuperAdmin(store, isClaimedPerson);
    if (!seed) {
      throw new HttpError(409, 'no unclaimed super admin row to set up', { code: 'SETUP_NO_SEED' });
    }
    return seed;
  }

  function validHandle(raw, seed) {
    const handle = String(raw ?? seed.handle ?? '').trim();
    if (!ADMIN_HANDLE_RE.test(handle)) {
      throw new HttpError(400, 'handle must be 2–32 letters, digits, dot, dash or underscore', {
        code: 'SETUP_BAD_HANDLE',
      });
    }
    const other = store.getUserByHandle(handle);
    if (other && other.id !== seed.id) {
      throw new HttpError(409, 'that handle is taken', { code: 'SETUP_HANDLE_TAKEN' });
    }
    return handle;
  }

  router.get('/', (req, res) => {
    res.json(setupStatus(deps, req));
  });

  router.post(
    '/admin/begin',
    asyncHandler(async (req, res) => {
      refuseIfAdminExists();
      checkSetupToken(req);
      requireAcceptedTerms(req.body || {});
      const seed = seedRow();
      const handle = validHandle(req.body?.handle, seed);
      // The seed row keeps its id; the handle is applied only when the
      // passkey verifies, so a begin that is never finished changes nothing.
      const options = await passkeys.beginRegister({
        user: { ...seed, handle },
        handle,
        acceptedTerms: true,
      });
      res.json({ ...options, publicKey: options, rpName: config.rpName, handle, nfp: true });
    }),
  );

  router.post(
    '/admin/finish',
    asyncHandler(async (req, res) => {
      refuseIfAdminExists();
      checkSetupToken(req);
      const seed = seedRow();
      const handle = validHandle(req.body?.handle, seed);
      let result;
      try {
        result = await passkeys.finishRegister({ body: req.body, user: null, handle, claimSeedOnly: seed.id });
      } catch (err) {
        // Two visitors raced: the other one's passkey landed first.
        if (hasClaimedSuperAdmin(store, isClaimedPerson)) {
          throw new HttpError(409, 'a platform super admin already exists; first-run setup is closed', {
            code: 'SETUP_ADMIN_EXISTS',
          });
        }
        throw err;
      }
      const account = store.getUser(result.user.id) || result.user;
      if (account.role !== 'platform_super_admin') {
        throw new HttpError(409, 'setup did not claim the super admin row', { code: 'SETUP_ADMIN_EXISTS' });
      }
      if (handle !== account.handle && !store.getUserByHandle(handle)) account.handle = handle;
      const setup = setupMeta(store);
      setup.adminCreatedAt = new Date().toISOString();
      setup.adminUserId = account.id;
      await store.persist();
      if (!config.quiet) console.info('[zk-voting] first-run setup: platform super admin created');
      const payload = await mfa.completeFactor(res, {
        user: account,
        factor: 'passkey',
        acceptedTerms: true,
      });
      res.json({ ...payload, setup: setupStatus(deps, { user: account }) });
    }),
  );

  router.put(
    '/chain-id',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const info = chainIdInfo(config, store);
      if (info.fixed) {
        throw new HttpError(409, 'CHAIN_ID is fixed by the environment', {
          code: 'CHAIN_ID_FIXED_BY_ENV',
          chainId: info.chainId,
        });
      }
      if (readSetup(store).completedAt) {
        throw new HttpError(409, 'setup is finished; set CHAIN_ID in the environment to change it', {
          code: 'SETUP_COMPLETE',
        });
      }
      const chainId = parseChainId(req.body?.chainId);
      if (chainId === null) {
        throw new HttpError(400, 'chainId must be a positive integer', { code: 'SETUP_BAD_CHAIN_ID' });
      }
      const setup = setupMeta(store);
      setup.chainId = chainId;
      setup.chainIdSetAt = new Date().toISOString();
      await store.persist();
      res.json(setupStatus(deps, req));
    }),
  );

  function refuseIfComplete(what) {
    if (readSetup(store).completedAt) {
      throw new HttpError(409, `setup is finished; set ${what} in the environment to change it`, {
        code: 'SETUP_COMPLETE',
      });
    }
  }

  router.put(
    '/ceremony',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      if (config.entropyCeremonyUrlEnv) {
        throw new HttpError(409, 'ENTROPY_CEREMONY_URL is fixed by the environment', {
          code: 'ENTROPY_CEREMONY_FIXED_BY_ENV',
        });
      }
      refuseIfComplete('ENTROPY_CEREMONY_URL');
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new HttpError(400, 'enabled must be true or false', { code: 'SETUP_BAD_CEREMONY' });
      }
      const setup = setupMeta(store);
      const entropy = { ...(setup.entropy || {}) };
      if (enabled) {
        const url = normalizeCeremonyUrl(req.body?.url);
        if (!url) {
          throw new HttpError(400, 'ceremony host must be a hostname or https URL, for example ceremony.example.org', {
            code: 'SETUP_BAD_CEREMONY_URL',
          });
        }
        entropy.ceremony = true;
        entropy.ceremonyUrl = url;
      } else {
        entropy.ceremony = false;
        entropy.ceremonyUrl = null;
        // A pasted ceremony output no longer applies without a ceremony.
        if (entropy.mode === 'ceremony') {
          entropy.mode = null;
          entropy.value = null;
        }
      }
      setup.entropy = entropy;
      await store.persist();
      res.json(setupStatus(deps, req));
    }),
  );

  router.get('/entropy', requireSuperAdmin, (req, res) => {
    res.set('cache-control', 'no-store');
    const info = entropyInfo(config, store);
    res.json({ nfp: true, entropy: { ...entropyPublic(info), value: info.value } });
  });

  router.put(
    '/entropy',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      if (config.entropyEnv) {
        throw new HttpError(409, 'ZK_ENTROPY is fixed by the environment', { code: 'ENTROPY_FIXED_BY_ENV' });
      }
      refuseIfComplete('ZK_ENTROPY');
      const mode = req.body?.mode;
      if (!ENTROPY_MODES.includes(mode)) {
        throw new HttpError(400, 'mode must be ceremony, local or skip', { code: 'SETUP_BAD_ENTROPY_MODE' });
      }
      const setup = setupMeta(store);
      const entropy = { ...(setup.entropy || {}) };
      if (mode === 'skip') {
        entropy.mode = 'skip';
        entropy.value = null;
      } else {
        const parsed = parseEntropyString(req.body?.value);
        if (!parsed.ok) {
          throw new HttpError(400, `entropy value rejected: ${parsed.error}`, { code: 'SETUP_BAD_ENTROPY' });
        }
        if (parsed.source !== mode) {
          throw new HttpError(400, `that is a ${parsed.source} entropy string, not ${mode}`, {
            code: 'SETUP_ENTROPY_SOURCE_MISMATCH',
          });
        }
        if (mode === 'ceremony' && entropyInfo(config, store).ceremony.enabled !== true) {
          throw new HttpError(409, 'say there is a ceremony (step 3) before pasting its output', {
            code: 'SETUP_NO_CEREMONY',
          });
        }
        entropy.mode = mode;
        entropy.value = parsed.value;
      }
      entropy.savedAt = new Date().toISOString();
      setup.entropy = entropy;
      await store.persist();
      res.json(setupStatus(deps, req));
    }),
  );

  router.post(
    '/complete',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const setup = setupMeta(store);
      if (!setup.completedAt) {
        const info = chainIdInfo(config, store);
        // Pin the chain id the install launched with, so a later default
        // change cannot move an existing deployment.
        if (!info.fixed && setup.chainId == null) setup.chainId = info.chainId;
        setup.completedAt = new Date().toISOString();
        await store.persist();
      }
      res.json(setupStatus(deps, req));
    }),
  );

  return router;
}
