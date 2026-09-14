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
import { Explorer } from './explorer.mjs';
import { errorHandler } from './http.mjs';
import { createPasskeyService } from './passkey.mjs';
import { Store } from './store.mjs';
import { adminRouter } from './routes/admin.mjs';
import { authRouter } from './routes/auth.mjs';
import { electionsRouter } from './routes/elections.mjs';
import { explorerRouter } from './routes/explorer.mjs';
import { configRouter, healthRouter } from './routes/health.mjs';
import { meRouter } from './routes/me.mjs';

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
  <p class="muted">The UI is loading. This Node process serves the civic voting API and will host the React SPA from <code>public/</code> or <code>dist/</code> when present.</p>
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
  const config = getConfig(overrides);
  const store = await Store.open(config);
  const explorer = await Explorer.open(config);
  const chain = createChain(config);
  const passkeys = createPasskeyService(config, store);
  const deps = { config, store, explorer, chain, passkeys };

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
  app.use('/api', meRouter(deps));
  app.use('/api', adminRouter(deps));
  app.use('/api', configRouter(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found', nfp: true });
  });

  app.use(express.static(config.distDir));
  app.use(express.static(config.publicDir));
  app.use(spaFallback(config));

  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      res.status(404).json({ error: 'not found', nfp: true });
      return;
    }
    res.status(404).type('text').send('Not found');
  });

  app.use(errorHandler);
  return { app, store, explorer, chain, config };
}

export async function startServer(overrides = {}) {
  const created = await createApp(overrides);
  const { app, config } = created;
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  if (!config.quiet) {
    console.log(`Republic Node (NOT FOR PROFIT) listening on :${port}  chainId=${config.chainId}`);
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
