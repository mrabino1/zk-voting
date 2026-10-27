// NOT FOR PROFIT — civic public good, not a commercial product.
// ZK-Voting node: JSON API + static page host.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { attachAuth, enforceApiKeyAccess, isBallotRequest } from './auth.mjs';
import { corsOptionsDelegate } from './corsPolicy.mjs';
import { installConsoleCapture, recordLog, setLogLevel, watchSecrets } from './superAdmin/logs.mjs';
import { superAdminRouter } from './routes/superAdmin.mjs';
import { createChain } from './chain.mjs';
import { getConfig } from './config.mjs';
import { announceGeneratedSetupToken } from './setupToken.mjs';
import { createL1Certifier } from './l1Certify.mjs';
import { Explorer } from './explorer.mjs';
import { errorHandler } from './http.mjs';
import { openNodeWriter, standbyGuard } from './writerMode.mjs';
import { createPasskeyService } from './passkey.mjs';
import { applySiteContractPins } from './cms.mjs';
import { createMailer } from './mailer.mjs';
import { createMfaService } from './mfa.mjs';
import { installChainIdAccessor } from './setup.mjs';
import { createPinService } from './pin.mjs';
import { createTermsService } from './terms.mjs';
import { Store } from './store.mjs';
import { loadReceiptPdfSecret } from './receipts.mjs';
import { createVotePassService } from './votePass.mjs';
import { adminRouter } from './routes/admin.mjs';
import { apiKeysRouter } from './routes/apiKeys.mjs';
import { botDocsRouter, repoLlmsRouter } from './routes/botDocs.mjs';
import { selfHostingDocsRouter } from './routes/selfHostingDocs.mjs';
import { authRouter } from './routes/auth.mjs';
import { setupRouter } from './routes/setup.mjs';
import { electionsRouter } from './routes/elections.mjs';
import { pollsRouter } from './routes/polls.mjs';
import { createTokenRegistry } from './tokenSource.mjs';
import { explorerRouter } from './routes/explorer.mjs';
import { configRouter, healthRouter } from './routes/health.mjs';
import { identityRouter } from './routes/identity.mjs';
import { pinRouter } from './routes/pin.mjs';
import { mailRouter } from './routes/mail.mjs';
import { meRouter } from './routes/me.mjs';
import { pagesRouter } from './routes/pages.mjs';
import { receiptsRouter } from './routes/receipts.mjs';
import { outcomesRouter } from './routes/outcomes.mjs';
import { l2ResultsRouter } from './routes/l2Results.mjs';
import { outcomeReportsRouter } from './routes/outcomeReports.mjs';
import { termsApiRouter, termsPdfRouter } from './routes/terms.mjs';
import { feedbackRouter } from './routes/feedback.mjs';
import { ceremonyAdminRouter, ceremonyPublicRouter } from './routes/ceremony.mjs';
import { createCeremonyService } from './ceremony/service.mjs';
import { ceremonyCsp, ceremonyHtmlFile, snarkjsVendorRoute } from './ceremony/web.mjs';
import { zkArtifactRoute } from './voteProof.mjs';
import { layoutPublicRouter, siteAdminRouter } from './routes/siteAdmin.mjs';
import { escapeHtml, getBranding, renderBrandedHtml, setBrandingProvider } from './branding.mjs';
import { createLayoutService } from './layout.mjs';
import { createPluginManager } from './plugins/manager.mjs';
import { canonicalPublicPath } from '../public/audience.js';

