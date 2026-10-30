// NOT FOR PROFIT — civic public good, not a commercial product.
// Read-only diagnostic projections. Counts and metadata only.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { brandName } from '../branding.mjs';
import { electionState, STATE_NAMES } from '../electionState.mjs';
import { electionTypeName, electionTypeOf, voteResultsSealed } from '../electionType.mjs';
import { countPasskeys, emailHint } from '../identity.mjs';
import { readArchiveIndex } from '../../../../l2/archive/job.mjs';

const require = createRequire(import.meta.url);
const nodePkg = require('../../package.json');
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
  ['explorerIngestSecret', 'explorerIngestSecretSet'],
  ['receiptPdfSecret', 'receiptPdfSecretSet'],
  ['relayerPrivateKey', 'relayerPrivateKeySet'],
  ['l1PublisherPrivateKey', 'l1PublisherPrivateKeySet'],
  ['l1Rpc', 'l1RpcSet'],
  ['chainRpc', 'chainRpcSet'],
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
    archiveEnabled: config.archiveEnabled !== false,
    hashScheme: config.hashScheme || null,
    provingPath: Boolean(config.provingPath),
    useMockVerifier: config.useMockVerifier !== false,
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
    chainMode: election.createTxHash || election.onChainElectionAddress ? 'onchain' : 'demo',
    tallied: sealed ? false : Boolean(election.tally),
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
  let archive = { present: false, hours: 0, archivedThrough: null };
  try {
    const index = readArchiveIndex(deps.config.dataDir);
    const hours = index?.hours && typeof index.hours === 'object' ? Object.keys(index.hours).length : 0;
    archive = {
      present: hours > 0 || Number(index?.archivedThrough) >= 0,
      hours,
      archivedThrough: index?.archivedThrough ?? null,
    };
  } catch {
    archive = { present: false, hours: 0, archivedThrough: null };
  }
  const check = deps.store?.data?.runtime?.lastArchiveHashCheck || null;
  return {
    nfp: true,
    node: {
      mode: deps.writer?.mode?.() || 'active',
      acceptingWrites: deps.writer ? deps.writer.acceptingWrites() : true,
      epoch: deps.writer?.epoch?.() || 0,
    },
    sequencer: {
      attached: false,
      heartbeatSeconds: Number(process.env.L2_HEARTBEAT_SECONDS || 3600),
    },
    prover: {
      attached: false,
      l1Configured: Boolean(deps.l1?.isConfigured?.()),
    },
    archive: {
      enabled: deps.config.archiveEnabled !== false,
      ...archive,
      hashCheck: check
        ? {
            at: check.at,
            status: check.status,
            checked: check.checked,
            matched: check.matched,
            mismatched: check.mismatched,
          }
        : { status: 'not-run', checked: 0, matched: 0, mismatched: 0 },
    },
    explorer: {
      height: blocks.length,
      headTimestamp: headTs || null,
      lagSeconds: headTs ? Math.max(0, now - headTs) : null,
      sealedCount: count(chain.sealed),
    },
  };
}

function deploymentRecord(config) {
  const file = process.env.DEPLOYMENTS_FILE
    ? path.resolve(process.env.DEPLOYMENTS_FILE)
    : path.join(config.dataDir, 'deployments.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      present: true,
      deployed: Boolean(parsed?.deployed),
      chainId: parsed?.chainId ?? null,
    };
  } catch {
    return { present: false, deployed: false, chainId: null };
  }
}

export function l1Diag(deps) {
  const config = deps.config || {};
  const site = deps.store?.getSite?.() || {};
  const contracts = site.contracts || {};
  const settlement = { posted: 0, skipped: 0, failed: 0, none: 0 };
  for (const election of deps.store?.data?.elections || []) {
    const status = election?.tally?.l1?.status || null;
    if (status === 'posted' || status === 'already_posted') settlement.posted += 1;
    else if (status === 'skipped') settlement.skipped += 1;
    else if (status === 'failed') settlement.failed += 1;
    else settlement.none += 1;
  }
  return {
    nfp: true,
    addresses: {
      factory: contracts.factory || config.electionFactoryAddress || null,
      ballotInbox: contracts.ballotInbox || config.ballotInboxAddress || null,
      verifier: contracts.verifier || config.verifierAddress || null,
      mirror: config.l1TallyMirrorAddress || null,
      settlement: config.l1SettlementAddress || null,
    },
    chainId: config.l1ChainId || null,
    rpcSet: Boolean(String(config.l1Rpc || '').trim()),
    publisherKeySet: Boolean(String(config.l1PublisherPrivateKey || '').trim()),
    configured: Boolean(deps.l1?.isConfigured?.()),
    deployment: deploymentRecord(config),
    settlement,
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
