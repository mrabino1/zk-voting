// NOT FOR PROFIT — civic public good, not a commercial product.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDisclosureIntervalSeconds } from './disclosure.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
export function getConfig(overrides = {}) {
  const port = Number(overrides.port ?? process.env.PORT ?? 3000);
  const defaultOrigins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ];
  const origins = csv(process.env.WEBAUTHN_ORIGINS).length
    ? csv(process.env.WEBAUTHN_ORIGINS)
    : defaultOrigins;

  const isTest = process.env.NODE_ENV === 'test';
  const disclosureIntervalSeconds = resolveDisclosureIntervalSeconds(
    overrides.disclosureIntervalSeconds ?? process.env.DISCLOSURE_INTERVAL_SECONDS,
    { isTest },
  );

  return {
    nfp: true,
    app: 'zk-voting',
    product: 'Republic',
    pkgRoot: PKG_ROOT,
    port,
    chainId: Number(process.env.CHAIN_ID || 27427),
    disclosureIntervalSeconds,
    nowFn: overrides.nowFn || (() => Math.floor(Date.now() / 1000)),
    rpName: 'Republic',
    rpID: process.env.RP_ID || 'localhost',
    origins,
    adminHandle: process.env.ADMIN_HANDLE || 'admin',
    chainRpc: process.env.CHAIN_RPC || '',
    ballotInboxAddress: process.env.BALLOT_INBOX_ADDRESS || '',
    electionFactoryAddress: process.env.ELECTION_FACTORY_ADDRESS || process.env.FACTORY || '',
    verifierAddress: process.env.VERIFIER_ADDRESS || process.env.VERIFIER || '',
    clerkAddress: process.env.CLERK_ADDRESS || process.env.CLERK || '',
    registrarAddress: process.env.REGISTRAR_ADDRESS || process.env.REGISTRAR || '',
    disqualificationOfficerAddress:
      process.env.DISQUALIFICATION_OFFICER_ADDRESS || process.env.DISQUALIFICATION_OFFICER || '',
    tallyOperatorAddress: process.env.TALLY_OPERATOR_ADDRESS || process.env.TALLY_OPERATOR || '',
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || '',
    dataDir: process.env.DATA_DIR || path.join(PKG_ROOT, 'data'),
    l2ChainFile: process.env.L2_CHAIN_FILE || '',
    allowDevLogin: process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_LOGIN === '1',
    allowSmartCardMock:
      process.env.NODE_ENV === 'test' || process.env.ALLOW_SMART_CARD_MOCK === '1',
    sessionCookie: 'republic.sid',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    quiet: process.env.NODE_ENV === 'test',
    publicDir: path.join(PKG_ROOT, 'public'),
    distDir: path.join(PKG_ROOT, 'dist'),
    ...overrides,
  };
}

export { PKG_ROOT };
