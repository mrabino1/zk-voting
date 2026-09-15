// NOT FOR PROFIT — civic public good, not a commercial product.
// Deterministic domain separation: account PRF/HKDF ≠ identity trapdoor/nullifier.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCOUNT_HKDF_INFO,
  ACCOUNT_PRF_DOMAIN,
  DEFAULT_CHAIN_ID,
  DEFAULT_JURISDICTION_ID,
  IDENTITY_HKDF_INFO,
  IDENTITY_PRF_DOMAIN,
  IDENTITY_SCHEME,
  STALE_WALLET_MESSAGE,
  WALLET_RECORD_VERSION,
  buildPrfEvalExtension,
  bytesToHex,
  deriveIdentitySecrets,
  derivePrfEvalSalt,
  hkdfSha256Bits,
  isCurrentWalletRecord,
  keccak256,
  prfEvalSaltsForCredential,
  unwrapSeedWithAccountPrf,
  wrapSeedWithAccountPrf,
} from '../public/passkey-wallet.js';

const CREDENTIAL_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const PRF_ACCOUNT = Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 0xff);
const PRF_IDENTITY = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 7) & 0xff);
const SEED = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + (i % 16));

const VECTORS = {
  saltAccount: '2116cfbf73763fce04df582be7e68888bf13acff3c6775c6a69a8d55590cf427',
  saltIdentity: 'afd32da566374f5aeea83ee8be78e790b95b02c30e28d8d12d2612ec42c6acc9',
  wrapKey: '6ca996ea0e238fcba6f7df6e4b9a1c9751b9e2f3d4d54226a215a9e3b3cae658',
  trapdoor: '47d056fe5167727938ff04f1418d5b6392cd0e229507d3823c99a30897a1cddf',
  nullifierSecret: 'f799aaeb233a9818b15ec079ecdfe1a7d922f7b05108322ea12841b58d7ea2ab',
  commitment: '0x64bf9260086772f0a30e42c687b52569bce194aa384613054ed3ed362c661ed7',
};

function hexEq(a, b) {
  return bytesToHex(a) === (typeof b === 'string' ? b : bytesToHex(b));
}

