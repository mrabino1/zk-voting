// NOT FOR PROFIT — civic public good, not a commercial product.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDisclosureIntervalSeconds } from './disclosure.mjs';
import { resolveVotingToken, tokenRpcMap } from './tokenSource.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/** At least two labels, no scheme, port, path, or IPv4 literal. */
const VOTE_FQDN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isIpv4Literal(host) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
  return host.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * Bare public hostname for this Node, e.g. `vote.domain.tld`.
 * Empty means a local demo. A trailing DNS dot is stripped.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeVoteFqdn(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const host = raw.toLowerCase().replace(/\.$/, '');
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (!VOTE_FQDN_RE.test(host) || isIpv4Literal(host) || !/[a-z]/.test(tld)) {
    throw new Error(
      `VOTE_FQDN must be a bare hostname such as vote.domain.tld (no scheme, port, or path); received ${JSON.stringify(raw)}`,
    );
  }
  return host;
}

function isDevHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function originList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return csv(value);
}

/**
 * `VOTE_FQDN` is the voting authority for this host. Passkeys, the browser
 * origin, and official links follow it unless the operator set a public
 * `RP_ID` or an explicit `PUBLIC_BASE_URL`. `localhost` does not override it.
 * @param {Record<string, unknown>} overrides
 * @param {string[]} defaultOrigins
 */
