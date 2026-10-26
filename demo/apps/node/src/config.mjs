// NOT FOR PROFIT — civic public good, not a commercial product.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { brandName } from './branding.mjs';
import { resolveDisclosureIntervalSeconds } from './disclosure.mjs';
import { normalizeEmail } from './identity.mjs';
import { resolveEnvCeremonyUrl, resolveEnvEntropy } from './entropy.mjs';
import { DEFAULT_CHAIN_ID, resolveEnvChainId } from './setup.mjs';
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

/** Hop count for Express `trust proxy`, or false when the TCP peer is the client. */
export function resolveTrustProxy(value) {
  if (value === undefined || value === null || value === '') return false;
  if (value === true) return 1;
  if (value === false) return false;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const s = String(value).trim().toLowerCase();
  if (!s || ['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return 1;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return false;
}

/**
 * Seconds between accepted /feedback submissions for one IP.
 * The floor is 3600: one per hour is the maximum rate.
 */
export function resolveFeedbackRateWindow(value) {
  if (value === undefined || value === null || value === '') return 3600;
  const n = Number(value);
  if (!Number.isFinite(n)) return 3600;
  return Math.max(3600, Math.floor(n));
}

export function resolveFeedbackMinSubmitMs(value) {
  if (value === undefined || value === null || value === '') return 3000;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 3000;
  return Math.min(60_000, Math.floor(n));
}

export function resolveFeedbackMaxBodyBytes(value) {
  const fallback = 16 * 1024;
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1024) return fallback;
  return Math.min(256 * 1024, Math.floor(n));
}

/**
 * Deploy-time contact email for the seeded platform super admin.
 * Empty (or whitespace) leaves the stored contactEmail alone.
 * Any other value must pass `normalizeEmail` or startup fails closed.
 * The address is read from the process environment at runtime. It is not
 * baked into the image.
 * @param {unknown} value
 * @returns {string}
 */
export function resolveSuperAdminEmail(value) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  try {
    return normalizeEmail(raw);
  } catch {
    throw new Error(
      'SUPER_ADMIN_EMAIL is set but is not a valid email address. Refusing to start.',
    );
  }
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
  const chainIdEnv = resolveEnvChainId(
    Object.prototype.hasOwnProperty.call(overrides, 'chainId') ? overrides.chainId : process.env.CHAIN_ID,
  );
  const disclosureIntervalSeconds = resolveDisclosureIntervalSeconds(
    overrides.disclosureIntervalSeconds ?? process.env.DISCLOSURE_INTERVAL_SECONDS,
    { isTest },
  );

  const provingPath = envFlag(overrides.provingPath ?? process.env.ZK_VOTING_PROVING_PATH, false);
  const useMockVerifier = provingPath
    ? false
    : envFlag(overrides.useMockVerifier ?? process.env.ZK_VOTING_USE_MOCK_VERIFIER, true);
  const hashScheme =
    overrides.hashScheme ||
    process.env.ZK_VOTING_HASH_SCHEME ||
    (provingPath ? 'zk-voting.hash.poseidon-bn254-x5-t3-v1' : 'zk-voting.hash.keccak-dev-v1');

  const config = {
    nfp: true,
    app: 'zk-voting',
    pkgRoot: PKG_ROOT,
    port,
    host: String(overrides.host ?? process.env.HOST ?? '0.0.0.0'),
    // CHAIN_ID from the environment. null = not fixed; the first-run setup
    // screen may choose it. Read it through config.chainId (see setup.mjs).
    chainIdEnv,
    chainId: chainIdEnv ?? DEFAULT_CHAIN_ID,
    setupToken: String(overrides.setupToken ?? process.env.SETUP_TOKEN ?? '').trim(),
    // ENTROPY_CEREMONY_URL (public ceremony origin). ZK_ENTROPY is attached
    // below as a non-enumerable property so it never ends up in a JSON dump.
    // Read both through entropyInfo() in entropy.mjs.
    entropyCeremonyUrlEnv: resolveEnvCeremonyUrl(overrides.entropyCeremonyUrl ?? process.env.ENTROPY_CEREMONY_URL),
    firstRunRedirect: envFlag(overrides.firstRunRedirect ?? process.env.FIRST_RUN_REDIRECT, !isTest),
    disclosureIntervalSeconds,
    nowFn: overrides.nowFn || (() => Math.floor(Date.now() / 1000)),
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
    // Postgres app state. Unset → JSON files in dataDir (dev fallback). The
    // test suite stays on JSON unless TEST_DATABASE_URL points at a scratch DB.
    databaseUrl: isTest ? process.env.TEST_DATABASE_URL || '' : process.env.DATABASE_URL || '',
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
    // NON-PRODUCTION: accept JSON "ciphertext" ballots (plaintext answers). Off by
    // default; the shipped client always encrypts. Only fixtures turn this on.
    allowPlaintextBallots: Boolean(
      overrides.allowPlaintextBallots ?? envFlag(process.env.ZKV_ALLOW_PLAINTEXT_BALLOTS, false),
    ),
    publicBaseUrl: authority.publicBaseUrl,
    mailWebhookUrl: String(overrides.mailWebhookUrl ?? process.env.MAIL_WEBHOOK_URL ?? '').trim(),
    sessionCookie: 'zk-voting.sid',
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    mfaCookie: 'zk-voting.mfa',
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
    // Phase-2 trusted-setup ceremony (docs/ceremony-web.md). Empty dirs mean
    // DATA_DIR/ceremonies and DATA_DIR/ceremony-inputs.
    ceremonyDir: process.env.CEREMONY_DIR || '',
    ceremonyInputDir: process.env.CEREMONY_INPUT_DIR || '',
    ceremonyMaxZkeyBytes: megabytes(process.env.CEREMONY_MAX_ZKEY_MB, 1024),
    ceremonyMaxInputBytes: megabytes(process.env.CEREMONY_MAX_INPUT_MB, 2048),
    // Beacon = a future Ethereum mainnet block hash, read from this read-only
    // JSON-RPC (comma-separate several to require agreement). Unset fails closed.
    ceremonyEthRpcUrls: String(process.env.CEREMONY_ETH_RPC_URL || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    ceremonyBeaconMinBlocksAhead: strictPositiveInt(process.env.CEREMONY_BEACON_MIN_BLOCKS_AHEAD, 32),
    ...overrides,
  };
  // Display name (site admin > BRAND_NAME > "ZK-Voting"); live, so a rename in
  // site admin reaches mail, PDFs and the WebAuthn rpName without a restart.
  for (const key of ['product', 'rpName']) {
    if (overrides[key] === undefined) {
      Object.defineProperty(config, key, { get: brandName, enumerable: true, configurable: true });
    }
  }
  // `VOTE_FQDN` wins over a localhost template even when overrides spread last.
  config.voteFqdn = authority.voteFqdn;
  config.rpID = authority.rpID;
  config.origins = authority.origins;
  config.publicBaseUrl = authority.publicBaseUrl;
  config.trustProxy = resolveTrustProxy(
    overrides.trustProxy !== undefined ? overrides.trustProxy : process.env.TRUST_PROXY,
  );
  config.feedbackRateWindowSeconds = resolveFeedbackRateWindow(
    overrides.feedbackRateWindowSeconds !== undefined
      ? overrides.feedbackRateWindowSeconds
      : process.env.FEEDBACK_RATE_WINDOW_SECONDS,
  );
  config.feedbackMinSubmitMs = resolveFeedbackMinSubmitMs(
    overrides.feedbackMinSubmitMs !== undefined
      ? overrides.feedbackMinSubmitMs
      : process.env.FEEDBACK_MIN_SUBMIT_MS,
  );
  config.feedbackMaxBodyBytes = resolveFeedbackMaxBodyBytes(
    overrides.feedbackMaxBodyBytes !== undefined
      ? overrides.feedbackMaxBodyBytes
      : process.env.FEEDBACK_MAX_BODY_BYTES,
  );
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
  config.superAdminEmail = resolveSuperAdminEmail(
    Object.prototype.hasOwnProperty.call(overrides, 'superAdminEmail')
      ? overrides.superAdminEmail
      : process.env.SUPER_ADMIN_EMAIL,
  );
  config.superAdminApiPepper = String(
    Object.prototype.hasOwnProperty.call(overrides, 'superAdminApiPepper')
      ? overrides.superAdminApiPepper
      : process.env.SUPER_ADMIN_API_PEPPER || '',
  ).trim();
  config.superAdminStepUpMs = resolveStepUpMs(
    Object.prototype.hasOwnProperty.call(overrides, 'superAdminStepUpMs')
      ? overrides.superAdminStepUpMs
      : process.env.SUPER_ADMIN_STEP_UP_MS,
  );
  config.logLevel = LOG_LEVELS.includes(overrides.logLevel) ? overrides.logLevel : 'info';
  config.archiveEnabled = envFlag(
    overrides.archiveEnabled !== undefined ? overrides.archiveEnabled : process.env.ARCHIVE_ENABLED,
    true,
  );
  applySiteAdminConfig(config, overrides);
  delete config.entropy; // a test override copied by ...overrides; keep it out of dumps
  Object.defineProperty(config, 'entropyEnv', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: resolveEnvEntropy(Object.prototype.hasOwnProperty.call(overrides, 'entropy') ? overrides.entropy : process.env.ZK_ENTROPY),
  });
  return config;
}

