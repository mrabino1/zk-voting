// NOT FOR PROFIT — civic public good, not a commercial product.
// The passkey ceremony must call credentials.create/get in the click turn,
// before any awaited request. Preparing the ceremony must not prompt.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  loginPasskey,
  prepareAssertionCeremony,
  prepareRegistrationCeremony,
  registerPasskey,
  startAssertionCeremony,
  startRegistrationCeremony,
} from '../public/passkey-wallet.js';

const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.PublicKeyCredential;
  if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
});

function installBrowser({ focused = true } = {}) {
  const calls = [];
  let hasFocus = focused;
  let focusCalls = 0;
  setGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  globalThis.PublicKeyCredential.getClientCapabilities = async () => ({ 'extension:prf': true });
  setGlobal('navigator', {
    credentials: {
      create() {
        calls.push({ op: 'create', focused: hasFocus, focusCalls });
        return new Promise(() => {});
      },
      get() {
        calls.push({ op: 'get', focused: hasFocus, focusCalls });
        return new Promise(() => {});
      },
    },
  });
  setGlobal('document', {
    hasFocus() {
      return hasFocus;
    },
    createElement() {
      return {
        type: '',
        tabIndex: 0,
        style: {},
        setAttribute() {},
        focus() {
          focusCalls += 1;
          hasFocus = true;
        },
        remove() {},
      };
    },
    body: { appendChild() {} },
  });
  setGlobal('window', {
    PublicKeyCredential: globalThis.PublicKeyCredential,
    location: { hostname: 'localhost' },
    focus() {
      focusCalls += 1;
      hasFocus = true;
    },
  });
  return { calls };
}

const creationOptions = {
  challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  rp: { name: 'ZK-Voting', id: 'localhost' },
  user: { id: 'bbbbbbbbbbbbbbbbbbbbbb', name: 'admin', displayName: 'admin' },
};

test('prepareRegistrationCeremony does not call credentials.create', async () => {
  const { calls } = installBrowser();
  const prepared = await prepareRegistrationCeremony(creationOptions);
  assert.ok(prepared.publicKey);
  assert.deepEqual(
    prepared.publicKey.pubKeyCredParams.map((param) => param.alg),
    [-48, -49, -7, -8, -257],
  );
  assert.equal(prepared.publicKey.authenticatorSelection.userVerification, 'required');
  assert.equal(prepared.publicKey.authenticatorSelection.residentKey, 'required');
  assert.deepEqual(calls, []);
});

test('startRegistrationCeremony calls create synchronously while the document is focused', async () => {
  const { calls } = installBrowser({ focused: false });
  const prepared = await prepareRegistrationCeremony(creationOptions);
  let yielded = false;
  const pending = startRegistrationCeremony(prepared);
  pending.then(
    () => {
      yielded = true;
    },
    () => {
      yielded = true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'create');
  assert.equal(calls[0].focused, true);
  assert.ok(calls[0].focusCalls > 0);
  await Promise.resolve();
  assert.equal(yielded, false);
});

test('registerPasskey({prepared}) calls create before any api request', async () => {
  const { calls } = installBrowser();
  const prepared = await prepareRegistrationCeremony(creationOptions);
  const order = [];
  const orig = globalThis.navigator.credentials.create;
  globalThis.navigator.credentials.create = function create() {
    order.push('create');
    return orig();
  };
  const api = async (path) => {
    order.push(`api:${path}`);
    return { chainId: 27427 };
  };
  const pending = registerPasskey({
    api,
    prepared,
    displayName: 'admin',
    acceptedTerms: true,
    strict: true,
  });
  assert.equal(order[0], 'create');
  const apiAt = order.findIndex((item) => String(item).startsWith('api:'));
  assert.equal(apiAt > 0, true);
  pending.catch(() => {});
});

test('loginPasskey({prepared}) calls get before any api request', async () => {
  const { calls } = installBrowser({ focused: false });
  const prepared = await prepareAssertionCeremony({
    challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    rpId: 'localhost',
    userVerification: 'required',
  });
  const order = [];
  globalThis.navigator.credentials.get = function get() {
    order.push('get');
    calls.push({ op: 'get', focused: globalThis.document.hasFocus() });
    return new Promise(() => {});
  };
  const api = async (path) => {
    order.push(`api:${path}`);
    return {};
  };
  const pending = loginPasskey({ api, handle: 'admin', prepared });
  assert.equal(order[0], 'get');
  assert.equal(order.filter((item) => String(item).startsWith('api:')).length, 0);
  assert.equal(globalThis.document.hasFocus(), true);
  pending.catch(() => {});
});

test('startAssertionCeremony refuses an unprepared ceremony without calling get', () => {
  const { calls } = installBrowser();
  assert.throws(() => startAssertionCeremony(null), /PASSKEY_NOT_READY/);
  assert.deepEqual(calls, []);
});
