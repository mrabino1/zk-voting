// NOT FOR PROFIT — civic public good, not a commercial product.
// Read-only diagnostic projections. Counts and metadata only.

import fs from 'node:fs';
import { createRequire } from 'node:module';

import { brandName } from '../branding.mjs';
import { electionState, STATE_NAMES } from '../electionState.mjs';
import { electionTypeName, electionTypeOf, voteResultsSealed } from '../electionType.mjs';
import { publicExclusion } from '../store.mjs';
import { countPasskeys, emailHint } from '../identity.mjs';

const require = createRequire(import.meta.url);
const nodePkg = require('../../package.json');
const { readDeployment } = require('@zk-voting/chain-client');
const startedAt = Date.now();

function count(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((n, row) => n + (row && typeof row === 'object' && row.is_deleted === true ? 0 : 1), 0);
}

export function healthDiag(deps) {
  const writer = deps.writer;
  const lease = writer?.lease || null;
  let holder = null;
  if (lease?.ownerPath) {
    try {
      const owner = JSON.parse(fs.readFileSync(lease.ownerPath(), 'utf8'));
      holder = {
        ownerId: owner.ownerId || null,
        epoch: owner.epoch ?? null,
        pid: owner.pid ?? null,
      };
    } catch {
      holder = null;
    }
  }
  return {
    ok: true,
    nfp: true,
    version: nodePkg.version || '0.0.0',
    schemaVersion: Number(deps.store?.data?.meta?.version || 0),
    build: process.env.GITHUB_SHA || process.env.SOURCE_COMMIT || null,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    mode: writer?.mode?.() || 'active',
    acceptingWrites: writer ? writer.acceptingWrites() : true,
    epoch: writer?.epoch?.() || 0,
    lease: {
      enabled: Boolean(writer?.enabled),
      heldHere: Boolean(lease?.held),
      holder,
    },
  };
}

const SECRET_FLAGS = [
  ['sesFromAddress', 'sesFromAddressSet'],
  ['awsRegion', 'awsRegionSet'],
  ['sesEndpoint', 'sesEndpointSet'],
  ['sesConfigurationSet', 'sesConfigurationSetSet'],
  ['credentialProviderSecret', 'credentialProviderSecretSet'],
  ['receiptPdfSecret', 'receiptPdfSecretSet'],
  ['l1RpcAuthToken', 'l1RpcAuthTokenSet'],
  ['superAdminApiPepper', 'superAdminApiPepperSet'],
  ['superAdminEmail', 'superAdminEmailSet'],
  ['mailWebhookUrl', 'mailWebhookUrlSet'],
];

export function configDiag(deps) {
  const config = deps.config || {};
  const set = {};
  for (const [field, flag] of SECRET_FLAGS) {
    set[flag] = Boolean(String(config[field] || '').trim());
  }
  return {
    nfp: true,
    app: config.app || 'zk-voting',
    product: config.product || brandName(),
    port: config.port,
    host: config.host,
    chainId: config.chainId,
    voteFqdn: config.voteFqdn || null,
    publicBaseUrl: config.publicBaseUrl || null,
    rpID: config.rpID || null,
    pollsEnabled: Boolean(config.pollsEnabled),
    pollsReady: Boolean(config.pollsReady),
    disclosureIntervalSeconds: config.disclosureIntervalSeconds,
    feedbackRateWindowSeconds: config.feedbackRateWindowSeconds,
    feedbackMinSubmitMs: config.feedbackMinSubmitMs,
    feedbackMaxBodyBytes: config.feedbackMaxBodyBytes,
    logLevel: config.logLevel || 'info',
    hashScheme: config.hashScheme || null,
    provingPath: Boolean(config.provingPath),
    useMockVerifier: config.useMockVerifier === true,
    allowDevLogin: Boolean(config.allowDevLogin),
    requireEmailMfa: Boolean(config.requireEmailMfa),
    sesDryRun: Boolean(config.sesDryRun),
    trustProxy: config.trustProxy,
    nodeEnv: process.env.NODE_ENV || null,
    set,
  };
}

