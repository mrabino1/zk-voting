// NOT FOR PROFIT — civic public good, not a commercial product.
// Republic Node: JSON API + SPA host (DealPunchList shape).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { attachAuth } from './auth.mjs';
import { createChain } from './chain.mjs';
import { getConfig } from './config.mjs';
import { createL1Certifier } from './l1Certify.mjs';
import { Explorer } from './explorer.mjs';
import { errorHandler } from './http.mjs';
import { createPasskeyService } from './passkey.mjs';
import { applySiteContractPins } from './cms.mjs';
import { createMailer } from './mailer.mjs';
import { createMfaService } from './mfa.mjs';
import { Store } from './store.mjs';
import { adminRouter } from './routes/admin.mjs';
import { authRouter } from './routes/auth.mjs';
import { electionsRouter } from './routes/elections.mjs';
import { explorerRouter } from './routes/explorer.mjs';
import { configRouter, healthRouter } from './routes/health.mjs';
import { identityRouter } from './routes/identity.mjs';
import { meRouter } from './routes/me.mjs';
import { pagesRouter } from './routes/pages.mjs';
import { canonicalPublicPath } from '../public/audience.js';

const LOADING_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Republic — zk-voting</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; line-height: 1.5; color: #111; }
    .nfp { font-weight: 700; letter-spacing: 0.04em; }
    .muted { color: #444; }
  </style>
</head>
<body>
  <p class="nfp">NOT FOR PROFIT</p>
  <h1>Republic</h1>
  <p class="muted">The UI is loading. This Node process serves the civic voting API and vanilla JS pages from <code>public/</code> (or <code>dist/</code> if present).</p>
  <p class="muted">Product: zk-voting · civic public good, not a commercial product.</p>
</body>
</html>
`;

function htmlCandidate(config, pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  let file = 'index.html';
  if (clean === '/explorer' || clean.startsWith('/explorer/')) file = 'explorer.html';
  else if (clean === '/admin' || clean.startsWith('/admin/')) file = 'admin.html';
  else if (clean === '/back-office' || clean.startsWith('/back-office/')) file = 'back-office.html';
  return [
    path.join(config.distDir, file),
    path.join(config.publicDir, file),
    path.join(config.distDir, 'index.html'),
    path.join(config.publicDir, 'index.html'),
  ];
}

const OFFICE_PAGE_RE = /^\/(admin|back-office|office)(\/|$)/i;

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

function spaFallback(config) {
  return function spaMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path === '/health' || req.path.startsWith('/api')) return next();
    if (path.extname(req.path)) return next();

    for (const file of htmlCandidate(config, req.path)) {
      if (fs.existsSync(file)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.sendFile(file);
        return;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(LOADING_SHELL);
  };
}

export async function createApp(overrides = {}) {
  const { chain: chainOverride, passkeyHooks, l1: l1Override, l1Hooks, ...configOverrides } = overrides;
  const config = getConfig(configOverrides);
  const store = await Store.open(config);
  applySiteContractPins(config, store.getSite());
  const explorer = await Explorer.open(config);
  const chain = chainOverride || createChain(config);
  const l1 = l1Override || createL1Certifier(config, l1Hooks || {});
  const passkeys = createPasskeyService(config, store, passkeyHooks);
  const mailer = configOverrides.mailer || createMailer(config);
  const mfa = createMfaService({ config, store, mailer });
  const deps = { config, store, explorer, chain, l1, passkeys, mailer, mfa };

  const app = express();
  app.locals.quiet = Boolean(config.quiet);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin: true,
      credentials: true,
      maxAge: 86400,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'invalid JSON', nfp: true });
      return;
    }
    next(err);
  });
  app.use(attachAuth(store, config));

  if (!config.quiet) {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => {
        console.log(`[republic] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`);
      });
      next();
    });
  }

  app.use(healthRouter(deps));
  app.use('/api/auth', authRouter(deps));
  app.use('/api/elections', electionsRouter(deps));
  app.use('/api/explorer', explorerRouter(deps));
  app.use('/api', identityRouter(deps));
  app.use('/api', meRouter(deps));
  app.use('/api', adminRouter(deps));
  app.use('/api', pagesRouter(deps));
  app.use('/api', configRouter(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found', nfp: true });
  });

  app.use(electionShortLinks(store));
  app.use(cleanHtmlUrls());
  app.use(officePageGuard());
  app.use(serveStaticNoHtml(config.distDir));
  app.use(serveStaticNoHtml(config.publicDir));
  app.use(spaFallback(config));

  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      res.status(404).json({ error: 'not found', nfp: true });
      return;
    }
    res.status(404).type('text').send('Not found');
  });

  app.use(errorHandler);
  return { app, store, explorer, chain, l1, config, mailer, mfa };
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
      `Republic Node (NOT FOR PROFIT) listening on ${config.host}:${port}  chainId=${config.chainId}`,
    );
  }
  return { ...created, server, port };
}

const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
