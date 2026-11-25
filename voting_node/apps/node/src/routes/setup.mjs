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
//   PUT  /api/setup/site               super admin, before finish: the
//                                      product name (same rules as Site
//                                      admin > Layout); the rest of step 5
//                                      comes from env (./setup.sh) and is
//                                      shown read-only in setupStatus.site
//   POST /api/setup/complete           super admin: mark setup finished
//
//   GET  /api/setup/rollup             super admin: step 6, the rollup
//                                      connection (ZkVotingRollup address,
//                                      L1 chain, node account and its L1
//                                      balance, L2 operator reachability)
//
// ROLLUP_PRIVATE_KEY and L2_BALLOT_TOKEN live in env only; nothing here returns them.
//
// Once a super admin holds a sign-in factor, the admin endpoints answer 409
// SETUP_ADMIN_EXISTS for ever. The admin endpoints always require a setup
// token (header x-setup-token or body.setupToken). An environment token stays
// valid until a super admin exists. A token minted because SETUP_TOKEN was
// empty is consumed when the claim succeeds.

import { Router } from 'express';

import { requireSuperAdmin } from '../auth.mjs';
import { resolveRequestWebAuthn } from '../config.mjs';
import { BRAND_NAME_MAX, brandDefaults, cleanBrandText, isSafeBrandText } from '../branding.mjs';
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
import { appendSiteAudit } from '../siteAudit.mjs';
import { saveVotingMode, votingSetupStatus } from '../votingSetup.mjs';
import { insecurePublicUrl, settingSource } from '../platformEnv.mjs';
import { parseIdentityInput, resolveSiteIdentity } from '../siteIdentity.mjs';
import { requireAcceptedTerms } from '../terms.mjs';
import {
  ENTROPY_MODES,
  entropyInfo,
  entropyPublic,
  normalizeCeremonyUrl,
  parseEntropyString,
} from '../entropy.mjs';

/**
 * Step 5, super admin only: what the environment (./setup.sh, .env) set for
 * this deployment. Never a secret: the database is reported by kind and the
 * setup token as set / not set.
 */
export function siteInfo(deps) {
  const { config, layoutService } = deps;
  const branding = layoutService?.effective().layout.branding || {};
  const saved = layoutService?.saved().branding || {};
  return {
    voteFqdn: config.voteFqdn || null,
    publicOrigin: config.origins?.[0] || null,
    rpId: config.rpID || null,
    trustProxy: config.trustProxy === undefined || config.trustProxy === false ? null : String(config.trustProxy),
    port: config.port ?? null,
    database: config.databaseUrl ? 'postgres' : 'json',
    setupTokenSet: Boolean(config.setupToken),
    productName: branding.productName || brandDefaults().name,
    productNameDefault: brandDefaults().name,
    productNameSaved: Boolean(saved.productName),
    env: 'VOTE_FQDN, ZK_VOTING_PORT, TRUST_PROXY, DATABASE_URL, BRAND_NAME',
    // Where each value came from: "environment" (typed by the operator), "platform"
    // (derived from the hosting platform, e.g. Coolify's domain), or "unset".
    sources: {
      voteFqdn: settingSource('VOTE_FQDN'),
      publicBaseUrl: settingSource('PUBLIC_BASE_URL'),
      trustProxy: settingSource('TRUST_PROXY'),
      database: settingSource('DATABASE_URL'),
    },
    publicBaseUrl: config.publicBaseUrl || null,
    // Who runs this site and which project it runs (src/siteIdentity.mjs).
    identity: resolveSiteIdentity({ saved: deps.store?.data?.siteIdentity }),
    // Passkeys need HTTPS on any real host name. A Coolify test domain is often plain http.
    insecureHttp: insecurePublicUrl(config.publicBaseUrl, config.voteFqdn),
  };
}