describe('passkey PRF/HKDF domain separation', () => {
  test('account and identity PRF eval salts differ for the same credential', async () => {
    const salts = await prfEvalSaltsForCredential({
      credentialId: CREDENTIAL_ID,
      chainId: DEFAULT_CHAIN_ID,
      jurisdictionId: DEFAULT_JURISDICTION_ID,
    });
    assert.equal(bytesToHex(salts.saltAccount), VECTORS.saltAccount);
    assert.equal(bytesToHex(salts.saltIdentity), VECTORS.saltIdentity);
    assert.notEqual(bytesToHex(salts.saltAccount), bytesToHex(salts.saltIdentity));
    assert.equal(salts.saltAccount.length, 32);
    assert.equal(salts.saltIdentity.length, 32);
  });

  test('chain id binds only the account salt; jurisdiction id binds only the identity salt', async () => {
    const base = await prfEvalSaltsForCredential({
      credentialId: CREDENTIAL_ID,
      chainId: DEFAULT_CHAIN_ID,
      jurisdictionId: DEFAULT_JURISDICTION_ID,
    });
    const otherChain = await prfEvalSaltsForCredential({
      credentialId: CREDENTIAL_ID,
      chainId: 1,
      jurisdictionId: DEFAULT_JURISDICTION_ID,
    });
    const otherJur = await prfEvalSaltsForCredential({
      credentialId: CREDENTIAL_ID,
      chainId: DEFAULT_CHAIN_ID,
      jurisdictionId: 'northbridge',
    });

    assert.notEqual(bytesToHex(base.saltAccount), bytesToHex(otherChain.saltAccount));
    assert.equal(bytesToHex(base.saltIdentity), bytesToHex(otherChain.saltIdentity));
    assert.equal(bytesToHex(base.saltAccount), bytesToHex(otherJur.saltAccount));
    assert.notEqual(bytesToHex(base.saltIdentity), bytesToHex(otherJur.saltIdentity));
  });

  test('swapping domain strings cannot produce the other salt', async () => {
    const account = await derivePrfEvalSalt({
      domain: ACCOUNT_PRF_DOMAIN,
      credentialId: CREDENTIAL_ID,
      binding: String(DEFAULT_CHAIN_ID),
    });
    const swapped = await derivePrfEvalSalt({
      domain: IDENTITY_PRF_DOMAIN,
      credentialId: CREDENTIAL_ID,
      binding: String(DEFAULT_CHAIN_ID),
    });
    assert.notEqual(bytesToHex(account), bytesToHex(swapped));
    const identity = await derivePrfEvalSalt({
      domain: IDENTITY_PRF_DOMAIN,
      credentialId: CREDENTIAL_ID,
      binding: DEFAULT_JURISDICTION_ID,
    });
    const identityWithAccountDomain = await derivePrfEvalSalt({
      domain: ACCOUNT_PRF_DOMAIN,
      credentialId: CREDENTIAL_ID,
      binding: DEFAULT_JURISDICTION_ID,
    });
    assert.notEqual(bytesToHex(identity), bytesToHex(identityWithAccountDomain));
  });

  test('identity secrets come from the identity PRF output, not the account PRF output', async () => {
    const fromIdentity = await deriveIdentitySecrets(PRF_IDENTITY);
    const fromAccount = await deriveIdentitySecrets(PRF_ACCOUNT);
    assert.equal(bytesToHex(fromIdentity.trapdoor), VECTORS.trapdoor);
    assert.equal(bytesToHex(fromIdentity.nullifierSecret), VECTORS.nullifierSecret);
    assert.equal(fromIdentity.commitment, VECTORS.commitment);
    assert.notEqual(fromIdentity.commitment, fromAccount.commitment);
    assert.notEqual(bytesToHex(fromIdentity.trapdoor), bytesToHex(fromAccount.trapdoor));
    assert.notEqual(bytesToHex(fromIdentity.trapdoor), bytesToHex(SEED));
    assert.notEqual(bytesToHex(fromIdentity.nullifierSecret), bytesToHex(SEED));
  });

  test('account wrap HKDF bits are not the identity trapdoor', async () => {
    const wrapKey = await hkdfSha256Bits(PRF_ACCOUNT, {
      salt: ACCOUNT_PRF_DOMAIN,
      info: ACCOUNT_HKDF_INFO,
      length: 32,
    });
    assert.equal(bytesToHex(wrapKey), VECTORS.wrapKey);
    const ident = await deriveIdentitySecrets(PRF_IDENTITY);
    assert.notEqual(bytesToHex(wrapKey), bytesToHex(ident.trapdoor));
    assert.notEqual(bytesToHex(wrapKey), bytesToHex(ident.nullifierSecret));
  });

  test('feeding the account PRF into identity HKDF still differs from the identity PRF path', async () => {
    const swapped = await hkdfSha256Bits(PRF_ACCOUNT, {
      salt: IDENTITY_PRF_DOMAIN,
      info: IDENTITY_HKDF_INFO,
      length: 64,
    });
    const ident = await deriveIdentitySecrets(PRF_IDENTITY);
    assert.notEqual(bytesToHex(swapped.subarray(0, 32)), bytesToHex(ident.trapdoor));
    assert.notEqual(bytesToHex(swapped.subarray(32, 64)), bytesToHex(ident.nullifierSecret));
  });

  test('v1 construction (identity HKDF of the account seed) is not the v2 identity', async () => {
    const v1 = await hkdfSha256Bits(SEED, {
      salt: 'republic.identity.v1',
      info: 'trapdoor+nullifier',
      length: 64,
    });
    const ident = await deriveIdentitySecrets(PRF_IDENTITY);
    assert.notEqual(bytesToHex(v1.subarray(0, 32)), bytesToHex(ident.trapdoor));
    const v1FromAccountPrf = await hkdfSha256Bits(PRF_ACCOUNT, {
      salt: 'republic.identity.v1',
      info: 'trapdoor+nullifier',
      length: 64,
    });
    assert.notEqual(bytesToHex(v1FromAccountPrf.subarray(0, 32)), bytesToHex(ident.trapdoor));
  });

  test('account PRF wrap cannot be opened with the identity PRF output', async () => {
    const wrapped = await wrapSeedWithAccountPrf(PRF_ACCOUNT, SEED);
    const unwrapped = await unwrapSeedWithAccountPrf(PRF_ACCOUNT, wrapped);
    assert.ok(hexEq(unwrapped, SEED));
    await assert.rejects(() => unwrapSeedWithAccountPrf(PRF_IDENTITY, wrapped));
  });

  test('commitment is keccak256(trapdoor || nullifierSecret)', async () => {
    const ident = await deriveIdentitySecrets(PRF_IDENTITY);
    const packed = new Uint8Array(64);
    packed.set(ident.trapdoor, 0);
    packed.set(ident.nullifierSecret, 32);
    assert.equal('0x' + bytesToHex(keccak256(packed)), ident.commitment);
  });

  test('buildPrfEvalExtension exposes first and second salts for login merge', async () => {
    const salts = await prfEvalSaltsForCredential({
      credentialId: CREDENTIAL_ID,
      chainId: DEFAULT_CHAIN_ID,
      jurisdictionId: DEFAULT_JURISDICTION_ID,
    });
    const ext = buildPrfEvalExtension(salts);
    assert.equal(bytesToHex(ext.prf.eval.first), VECTORS.saltAccount);
    assert.equal(bytesToHex(ext.prf.eval.second), VECTORS.saltIdentity);
    const accountOnly = buildPrfEvalExtension({ saltAccount: salts.saltAccount });
    assert.equal(accountOnly.prf.eval.second, undefined);
  });

  test('v1 IndexedDB records are stale; v2 records with both domains are current', () => {
    assert.equal(WALLET_RECORD_VERSION, 2);
    assert.equal(ACCOUNT_PRF_DOMAIN, 'republic:account:v1');
    assert.equal(IDENTITY_PRF_DOMAIN, 'republic:identity:v1');
    assert.equal(
      isCurrentWalletRecord({ version: 1, wrapScheme: 'prf-hkdf-aes-gcm', identityCommitment: '0xab' }),
      false,
    );
    assert.equal(
      isCurrentWalletRecord({
        version: 2,
        identityScheme: IDENTITY_SCHEME,
        prfDomains: { account: ACCOUNT_PRF_DOMAIN, identity: IDENTITY_PRF_DOMAIN },
      }),
      true,
    );
    assert.match(STALE_WALLET_MESSAGE, /v1 passkey wrap/);
    assert.match(STALE_WALLET_MESSAGE, /Reset the device wallet/);
  });
});
