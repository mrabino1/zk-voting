// NOT FOR PROFIT — civic public good, not a commercial product.
// Public documentation for personal API keys. HTML for people, JSON and
// plain text for bots. Host-only administration is not described here.

import { Router } from 'express';

import { botDiscovery, renderBotGuideMarkdown, renderBotHtml, renderOpenApi } from '../botApiCatalog.mjs';

function prefersJson(req) {
  if (String(req.query?.format || '').toLowerCase() === 'json') return true;
  const accept = String(req.get('accept') || '');
  if (!accept) return false;
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json');
}

function linkHeaders(res) {
  res.set(
    'Link',
    '</api/openapi.json>; rel="describedby", </api/llms.txt>; rel="describedby"',
  );
}

export function botDocsRouter() {
  const router = Router();

  router.get(['/', ''], (req, res) => {
    linkHeaders(res);
    if (prefersJson(req)) {
      res.json(botDiscovery());
      return;
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderBotHtml());
  });

  router.get('/openapi.json', (_req, res) => {
    linkHeaders(res);
    res.json(renderOpenApi());
  });

  router.get('/llms.txt', (_req, res) => {
    linkHeaders(res);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(renderBotGuideMarkdown());
  });

  return router;
}

export function repoLlmsRouter() {
  const router = Router();
  router.get('/llms.txt', (_req, res) => {
    linkHeaders(res);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(renderBotGuideMarkdown());
  });
  return router;
}