export function setupStatus(deps, req) {
  const { config, store } = deps;
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
    setupTokenSource: !adminExists
      ? config.setupTokenConsumed
        ? null
        : config.setupTokenGenerated
          ? 'generated'
          : config.setupToken
            ? 'environment'
            : null
      : null,
    suggestedHandle: !adminExists ? seed?.handle || config.adminHandle || 'admin' : null,
    chainId: { value: chain.chainId, source: chain.source, fixed: chain.fixed, env: 'CHAIN_ID' },
    chainIdPresets: CHAIN_ID_PRESETS,
    entropy: entropyPublic(entropyInfo(config, store)),
    site: viewerIsSuper ? siteInfo(deps) : null,
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
    if (config.setupTokenConsumed) {
      throw new HttpError(403, 'setup token already used', { code: 'SETUP_TOKEN_USED' });
    }
    const provided = req.get('x-setup-token') || req.body?.setupToken || '';
    if (!config.setupToken || !secretsEqual(config.setupToken, provided)) {
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
        webauthn: resolveRequestWebAuthn(config, req),
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
      if (config.setupTokenGenerated) config.setupTokenConsumed = true;
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

  // Site identity: the footer contact, the contracting offer, and the source / project /
  // forum links. Super admin; stays editable after setup finishes.
  router.put(
    '/identity',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      let parsed;
      try {
        parsed = parseIdentityInput(req.body || {});
      } catch (err) {
        throw new HttpError(400, err.message, { code: 'SETUP_BAD_IDENTITY' });
      }
      const before = { ...(store.data.siteIdentity || {}) };
      const next = { ...before };
      for (const [k, v] of Object.entries(parsed)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      store.data.siteIdentity = next;
      await appendSiteAudit(store, {
        actor: req.user,
        method: 'PUT',
        path: '/api/setup/identity',
        area: 'setup',
        action: 'site identity saved',
        before,
        after: next,
      });
      res.json(setupStatus(deps, req));
    }),
  );

  // "How will civic votes be counted?" (src/votingSetup.mjs). Super admin only. Unlike
  // the chain id, this stays changeable after setup finishes, until a civic vote is on L1.
  router.get('/voting', requireSuperAdmin, (_req, res) => {
    res.json({ nfp: true, ...votingSetupStatus(deps) });
  });

  router.put(
    '/voting',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      const saved = await saveVotingMode(deps, req.body || {});
      await appendSiteAudit(store, {
        actor: req.user,
        method: 'PUT',
        path: '/api/setup/voting',
        area: 'setup',
        action: 'voting mode saved',
        after: { mode: saved.mode, network: saved.network || null },
      });
      const restarting = typeof deps.requestRestart === 'function';
      res.json({ nfp: true, saved: { mode: saved.mode, network: saved.network || null }, restarting, ...votingSetupStatus(deps) });
      // The node and the l2 operator read these settings at start-up.
      if (restarting) deps.requestRestart();
    }),
  );

  router.get(
    '/rollup',
    requireSuperAdmin,
    asyncHandler(async (_req, res) => {
      res.json({ nfp: true, ...(await rollupSetupStatus(deps)) });
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

  router.put(
    '/site',
    requireSuperAdmin,
    asyncHandler(async (req, res) => {
      if (readSetup(store).completedAt) {
        throw new HttpError(409, 'setup is finished; rename the product in Site admin > Layout', {
          code: 'SETUP_COMPLETE',
        });
      }
      const { layoutService } = deps;
      if (!layoutService) throw new HttpError(503, 'layout service unavailable');
      const raw = req.body?.productName;
      if (typeof raw !== 'string') {
        throw new HttpError(400, 'productName must be a string ("" = default)', { code: 'SETUP_BAD_NAME' });
      }
      let name = cleanBrandText(raw, BRAND_NAME_MAX);
      if (raw.trim() && (!name || !isSafeBrandText(raw.trim(), BRAND_NAME_MAX))) {
        throw new HttpError(400, `product name must be 1–${BRAND_NAME_MAX} plain characters`, { code: 'SETUP_BAD_NAME' });
      }
      // Same rule as Site admin > Layout: the env / built-in default is saved
      // as "" (inherit), so a later BRAND_NAME change still applies.
      if (name === brandDefaults().name) name = '';
      const before = layoutService.saved();
      if ((before.branding?.productName || '') !== name) {
        await layoutService.save({ ...before, branding: { ...before.branding, productName: name } });
        await appendSiteAudit(store, {
          actor: req.user,
          area: 'layout',
          action: 'layout.update',
          method: req.method,
          path: req.originalUrl,
          before: { productName: before.branding?.productName || null },
          after: { productName: name || null },
        });
      }
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

// The node pays L1 gas to publish, close and finalize civic votes; voters never pay.
// One publish-to-finalize cycle is a handful of transactions, so warn below ~20 of them.
const GAS_PER_CALL = 300_000n;
const MIN_CALLS = 20n;

export function rollupFundingLevel({ balanceWei, gasPriceWei }) {
  const perCall = BigInt(gasPriceWei) * GAS_PER_CALL;
  const balance = BigInt(balanceWei);
  const level = balance === 0n || balance < perCall ? 'empty' : balance < perCall * MIN_CALLS ? 'low' : 'ok';
  return { level, balanceWei: balance.toString(), gasPriceWei: BigInt(gasPriceWei).toString(), callsLeft: perCall > 0n ? Number(balance / perCall) : null };
}

async function rollupSetupStatus(deps) {
  const cfg = deps.config.rollup || {};
  const client = deps.rollup?.client || null;
  const out = {
    configured: Boolean(deps.rollup?.enabled),
    address: client?.address || cfg.address || null,
    chainId: client?.chainId ?? cfg.chainId ?? null,
    jurisdictionId: cfg.jurisdictionId || null,
    nodeAccount: client?.account || null,
    keySet: Boolean(String(cfg.privateKey || '').trim()),
    l2Url: cfg.l2Url || null,
    l2Reachable: null,
    funding: null,
    problems: [],
  };
  if (!cfg.address) out.problems.push('ROLLUP_ADDRESS is not set');
  if (!cfg.l1Rpc) out.problems.push('L1_RPC is not set');
  if (!out.keySet) out.problems.push('ROLLUP_PRIVATE_KEY is not set: the node cannot publish or finalize civic votes');
  if (!cfg.jurisdictionId) out.problems.push('ROLLUP_JURISDICTION_ID is not set');
  if (!client) return out;
  try {
    const bal = await client.accountBalance();
    if (bal) out.funding = rollupFundingLevel(bal);
  } catch (err) {
    out.problems.push(`L1 unreachable: ${err?.shortMessage || err?.message || 'error'}`);
  }
  try {
    if (typeof client.l2Health === 'function') {
      const health = await client.l2Health();
      const status = health?.status || 'unreachable';
      const reason = typeof health?.reason === 'string' ? health.reason : null;
      out.l2 = { status, reason };
      out.l2Reachable = status === 'ok';
      if (status === 'degraded') {
        out.problems.push(`the L2 operator is degraded (${reason || 'degraded'})`);
      } else if (status === 'starting') {
        out.problems.push('the L2 operator is still starting');
      } else if (status === 'standby') {
        out.problems.push('the L2 operator is in standby');
      } else if (status !== 'ok') {
        out.problems.push('the L2 operator is unreachable at L2_URL');
      }
    } else {
      out.l2Reachable = Boolean(await client.l2Status());
    }
  } catch (err) {
    out.l2Reachable = false;
    if (err?.code === 'L2_DEGRADED') {
      out.l2 = { status: 'degraded', reason: err.reason || 'degraded' };
      out.problems.push(err.message);
    } else {
      out.problems.push('the L2 operator is unreachable at L2_URL');
    }
  }
  return out;
}