export function storeDiag(store) {
  const data = store?.data || {};
  return {
    nfp: true,
    schemaVersion: Number(data.meta?.version || 0),
    nodeId: data.meta?.nodeId || null,
    counts: {
      users: count(data.users),
      sessionCount: count(data.sessions),
      jurisdictions: count(data.jurisdictions),
      elections: count(data.elections),
      registrationCount: count(data.registrations),
      registrationRequestCount: count(data.registrationRequests),
      identityLinkCount: count(data.identityLinks),
      disqualificationCount: count(data.disqualifications),
      voteCount: count(data.votes),
      pollCount: count(data.polls),
      pollBallotCount: count(data.pollBallots),
      receiptCount: count(data.receipts),
      personalApiKeyCount: count(data.apiKeys),
      superAdminKeyCount: count(data.superAdminKeys),
      auditCount: count(data.superAdminAudit),
      mailOutboxCount: count(data.mailOutbox),
    },
  };
}

function electionMeta(election, now, store) {
  const state = electionState(election, now);
  const sealed = voteResultsSealed(election, now);
  const rawCast = Number(election.acceptedBallots || 0);
  const hidden = typeof store?.hiddenVoteCount === 'function' ? store.hiddenVoteCount(election.id) : 0;
  return {
    id: String(election.id),
    title: election.title || '',
    status: STATE_NAMES[state] || 'Created',
    state,
    electionType: electionTypeOf(election),
    electionTypeName: electionTypeName(election),
    resultsSealed: sealed,
    createdAt: election.createdAt || null,
    startTime: election.startTime ?? null,
    cutoffTime: election.cutoffTime ?? null,
    rollFrozen: Boolean(election.rollFrozen),
    votingPaused: Boolean(election.votingPaused),
    eligibleCount: Number(election.eligibleCount ?? election.participantCount ?? 0),
    castCount: hidden > 0 ? Math.max(0, rawCast - hidden) : rawCast,
    questionCount: Number(election.questionCount ?? (election.questions || []).length),
    ballotMethod: election.ballotMethod || 'plurality',
    lateUpdateAllowed: Boolean(election.lateUpdateAllowed),
    jurisdictionId: election.jurisdictionId || null,
    chainMode: election.rollup?.electionId ? 'rollup' : 'node',
    tallied: sealed ? false : Boolean(election.tally),
    excludedCount: publicExclusion(election).count,
    excludedReasons: publicExclusion(election).reasons,
  };
}

function pollMeta(poll, now) {
  const start = Number(poll.startTime || 0);
  const cutoff = Number(poll.cutoffTime || 0);
  let status = poll.state || 'DRAFT';
  if (cutoff && now >= cutoff) status = 'CLOSED';
  else if (start && now >= start && (!cutoff || now < cutoff)) status = poll.state && poll.state !== 'DRAFT' ? poll.state : 'OPEN';
  return {
    id: poll.id,
    status,
    createdAt: poll.createdAt || null,
    startTime: poll.startTime ?? null,
    cutoffTime: poll.cutoffTime ?? null,
    optionCount: Array.isArray(poll.options) ? poll.options.length : 0,
    jurisdictionId: poll.jurisdictionId || null,
    pollType: poll.pollType || null,
  };
}

export function electionsDiag(store, nowSeconds) {
  const now = Number(nowSeconds) || Math.floor(Date.now() / 1000);
  return {
    nfp: true,
    now,
    elections: (store.data.elections || []).map((election) => electionMeta(election, now, store)),
    polls: (store.data.polls || []).map((poll) => pollMeta(poll, now)),
  };
}

export function electionDiag(store, id, nowSeconds) {
  const election = store.getElection(id);
  if (!election) return null;
  const now = Number(nowSeconds) || Math.floor(Date.now() / 1000);
  return { nfp: true, election: electionMeta(election, now, store) };
}

