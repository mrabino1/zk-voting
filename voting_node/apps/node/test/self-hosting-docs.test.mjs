// NOT FOR PROFIT — civic public good, not a commercial product.
// Self-hosting docs: /docs pages, the Markdown source route, nav, and renderer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { isStandaloneHtmlPath, mainNav, navItemIsCurrent } from '../public/audience.js';
import { docHref, renderMarkdown, slugFromPath, slugify } from '../public/docs.js';
import { SELF_HOSTING_DOCS_DIR } from '../src/routes/selfHostingDocs.mjs';
import { createApp } from '../src/server.mjs';

const nav = JSON.parse(readFileSync(path.join(SELF_HOSTING_DOCS_DIR, 'nav.json'), 'utf8'));
const slugs = nav.sections.flatMap((s) => s.pages.map((p) => p.slug));

describe('self-hosting docs renderer', () => {
  test('escapes HTML and drops unsafe links', () => {
    const html = renderMarkdown('# Hi <script>\n\n<img src=x onerror=alert(1)> [x](javascript:void) [y](../SECRET.md)');
    assert.doesNotMatch(html, /<script|<img|href="javascript/i);
    assert.match(html, /&gt; x <code>SECRET/);
    assert.match(html, /&lt;img/);
    assert.match(html, /<code>SECRET\.md<\/code>/);
  });

  test('maps sibling Markdown links to /docs URLs', () => {
    assert.deepEqual(docHref('./README.md'), { href: '/docs' });
    assert.deepEqual(docHref('./tailscale.md'), { href: '/docs/tailscale' });
    assert.deepEqual(docHref('./upgrading.md#release-channels'), { href: '/docs/upgrading#release-channels' });
    assert.equal(docHref('../ARCHITECTURE.md'), null);
    assert.equal(docHref('javascript:alert(1)'), null);
    assert.equal(docHref('//evil.example/x'), null);
    assert.equal(docHref('https://tailscale.com').external, true);
  });

  test('tables, fenced code in lists, and GitHub heading ids', () => {
    const html = renderMarkdown('## Archive (S3 / R2)\n\n| A | B |\n| --- | --- |\n| `x` | y |\n\n1. Step\n\n   ```bash\n   echo hi\n   ```\n\n2. Next\n');
    assert.match(html, /id="archive-s3--r2"/);
    assert.match(html, /<th scope="col">A<\/th>/);
    assert.match(html, /<td><code>x<\/code><\/td>/);
    assert.match(html, /<ol><li><p>Step<\/p>\n<pre tabindex="0"><code class="language-bash">echo hi<\/code><\/pre><\/li><li>Next<\/li><\/ol>/);
    assert.equal(slugify('Plain Docker Compose (any Linux host)'), 'plain-docker-compose-any-linux-host');
  });

  test('slugFromPath', () => {
    assert.equal(slugFromPath('/docs'), 'README');
    assert.equal(slugFromPath('/docs/'), 'README');
    assert.equal(slugFromPath('/docs/tailscale'), 'tailscale');
    assert.equal(slugFromPath('/docs/../etc'), null);
  });

  test('every page in nav.json renders and its in-docs links resolve', () => {
    for (const slug of slugs) {
      const headings = [];
      const html = renderMarkdown(readFileSync(path.join(SELF_HOSTING_DOCS_DIR, `${slug}.md`), 'utf8'), headings);
      assert.ok(headings.some((h) => h.level === 1), `${slug} has an h1`);
      assert.match(html, /NOT FOR PROFIT/, `${slug} carries the charter line`);
      assert.doesNotMatch(html, /```/, `${slug} has no unrendered fences`);
      for (const [, target, hash] of html.matchAll(/href="\/docs(?:\/([a-z0-9-]+))?(#[^"]*)?"/g)) {
        const page = target || 'README';
        assert.ok(slugs.includes(page), `${slug} links to unknown page ${page}`);
        if (hash) {
          const other = renderMarkdown(readFileSync(path.join(SELF_HOSTING_DOCS_DIR, `${page}.md`), 'utf8'));
          assert.ok(other.includes(`id="${hash.slice(1)}"`), `${slug} links to missing anchor ${page}${hash}`);
        }
      }
    }
  });
});

describe('self-hosting docs navigation', () => {
  test('Docs is a standalone page, not in the voting-demo nav', () => {
    for (const audience of ['public', 'voter', 'officer']) {
      const item = mainNav(audience).find((i) => i.href === '/docs');
      assert.equal(item, undefined, audience);
    }
    assert.equal(isStandaloneHtmlPath('/docs'), true);
    assert.equal(isStandaloneHtmlPath('/docs/tailscale'), true);
    assert.equal(navItemIsCurrent({ href: '/docs' }, '/docs/tailscale', null), true);
  });
});

describe('self-hosting docs HTTP', () => {
  let tmp;
  let server;
  let base;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'zkv-docs-'));
    const created = await createApp({ dataDir: tmp, quiet: true, port: 0, disclosureIntervalSeconds: 0 });
    server = await new Promise((resolve) => {
      const s = created.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await rm(tmp, { recursive: true, force: true });
  });

  test('/docs and /docs/<slug> serve the docs page without sign-in', async () => {
    for (const p of ['/docs', '/docs/', '/docs/tailscale', '/docs/upgrading']) {
      const res = await fetch(base + p, { redirect: 'manual' });
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type') || '', /html/);
      const html = await res.text();
      assert.match(html, /id="docs-article"/, p);
      assert.match(html, /NOT FOR PROFIT/, p);
    }
    const redirect = await fetch(`${base}/docs.html`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/docs');
  });

  test('Markdown source is served for listed pages only', async () => {
    const navRes = await fetch(`${base}/docs-src/self-hosting/nav.json`);
    assert.equal(navRes.status, 200);
    assert.deepEqual(await navRes.json(), nav);
    for (const slug of slugs) {
      const res = await fetch(`${base}/docs-src/self-hosting/${slug}.md`);
      assert.equal(res.status, 200, slug);
      assert.match(res.headers.get('content-type') || '', /text\/markdown/);
    }
    for (const bad of ['missing.md', '..%2F..%2Fpackage.json', '..%2FARCHITECTURE.md', 'README.md.bak', '.env.md']) {
      const res = await fetch(`${base}/docs-src/self-hosting/${bad}`);
      assert.equal(res.status, 404, bad);
    }
  });
});