const LOADING_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>%BRAND_NAME%</title>
  <style>
    body { font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; margin: 2rem; line-height: 1.5; color: #19191c; background: #f5f5f5; }
    @media (prefers-color-scheme: dark) { body { color: #ebebeb; background: #0e1014; } .muted { color: #adaeb0; } }
    h1 { font-weight: 500; font-size: 1.5rem; text-decoration: underline; text-underline-offset: 0.28rem; text-decoration-color: #708f13; }
    .nfp { font-weight: 600; letter-spacing: 0.06em; font-size: 0.75rem; }
    .muted { color: #525355; }
  </style>
</head>
<body>
  <p class="nfp">NOT FOR PROFIT</p>
  <h1>%BRAND_NAME%</h1>
  <p class="muted">The UI is loading. This Node process serves the civic voting API and vanilla JS pages from <code>public/</code> (or <code>dist/</code> if present).</p>
  <p class="muted">%BRAND_NAME% · civic public good, not a commercial product.</p>
</body>
</html>
`;

function htmlCandidate(config, pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  let file = 'index.html';
  const ceremonyFile = ceremonyHtmlFile(clean);
  if (ceremonyFile) file = ceremonyFile;
  else if (clean === '/explorer' || clean.startsWith('/explorer/')) file = 'explorer.html';
  else if (clean === '/admin' || clean.startsWith('/admin/')) file = 'admin.html';
  else if (clean === '/back-office' || clean.startsWith('/back-office/')) file = 'back-office.html';
  else if (clean === '/site-admin' || clean.startsWith('/site-admin/')) file = 'site-admin.html';
  else if (clean === '/docs' || clean.startsWith('/docs/')) file = 'docs.html';
  return [
    path.join(config.distDir, file),
    path.join(config.publicDir, file),
    path.join(config.distDir, 'index.html'),
    path.join(config.publicDir, 'index.html'),
  ];
}

const OFFICE_PAGE_RE = /^\/(admin|back-office|office|site-admin)(\/|$)/i;

/**
 * Strict CSP for the site-admin page and plugin pages: external scripts and
 * styles from this origin only, no inline script, no eval. (Other pages have
 * no CSP today; see docs/plugins/README.md "Open decisions".)
 */
export const SITE_ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function siteAdminCsp() {
  return function siteAdminCspMiddleware(req, res, next) {
    if (/^\/site-admin(\/|$)/i.test(req.path || '')) {
      res.set('Content-Security-Policy', SITE_ADMIN_CSP);
      res.set('X-Frame-Options', 'DENY');
      res.set('Referrer-Policy', 'same-origin');
    }
    next();
  };
}

/** Public URLs are /admin not /admin.html. Files on disk stay *.html. */
export function cleanHtmlUrls() {
  return function cleanHtmlMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathOnly = req.path || '';
    if (!/\.html$/i.test(pathOnly)) return next();
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, `${canonicalPublicPath(pathOnly)}${q}`);
  };
}

function serveStaticNoHtml(root) {
  const serve = express.static(root, { index: false, redirect: false });
  return function staticNoHtml(req, res, next) {
    if (/\.html$/i.test(req.path || '')) return next();
    return serve(req, res, next);
  };
}

function officePageGuard() {
  return function officeGuardMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const clean = canonicalPublicPath(req.path);
    if (!OFFICE_PAGE_RE.test(clean)) {
      return next();
    }
    if (req.user) return next();
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(302, `/signin?next=${encodeURIComponent(`${clean}${search}`)}`);
  };
}

function electionShortLinks(store) {
  return function shortLinkMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const outcomeQr = /^\/o\/([^/]+)\/?$/.exec(req.path);
    if (outcomeQr) {
      let token = outcomeQr[1];
      try {
        token = decodeURIComponent(token);
      } catch {
        /* keep raw */
      }
      res.redirect(302, `/outcomes/verify?id=${encodeURIComponent(token)}`);
      return;
    }
    const match = /^\/(v|e)\/([^/]+)\/?$/.exec(req.path);
    if (!match) return next();
    let code = match[2];
    try {
      code = decodeURIComponent(code);
    } catch {
      /* keep raw */
    }
    const election = store.getElection(code);
    if (!election) return next();
    res.redirect(302, `/vote/${encodeURIComponent(election.id)}`);
  };
}

/**
 * Server-render branding into a page: replace the %BRAND_*% placeholders and
 * add <meta name="brand-*"> tags so client scripts (i18n `{brand}`) agree.
 */
function brandHtml(html, branding) {
  let out = renderBrandedHtml(html, branding);
  if (!/<meta name="brand-name"/.test(out)) {
    const meta =
      `<meta name="brand-name" content="${escapeHtml(branding.name)}"/>\n` +
      `  <meta name="brand-short-name" content="${escapeHtml(branding.shortName)}"/>\n` +
      `  <meta name="brand-tagline" content="${escapeHtml(branding.tagline)}"/>\n`;
    const charset = /<meta charset[^>]*>\s*/i;
    out = charset.test(out)
      ? out.replace(charset, (m) => `${m}${meta}  `)
      : out.replace(/<head([^>]*)>\s*/i, (m) => `${m}${meta}  `);
  }
  return out;
}

function spaFallback(config, layoutService) {
  const currentBranding = () => {
    const b = layoutService.effective().layout.branding;
    return { name: b.productName, shortName: b.shortName, tagline: b.tagline };
  };
  return function spaMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/health' || req.path.startsWith('/api')) return next();
    if (path.extname(req.path)) return next();

    let branding;
    try {
      branding = currentBranding();
    } catch {
      branding = getBranding();
    }
    for (const file of htmlCandidate(config, req.path)) {
      if (fs.existsSync(file)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        fs.promises.readFile(file, 'utf8').then(
          (html) => res.send(brandHtml(html, branding)),
          (err) => next(err),
        );
        return;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(brandHtml(LOADING_SHELL, branding));
  };
}

export async function createApp(overrides = {}) {
  const {
    chain: chainOverride,
    passkeyHooks,
    l1: l1Override,
    l1Hooks,
    tokenRegistry: tokenRegistryOverride,
    ...configOverrides
  } = overrides;
  const config = getConfig(configOverrides);
  watchSecrets([config.setupToken]);
  announceGeneratedSetupToken(config);
  const writer = openNodeWriter(config);
  config.writerActive = writer.active;
  config.writerLeaseHandle = writer.lease;
  const store = await Store.open(config);
  // One chain id accessor: env CHAIN_ID > first-run setup choice > 27427.
  installChainIdAccessor(config, store);
  store.writerActive = writer.active;
  store.lease = writer.lease;
  const runtime = store.data.runtime || {};
  if (runtime.feedbackRateWindowSeconds) {
    config.feedbackRateWindowSeconds = runtime.feedbackRateWindowSeconds;
  }
  if (runtime.logLevel) {
    config.logLevel = runtime.logLevel;
    try {
      setLogLevel(runtime.logLevel);
    } catch {
      /* ignore a corrupt runtime level */
    }
  }
  if (typeof runtime.archiveEnabled === 'boolean') config.archiveEnabled = runtime.archiveEnabled;
  installConsoleCapture([config.superAdminEmail, config.superAdminApiPepper, config.setupToken]);
  config.receiptPdfSecret = await loadReceiptPdfSecret(config, { mint: writer.active });
  applySiteContractPins(config, store.getSite());
  const explorer = await Explorer.open(config);
  explorer.writerActive = writer.active;
  explorer.disclosurePolicy = () => ({
    delaySeconds: config.disclosureDelaySeconds,
    minBlockVotes: config.disclosureMinBlockVotes,
    minVotes: config.resultsMinVotes,
    electionContext(id) {
      const election = store.getElection(id);
      if (!election) return { submittedVotes: 0, endTime: null, tallied: false };
      return {
        submittedVotes: Number(election.acceptedBallots) || 0,
        endTime: election.cutoffTime,
        tallied: Boolean(election.tally),
      };
    },
  });
  const chain = chainOverride || createChain(config);
  const l1 = l1Override || createL1Certifier(config, l1Hooks || {});
  const passkeys = createPasskeyService(config, store, passkeyHooks);
  const mailer = configOverrides.mailer || createMailer(config);
  const terms = configOverrides.terms || createTermsService({ store, mailer, config });
  const mfa = createMfaService({ config, store, mailer, terms });
  const pin = createPinService({ store });
  const votePass = createVotePassService(config);
  const tokenRegistry = tokenRegistryOverride || createTokenRegistry(config);
  const deps = {
    config,
    store,
    explorer,
    chain,
    l1,
    passkeys,
    mailer,
    mfa,
    terms,
    pin,
    votePass,
    tokenRegistry,
    writer,
  };
  deps.ceremonies = createCeremonyService({
    config,
    store,
    ...(typeof config.ceremonyNowMs === 'function' ? { now: config.ceremonyNowMs } : {}),
  });
  const layoutService = await createLayoutService({ store, config });
  const plugins = await createPluginManager({ store, config, layout: layoutService });
  deps.layoutService = layoutService;
  // Server modules (mail, PDFs, receipts, WebAuthn rpName) read the brand from here.
  setBrandingProvider(() => {
    const b = layoutService.effective().layout.branding;
    return { name: b.productName, shortName: b.shortName, tagline: b.tagline };
  });
  deps.plugins = plugins;

  const app = express();
  app.locals.quiet = Boolean(config.quiet);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(cors(corsOptionsDelegate(config)));
  app.use('/api/feedback', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const len = Number(req.headers['content-length'] || 0);
    if (len > config.feedbackMaxBodyBytes) {
      res.status(413).json({ error: 'Feedback is too large.', nfp: true, code: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    next();
  });
  // Scoped CSP for the ceremony pages, their scripts, and the snarkjs worker.
  // No global CSP exists yet; this adds none elsewhere. See docs/ceremony-web.md#csp.
  app.use(ceremonyCsp());
  app.use(express.json({ limit: '2mb' }));
  app.use(standbyGuard(writer));
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'invalid JSON', nfp: true });
      return;
    }
    next(err);
  });
  app.use(attachAuth(store, config));
  app.use(enforceApiKeyAccess);

  if (!config.quiet) {
    app.use((req, res, next) => {
      // Ballot unlinkability: never log the ballot POST (no line, no timestamp),
      // so access logs cannot be lined up with vote-pass issuance or sessions.
      if (isBallotRequest(req)) return next();
      const t = Date.now();
      res.on('finish', () => {
        const line = `[zk-voting] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`;
        recordLog('info', line, [config.superAdminEmail, config.superAdminApiPepper]);
        if (config.logLevel === 'error' || config.logLevel === 'warn') return;
        console.log(line);
      });
      next();
    });
  }

  app.use('/api/_sa/v1', superAdminRouter(deps));
  app.use('/api/ceremonies', ceremonyPublicRouter({ ...deps, limits: config.ceremonyRateLimits || {} }));
  app.use('/api/ceremony-admin', ceremonyAdminRouter(deps));
  app.use(healthRouter(deps));
  app.use(termsPdfRouter(deps));
  app.use('/api/setup', setupRouter(deps));
  app.use('/api/auth', authRouter(deps));
  app.use('/api/elections', electionsRouter(deps));
  if (config.pollsReady) {
    app.use('/api/polls', pollsRouter(deps));
  }
  app.use('/api/explorer', explorerRouter(deps));
  app.use('/api', identityRouter(deps));
  app.use('/api', pinRouter(deps));
  app.use('/api', meRouter(deps));
  app.use('/api', apiKeysRouter(deps));
  app.use('/api', mailRouter(deps));
  app.use('/api', adminRouter(deps));
  app.use('/api', pagesRouter(deps));
  app.use('/api', termsApiRouter(deps));
  app.use('/api/feedback', feedbackRouter(deps));
  app.use('/api', receiptsRouter(deps));
  app.use('/api', outcomeReportsRouter(deps));
  app.use('/api', outcomesRouter(deps));
  app.use('/api', l2ResultsRouter(deps));
  app.use('/api', configRouter(deps));
  app.use('/api', botDocsRouter());
  app.use('/api/site-admin', siteAdminRouter(deps));
  app.use('/api', layoutPublicRouter(deps));
  app.use('/api/plugins/:name', plugins.routeDispatcher());
  app.use(repoLlmsRouter());
  app.use(selfHostingDocsRouter());
  app.get('/vendor/snarkjs.min.js', snarkjsVendorRoute());
  app.use(zkArtifactRoute());
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found', nfp: true });
  });

  app.get('/plugins-assets/:name/*', plugins.assetHandler());
  app.use(siteAdminCsp());
  app.use(electionShortLinks(store));
  app.use(cleanHtmlUrls());
  app.use(officePageGuard());
  app.use(serveStaticNoHtml(config.distDir));
  app.use(serveStaticNoHtml(config.publicDir));
  app.use(spaFallback(config, layoutService));

  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      res.status(404).json({ error: 'not found', nfp: true });
      return;
    }
    res.status(404).type('text').send('Not found');
  });

  app.use(errorHandler);
  return { app, store, explorer, chain, l1, config, mailer, mfa, terms, pin, votePass, writer, plugins, ceremonies: deps.ceremonies };
}

export async function startServer(overrides = {}) {
  const created = await createApp(overrides);
  const { app, config } = created;
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, config.host, () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  if (!config.quiet) {
    console.log(
      `${getBranding().name} node (NOT FOR PROFIT) listening on ${config.host}:${port}  chainId=${config.chainId}`,
    );
  }
  if (created.writer?.enabled && !created.writer.active) {
    const timer = setInterval(async () => {
      if (!created.writer.tryPromote()) return;
      clearInterval(timer);
      try {
        if (typeof created.store.reloadFromDisk === 'function') await created.store.reloadFromDisk();
        if (typeof created.explorer.refresh === 'function') await created.explorer.refresh();
        if (typeof created.store.claimWriter === 'function') await created.store.claimWriter();
        if (typeof created.explorer.claimWriter === 'function') await created.explorer.claimWriter();
        created.config.receiptPdfSecret = await loadReceiptPdfSecret(created.config, { mint: true });
        created.store.writerActive = true;
        created.explorer.writerActive = true;
        created.config.writerActive = true;
        await created.store.adoptSuperAdminEmail(created.config);
        if (typeof created.plugins?.onPromoted === 'function') await created.plugins.onPromoted();
        console.log(`node writer active epoch=${created.writer.epoch()}`);
      } catch (err) {
        console.error('node promote failed:', err);
      }
    }, created.writer.lease?.pollMs || 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return { ...created, server, port };
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then((created) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        console.log('node stopping');
        created.writer?.beginDrain();
        const force = setTimeout(() => process.exit(0), 20_000);
        if (typeof force.unref === 'function') force.unref();
        created.server.close(async () => {
          try {
            if (created.store?.writerActive !== false) await created.store.persist();
          } catch (err) {
            console.warn('node flush failed:', err.message || err);
          }
          try {
            created.writer?.release();
          } catch {
            // lease already released
          }
          clearTimeout(force);
          process.exit(0);
        });
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