function maskedUser(user) {
  const email = user.contactEmail || user.email || '';
  return {
    handle: user.handle,
    role: user.role,
    status: user.suspendedAt ? 'suspended' : 'active',
    createdAt: user.createdAt || null,
    maskedEmail: email ? emailHint(email) : null,
    passkeyCount: countPasskeys(user),
  };
}

export function usersDiag(store) {
  return {
    nfp: true,
    users: (store.data.users || []).filter((user) => user && user.is_deleted !== true).map((user) => maskedUser(user)),
  };
}

export function userDiag(store, handle) {
  const user = store.getUserByHandle(handle);
  if (!user) return null;
  return { nfp: true, user: maskedUser(user) };
}

export function l2Diag(deps) {
  const chain = deps.explorer?.chain || {};
  const now = Number(deps.config?.nowFn?.() || Math.floor(Date.now() / 1000));
  const blocks = Array.isArray(chain.blocks) ? chain.blocks : [];
  const head = blocks.length ? blocks[blocks.length - 1] : null;
  const headTs = Number(head?.timestamp || 0);
  return {
    nfp: true,
    node: {
      mode: deps.writer?.mode?.() || 'active',
      acceptingWrites: deps.writer ? deps.writer.acceptingWrites() : true,
      epoch: deps.writer?.epoch?.() || 0,
    },
    rollup: {
      enabled: Boolean(deps.rollup?.enabled),
      address: deps.rollup?.client?.address || null,
      chainId: deps.rollup?.client?.chainId || null,
      l2Url: deps.config.rollup?.l2Url || null,
    },
    explorer: {
      height: blocks.length,
      headTimestamp: headTs || null,
      lagSeconds: headTs ? Math.max(0, now - headTs) : null,
      sealedCount: count(chain.sealed),
      alerts: Array.isArray(chain.alerts) ? chain.alerts.slice(-20) : [],
    },
  };
}

function deploymentRecord() {
  const file = String(process.env.ROLLUP_DEPLOYMENT_FILE || '').trim();
  if (!file) return { file: null, present: false, rollup: null, chainId: null };
  try {
    const record = readDeployment(file);
    return { file, present: Boolean(record), rollup: record?.rollup || null, chainId: record?.chainId ?? null };
  } catch (err) {
    return { file, present: false, rollup: null, chainId: null, error: err.message };
  }
}

export function l1Diag(deps) {
  const config = deps.config || {};
  // Status lives on L1; read it per election from GET /api/elections/:id/rollup.
  const rollup = { published: 0 };
  for (const election of deps.store?.data?.elections || []) {
    if (election?.rollup?.electionId) rollup.published += 1;
  }
  return {
    nfp: true,
    rollup: {
      enabled: Boolean(deps.rollup?.enabled),
      address: deps.rollup?.client?.address || null,
      chainId: deps.rollup?.client?.chainId || null,
      nodeAccount: deps.rollup?.client?.account || null,
      rpcSet: Boolean(String(config.rollup?.l1Rpc || '').trim()),
      rpcAuthSet: Boolean(String(config.l1RpcAuthToken || config.rollup?.authToken || '').trim()),
      keySet: Boolean(String(config.rollup?.privateKey || '').trim()),
      l2Url: config.rollup?.l2Url || null,
    },
    elections: rollup,
    deployment: deploymentRecord(),
  };
}

export function mailDiag(deps) {
  const mailer = deps.mailer || {};
  const config = deps.config || {};
  return {
    nfp: true,
    vendor: mailer.vendor || 'ses',
    sesConfigured: Boolean(config.sesFromAddress && config.awsRegion),
    sesDryRun: Boolean(config.sesDryRun),
    fromSet: Boolean(String(config.sesFromAddress || '').trim()),
    regionSet: Boolean(String(config.awsRegion || '').trim()),
    capture: Boolean(config.captureEmail || config.allowCaptureMailer),
    sendCount: Number(mailer.sendCount || 0),
    failureCount: Number(mailer.failureCount || 0),
    outboxCount: count(deps.store?.data?.mailOutbox),
  };
}