/** Repository root (apps/node/../..). Bundled plugins live in `<repo>/plugins`. */
export const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

function pick(overrides, key, envValue) {
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : envValue;
}

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Site admin: layout and plugins. Safe defaults: zip upload OFF, 1 MiB zip cap,
 * a fresh sign-in (10 min) required to install.
 */
function applySiteAdminConfig(config, overrides) {
  config.pluginsAllowUpload = envFlag(pick(overrides, 'pluginsAllowUpload', process.env.PLUGINS_ALLOW_UPLOAD), false);
  config.pluginsBundledDir = String(
    pick(overrides, 'pluginsBundledDir', process.env.PLUGINS_DIR) || path.join(REPO_ROOT, 'plugins'),
  );
  config.pluginsUploadDir = String(
    pick(overrides, 'pluginsUploadDir', process.env.PLUGINS_UPLOAD_DIR) || path.join(config.dataDir, 'plugins'),
  );
  config.pluginMaxZipBytes = positiveInt(
    pick(overrides, 'pluginMaxZipBytes', process.env.PLUGIN_MAX_ZIP_BYTES),
    1024 * 1024,
    16 * 1024 * 1024,
  );
  config.pluginReauthMs = positiveInt(
    pick(overrides, 'pluginReauthMs', process.env.PLUGIN_REAUTH_MS),
    10 * 60 * 1000,
    60 * 60 * 1000,
  );
  config.layoutFile = String(
    pick(overrides, 'layoutFile', process.env.LAYOUT_FILE) || path.join(PKG_ROOT, 'site', 'layout.json'),
  );
  config.layoutOverrideModule = String(
    pick(overrides, 'layoutOverrideModule', process.env.LAYOUT_OVERRIDE_MODULE) ||
      path.join(PKG_ROOT, 'site', 'layout.override.mjs'),
  );
  config.appVersion = String(pick(overrides, 'appVersion', '') || readPackageVersion());
}

let packageVersion = '';
function readPackageVersion() {
  if (packageVersion) return packageVersion;
  try {
    packageVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    packageVersion = '0.0.0';
  }
  return packageVersion;
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

function strictPositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`expected a positive integer, got ${value}`);
  return n;
}

function megabytes(value, fallbackMb) {
  const n = Number(value);
  const mb = Number.isFinite(n) && n > 0 ? n : fallbackMb;
  return Math.floor(mb * 1024 * 1024);
}

function resolveStepUpMs(value) {
  if (value === undefined || value === null || value === '') return 15 * 60 * 1000;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 60_000) return 15 * 60 * 1000;
  return Math.min(24 * 60 * 60 * 1000, Math.floor(n));
}

export { PKG_ROOT };
