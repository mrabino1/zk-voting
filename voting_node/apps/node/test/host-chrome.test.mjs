// NOT FOR PROFIT — civic public good, not a commercial product.
// A VOTE_FQDN install is the operator's site. The Demo label is for an unnamed host.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { h, fill } from '../public/app.js';
import { footerMetaKey, namedVotingHost, showsDemoChrome } from '../public/host-chrome.js';
import { renderPublicHtml, rewriteModuleSpecifiers } from '../src/publicAssets.mjs';
import { webAuthnErrorMessage } from '../public/passkey-wallet.js';
import { homeIntro } from '../public/public-pages.js';
import { renderSetup, setupPasskeyControl } from '../public/setup.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');

test('VOTE_FQDN hides the Demo chrome; an unnamed host keeps it', () => {
  const named = { vote: { fqdn: 'vote.nuursha.com' } };
  assert.equal(namedVotingHost(named), true);
  assert.equal(showsDemoChrome(named), false);
  assert.equal(namedVotingHost({ vote: { fqdn: '  ' } }), false);
  assert.equal(showsDemoChrome({ vote: { fqdn: '' } }), true);
  assert.equal(showsDemoChrome({}), true);
  assert.equal(showsDemoChrome(null), false);
  assert.equal(footerMetaKey(named), 'chrome.footerMetaHost');
  assert.equal(footerMetaKey({}), 'chrome.footerMeta');
  assert.doesNotMatch(
    readFileSync(join(publicDir, 'locales/en.js'), 'utf8').match(/footerMetaHost:\s*\n\s*"([^"]+)"/)[1],
    /demo/i,
  );
});

test('a named host response omits the Demo chip instead of hiding it', () => {
  const html = '<span class="topbar-chip" id="topbar-demo" hidden>Demo</span><p class="footer-meta" id="footer-demo" hidden>Voting demo: <a href="/register">Register</a></p><script type="module" src="/app.js"></script>';
  const named = renderPublicHtml(html, { voteFqdn: 'vote.nuursha.com', assetVersion: 'abc123' });
  assert.doesNotMatch(named, /topbar-demo|footer-demo|>Demo</);
  assert.match(named, /src="\/app\.js\?v=abc123"/);
  const demo = renderPublicHtml(html, { assetVersion: 'abc123' });
  assert.match(demo, /id="topbar-demo"/);
  assert.equal(
    rewriteModuleSpecifiers('import { renderSetup } from "./setup.js";\nimport "./i18n.js";', 'abc123'),
    'import { renderSetup } from "./setup.js?v=abc123";\nimport "./i18n.js?v=abc123";',
  );
});

test('the shell starts with the Demo chip hidden so a named host never flashes it', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /id="topbar-demo"[^>]*\bhidden\b/);
  assert.match(html, /id="footer-demo"[^>]*\bhidden\b/);
  const css = readFileSync(join(publicDir, 'styles.css'), 'utf8');
  assert.match(css, /\.topbar-chip\[hidden\][\s\S]*display:\s*none/);
});

test('a named host home is the install, and a custom home is not a demo', () => {
  const named = homeIntro({ namedHost: true, siteTitle: 'Nuursha', brand: 'ZK-Voting' });
  assert.equal(named.kicker, null);
  assert.equal(named.heading, 'Nuursha');
  assert.equal(named.demoNote, false);
  assert.doesNotMatch(named.lede, /demo/i);

  const custom = homeIntro({
    replace: true,
    overlayTitle: 'City elections',
    brand: 'ZK-Voting',
  });
  assert.equal(custom.kicker, null);
  assert.equal(custom.heading, 'City elections');
  assert.equal(custom.demoNote, false);

  const demo = homeIntro({ brand: 'ZK-Voting' });
  assert.equal(demo.kicker, 'Voting demo');
  assert.match(demo.heading, /Try a ZK-Voting vote/);
  assert.equal(demo.demoNote, true);
});

test('the setup passkey button waits until the ceremony is prepared', () => {
  assert.deepEqual(setupPasskeyControl({ preparing: true }), {
    disabled: true,
    label: 'Preparing passkey…',
  });
  assert.equal(setupPasskeyControl({}).disabled, true);
  assert.equal(setupPasskeyControl({ ready: true }).disabled, false);
  assert.equal(setupPasskeyControl({ failed: true }).disabled, false);
  assert.equal(setupPasskeyControl({ busy: true, ready: true }).disabled, true);
  const src = readFileSync(join(publicDir, 'setup.js'), 'utf8');
  assert.equal(src.includes('PASSKEY_NOT_READY'), false);
  assert.match(src, /webAuthnErrorMessage\(err\)/);
  assert.match(src, /id: "setup-passkey-btn"/);
});

