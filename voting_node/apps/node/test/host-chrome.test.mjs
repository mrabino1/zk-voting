// NOT FOR PROFIT — civic public good, not a commercial product.
// A VOTE_FQDN install is the operator's site. The Demo label is for an unnamed host.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { h, fill } from '../public/app.js';
import { footerMetaKey, namedVotingHost, showsDemoChrome } from '../public/host-chrome.js';
import { resolveClientBrand } from '../src/branding.mjs';
import { applyClientHostHtml, renderPublicHtml, rewriteModuleSpecifiers } from '../src/publicAssets.mjs';
import { webAuthnErrorMessage } from '../public/passkey-wallet.js';
import { homeIntro } from '../public/public-pages.js';
import { renderSetup, setupPasskeyControl } from '../public/setup.js';
import { mountSignInPanel, passkeyLoginControl } from '../public/signin.js';

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

test('a named host drops the civic banner and footer and can wear a client mark', () => {
  const shell = `
    <html lang="en">
      <!-- NOT FOR PROFIT — civic public good. Not a commercial product. -->
      <title data-i18n="chrome.titleHome">ZK-Voting — civic elections</title>
      <div id="nfp-banner" class="nfp-banner nfp-ribbon">NOT FOR PROFIT — civic public good. Not a commercial product.</div>
      <a class="brand" href="/"><span class="brand-mark"><img src="/brand-mark.svg" alt="" /></span>
        <span class="brand-name" title="ZK-Voting">ZK-Voting</span>
        <span class="brand-sub" data-i18n="chrome.brandSub">Office of civic elections</span>
      </a>
      <span class="brand-sub">Site admin</span>
      <ul><li><a href="https://zk-voting.org">About</a></li></ul>
      <span class="office-badge">Not for profit</span>
      <footer class="site-footer"><p class="footer-nfp">NOT FOR PROFIT</p><p>hello@zk-voting.org</p></footer>
    </html>`;
  const client = resolveClientBrand({
    voteFqdn: 'vote.nersha.example',
    env: {
      CLIENT_BRAND_NAME: 'Nersha',
      CLIENT_LOGO_URL: 'https://cdn.nersha.example/mark.svg',
      CLIENT_BRAND_URL: 'https://nersha.example',
      CLIENT_BRAND_SUBTITLE: 'City vote',
    },
  });
  assert.equal(client.name, 'Nersha');
  const named = applyClientHostHtml(shell, client);
  assert.match(named, /data-client-host="1"/);
  assert.doesNotMatch(named, /nfp-banner|office-badge|footer-nfp|NOT FOR PROFIT|Office of civic elections|civic elections/);
  assert.match(named, /src="https:\/\/cdn\.nersha\.example\/mark\.svg"/);
  assert.match(named, /href="https:\/\/nersha\.example\/"/);
  assert.match(named, /City vote/);
  assert.match(named, />Site admin</);
  assert.doesNotMatch(named, /href="https:\/\/zk-voting\.org">About/);
  assert.match(named, /powered by zk-voting\.org/);
  assert.match(named, /class="powered-by-mark" src="\/brand-mark\.svg"/);
  const ignored = resolveClientBrand({
    voteFqdn: '',
    env: { CLIENT_BRAND_NAME: 'Nersha', CLIENT_LOGO_URL: 'javascript:alert(1)' },
  });
  assert.equal(ignored.active, false);
  assert.equal(applyClientHostHtml(shell, ignored), shell);
  assert.equal(resolveClientBrand({ voteFqdn: 'vote.nersha.example', env: { CLIENT_LOGO_URL: 'javascript:alert(1)' } }).logoUrl, '');
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
    getAttribute(name) {
      return this.attrs[name];
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
    const attr = /^\[([^\]=]+)='([^']*)'\]$/.exec(sel);
    const matched = sel.startsWith('#')
      ? child.id === sel.slice(1)
      : sel.startsWith('.')
        ? classNames.includes(sel.slice(1))
        : attr
          ? String(child.attrs?.[attr[1]] ?? '') === attr[2]
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
    querySelector(sel) {
      return query(body, sel);
    },
    hasFocus() {
      return true;
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

test('sign-in and register do not report an unready passkey prompt', () => {
  assert.deepEqual(passkeyLoginControl({ preparing: true }), {
    disabled: true,
    label: 'Preparing passkey…',
  });
  assert.equal(passkeyLoginControl({ ready: true }).disabled, false);
  assert.equal(passkeyLoginControl({ failed: true }).disabled, false);
  for (const file of ['signin.js', 'register.js']) {
    assert.doesNotMatch(readFileSync(join(publicDir, file), 'utf8'), /PASSKEY_NOT_READY/);
  }
});

function walk(node, visit) {
  if (!node || node.nodeType !== 1) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findNode(node, pred) {
  let found = null;
  walk(node, (child) => {
    if (!found && pred(child)) found = child;
  });
  return found;
}

test('sign-in waits for the login challenge and shows the real prepare error', async () => {
  const { body } = installDom();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousFetch = globalThis.fetch;
  const gets = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      PublicKeyCredential: function PublicKeyCredential() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      credentials: {
        create() {},
        get(opts) {
          gets.push(opts);
          return new Promise(() => {});
        },
      },
    },
  });
  const begins = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/api/auth/passkey/login/begin')) {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      begins.push({ resolve });
      const data = await promise;
      const status = data.statusCode || 200;
      return {
        ok: status < 400,
        status,
        statusText: status < 400 ? 'OK' : 'Error',
        headers: { get() { return null; } },
        async text() {
          return JSON.stringify(data.body ?? data);
        },
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get() { return null; } },
      async text() {
        return JSON.stringify({ user: null, auth: {} });
      },
    };
  };
  try {
    const root = createNode('div');
    body.append(root);
    mountSignInPanel(root);
    let passkeyTab = null;
    for (let i = 0; i < 20 && !passkeyTab; i += 1) {
      await Promise.resolve();
      passkeyTab = findNode(root, (node) => node.tagName === 'BUTTON' && node.textContent === 'Passkey');
    }
    assert.ok(passkeyTab);
    fire(passkeyTab, 'click');
    const button = () => findNode(root, (node) => node.attrs?.['data-signin'] === 'passkey');
    const flash = () => findNode(root, (node) => String(node.className || '').split(/\s+/).includes('flash'));
    assert.equal(begins.length, 1);
    assert.equal(button().disabled, true);
    assert.equal(button().textContent, 'Preparing passkey…');
    fire(button(), 'click');
    assert.equal(gets.length, 0);
    assert.doesNotMatch(flash().textContent || '', /not ready/i);

    begins[0].resolve({ statusCode: 500, body: { error: 'challenge store unavailable' } });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    assert.equal(button().disabled, false);
    assert.match(flash().textContent, /challenge store unavailable/);
    assert.doesNotMatch(flash().textContent, /not ready/i);

    fire(button(), 'click');
    assert.equal(begins.length, 2);
    assert.equal(gets.length, 0);
    begins[1].resolve({ challenge: 'AQIDBA', rpId: 'vote.example.test' });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    assert.equal(button().disabled, false);
    assert.equal(button().textContent, 'Sign in with passkey');
    assert.equal(flash().textContent || '', '');

    fire(button(), 'click');
    assert.equal(gets.length, 1);
    assert.doesNotMatch(flash().textContent || '', /not ready/i);
  } finally {
    delete globalThis.document;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    globalThis.fetch = previousFetch;
  }
});
