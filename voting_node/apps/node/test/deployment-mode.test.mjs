// NOT FOR PROFIT — civic public good, not a commercial product.
// A deployment is civic elections or one ERC-20. The host page is /admin.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { deploymentMode, deploymentSummary } from '../public/deployment-mode.js';

const adminHtml = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const adminJs = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const backOffice = readFileSync(new URL('../public/back-office.js', import.meta.url), 'utf8');

function installDom() {
  class Node {
    constructor(type) {
      this.nodeType = type;
      this.childNodes = [];
    }
    append(...kids) {
      for (const kid of kids) this.childNodes.push(kid);
    }
    get textContent() {
      if (this.nodeType === 3) return this.data || '';
      return this.childNodes.map((child) => (child.textContent == null ? '' : child.textContent)).join('');
    }
    set textContent(value) {
      const text = new Node(3);
      text.data = String(value);
      this.childNodes = [text];
    }
    replaceChildren(...kids) {
      this.childNodes = kids.flat().filter((child) => child != null && child !== false);
    }
  }
  class Element extends Node {
    constructor(tag) {
      super(1);
      this.tagName = String(tag).toUpperCase();
      this.attrs = {};
      this.className = '';
    }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }
    addEventListener() {}
  }
  globalThis.document = {
    createElement(tag) {
      return new Element(tag);
    },
    createTextNode(value) {
      const text = new Node(3);
      text.data = String(value);
      return text;
    },
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const officer = { user: { handle: 'admin', role: 'platform_super_admin' }, jurisdictionRoles: [] };

describe('deployment mode', () => {
  test('civic when polls are off, ERC-20 only when the one token is configured', () => {
    assert.equal(deploymentMode(null), 'civic');
    assert.equal(deploymentMode({ pollsEnabled: false }), 'civic');
    assert.equal(deploymentMode({ pollsEnabled: true, pollsReady: false, votingToken: { configured: false, reason: 'unset' } }), 'erc20-unconfigured');
    assert.equal(
      deploymentMode({ pollsEnabled: true, pollsReady: true, votingToken: { configured: true, address: '0xabc', chainId: 1 } }),
      'erc20',
    );
    assert.match(deploymentSummary({ pollsEnabled: false }).body, /no ERC-20/);
    assert.match(deploymentSummary({ pollsEnabled: true, votingToken: { reason: 'unset' } }).body, /VOTING_TOKEN_ADDRESS/);
    const ready = deploymentSummary({
      pollsEnabled: true,
      pollsReady: true,
      votingToken: { configured: true, address: '0xabc', chainId: 1 },
    });
    assert.match(ready.body, /0xabc/);
    assert.match(ready.body, /not a voter roll/);
  });

  test('the host admin page owns ERC-20 polls', () => {
    assert.match(adminHtml, /id="deployment"/);
    assert.match(adminHtml, /VOTING_TOKEN_ADDRESS/);
    assert.match(adminJs, /mountTokenPolls/);
    assert.match(backOffice, /\/admin#deployment/);
    assert.doesNotMatch(backOffice, /id="token-polls"|Token polls/);
  });

  test('the officer hub follows the deployment', async () => {
    installDom();
    const { renderOffice } = await import('../public/public-pages.js');
    const civic = document.createElement('main');
    renderOffice(
      civic,
      { h, setTitle() {}, navigate() {}, route: { path: '/office' }, hostConfig: { pollsEnabled: false }, namedHost: true },
      { me: officer },
    );
    assert.match(civic.textContent, /Create and manage elections/);
    assert.doesNotMatch(civic.textContent, /ERC-20 polls/);

    const erc20 = document.createElement('main');
    renderOffice(
      erc20,
      {
        h,
        setTitle() {},
        navigate() {},
        route: { path: '/office' },
        namedHost: true,
        hostConfig: { pollsEnabled: true, pollsReady: true, votingToken: { configured: true, address: '0xabc', chainId: 1 } },
      },
      { me: officer },
    );
    assert.match(erc20.textContent, /ERC-20 polls/);
    assert.match(erc20.textContent, /0xabc/);
    assert.doesNotMatch(erc20.textContent, /Create and manage elections/);
    assert.doesNotMatch(erc20.textContent, /Voter roll/);
  });
});