function resolveVoteAuthority(overrides, defaultOrigins) {
  const voteFqdn = normalizeVoteFqdn(
    overrides.voteFqdn !== undefined ? overrides.voteFqdn : process.env.VOTE_FQDN,
  );
  const rpRaw = String(overrides.rpID !== undefined ? overrides.rpID : process.env.RP_ID || '').trim();
  const rpID = isDevHost(rpRaw) ? voteFqdn || rpRaw || 'localhost' : rpRaw;

  const listed = originList(overrides.origins !== undefined ? overrides.origins : process.env.WEBAUTHN_ORIGINS);
  let origins = listed.length ? listed.slice() : voteFqdn ? [] : defaultOrigins.slice();
  if (voteFqdn) {
    const authorityOrigin = `https://${voteFqdn}`;
    origins = [authorityOrigin, ...origins.filter((origin) => origin !== authorityOrigin)];
  }

  const publicRaw = String(
    overrides.publicBaseUrl !== undefined ? overrides.publicBaseUrl : process.env.PUBLIC_BASE_URL || '',
  ).trim();
  const publicBaseUrl = publicRaw || (voteFqdn ? `https://${voteFqdn}` : '');

  return { voteFqdn, rpID, origins, publicBaseUrl };
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
  const authority = resolveVoteAuthority(overrides, defaultOrigins);

  const isTest = process.env.NODE_ENV === 'test';
  const disclosureIntervalSeconds = resolveDisclosureIntervalSeconds(
    overrides.disclosureIntervalSeconds ?? process.env.DISCLOSURE_INTERVAL_SECONDS,
    { isTest },
  );

  const provingPath = envFlag(overrides.provingPath ?? process.env.REPUBLIC_PROVING_PATH, false);
  const useMockVerifier = provingPath
    ? false
    : envFlag(overrides.useMockVerifier ?? process.env.REPUBLIC_USE_MOCK_VERIFIER, true);
  const hashScheme =
    overrides.hashScheme ||
    process.env.REPUBLIC_HASH_SCHEME ||
    (provingPath ? 'republic.hash.poseidon-bn254-x5-t3-v1' : 'republic.hash.keccak-dev-v1');

  const config = {
    nfp: true,
    app: 'zk-voting',
    product: 'Republic',
    pkgRoot: PKG_ROOT,
    port,
    host: String(overrides.host ?? process.env.HOST ?? '0.0.0.0'),
    chainId: Number(process.env.CHAIN_ID || 27427),
    disclosureIntervalSeconds,
    nowFn: overrides.nowFn || (() => Math.floor(Date.now() / 1000)),
    rpName: 'Republic',
    rpID: authority.rpID,
    voteFqdn: authority.voteFqdn,
    origins: authority.origins,
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
    // NODE_ENV=test never inherits operator L1 keys (CI / local Anvil leakage).
    l1Rpc: isTest ? '' : process.env.L1_RPC || process.env.L1_RPC_URL || '',
    l1TallyMirrorAddress: isTest
      ? ''
      : process.env.L1_TALLY_MIRROR_ADDRESS ||
        process.env.TALLY_MIRROR_ADDRESS ||
        process.env.TALLY_MIRROR ||
        '',
    l1PublisherPrivateKey: isTest
      ? ''
      : process.env.L1_PUBLISHER_PRIVATE_KEY || process.env.L1_PRIVATE_KEY || '',
    l1SettlementAddress: isTest
      ? ''
      : process.env.L1_SETTLEMENT_ADDRESS || process.env.SETTLEMENT_ADDRESS || process.env.SETTLEMENT || '',
    l1ChainId: isTest ? 0 : Number(process.env.L1_CHAIN_ID || 0),
    dataDir: process.env.DATA_DIR || path.join(PKG_ROOT, 'data'),
    l2ChainFile: process.env.L2_CHAIN_FILE || '',
    allowDevLogin: (() => {
      if (process.env.NODE_ENV === 'production') return false;
      if (overrides.allowDevLogin !== undefined) return Boolean(overrides.allowDevLogin);
      return process.env.NODE_ENV === 'test' || process.env.ALLOW_DEV_LOGIN === '1';
    })(),
    allowSmartCardMock:
      process.env.NODE_ENV === 'test' || process.env.ALLOW_SMART_CARD_MOCK === '1',
    allowCivicIdMock:
      process.env.NODE_ENV === 'test' ||
      process.env.ALLOW_CIVIC_ID_MOCK === '1' ||
      process.env.ALLOW_SMART_CARD_MOCK === '1',
    sesFromAddress: String(
      overrides.sesFromAddress ?? process.env.SES_FROM_ADDRESS ?? process.env.AWS_SES_FROM ?? '',
    ).trim(),
    awsRegion: String(overrides.awsRegion ?? process.env.AWS_REGION ?? process.env.SES_REGION ?? '').trim(),
    sesConfigurationSet: String(process.env.SES_CONFIGURATION_SET || '').trim(),
    sesEndpoint: String(process.env.SES_ENDPOINT || '').trim(),
    sesDryRun: envFlag(process.env.SES_DRY_RUN, false),
    credentialProviderSecret: String(
      overrides.credentialProviderSecret ?? process.env.CREDENTIAL_PROVIDER_SECRET ?? '',
    ).trim(),
    credentialProviderId: String(
      overrides.credentialProviderId ?? process.env.CREDENTIAL_PROVIDER_ID ?? 'manual',
    ).trim() || 'manual',
    explorerIngestSecret: String(
      overrides.explorerIngestSecret ?? process.env.EXPLORER_INGEST_SECRET ?? '',
    ).trim(),
    requireEmailMfa: (() => {
      if (overrides.requireEmailMfa !== undefined) return Boolean(overrides.requireEmailMfa);
      if (process.env.REQUIRE_EMAIL_MFA !== undefined && process.env.REQUIRE_EMAIL_MFA !== '') {
        return envFlag(process.env.REQUIRE_EMAIL_MFA, false);
      }
      if (isTest) return false;
      const from = String(process.env.SES_FROM_ADDRESS || process.env.AWS_SES_FROM || '').trim();
      const region = String(process.env.AWS_REGION || process.env.SES_REGION || '').trim();
      return Boolean(from && region);
    })(),
    captureEmail: isTest,
    includeOtpInCapture: isTest,
    allowCaptureMailer: isTest || envFlag(process.env.ALLOW_CAPTURE_MAILER, false),
    receiptPdfSecret: String(overrides.receiptPdfSecret ?? process.env.RECEIPT_PDF_SECRET ?? '').trim(),
    publicBaseUrl: authority.publicBaseUrl,
    mailWebhookUrl: String(overrides.mailWebhookUrl ?? process.env.MAIL_WEBHOOK_URL ?? '').trim(),
    sessionCookie: 'republic.sid',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    mfaCookie: 'republic.mfa',
    mfaTtlMs: 10 * 60 * 1000,
    quiet: process.env.NODE_ENV === 'test',
    publicDir: path.join(PKG_ROOT, 'public'),
    distDir: path.join(PKG_ROOT, 'dist'),
    provingPath,
    useMockVerifier,
    hashScheme,
    pollsEnabled:
      overrides.pollsEnabled !== undefined
        ? Boolean(overrides.pollsEnabled)
        : envFlag(process.env.POLLS_ENABLED, false),
    pollMaxOptions: Number(process.env.POLL_MAX_OPTIONS || 32),
    tokenRpcs: tokenRpcMap(),
    ...overrides,
  };
  // `VOTE_FQDN` wins over a localhost template even when overrides spread last.
  config.voteFqdn = authority.voteFqdn;
  config.rpID = authority.rpID;
  config.origins = authority.origins;
  config.publicBaseUrl = authority.publicBaseUrl;
  config.votingToken = resolveVotingToken({
    address:
      overrides.votingTokenAddress !== undefined
        ? overrides.votingTokenAddress
        : process.env.VOTING_TOKEN_ADDRESS,
    chainId:
      overrides.votingTokenChainId !== undefined
        ? overrides.votingTokenChainId
        : process.env.VOTING_TOKEN_CHAIN_ID,
  });
  config.pollsReady = Boolean(config.pollsEnabled) && config.votingToken.configured;
  return config;
}

export { PKG_ROOT };
