// NOT FOR PROFIT — civic public good, not a commercial product.
// Serves the self-hosting guides in docs/self-hosting/ as raw Markdown for
// the /docs pages. Read-only, public, no secrets: the same files are in the
// repository. Only names listed in nav.json (plus nav.json itself) are served.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));

/** docs/self-hosting at the repository root (also copied into the image). */
export const SELF_HOSTING_DOCS_DIR = path.resolve(here, '../../../../docs/self-hosting');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$|^README$/;

function loadAllowedSlugs(dir) {
  try {
    const nav = JSON.parse(fs.readFileSync(path.join(dir, 'nav.json'), 'utf8'));
    const slugs = new Set();
    for (const section of nav.sections || []) {
      for (const page of section.pages || []) {
        if (typeof page.slug === 'string' && SLUG_RE.test(page.slug)) slugs.add(page.slug);
      }
    }
    return slugs;
  } catch {
    return new Set();
  }
}

export function selfHostingDocsRouter({ dir = SELF_HOSTING_DOCS_DIR } = {}) {
  const router = Router();
  const allowed = loadAllowedSlugs(dir);

  router.get('/docs-src/self-hosting/nav.json', (_req, res) => {
    const file = path.join(dir, 'nav.json');
    if (!fs.existsSync(file)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(fs.readFileSync(file, 'utf8'));
  });

  router.get('/docs-src/self-hosting/:name.md', (req, res) => {
    const slug = req.params.name;
    if (!allowed.has(slug)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    const file = path.join(dir, `${slug}.md`);
    if (!fs.existsSync(file)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('text/markdown; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });

  return router;
}