function createNode(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    htmlFor: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    type: '',
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    parent: null,
    listeners: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
      if (name === 'id') this.id = value;
      if (name === 'type') this.type = value;
      if (name === 'disabled') this.disabled = true;
      if (name === 'class') this.className = value;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    append(...kids) {
      for (const kid of kids) {
        if (kid && typeof kid === 'object') kid.parent = this;
        this.children.push(kid);
      }
    },
    replaceChildren(...kids) {
      this.children = [];
      this.append(...kids.flat());
    },
    querySelector(sel) {
      return query(this, sel);
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
    },
  };
  return node;
}

function query(node, sel) {
  for (const child of node.children || []) {
    if (!child || child.nodeType !== 1) continue;
    const classNames = String(child.className || '').split(/\s+/);
    const matched = sel.startsWith('#')
      ? child.id === sel.slice(1)
      : sel.startsWith('.')
        ? classNames.includes(sel.slice(1))
        : child.tagName === sel.toUpperCase();
    if (matched) return child;
    const nested = query(child, sel);
    if (nested) return nested;
  }
  return null;
}

function installDom() {
  const body = createNode('body');
  const documentStub = {
    body,
    createElement: createNode,
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), children: [] };
    },
    getElementById(id) {
      return query(body, `#${id}`);
    },
  };
  globalThis.document = documentStub;
  return { body, document: documentStub };
}

function fire(node, type) {
  const event = { type, target: node, preventDefault() {} };
  for (const fn of node.listeners[type] || []) fn(event);
}

function textOf(node) {
  if (!node) return '';
  const own = node.children?.length ? '' : node.textContent || '';
  return own + (node.children || []).map(textOf).join('');
}

test('setup shows the real prepare error and does not open a passkey until it is ready', async () => {
  const { body } = installDom();
  const main = createNode('main');
  body.append(main);
  let releaseBegin;
  let rejectBegin;
  const beginGate = new Promise((resolve, reject) => {
    releaseBegin = resolve;
    rejectBegin = reject;
  });
  const prompts = [];
  const api = async (path) => {
    if (path === '/api/setup') {
      return {
        needsAdmin: true,
        setupTokenRequired: true,
        setupTokenSource: 'env',
        suggestedHandle: 'nuursha-vote',
      };
    }
    if (path === '/api/setup/admin/begin') return beginGate;
    throw new Error(`unexpected ${path}`);
  };
  const wallet = {
    hasWebAuthn: () => true,
    webAuthnErrorMessage,
    prepareRegistrationCeremony: async (options) => ({ publicKey: { rp: options.rp }, displayName: options.displayName }),
    registerPasskey(args) {
      prompts.push(args);
      return Promise.resolve({ finishResult: {} });
    },
  };

  await renderSetup(main, { h, api, fill, wallet, announce() {}, navigate() {} });
  const token = query(main, '#setup-token');
  const terms = query(main, '#setup-terms');
  const form = query(main, 'FORM');
  token.value = 'setup-token-value';
  fire(token, 'input');
  terms.checked = true;
  fire(terms, 'change');

  const button = () => document.getElementById('setup-passkey-btn');
  assert.equal(button().disabled, true);
  assert.equal(button().textContent, 'Preparing passkey…');
  fire(form, 'submit');
  assert.deepEqual(prompts, []);
  assert.equal(query(main, '.notice-error'), null);

  const beginError = new Error('setup token required');
  beginError.data = { code: 'SETUP_TOKEN_REQUIRED' };
  rejectBegin(beginError);
  await beginGate.catch(() => {});
  for (let i = 0; i < 6; i += 1) await Promise.resolve();

  const alert = query(main, '.notice-error');
  assert.ok(alert, 'prepare failure is shown');
  assert.match(textOf(alert), /setup token/i);
  assert.doesNotMatch(textOf(alert), /not ready/i);
  assert.equal(button().disabled, false);

  delete globalThis.document;
});

test('a prepared setup ceremony opens the passkey on the click', async () => {
  const { body } = installDom();
  const main = createNode('main');
  body.append(main);
  let releaseBegin;
  const beginGate = new Promise((resolve) => {
    releaseBegin = resolve;
  });
  const prompts = [];
  const api = async (path) => {
    if (path === '/api/setup') {
      return { needsAdmin: true, suggestedHandle: 'nuursha-vote' };
    }
    if (path === '/api/setup/admin/begin') return beginGate;
    return {};
  };
  const wallet = {
    hasWebAuthn: () => true,
    webAuthnErrorMessage,
    prepareRegistrationCeremony: async () => ({ publicKey: { challenge: 'ready' } }),
    registerPasskey(args) {
      prompts.push(args.prepared);
      return new Promise(() => {});
    },
  };
  await renderSetup(main, { h, api, fill, wallet, announce() {}, navigate() {} });
  const terms = query(main, '#setup-terms');
  const form = query(main, 'FORM');
  terms.checked = true;
  fire(terms, 'change');
  const button = () => document.getElementById('setup-passkey-btn');
  assert.equal(button().disabled, true);
  releaseBegin({ publicKey: { challenge: 'server' } });
  await beginGate;
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.equal(button().disabled, false);
  assert.equal(button().textContent, 'Create super admin passkey');
  fire(form, 'submit');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].publicKey);
  delete globalThis.document;
});
