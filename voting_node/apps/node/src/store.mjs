// NOT FOR PROFIT — civic public good, not a commercial product.
// JSON file store (no native addons). A jurisdiction owns its elections.
// Identity links (passkey user ↔ commitment) live in a
// separate collection from ballots and are never copied onto a vote record.

import { LEGACY_DEFAULT_NAMES, brandName } from './branding.mjs';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  API_KEY_LIMIT,
  apiKeyExpiresAt,
  apiKeyHashesEqual,
  hashApiKey,
  isApiKeySecret,
  mintApiKeySecret,
  normalizeApiKeyExpiration,
  normalizeApiKeyLevel,
  normalizeApiKeyName,
  publicApiKey,
} from './apiKeys.mjs';
import { resolveSuperAdminEmail } from './config.mjs';
import {
  PgDocument,
  describeDatabaseUrl,
  migrate,
  recordImport,
  resolveDatabaseUrl,
  usingPostgres,
} from './db.mjs';
import { ensureSuperAdminCollections } from './superAdmin/collections.mjs';
import { ensureSiteAdminCollections } from './siteAudit.mjs';
import { disclosureSettings, isDisclosed, selectPublicVotes } from './disclosure.mjs';
import { electionTypeOf, isVoteElection, voteResultsSealed } from './electionType.mjs';
import {
  electionMatchesRef,
  mintScopedPublicId,
  mintShortCode,
  parseOnChainElectionId,
} from './electionIds.mjs';
import { DEMO_JURISDICTION_ID, canonicalJurisdictionId } from './recordIds.mjs';
import { HttpError } from './http.mjs';
import {
  applyCredentialReview,
  assertCivicIdRoom,
  assertSmartCardRoom,
  ensureCredentialFields,
  isCredentialMethodType,
  parseExpiresAt,
  publicCredential,
} from './credentials.mjs';
import {
  assertEmailRoom,
  assertPasskeyRoom,
  emailHint,
  ensurePersonFields,
  isAuthMethodType,
  normalizeEmail,
  normalizeEthAddress,
  normalizeFingerprint,
  personEmailMethods,
  publicIdentity,
  sameEmail,
  sameEthAddress,
  syncPersonEmails,
} from './identity.mjs';
import { disqualificationTree, emptyTree, insertLeaf, toBytes32 } from './merkle.mjs';
import { isOfficerRole, isPlatformOperator, isRole } from './roles.mjs';
import { isValidReasonCode, reasonName } from './reasonCodes.mjs';
import {
  defaultSite,
  normalizeKind,
  normalizeSlug,
  normalizeStatus,
  pageSlugForKind,
  sanitizeAddress,
  sanitizeBlocks,
  sanitizeText,
} from './cms.mjs';
import {
  AGGREGATION_UNDECIDED,
  GUARDIAN_SCHEME,
  GUARDIAN_WARNING,
  TALLY_SCHEME_OPENS_BALLOTS,
  TALLY_SCHEME_SUM_ONLY,
  normalizeTallyScheme,
} from './tallyCrypto.mjs';

/** Public aliases for an election id (numeric, UUID, or short code when stored). */
export function electionAliases(election) {
  if (!election) return [];
  return [election.id, election.uuid, election.code, election.shortCode, election.publicId].filter(
    (v) => v != null && String(v) !== '',
  );
}

export function electionIdMatches(election, id) {
  const want = String(id ?? '').trim();
  if (!want) return false;
  return electionAliases(election).some((v) => String(v) === want);
}

/** Public ballot row: no acceptedAt, no choice, no user id. */
export function publicVoteRecord(vote) {
  if (!vote) return null;
  return {
    nullifier: vote.nullifier,
    ballotHash: vote.ballotHash,
    electionId: String(vote.electionId),
    relayer: vote.relayer || 'node',
  };
}

/** Hourly-safe view of a stored vote. Null if the accept is still sealed. */
export function publishedVoteSlice(vote, now, intervalSeconds, delaySeconds = 0) {
  if (!vote) return null;
  if (!isDisclosed(vote.acceptedAt, now, intervalSeconds, delaySeconds)) return null;
  return vote;
}

export function electionDisclosurePolicy(election, config, now, submittedVotes) {
  const settings = disclosureSettings(config || {});
  const sealed = voteResultsSealed(election, now);
  const vote = isVoteElection(election);
  // RESULTS_MIN_VOTES is a POLL gate. A VOTE does not use it. submittedVotes
  // is turnout for both types. Choice results are not on this object.
  const votes = submittedVotes ?? election?.acceptedBallots ?? 0;
  return {
    now,
    intervalSeconds: settings.intervalSeconds,
    delaySeconds: settings.delaySeconds,
    minBlockVotes: settings.minBlockVotes,
    minVotes: vote ? 0 : settings.minVotes,
    endTime: election?.cutoffTime ?? null,
    tallied: sealed ? false : Boolean(election?.tally),
    submittedVotes: votes,
    resultsSealed: sealed,
    electionType: electionTypeOf(election),
  };
}

function emptyData() {
  return {
    meta: {
      nfp: true,
      app: 'zk-voting',
      version: 9,
      nextElectionId: 1,
      nodeId: randomUUID(),
    },
    users: [],
    sessions: [],
    jurisdictions: [],
    elections: [],
    registrations: [],
    registrationRequests: [],
    identityLinks: [],
    disqualifications: [],
    votes: [],
    receipts: [],
    envelopes: [],
    // Ballots waiting for the next BallotInbox batch. Proof points only.
    // The JSON backend's live copy is chain-vote-queue.json; these fields are
    // the copy a full persist writes, and the postgres collections.
    chainVoteQueue: [],
    chainVoteBatchAt: {},
    chainVoteInFlight: {},
    chainVoteDeadLetter: [],
    chainVoteAttempts: {},
    notifications: [],
    tallyGuardians: [],
    pages: [],
    site: defaultSite(),
    termsAcceptances: [],
    outcomeSubscriptions: [],
    outcomeReports: [],
    outcomeReportDeliveries: [],
    outcomeReportTemplate: null,
    externalParties: [],
    partyRejections: [],
    partyAttestations: [],
    polls: [],
    pollBallots: [],
    pollResults: [],
    mailOutbox: [],
    apiKeys: [],
    superAdminKeys: [],
    superAdminAudit: [],
    // Phase-2 trusted-setup ceremonies (src/ceremony/service.mjs).
    ceremonies: [],
    // electionId -> sorted hashes of spent vote passes (no order, no time).
    votePassSpent: {},
    runtime: {},
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Keep a successful L1 post if a later retry fails or is AlreadyPosted. */
export function mergeTallyL1(prev, next) {
  if (!next || typeof next !== 'object') return prev || next;
  if (!prev || typeof prev !== 'object') return next;
  const prevOnChain = prev.posted || prev.alreadyPosted;
  if (prevOnChain && next.status === 'failed') {
    return { ...prev, lastError: next.error || null };
  }
  if (
    next.alreadyPosted ||
    next.status === 'already_posted' ||
    next.status === 'already_posted_mismatch'
  ) {
    return {
      ...next,
      txHash: next.txHash || prev.txHash || null,
      chainId: next.chainId || prev.chainId || null,
      mirror: next.mirror || prev.mirror || null,
      settlement: next.settlement || prev.settlement || null,
      certificationId: next.certificationId || prev.certificationId || null,
      factory: next.factory || prev.factory || null,
      jurisdictionId: next.jurisdictionId || prev.jurisdictionId || null,
      publicIdHash: next.publicIdHash || prev.publicIdHash || null,
      publicId: next.publicId || prev.publicId || null,
      electionAddress: next.electionAddress || prev.electionAddress || null,
      ballotSpecHash: next.ballotSpecHash || prev.ballotSpecHash || null,
      hashMismatch: Boolean(next.hashMismatch),
      requestedHash: next.requestedHash || prev.requestedHash || null,
    };
  }
  return next;
}

/** Fill defaults and repair collection shapes on a loaded document. */
function normalizeLoadedData(parsed) {
  const data = { ...emptyData(), ...(parsed || {}) };
  for (const key of ARRAY_COLLECTIONS) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  data.site = { ...defaultSite(), ...(data.site || {}) };
  data.site.contracts = { ...defaultSite().contracts, ...(data.site.contracts || {}) };
  delete data.heldChainBallots;
  ensureSuperAdminCollections(data);
  ensureSiteAdminCollections(data);
  data.meta = data.meta || {};
  data.meta.version = Math.max(Number(data.meta.version || 0), 9);
  scrubBallotLinkage(data);
  return data;
}

/**
 * Drop fields older nodes stored that could join a ballot to a person:
 * a userOpHash bound to the smart-account address, the email hint and send
 * time of an emailed receipt, and second-precision acceptance times.
 */
export function scrubBallotLinkage(data) {
  if (!data.votePassSpent || typeof data.votePassSpent !== 'object' || Array.isArray(data.votePassSpent)) {
    data.votePassSpent = {};
  }
  const hour = (t) => (Number.isFinite(Number(t)) ? Math.floor(Number(t) / 3600) * 3600 : t);
  for (const r of data.receipts || []) {
    if (!r || typeof r !== 'object') continue;
    delete r.userOpHash;
    delete r.emailHint;
    delete r.emailedAt;
    if (r.acceptedAt != null) r.acceptedAt = hour(r.acceptedAt);
  }
  for (const v of data.votes || []) {
    if (v && typeof v === 'object' && v.acceptedAt != null) v.acceptedAt = hour(v.acceptedAt);
  }
  // Older builds subscribed the voter at the moment of the ballot; those rows'
  // timestamps were a per-user vote clock. Keep the choice, drop the clock.
  const day = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(Math.floor(t / 86400000) * 86400000).toISOString() : iso;
  };
  for (const s of data.outcomeSubscriptions || []) {
    if (!s || typeof s !== 'object' || s.source !== 'vote-default') continue;
    s.source = 'legacy-default';
    if (s.createdAt) s.createdAt = day(s.createdAt);
    if (s.updatedAt) s.updatedAt = day(s.updatedAt);
  }
  return data;
}

function insertAtRandom(list, item) {
  list.splice(randomInt(list.length + 1), 0, item);
}

/** Soft-deleted rows stay in the document. Every read skips them. */
function isSoftDeleted(row) {
  return Boolean(row && typeof row === 'object' && row.is_deleted === true);
}

const ARRAY_COLLECTIONS = [
  'users',
  'sessions',
  'jurisdictions',
  'elections',
  'registrations',
  'registrationRequests',
  'identityLinks',
  'disqualifications',
  'votes',
  'receipts',
  'envelopes',
  'notifications',
  'tallyGuardians',
  'pages',
  'termsAcceptances',
  'outcomeSubscriptions',
  'outcomeReports',
  'outcomeReportDeliveries',
  'externalParties',
  'partyRejections',
  'partyAttestations',
  'polls',
  'pollBallots',
  'pollResults',
  'mailOutbox',
  'apiKeys',
  'superAdminKeys',
  'superAdminAudit',
  'ceremonies',
];

const PG_NAMESPACE = 'store';
/** Ballot-side collections whose Postgres timestamps are hour-truncated (db.mjs). */
export const BALLOT_TIMING_COLLECTIONS = [
  'votes',
  'receipts',
  'envelopes',
  'votePassSpent',
  'elections',
];

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Queue document. Rows are proof points; the chain layer owns the meaning. */
export function normalizeChainVoteQueue(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const batchAt = {};
  if (plainObject(src.batchAt)) {
    for (const [id, at] of Object.entries(src.batchAt)) batchAt[id] = Number(at) || 0;
  }
  const inFlight = {};
  if (plainObject(src.inFlight)) {
    for (const [id, marker] of Object.entries(src.inFlight)) {
      if (!plainObject(marker)) continue;
      inFlight[id] = {
        txHash: marker.txHash ? String(marker.txHash) : null,
        nullifiers: Array.isArray(marker.nullifiers) ? marker.nullifiers.map((n) => String(n)) : [],
      };
    }
  }
  const attempts = {};
  if (plainObject(src.attempts)) {
    for (const [id, n] of Object.entries(src.attempts)) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) attempts[id] = Math.floor(num);
    }
  }
  return {
    rows: Array.isArray(src.rows) ? src.rows : [],
    batchAt,
    inFlight,
    deadLetter: Array.isArray(src.deadLetter) ? src.deadLetter.filter((item) => plainObject(item)) : [],
    attempts,
  };
}

function chainVoteQueueFromData(data) {
  return normalizeChainVoteQueue({
    rows: data?.chainVoteQueue,
    batchAt: data?.chainVoteBatchAt,
    inFlight: data?.chainVoteInFlight,
    deadLetter: data?.chainVoteDeadLetter,
    attempts: data?.chainVoteAttempts,
  });
}

export class Store {
  constructor(filePath, data) {
    this.filePath = filePath;
    this.queuePath = path.join(path.dirname(filePath), 'chain-vote-queue.json');
    this.data = data;
    this._write = Promise.resolve();
    this._queueWrite = Promise.resolve();
    this._chainQueue = chainVoteQueueFromData(data);
    /** 'json' (DATA_DIR file, dev fallback) or 'postgres' (DATABASE_URL). */
    this.backend = 'json';
    this.pg = null;
  }

  static async open(config) {
    await fs.mkdir(config.dataDir, { recursive: true });
    const filePath = path.join(config.dataDir, 'zk-voting.json');
    let data;
    let pgDoc = null;
    let imported = false;
    if (usingPostgres(config)) {
      await migrate(config, { quiet: config.quiet });
      pgDoc = new PgDocument(config, PG_NAMESPACE, { coarseTimes: BALLOT_TIMING_COLLECTIONS });
      const stored = await pgDoc.load();
      if (stored) {
        data = normalizeLoadedData(stored);
      } else {
        // One-time import: tables are empty and DATA_DIR still has a JSON store.
        const legacy = await readJsonFile(filePath);
        data = legacy ? normalizeLoadedData(legacy) : emptyData();
        imported = Boolean(legacy);
      }
    } else {
      const legacy = await readJsonFile(filePath);
      data = legacy ? normalizeLoadedData(legacy) : emptyData();
    }
    const store = new Store(filePath, data);
    if (pgDoc) {
      store.backend = 'postgres';
      store.pg = pgDoc;
    }
    if (!config.quiet) {
      console.info(
        store.backend === 'postgres'
          ? `[zk-voting] store backend: postgres (${describeDatabaseUrl(resolveDatabaseUrl(config))})`
          : `[zk-voting] store backend: json file ${filePath} (dev fallback; set DATABASE_URL for postgres)`,
      );
    }
    store.writerActive = config.writerActive !== false;
    store.lease = config.writerLeaseHandle || null;
    for (const user of store.data.users) {
      ensurePersonFields(user);
      for (const cred of user.credentials) {
        store._addAuthMethodUnchecked(user, {
          type: 'passkey',
          credentialId: cred.id,
          label: 'Passkey',
          verifiedBy: 'self',
        });
      }
    }
    await store.seed(config);
    store.ensureJurisdictionIds();
    store.ensureElectionPublicIds();
    store.rebuildAllEligibility();
    for (const key of ARRAY_COLLECTIONS) {
      if (!Array.isArray(store.data[key])) store.data[key] = [];
    }
    ensureSuperAdminCollections(store.data);
    // v9: site admin (capability roles audit, layout, plugin registry).
    ensureSiteAdminCollections(store.data);
    store.data.meta = store.data.meta || {};
    if (!store.data.meta.nodeId) store.data.meta.nodeId = randomUUID();
    store.data.meta.version = Math.max(Number(store.data.meta.version || 0), 9);
    await store.loadChainQueueFromDisk();
    if (store.writerActive) {
      if (store.pg) await store.pg.claimWriter();
      await store.persist();
      if (imported) {
        await recordImport(config, filePath, {
          users: store.data.users.length,
          elections: store.data.elections.length,
          votes: store.data.votes.length,
        });
        if (!config.quiet) {
          console.info(
            `[zk-voting] imported ${filePath} into postgres (users=${store.data.users.length} elections=${store.data.elections.length} votes=${store.data.votes.length}); the JSON file is left in place and no longer read`,
          );
        }
      }
    }
    return store;
  }

  /** Take the Postgres writer fence (standby promotion). No-op on the JSON backend. */
  async claimWriter(owner) {
    if (this.pg) await this.pg.claimWriter(owner);
  }

  refuseIfStandby() {
    if (this.writerActive === false) {
      throw new HttpError(503, 'maintenance handover', {
        code: 'STANDBY',
        mode: 'standby',
        retryAfter: 2,
      });
    }
  }

  /** Re-read persisted state (standby promotion). Postgres or the JSON file. */
  async reloadFromDisk() {
    let parsed;
    if (this.pg) {
      parsed = await this.pg.load();
      if (!parsed) return;
    } else {
      parsed = await readJsonFile(this.filePath);
      if (!parsed) return;
    }
    const data = normalizeLoadedData(parsed);
    for (const user of data.users || []) ensurePersonFields(user);
    this.data = data;
    this.ensureJurisdictionIds();
    this.rebuildAllEligibility();
    await this.loadChainQueueFromDisk();
  }

  async persist() {
    this.refuseIfStandby();
    if (this.lease) {
      this.lease.assertFence();
      this.data.meta = this.data.meta || {};
      const diskEpoch = Number(this.data.meta.writerEpoch || 0);
      if (diskEpoch > this.lease.epoch) {
        throw new HttpError(503, 'stale writer fence', { code: 'STALE_FENCE', mode: 'standby' });
      }
      this.data.meta.writerEpoch = this.lease.epoch;
    }
    if (this.pg) {
      try {
        await this.pg.save(this.data);
      } catch (err) {
        if (err && err.code === 'STALE_FENCE') {
          throw new HttpError(503, 'stale writer fence', { code: 'STALE_FENCE', mode: 'standby' });
        }
        throw err;
      }
      return;
    }
    this._write = this._write.then(async () => {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this._write;
  }

  async seed(config) {
    const handle = String(config.adminHandle || 'admin').trim() || 'admin';
    const hasSuper = this.data.users.some((u) => !isSoftDeleted(u) && u.role === 'platform_super_admin');
    if (!hasSuper) {
      const existing = this.getUserByHandle(handle);
      if (existing) {
        existing.role = 'platform_super_admin';
      } else {
        this.data.users.push(
          ensurePersonFields({
            id: randomUUID(),
            handle,
            role: 'platform_super_admin',
            createdAt: new Date().toISOString(),
            credentials: [],
            authMethods: [],
            ethAccounts: [],
            activeEthAddress: null,
            personKeyHash: null,
            email: null,
          }),
        );
      }
    }
    if (this.data.jurisdictions.length === 0) {
      this.data.jurisdictions.push({
        id: DEMO_JURISDICTION_ID,
        name: 'Demo jurisdiction',
        metadataURI: '',
        officers: [],
        createdAt: new Date().toISOString(),
      });
    }
    return this.applySuperAdminEmail(config);
  }

  /**
   * Point the existing platform super admin's contactEmail at SUPER_ADMIN_EMAIL.
   * Empty env is a no-op. The active writer overwrites on every boot so
   * operators can rotate. Standby must not mutate the store. Does not create
   * a user. Returns true when contactEmail changed.
   * @param {Record<string, unknown>} [config]
   * @returns {boolean}
   */
  applySuperAdminEmail(config = {}) {
    const email = resolveSuperAdminEmail(config.superAdminEmail);
    if (!email) return false;
    if (config.writerActive === false || this.writerActive === false) return false;
    const user = this.data.users.find((row) => row && !isSoftDeleted(row) && row.role === 'platform_super_admin');
    if (!user || user.contactEmail === email) return false;
    user.contactEmail = email;
    if (!config.quiet) {
      console.info(
        `[zk-voting] platform super admin contact email set from SUPER_ADMIN_EMAIL (${emailHint(email)})`,
      );
    }
    return true;
  }

  /**
   * After this process takes the writer lease, apply SUPER_ADMIN_EMAIL and
   * persist only when the contact email changed. Standby must not call this.
   * @param {Record<string, unknown>} [config]
   */
  async adoptSuperAdminEmail(config = {}) {
    if (this.writerActive === false || config.writerActive === false) return false;
    const changed = this.applySuperAdminEmail(config);
    if (changed) await this.persist();
    return changed;
  }

  snapshot() {
    return clone(this.data);
  }

  nodeId() {
    this.data.meta = this.data.meta || {};
    if (!this.data.meta.nodeId) this.data.meta.nodeId = randomUUID();
    return String(this.data.meta.nodeId);
  }

  findElectionsByRef(id) {
    const want = String(id ?? '').trim();
    if (!want) return [];
    return this.data.elections.filter((e) => electionMatchesRef(e, want) || electionIdMatches(e, want));
  }

  requireElection(id) {
    const election = this.getElection(id);
    if (!election) throw new HttpError(404, 'election not found');
    return election;
  }

  getElection(id) {
    const matches = this.findElectionsByRef(id);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const want = String(id ?? '').trim();
    const exactId = matches.find((e) => String(e.id) === want);
    if (exactId) return exactId;
    const shorts = matches.filter((e) => e.shortCode === want);
    if (shorts.length === 1) return shorts[0];
    throw new HttpError(409, 'ambiguous election id', { code: 'ELECTION_ID_COLLISION' });
  }

  _shortCodeTaken(code, exceptId = null) {
    return this.data.elections.some(
      (e) => e.shortCode && e.shortCode === code && (exceptId == null || String(e.id) !== String(exceptId)),
    );
  }

  _uniqueShortCode() {
    for (let i = 0; i < 48; i += 1) {
      const code = mintShortCode();
      if (!this._shortCodeTaken(code) && !this.getElection(code)) return code;
    }
    throw new HttpError(500, 'could not mint election short code');
  }

  _allocateOnChainElectionId(requested) {
    let value;
    try {
      value = parseOnChainElectionId(requested);
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
    if (value == null) {
      value = String(this.data.meta.nextElectionId || 1);
      this.data.meta.nextElectionId = Number(this.data.meta.nextElectionId || 1) + 1;
    } else {
      const taken = this.data.elections.some((e) => String(e.onChainElectionId) === value);
      if (taken) throw new HttpError(409, 'onChainElectionId taken');
      try {
        const n = BigInt(value);
        const next = BigInt(this.data.meta.nextElectionId || 1);
        if (n >= next && n < BigInt(Number.MAX_SAFE_INTEGER)) {
          this.data.meta.nextElectionId = Number(n) + 1;
        }
      } catch {
        /* keep allocator as-is for oversized ids */
      }
    }
    return value;
  }

  /**
   * Backfill shortCode / onChainElectionId on elections created before UUID
   * public ids. Existing non-UUID ids are kept so old bookmarks still resolve.
   */
  ensureElectionPublicIds() {
    this.data.meta = this.data.meta || {};
    if (this.data.meta.nextElectionId == null) this.data.meta.nextElectionId = 1;
    this.data.meta.version = Math.max(Number(this.data.meta.version || 0), 3);
    for (const election of this.data.elections) {
      if (!election.shortCode) {
        election.shortCode = this._uniqueShortCode();
      }
      if (election.onChainElectionId == null || election.onChainElectionId === '') {
        if (/^\d+$/.test(String(election.id))) {
          election.onChainElectionId = String(election.id);
          try {
            const n = BigInt(election.id);
            const next = BigInt(this.data.meta.nextElectionId || 1);
            if (n >= next && n < BigInt(Number.MAX_SAFE_INTEGER)) {
              this.data.meta.nextElectionId = Number(n) + 1;
            }
          } catch {
            /* ignore */
          }
        } else {
          election.onChainElectionId = this._allocateOnChainElectionId(null);
        }
      }
    }
  }

  getElectionByOnChainId(onChainId) {
    if (onChainId == null || onChainId === '') return null;
    const key = String(onChainId);
    return (
      this.data.elections.find((e) => e.onChainElectionId != null && String(e.onChainElectionId) === key) ||
      null
    );
  }

  listElections() {
    return this.data.elections.slice();
  }

  /** Public lists omit a row whose sequencer open has not finished. */
  listPublicElections() {
    return this.listElections().filter((row) => row && !isSoftDeleted(row) && row.l2OpenStatus !== 'pending');
  }

  applyChainVoteQueue(doc) {
    const next = normalizeChainVoteQueue(doc);
    this._chainQueue = next;
    this.data.chainVoteQueue = next.rows;
    this.data.chainVoteBatchAt = next.batchAt;
    this.data.chainVoteInFlight = next.inFlight;
    this.data.chainVoteDeadLetter = next.deadLetter;
    this.data.chainVoteAttempts = next.attempts;
    return next;
  }

  /**
   * JSON: chain-vote-queue.json wins over the embedded copy so a crash between
   * a ballot and the next full persist still has the queue. Postgres keeps the
   * queue in its own collections; the sidecar is not read there.
   */
  async loadChainQueueFromDisk() {
    if (!this.pg) {
      const sidecar = await readJsonFile(this.queuePath);
      if (sidecar && typeof sidecar === 'object') {
        this.applyChainVoteQueue(sidecar);
        return this._chainQueue;
      }
    }
    this.applyChainVoteQueue(chainVoteQueueFromData(this.data));
    return this._chainQueue;
  }

  loadChainVoteQueue() {
    return this._chainQueue || chainVoteQueueFromData(this.data);
  }

  /**
   * Persist the ballot queue only. The JSON backend rewrites chain-vote-queue.json.
   * Postgres writes the queue collections. Neither path rewrites the whole store.
   */
  async saveChainVoteQueue(doc) {
    this.refuseIfStandby();
    const next = this.applyChainVoteQueue(doc);
    if (this.pg) {
      await this.pg.saveCollections({
        chainVoteQueue: next.rows,
        chainVoteBatchAt: next.batchAt,
        chainVoteInFlight: next.inFlight,
        chainVoteDeadLetter: next.deadLetter,
        chainVoteAttempts: next.attempts,
      });
      return;
    }
    this._queueWrite = this._queueWrite.then(async () => {
      const tmp = `${this.queuePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next));
      await fs.rename(tmp, this.queuePath);
    });
    return this._queueWrite;
  }

  getUser(id) {
    const user = this.data.users.find((u) => u.id === id && !isSoftDeleted(u)) || null;
    return user ? ensurePersonFields(user) : null;
  }

  getUserByHandle(handle) {
    const h = String(handle || '').trim().toLowerCase();
    if (!h) return null;
    const user = this.data.users.find((u) => !isSoftDeleted(u) && u.handle.toLowerCase() === h) || null;
    return user ? ensurePersonFields(user) : null;
  }

  createUser({ handle, role = 'voter', email = null }) {
    const trimmed = String(handle || '').trim();
    if (!trimmed) throw new HttpError(400, 'handle required');
    if (!isRole(role)) throw new HttpError(400, 'invalid role');
    if (this.getUserByHandle(trimmed)) throw new HttpError(409, 'handle taken');
    const user = ensurePersonFields({
      id: randomUUID(),
      handle: trimmed,
      role,
      email: email || null,
      createdAt: new Date().toISOString(),
      credentials: [],
      authMethods: [],
      ethAccounts: [],
      activeEthAddress: null,
      personKeyHash: null,
      pinHash: null,
      pinSetAt: null,
      pinResetUntil: null,
    });
    this.data.users.push(user);
    return user;
  }

  async setPinHash(userId, pinHash) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    user.pinHash = String(pinHash);
    user.pinSetAt = new Date().toISOString();
    user.pinResetUntil = null;
    await this.persist();
    return user;
  }

  async grantPinReset(userId, untilMs = 15 * 60 * 1000) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    user.pinResetUntil = new Date(Date.now() + Number(untilMs || 0)).toISOString();
    await this.persist();
    return user;
  }

  async ensureUser({ handle, role = 'voter' }) {
    const existing = this.getUserByHandle(handle);
    if (existing) return existing;
    const user = this.createUser({ handle, role });
    await this.persist();
    return user;
  }

  async updateUserRole(userId, role) {
    if (!isRole(role)) throw new HttpError(400, 'invalid role');
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    user.role = role;
    await this.persist();
    return user;
  }

  listUsers() {
    return this.data.users.filter((u) => !isSoftDeleted(u));
  }

  /** Votes still stored but hidden from reads, tallies, and turnout. */
  hiddenVoteCount(electionId) {
    return (this.data.votes || []).filter(
      (v) => isSoftDeleted(v) && String(v.electionId) === String(electionId),
    ).length;
  }

  /**
   * Live accepted-ballot count. With no soft-deleted votes this is the stored
   * counter, including elections whose counter was set without vote rows.
   * Hidden rows are subtracted only when some exist.
   */
  visibleAcceptedBallots(election) {
    const raw = Number(election?.acceptedBallots) || 0;
    const hidden = this.hiddenVoteCount(election?.id);
    if (hidden <= 0) return raw;
    return Math.max(0, raw - hidden);
  }

  getSession(id) {
    if (!id) return null;
    const session = this.data.sessions.find((s) => s.id === id && !isSoftDeleted(s));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  }

  async createSession(userId, ttlMs) {
    // Drop expired live sessions. Keep soft-deleted rows so a purge is not a hard delete.
    this.data.sessions = this.data.sessions.filter((s) => isSoftDeleted(s) || s.expiresAt > Date.now());
    const now = Date.now();
    const session = {
      id: randomUUID(),
      userId,
      createdAt: now,
      authenticatedAt: now,
      stepUpAt: now,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: now + ttlMs,
    };
    this.data.sessions.push(session);
    await this.persist();
    return session;
  }

  async deleteSession(id) {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    await this.persist();
  }

  addCredential(userId, credential) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    user.credentials = user.credentials || [];
    if (user.credentials.some((c) => c.id === credential.id)) {
      throw new HttpError(409, 'credential already registered');
    }
    assertPasskeyRoom(user);
    user.credentials.push(credential);
    this._addAuthMethodUnchecked(user, {
      type: 'passkey',
      credentialId: credential.id,
      label: credential.label || 'Passkey',
      verifiedBy: 'self',
    });
    return credential;
  }

  async removeCredential(userId, credentialId) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const id = String(credentialId || '');
    const cred = (user.credentials || []).find((c) => c.id === id);
    if (!cred) {
      throw new HttpError(404, 'unknown credential', { code: 'UNKNOWN_CREDENTIAL' });
    }
    user.credentials = user.credentials.filter((c) => c.id !== id);
    user.authMethods = (user.authMethods || []).filter(
      (m) => !(m.type === 'passkey' && m.credentialId === id),
    );
    await this.persist();
    return user;
  }

  findCredential(credentialId) {
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      const cred = (user.credentials || []).find((c) => c.id === credentialId);
      if (cred) return { user: ensurePersonFields(user), credential: cred };
    }
    return null;
  }

  async updateCredentialCounter(credentialId, counter) {
    const found = this.findCredential(credentialId);
    if (found) found.credential.counter = counter;
    await this.persist();
  }

  findUserByEthAddress(address) {
    let addr;
    try {
      addr = normalizeEthAddress(address);
    } catch {
      return null;
    }
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      ensurePersonFields(user);
      if (sameEthAddress(user.activeEthAddress, addr)) return user;
      if (user.ethAccounts.some((a) => sameEthAddress(a.address, addr))) return user;
    }
    return null;
  }

  findUserByPersonKeyHash(hash) {
    const key = String(hash || '').toLowerCase();
    if (!key) return null;
    const user = this.data.users.find((u) => !isSoftDeleted(u) && String(u.personKeyHash || '').toLowerCase() === key) || null;
    return user ? ensurePersonFields(user) : null;
  }

  findUserByEmail(email) {
    const want = String(email || '')
      .trim()
      .toLowerCase();
    if (!want) return null;
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      ensurePersonFields(user);
      if (String(user.email || '').trim().toLowerCase() === want) return user;
      const hit = user.authMethods.find(
        (m) => m.type === 'email' && String(m.email || '').trim().toLowerCase() === want,
      );
      if (hit) return user;
    }
    return null;
  }

  findUserByAuthMethod({ type, credentialId, address, fingerprint, email, civicIdHash }) {
    const wantEmail = email ? String(email).trim().toLowerCase() : '';
    const wantCivic = civicIdHash ? String(civicIdHash).toLowerCase() : '';
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      ensurePersonFields(user);
      const hit = user.authMethods.find((m) => {
        if (type && m.type !== type) return false;
        if (credentialId && m.credentialId === credentialId) return true;
        if (address && sameEthAddress(m.address, address)) return true;
        if (fingerprint && String(m.fingerprint || '').toLowerCase() === String(fingerprint).toLowerCase()) {
          return true;
        }
        if (wantEmail && String(m.email || '').trim().toLowerCase() === wantEmail) return true;
        if (wantCivic) {
          const stored = String(m.civicIdHash || m.fingerprint || '').toLowerCase();
          if (stored === wantCivic) return true;
        }
        return false;
      });
      if (hit) return { user, method: hit };
    }
    return null;
  }

  _addAuthMethodUnchecked(user, fields) {
    ensurePersonFields(user);
    const type = fields.type;
    if (!isAuthMethodType(type)) throw new HttpError(400, 'invalid auth method type');
    if (Object.prototype.hasOwnProperty.call(fields, 'documentNumber') && fields.documentNumber) {
      throw new HttpError(400, 'document numbers are not stored; send a civicIdHash');
    }
    const existing = this.findUserByAuthMethod({
      type,
      credentialId: fields.credentialId,
      address: fields.address,
      fingerprint: fields.fingerprint,
      email: fields.email,
      civicIdHash: fields.civicIdHash,
    });
    if (existing && existing.user.id !== user.id) {
      throw new HttpError(409, 'authenticator already bound to another person', {
        code: 'METHOD_OWNED',
      });
    }
    if (existing && existing.user.id === user.id) {
      if (type === 'email') syncPersonEmails(user);
      return existing.method;
    }
    const emailCountBefore = personEmailMethods(user).length;
    if (type === 'smart_card' && !existing) assertSmartCardRoom(user);
    if (type === 'civic_id' && !existing) assertCivicIdRoom(user);
    const method = {
      id: randomUUID(),
      type,
      verified: true,
      verifiedBy: fields.verifiedBy || 'self',
      verifiedAt: new Date().toISOString(),
      label: fields.label || null,
      credentialId: fields.credentialId || null,
      address: fields.address || null,
      fingerprint: fields.fingerprint || null,
      subject: fields.subject || null,
      issuer: fields.issuer || null,
      email: fields.email || null,
      kind: fields.kind || null,
      civicIdHash: fields.civicIdHash || (type === 'civic_id' ? fields.fingerprint : null),
      primary: type === 'email' ? emailCountBefore === 0 : undefined,
      status: isCredentialMethodType(type) ? fields.status || 'active' : undefined,
      expiresAt: isCredentialMethodType(type)
        ? fields.expiresAt
          ? parseExpiresAt(fields.expiresAt)
          : null
        : undefined,
      claimedExpiresAt: isCredentialMethodType(type)
        ? fields.claimedExpiresAt
          ? parseExpiresAt(fields.claimedExpiresAt)
          : null
        : undefined,
      provider: isCredentialMethodType(type) ? fields.provider || 'manual' : undefined,
      providerRef: isCredentialMethodType(type) ? fields.providerRef || null : undefined,
    };
    if (isCredentialMethodType(type)) ensureCredentialFields(method);
    if (type === 'email' && method.email) {
      try {
        method.email = normalizeEmail(method.email);
      } catch {
        /* keep raw; caller already validated on HTTP paths */
      }
    }
    user.authMethods.push(method);
    if (type === 'email') syncPersonEmails(user);
    return method;
  }

  async setPrimaryEmail(userId, { emailId, email } = {}) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const methods = personEmailMethods(user);
    let target = null;
    if (emailId) target = methods.find((m) => m.id === String(emailId));
    if (!target && email) {
      const want = normalizeEmail(email);
      target = methods.find((m) => sameEmail(m.email, want));
    }
    if (!target) {
      throw new HttpError(404, 'email not bound to this person', { code: 'EMAIL_NOT_FOUND' });
    }
    for (const method of methods) {
      method.primary = method.id === target.id;
    }
    user.email = target.email;
    syncPersonEmails(user);
    await this.persist();
    return user;
  }

  async removeEmail(userId, emailId) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const methods = personEmailMethods(user);
    const target = methods.find((m) => m.id === String(emailId));
    if (!target) {
      throw new HttpError(404, 'email not bound to this person', { code: 'EMAIL_NOT_FOUND' });
    }
    if (target.primary) {
      throw new HttpError(
        400,
        methods.length === 1
          ? 'Cannot remove the only email until another address is added and set as primary'
          : 'Set another email as primary before removing this one',
        { code: 'PRIMARY_REQUIRED' },
      );
    }
    user.authMethods = user.authMethods.filter((m) => m.id !== target.id);
    syncPersonEmails(user);
    await this.persist();
    return user;
  }

  async addAuthMethod(userId, fields) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    if (fields?.type === 'email' && fields.email) {
      assertEmailRoom(user, fields.email);
    }
    if (fields?.type === 'passkey' && fields.credentialId) {
      const alreadyCred = (user.credentials || []).some((c) => c.id === fields.credentialId);
      if (!alreadyCred) assertPasskeyRoom(user);
    }
    const method = this._addAuthMethodUnchecked(user, fields);
    await this.persist();
    return { user, method };
  }

  async addEthAccount(userId, { address, source = 'web3', methodId = null, verified = true, verifiedBy = 'self' } = {}) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const addr = normalizeEthAddress(address);
    const owner = this.findUserByEthAddress(addr);
    if (owner && owner.id !== user.id) {
      throw new HttpError(409, 'Ethereum address already bound to another person', {
        code: 'ADDRESS_OWNED',
      });
    }
    const existing = user.ethAccounts.find((a) => sameEthAddress(a.address, addr));
    if (existing) {
      if (verified && !existing.verified) {
        existing.verified = true;
        existing.verifiedBy = verifiedBy || 'self';
        existing.verifiedAt = new Date().toISOString();
        if (!user.activeEthAddress) user.activeEthAddress = addr;
        await this.persist();
      }
      return { user, account: existing, created: false };
    }
    const account = {
      address: addr,
      source: String(source || 'web3'),
      verified: Boolean(verified),
      verifiedBy: verified ? verifiedBy || 'self' : null,
      verifiedAt: verified ? new Date().toISOString() : null,
      methodId: methodId || null,
    };
    user.ethAccounts.push(account);
    if (verified && !user.activeEthAddress) user.activeEthAddress = addr;
    await this.persist();
    return { user, account, created: true };
  }

  async setActiveEthAddress(userId, address) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const addr = normalizeEthAddress(address);
    const account = user.ethAccounts.find((a) => sameEthAddress(a.address, addr) && a.verified);
    if (!account) {
      throw new HttpError(400, 'address is not an internally verified account of this person', {
        code: 'NOT_VERIFIED',
      });
    }
    user.activeEthAddress = addr;
    await this.persist();
    return user;
  }

  async setPersonKeyHash(userId, personKeyHash) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const key = String(personKeyHash || '').trim().toLowerCase();
    if (!key || !/^0x[0-9a-f]{64}$/.test(key)) {
      throw new HttpError(400, 'personKeyHash must be keccak256 hex (bytes32)');
    }
    const other = this.findUserByPersonKeyHash(key);
    if (other && other.id !== user.id) {
      throw new HttpError(409, 'person key already bound to another account', {
        code: 'PERSON_KEY_OWNED',
      });
    }
    user.personKeyHash = key;
    await this.persist();
    return user;
  }

  listJurisdictions() {
    return this.data.jurisdictions.slice();
  }

  ensureJurisdictionIds() {
    for (const jurisdiction of this.data.jurisdictions || []) {
      if (jurisdiction && jurisdiction.id === 'demo') jurisdiction.id = DEMO_JURISDICTION_ID;
    }
  }

  getJurisdiction(id) {
    const want = canonicalJurisdictionId(id);
    return this.data.jurisdictions.find((j) => String(j.id) === want) || null;
  }

  async createJurisdiction({ name, metadataURI = '' } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new HttpError(400, 'name required');
    const jurisdiction = {
      id: randomUUID(),
      name: trimmed,
      metadataURI: String(metadataURI || ''),
      officers: [],
      createdAt: new Date().toISOString(),
    };
    if (this.getJurisdiction(jurisdiction.id)) {
      throw new HttpError(409, 'jurisdiction id taken');
    }
    this.data.jurisdictions.push(jurisdiction);
    await this.persist();
    return jurisdiction;
  }

  resolveOfficerUser({ userId, handle, address } = {}) {
    if (userId) {
      const user = this.getUser(userId);
      if (user) return user;
    }
    if (handle) {
      const user = this.getUserByHandle(handle);
      if (user) return user;
    }
    if (address) {
      const byEth = this.findUserByEthAddress(address);
      if (byEth) return byEth;
      const byHandle = this.getUserByHandle(address);
      if (byHandle) return byHandle;
    }
    return null;
  }

  officerMatchesUser(grant, user) {
    if (!grant || !user) return false;
    if (grant.userId && grant.userId === user.id) return true;
    const grantHandle = String(grant.handle || '').trim().toLowerCase();
    const userHandle = String(user.handle || '').trim().toLowerCase();
    if (grantHandle && grantHandle === userHandle) return true;
    const grantAddr = String(grant.address || '').trim();
    if (!grantAddr) return false;
    if (grantAddr.toLowerCase() === userHandle) return true;
    if (sameEthAddress(user.activeEthAddress, grantAddr)) return true;
    return (user.ethAccounts || []).some((a) => sameEthAddress(a.address, grantAddr));
  }

  userHasJurisdictionRole(user, roles, jurisdictionId) {
    if (!user) return false;
    if (isPlatformOperator(user)) return true;
    const wanted = new Set((Array.isArray(roles) ? roles : [roles]).filter(Boolean));
    if (!wanted.size || jurisdictionId == null || jurisdictionId === '') return false;
    const jurisdiction = this.getJurisdiction(jurisdictionId);
    if (!jurisdiction) return false;
    return (jurisdiction.officers || []).some(
      (grant) => wanted.has(grant.role) && this.officerMatchesUser(grant, user),
    );
  }

  userHasAnyJurisdictionRole(user, roles) {
    if (!user) return false;
    if (isPlatformOperator(user)) return true;
    return this.data.jurisdictions.some((jurisdiction) =>
      this.userHasJurisdictionRole(user, roles, jurisdiction.id),
    );
  }

  listJurisdictionRolesForUser(user) {
    if (!user) return [];
    const out = [];
    for (const jurisdiction of this.data.jurisdictions) {
      for (const grant of jurisdiction.officers || []) {
        if (this.officerMatchesUser(grant, user)) {
          out.push({
            jurisdictionId: jurisdiction.id,
            jurisdictionName: jurisdiction.name,
            role: grant.role,
            grantedAt: grant.grantedAt || null,
            address: grant.address || '',
          });
        }
      }
    }
    return out;
  }

  _matchingOfficerGrant(jurisdiction, role, { user, handle, address, userId }) {
    const handleKey = String(handle || '').trim().toLowerCase();
    const addressKey = String(address || '').trim().toLowerCase();
    const idKey = String(userId || '').trim();
    return (jurisdiction.officers || []).find((grant) => {
      if (grant.role !== role) return false;
      if (user && this.officerMatchesUser(grant, user)) return true;
      if (idKey && grant.userId === idKey) return true;
      if (handleKey && String(grant.handle || '').trim().toLowerCase() === handleKey) return true;
      if (addressKey && String(grant.address || '').trim().toLowerCase() === addressKey) return true;
      return false;
    });
  }

  async grantJurisdictionRole(jurisdictionId, { address, role, handle, userId } = {}) {
    const jurisdiction = this.getJurisdiction(jurisdictionId);
    if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
    if (!isOfficerRole(role)) throw new HttpError(400, 'invalid role');
    const trimmedHandle = String(handle || '').trim();
    const trimmedAddress = String(address || '').trim();
    const trimmedUserId = String(userId || '').trim();
    if (!trimmedHandle && !trimmedAddress && !trimmedUserId) {
      throw new HttpError(400, 'handle, userId, or address required');
    }
    const user = this.resolveOfficerUser({
      userId: trimmedUserId,
      handle: trimmedHandle,
      address: trimmedAddress,
    });
    jurisdiction.officers = jurisdiction.officers || [];
    const existing = this._matchingOfficerGrant(jurisdiction, role, {
      user,
      handle: trimmedHandle,
      address: trimmedAddress,
      userId: trimmedUserId,
    });
    if (existing) {
      if (user && !existing.userId) existing.userId = user.id;
      if (user && !existing.handle) existing.handle = user.handle;
      await this.persist();
      return { jurisdiction, grant: existing, user, created: false };
    }
    const grant = {
      userId: user?.id || trimmedUserId || '',
      address: trimmedAddress || user?.activeEthAddress || '',
      handle: user?.handle || trimmedHandle,
      role,
      grantedAt: new Date().toISOString(),
    };
    jurisdiction.officers.push(grant);
    await this.persist();
    return { jurisdiction, grant, user, created: true };
  }

  async revokeJurisdictionRole(jurisdictionId, { address, role, handle, userId } = {}) {
    const jurisdiction = this.getJurisdiction(jurisdictionId);
    if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
    if (!isOfficerRole(role)) throw new HttpError(400, 'invalid role');
    const trimmedHandle = String(handle || '').trim();
    const trimmedAddress = String(address || '').trim();
    const trimmedUserId = String(userId || '').trim();
    if (!trimmedHandle && !trimmedAddress && !trimmedUserId) {
      throw new HttpError(400, 'handle, userId, or address required');
    }
    const user = this.resolveOfficerUser({
      userId: trimmedUserId,
      handle: trimmedHandle,
      address: trimmedAddress,
    });
    const before = jurisdiction.officers || [];
    const next = before.filter((grant) => {
      if (grant.role !== role) return true;
      if (user && this.officerMatchesUser(grant, user)) return false;
      if (trimmedUserId && grant.userId === trimmedUserId) return false;
      if (
        trimmedHandle &&
        String(grant.handle || '').trim().toLowerCase() === trimmedHandle.toLowerCase()
      ) {
        return false;
      }
      if (
        trimmedAddress &&
        String(grant.address || '').trim().toLowerCase() === trimmedAddress.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
    if (next.length === before.length) {
      throw new HttpError(404, 'officer grant not found');
    }
    jurisdiction.officers = next;
    await this.persist();
    return { jurisdiction, role, user };
  }

  async createElection(params) {
    // Never honor a client-supplied public id (copied UUID / squatting).
    const onChainElectionId = this._allocateOnChainElectionId(params.onChainElectionId);
    const scope = {
      factoryAddress: params.factoryAddress || null,
      onChainElectionId,
      jurisdictionId: params.jurisdictionId,
      chainId: params.chainId,
      nodeId: this.nodeId(),
    };
    const id = mintScopedPublicId(scope);
    const existing = this.getElection(id);
    if (existing) {
      const sameIdentity =
        String(existing.onChainElectionId) === String(onChainElectionId) &&
        String(existing.jurisdictionId) === String(params.jurisdictionId) &&
        String(existing.factoryAddress || '') === String(params.factoryAddress || '');
      throw new HttpError(
        409,
        sameIdentity
          ? 'election already exists for this factory, jurisdiction, and on-chain id'
          : 'election public id collision',
        { code: 'ELECTION_ID_COLLISION' },
      );
    }
    const shortCode = this._uniqueShortCode();
    const tree = emptyTree(params.treeDepth);
    const dq = disqualificationTree(params.treeDepth, []);
    let tallyScheme;
    try {
      tallyScheme = normalizeTallyScheme(params.tallyScheme, { opensBallots: params.opensBallots });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    let tallyPubKey = params.tallyPubKey || null;
    let tallyPubKeyX = params.tallyPubKeyX || null;
    let tallyPubKeyY = params.tallyPubKeyY || null;
    let tallyCeremony = null;
    if (tallyScheme === TALLY_SCHEME_OPENS_BALLOTS) {
      if (params.aggregation && params.aggregation !== AGGREGATION_UNDECIDED) {
        throw new HttpError(
          400,
          'ballot aggregation is an open product decision; omit it or pass undecided',
          { code: 'AGGREGATION_UNDECIDED' },
        );
      }
      const guardianCount = Number(params.guardianCount);
      const threshold = Number(params.threshold);
      if (!Number.isInteger(guardianCount) || guardianCount < 2 || guardianCount > 16) {
        throw new HttpError(400, 'guardianCount must be an integer from 2 to 16', {
          code: 'BAD_GUARDIANS',
        });
      }
      if (!Number.isInteger(threshold) || threshold < 2 || threshold > guardianCount) {
        throw new HttpError(400, 'threshold must be an integer from 2 to guardianCount', {
          code: 'BAD_THRESHOLD',
        });
      }
      tallyCeremony = {
        scheme: GUARDIAN_SCHEME,
        threshold,
        guardians: guardianCount,
        aggregation: AGGREGATION_UNDECIDED,
        production: false,
        status: 'awaiting_guardians',
        warning: GUARDIAN_WARNING,
        publicKey: null,
        publicKeyX: null,
        publicKeyY: null,
        verificationKeys: null,
        roster: [],
      };
      tallyPubKey = null;
      tallyPubKeyX = null;
      tallyPubKeyY = null;
      if (!this.data.tallyGuardians) this.data.tallyGuardians = [];
      this.data.tallyGuardians.push({
        electionId: String(id),
        scheme: GUARDIAN_SCHEME,
        deals: [],
        partials: [],
        createdAt: new Date().toISOString(),
      });
    }
    const election = {
      id,
      shortCode,
      onChainElectionId,
      publicIdScheme: 'uuid-v5-jurisdiction',
      aliases: [],
      title: params.title,
      metadataURI: params.metadataURI || '',
      startTime: params.startTime,
      cutoffTime: params.cutoffTime,
      maxParticipants: params.maxParticipants,
      treeDepth: params.treeDepth,
      ballotSpecHash: params.ballotSpecHash,
      ballotMethod: params.ballotMethod || 'plurality',
      electionType: isVoteElection({ electionType: params.electionType }) ? 1 : 0,
      questions: params.questions,
      questionCount: params.questions.length,
      jurisdictionId: params.jurisdictionId,
      clerk: params.clerk || '',
      registrar: params.registrar || '',
      disqualificationOfficer: params.disqualificationOfficer || '',
      tallyOperator: params.tallyOperator || '',
      verifier: params.verifier || '',
      lateUpdateAllowed: Boolean(params.lateUpdateAllowed),
      tallyScheme,
      tallyPubKey,
      tallyPubKeyX,
      tallyPubKeyY,
      tallyCeremony,
      onChainElectionAddress: params.onChainElectionAddress || null,
      factoryAddress: params.factoryAddress || null,
      createTxHash: params.createTxHash || null,
      chainId: params.chainId != null ? Number(params.chainId) : null,
      rollFrozen: false,
      frozenAt: null,
      frozenEligibleRoot: null,
      frozenDisqualificationRoot: null,
      participantCount: 0,
      eligibleCount: 0,
      acceptedBallots: 0,
      eligibleRoot: tree.root,
      disqualificationRoot: dq.root,
      eligibleTree: tree,
      disqualificationTree: dq,
      tally: null,
      createdBy: params.createdBy || null,
      createdAt: new Date().toISOString(),
      staff: [],
      l2OpenStatus:
        params.l2OpenStatus === 'pending' || params.l2OpenStatus === 'open'
          ? params.l2OpenStatus
          : 'unconfigured',
      l2OpenFingerprint: params.l2OpenFingerprint || null,
    };
    this.data.elections.push(election);
    await this.persist();
    return election;
  }

  /** A create whose sequencer open failed. A matching retry reuses this row. */
  findPendingL2Open(fingerprint) {
    const want = String(fingerprint || '');
    if (!want) return null;
    return (
      (this.data.elections || []).find(
        (row) =>
          row &&
          !isSoftDeleted(row) &&
          row.l2OpenStatus === 'pending' &&
          String(row.l2OpenFingerprint || '') === want,
      ) || null
    );
  }

  async setL2OpenStatus(id, status) {
    const election = this.requireElection(id);
    election.l2OpenStatus = status;
    await this.persist();
    return election;
  }

  /**
   * Update ballot title / questions / metadata URI before the roll is frozen.
   * `ballotSpecHash` must already be the keccak of the canonical ballot JSON.
   */
  async updateElectionBallot(id, { title, metadataURI, questions, ballotSpecHash, ballotMethod, startTime, cutoffTime }) {
    const election = this.requireElection(id);
    if (election.tally) throw new HttpError(409, 'election already tallied', { code: 'TALLIED' });
    if (election.rollFrozen) {
      throw new HttpError(409, 'roll frozen; ballot spec is locked', { code: 'ROLL_FROZEN' });
    }
    if (title != null) {
      const trimmed = String(title).trim();
      if (!trimmed) throw new HttpError(400, 'title required');
      election.title = trimmed;
    }
    if (metadataURI != null) election.metadataURI = String(metadataURI);
    if (startTime != null) election.startTime = Number(startTime);
    if (cutoffTime != null) election.cutoffTime = Number(cutoffTime);
    if (ballotMethod) election.ballotMethod = ballotMethod;
    if (questions != null) {
      if (!Array.isArray(questions)) throw new HttpError(400, 'questions must be an array');
      election.questions = questions;
      election.questionCount = questions.length;
    }
    if (ballotSpecHash) election.ballotSpecHash = ballotSpecHash;
    await this.persist();
    return election;
  }

  /**
   * Remove an election that has never been used. Chain-posted, frozen, registered,
   * or tallied elections stay. `confirmTitle` must match the saved title exactly.
   */
  async deleteUnusedElection(id, { confirmTitle } = {}) {
    const election = this.requireElection(id);
    const title = String(election.title || '');
    if (String(confirmTitle ?? '') !== title) {
      throw new HttpError(400, 'type the election title to confirm', { code: 'CONFIRM_TITLE' });
    }
    if (election.rollFrozen) {
      throw new HttpError(409, 'roll is frozen; this election cannot be deleted', { code: 'ROLL_FROZEN' });
    }
    if (election.tally) {
      throw new HttpError(409, 'election already tallied', { code: 'TALLIED' });
    }
    if (election.createTxHash || election.onChainElectionAddress) {
      throw new HttpError(409, 'election was created on chain and cannot be deleted here', {
        code: 'ON_CHAIN',
      });
    }
    const idStr = String(election.id);
    const tied = (rows) =>
      Array.isArray(rows) && rows.some((row) => row && String(row.electionId) === idStr);
    if (
      Number(election.acceptedBallots) > 0 ||
      Number(election.participantCount) > 0 ||
      Number(election.eligibleCount) > 0 ||
      tied(this.data.registrations) ||
      tied(this.data.votes) ||
      tied(this.data.disqualifications) ||
      tied(this.data.registrationRequests) ||
      tied(this.data.envelopes) ||
      tied(this.data.receipts) ||
      tied(this.data.identityLinks) ||
      tied(this.data.externalParties)
    ) {
      throw new HttpError(409, 'election already has a roll or ballots', { code: 'NOT_EMPTY' });
    }
    this.data.elections = this.data.elections.filter((row) => String(row.id) !== idStr);
    if (Array.isArray(this.data.tallyGuardians)) {
      this.data.tallyGuardians = this.data.tallyGuardians.filter((row) => String(row.electionId) !== idStr);
    }
    await this.persist();
    return { id: idStr, title };
  }

  async freezeElection(id) {
    const election = this.requireElection(id);
    if (election.rollFrozen) throw new HttpError(409, 'roll already frozen');
    this.rebuildEligibleTree(election);
    this.rebuildDisqualificationTree(election);
    election.rollFrozen = true;
    election.frozenAt = new Date().toISOString();
    election.frozenEligibleRoot = election.eligibleRoot;
    election.frozenDisqualificationRoot = election.disqualificationRoot;
    await this.persist();
    return election;
  }

  isRegistered(electionId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    return this.data.registrations.some(
      (r) => String(r.electionId) === String(electionId) && r.identityCommitment === key,
    );
  }

  async registerCommitment(electionId, identityCommitment, { userId, persist = true } = {}) {
    this.refuseIfStandby();
    const election = this.requireElection(electionId);
    if (election.rollFrozen) {
      throw new HttpError(409, 'roll is frozen', { code: 'ROLL_FROZEN' });
    }
    if (election.tally) throw new HttpError(409, 'election already tallied');
    const key = toBytes32(identityCommitment);
    if (this.isRegistered(electionId, key)) {
      throw new HttpError(409, 'already registered', { code: 'DUPLICATE_COMMITMENT' });
    }
    if (election.maxParticipants !== 0 && election.participantCount >= election.maxParticipants) {
      throw new HttpError(409, 'participant cap reached', { code: 'CAP' });
    }
    const leafIndex = election.participantCount;
    election.participantCount += 1;
    this.data.registrations.push({
      electionId: String(election.id),
      identityCommitment: key,
      leafIndex,
      registeredAt: new Date().toISOString(),
    });
    if (userId) {
      const already = this.data.identityLinks.some(
        (l) => l.userId === userId && String(l.electionId) === String(election.id),
      );
      if (!already) {
        this.data.identityLinks.push({
          userId,
          electionId: String(election.id),
          identityCommitment: key,
          createdAt: new Date().toISOString(),
        });
      }
    }
    this.appendEligibleLeaf(election, key);
    const eligibleLeafIndex = election.eligibleTree.leaves.indexOf(key);
    if (persist) await this.persist();
    return {
      election,
      leafIndex: eligibleLeafIndex >= 0 ? eligibleLeafIndex : leafIndex,
      identityCommitment: key,
      eligibleRoot: election.eligibleRoot,
    };
  }

  findLink(electionId, userId) {
    return (
      this.data.identityLinks.find(
        (l) => !isSoftDeleted(l) && l.userId === userId && String(l.electionId) === String(electionId),
      ) || null
    );
  }

  findUserIdForCommitment(electionId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    const link = this.data.identityLinks.find(
      (l) => !isSoftDeleted(l) && String(l.electionId) === String(electionId) && l.identityCommitment === key,
    );
    return link?.userId || null;
  }

  isDisqualified(electionId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    const rec = this.data.disqualifications.find(
      (d) =>
        String(d.electionId) === String(electionId) &&
        d.identityCommitment === key &&
        !d.revokedAt,
    );
    return rec || null;
  }

  isEligible(electionId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    return this.isRegistered(electionId, key) && !this.isDisqualified(electionId, key);
  }

  listEligibleRegistrations(electionId) {
    return this.listRegistrations(electionId).filter(
      (r) => !this.isDisqualified(electionId, r.identityCommitment),
    );
  }

  /**
   * Node eligible set: registered ∩ ¬currently-disqualified, in registration order.
   * Incremental Merkle trees cannot delete; disqualify/revoke rebuild this tree.
   * A new registration appends one leaf when the in-memory tree already matches
   * that set; any mismatch falls back to the same full rebuild.
   */
  appendEligibleLeaf(election, identityCommitment) {
    const key = toBytes32(identityCommitment);
    const eligible = this.listEligibleRegistrations(election.id);
    const tree = election.eligibleTree;
    const prior = eligible.slice(0, -1);
    const matches =
      tree &&
      Array.isArray(tree.leaves) &&
      Number(tree.depth) === Number(election.treeDepth) &&
      eligible.length === tree.leaves.length + 1 &&
      eligible[eligible.length - 1]?.identityCommitment === key &&
      prior.length === tree.leaves.length &&
      prior.every((row, index) => row.identityCommitment === tree.leaves[index]);
    if (!matches) {
      this.rebuildEligibleTree(election);
      return;
    }
    insertLeaf(tree, key);
    election.eligibleRoot = tree.root;
    election.eligibleCount = tree.leaves.length;
  }

  rebuildEligibleTree(election) {
    const tree = emptyTree(election.treeDepth);
    for (const r of this.listEligibleRegistrations(election.id)) {
      insertLeaf(tree, r.identityCommitment);
    }
    election.eligibleTree = tree;
    election.eligibleRoot = tree.root;
    election.eligibleCount = tree.leaves.length;
    return tree;
  }

  /**
   * Indexed chain of currently-disqualified commitments (keccak-dev-v1).
   * Same shape the vote circuit proves against, under Poseidon when the
   * proving path is on. Revoked rows are omitted, so the root is not an
   * append-only event log.
   */
  rebuildDisqualificationTree(election) {
    const commitments = [];
    for (const d of this.data.disqualifications) {
      if (String(d.electionId) !== String(election.id) || d.revokedAt) continue;
      commitments.push(d.identityCommitment);
    }
    const tree = disqualificationTree(election.treeDepth, commitments);
    election.disqualificationTree = tree;
    election.disqualificationRoot = tree.root;
  }

  rebuildAllEligibility() {
    for (const election of this.data.elections) {
      if (!Number.isInteger(Number(election.treeDepth))) continue;
      this.rebuildDisqualificationTree(election);
      this.rebuildEligibleTree(election);
      if (election.rollFrozen) {
        if (!election.frozenEligibleRoot) election.frozenEligibleRoot = election.eligibleRoot;
        if (!election.frozenDisqualificationRoot) {
          election.frozenDisqualificationRoot = election.disqualificationRoot;
        }
      }
    }
  }

  votingRoots(election) {
    if (election.rollFrozen && !election.lateUpdateAllowed && election.frozenEligibleRoot) {
      return {
        eligibleRoot: election.frozenEligibleRoot,
        disqualificationRoot: election.frozenDisqualificationRoot || election.disqualificationRoot,
      };
    }
    return {
      eligibleRoot: election.eligibleRoot,
      disqualificationRoot: election.disqualificationRoot,
    };
  }

  /**
   * Roll helper: registered ∩ ¬currently-disqualified.
   * The published eligible root is that same intersection. The HTTP vote route
   * does not call this. The vote POST must not carry the leaf.
   */
  assertCanVote(electionId, identityCommitment) {
    if (identityCommitment == null || identityCommitment === '') {
      throw new HttpError(400, 'identityCommitment required for the roll check', {
        code: 'IDENTITY_COMMITMENT_REQUIRED',
      });
    }
    let key;
    try {
      key = toBytes32(identityCommitment);
    } catch {
      throw new HttpError(400, 'invalid identityCommitment', { code: 'INVALID_COMMITMENT' });
    }
    const dq = this.isDisqualified(electionId, key);
    if (dq) {
      throw new HttpError(403, 'identity is disqualified', {
        code: 'DISQUALIFIED',
        reasonCode: dq.reasonCode,
        reasonName: reasonName(dq.reasonCode),
      });
    }
    if (!this.isRegistered(electionId, key)) {
      throw new HttpError(403, 'identity is not registered', { code: 'NOT_REGISTERED' });
    }
  }

  listAdmins() {
    return this.data.users.filter(
      (u) => !isSoftDeleted(u) && (u.role === 'platform_admin' || u.role === 'platform_super_admin'),
    );
  }

  async approveAdmin({ userId, handle, contactEmail } = {}) {
    const user = this.resolveOfficerUser({ userId, handle });
    if (!user) throw new HttpError(404, 'user not found');
    if (user.role === 'platform_super_admin') {
      throw new HttpError(400, 'cannot change a platform super admin with this approval');
    }
    let email = null;
    if (contactEmail != null && String(contactEmail).trim() !== '') {
      email = normalizeEmail(contactEmail);
    }
    const created = user.role !== 'platform_admin';
    if (email) user.contactEmail = email;
    if (created) {
      user.role = 'platform_admin';
      user.approvedAsAdminAt = new Date().toISOString();
    }
    if (email || created) await this.persist();
    return { user, created };
  }

  async revokeAdmin({ userId, handle } = {}) {
    const user = this.resolveOfficerUser({ userId, handle });
    if (!user) throw new HttpError(404, 'user not found');
    if (user.role === 'platform_super_admin') {
      throw new HttpError(400, 'cannot revoke the platform super admin');
    }
    if (user.role !== 'platform_admin') {
      throw new HttpError(404, 'platform admin grant not found');
    }
    user.role = 'voter';
    user.approvedAsAdminAt = null;
    await this.persist();
    return user;
  }

  userIsElectionStaff(user, election) {
    if (!user || !election) return false;
    if (isPlatformOperator(user)) return true;
    if (this.userHasJurisdictionRole(user, ['election_staff', 'clerk'], election.jurisdictionId)) {
      return true;
    }
    return (election.staff || []).some((grant) => this.officerMatchesUser(grant, user));
  }

  listElectionStaff(election) {
    const out = [];
    const seen = new Set();
    const push = (row) => {
      const key = `${row.userId || ''}::${row.handle || ''}::${row.address || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(row);
    };
    for (const grant of election.staff || []) {
      push({
        electionId: String(election.id),
        jurisdictionId: election.jurisdictionId,
        role: 'election_staff',
        source: 'election',
        ...grant,
      });
    }
    const jurisdiction = this.getJurisdiction(election.jurisdictionId);
    for (const grant of jurisdiction?.officers || []) {
      if (grant.role === 'election_staff' || grant.role === 'clerk') {
        push({
          electionId: String(election.id),
          jurisdictionId: election.jurisdictionId,
          role: grant.role,
          source: 'jurisdiction',
          ...grant,
        });
      }
    }
    return out;
  }

  async approveElectionStaff(electionId, { address, handle, userId, contactEmail } = {}) {
    const election = this.requireElection(electionId);
    const trimmedHandle = String(handle || '').trim();
    const trimmedAddress = String(address || '').trim();
    const trimmedUserId = String(userId || '').trim();
    if (!trimmedHandle && !trimmedAddress && !trimmedUserId) {
      throw new HttpError(400, 'handle, userId, or address required');
    }
    const user = this.resolveOfficerUser({
      userId: trimmedUserId,
      handle: trimmedHandle,
      address: trimmedAddress,
    });
    if (user && contactEmail) user.contactEmail = normalizeEmail(contactEmail);
    election.staff = election.staff || [];
    const exists = election.staff.some(
      (grant) =>
        (user && this.officerMatchesUser(grant, user)) ||
        (trimmedUserId && grant.userId === trimmedUserId) ||
        (trimmedHandle &&
          String(grant.handle || '').trim().toLowerCase() === trimmedHandle.toLowerCase()),
    );
    if (exists) {
      if (user && contactEmail) await this.persist();
      return { election, staff: election.staff, user, created: false };
    }
    election.staff.push({
      userId: user?.id || trimmedUserId || '',
      handle: user?.handle || trimmedHandle,
      address: trimmedAddress || user?.activeEthAddress || '',
      role: 'election_staff',
      grantedAt: new Date().toISOString(),
    });
    await this.persist();
    return { election, staff: election.staff, user, created: true };
  }

  async revokeElectionStaff(electionId, { address, handle, userId } = {}) {
    const election = this.requireElection(electionId);
    const trimmedHandle = String(handle || '').trim();
    const trimmedAddress = String(address || '').trim();
    const trimmedUserId = String(userId || '').trim();
    const user = this.resolveOfficerUser({
      userId: trimmedUserId,
      handle: trimmedHandle,
      address: trimmedAddress,
    });
    const before = election.staff || [];
    const next = before.filter((grant) => {
      if (user && this.officerMatchesUser(grant, user)) return false;
      if (trimmedUserId && grant.userId === trimmedUserId) return false;
      if (
        trimmedHandle &&
        String(grant.handle || '').trim().toLowerCase() === trimmedHandle.toLowerCase()
      ) {
        return false;
      }
      if (
        trimmedAddress &&
        String(grant.address || '').trim().toLowerCase() === trimmedAddress.toLowerCase()
      ) {
        return false;
      }
      return true;
    });
    if (next.length === before.length) {
      throw new HttpError(404, 'election staff grant not found');
    }
    election.staff = next;
    await this.persist();
    return { election, user };
  }

  listElectionRolesForUser(user) {
    if (!user) return [];
    if (isPlatformOperator(user)) return [];
    const out = [];
    for (const election of this.data.elections) {
      if (!this.userIsElectionStaff(user, election)) continue;
      const onElection = (election.staff || []).some((g) => this.officerMatchesUser(g, user));
      out.push({
        electionId: String(election.id),
        title: election.title,
        role: 'election_staff',
        source: onElection ? 'election' : 'jurisdiction',
      });
    }
    return out;
  }

  listExternalParties(electionId, { includeEndpoint = false } = {}) {
    const id = String(this.requireElection(electionId).id);
    return (this.data.externalParties || [])
      .filter((p) => String(p.electionId) === id)
      .map((p) => this.presentExternalParty(p, { includeEndpoint }));
  }

  listActiveExternalParties(electionId) {
    const id = String(this.requireElection(electionId).id);
    return (this.data.externalParties || []).filter(
      (p) => String(p.electionId) === id && p.status === 'active',
    );
  }

  presentExternalParty(party, { includeEndpoint = false } = {}) {
    if (!party) return null;
    const row = {
      id: party.id,
      electionId: party.electionId,
      name: party.name,
      metadataURI: party.metadataURI || '',
      mode: party.mode,
      status: party.status,
      operatorHandle: party.operatorHandle || '',
      operatorUserId: party.operatorUserId || '',
      operatorAddress: party.operatorAddress || '',
      createdAt: party.createdAt,
    };
    if (includeEndpoint) {
      row.endpointUrl = party.endpointUrl || '';
      row.endpointTimeoutMs = party.endpointTimeoutMs || 2500;
    }
    return row;
  }

  getExternalParty(electionId, partyId) {
    const id = String(this.requireElection(electionId).id);
    return (
      (this.data.externalParties || []).find(
        (p) => String(p.electionId) === id && p.id === partyId,
      ) || null
    );
  }

  requireExternalParty(electionId, partyId) {
    const party = this.getExternalParty(electionId, partyId);
    if (!party) throw new HttpError(404, 'external party not found');
    return party;
  }

  userOperatesParty(user, party) {
    if (!user || !party) return false;
    if (party.operatorUserId && party.operatorUserId === user.id) return true;
    const handle = String(user.handle || '').trim().toLowerCase();
    if (handle && String(party.operatorHandle || '').trim().toLowerCase() === handle) return true;
    if (party.operatorAddress && sameEthAddress(user.activeEthAddress, party.operatorAddress)) {
      return true;
    }
    return false;
  }

  async addExternalParty(electionId, input = {}) {
    const election = this.requireElection(electionId);
    const name = String(input.name || '').trim();
    if (!name) throw new HttpError(400, 'name required');
    const mode = String(input.mode || 'veto').trim();
    if (mode !== 'veto' && mode !== 'must_attest') {
      throw new HttpError(400, 'mode must be veto or must_attest');
    }
    const operatorHandle = String(input.operatorHandle || input.handle || '').trim();
    const operatorUserId = String(input.operatorUserId || input.userId || '').trim();
    const operatorAddress = String(input.operatorAddress || input.address || '').trim();
    const operator = this.resolveOfficerUser({
      userId: operatorUserId,
      handle: operatorHandle,
      address: operatorAddress,
    });
    if (!operator && !operatorHandle && !operatorAddress && !operatorUserId) {
      throw new HttpError(400, 'operator handle, userId, or address required');
    }
    const endpointUrl = String(input.endpointUrl || '').trim();
    if (endpointUrl && !/^https?:\/\//i.test(endpointUrl)) {
      throw new HttpError(400, 'endpointUrl must be http(s)');
    }
    const party = {
      id: randomUUID(),
      electionId: String(election.id),
      name,
      metadataURI: String(input.metadataURI || ''),
      mode,
      status: input.status === 'paused' ? 'paused' : 'active',
      operatorUserId: operator?.id || operatorUserId || '',
      operatorHandle: operator?.handle || operatorHandle,
      operatorAddress: operatorAddress || operator?.activeEthAddress || '',
      endpointUrl,
      endpointTimeoutMs: Number(input.endpointTimeoutMs) || 2500,
      createdBy: input.createdBy || null,
      createdAt: new Date().toISOString(),
    };
    this.data.externalParties.push(party);
    await this.persist();
    return { election, party };
  }

  async setExternalPartyStatus(electionId, partyId, status) {
    const party = this.requireExternalParty(electionId, partyId);
    if (status !== 'active' && status !== 'paused') {
      throw new HttpError(400, 'status must be active or paused');
    }
    party.status = status;
    await this.persist();
    return party;
  }

  activePartyRejection(electionId, partyId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    const id = String(this.requireElection(electionId).id);
    return (
      (this.data.partyRejections || []).find(
        (r) =>
          String(r.electionId) === id &&
          r.partyId === partyId &&
          r.identityCommitment === key &&
          !r.revokedAt,
      ) || null
    );
  }

  activePartyAttestation(electionId, partyId, identityCommitment, now) {
    const key = toBytes32(identityCommitment);
    const id = String(this.requireElection(electionId).id);
    const rec = (this.data.partyAttestations || []).find(
      (a) =>
        String(a.electionId) === id &&
        a.partyId === partyId &&
        a.identityCommitment === key &&
        !a.revokedAt,
    );
    if (!rec) return null;
    if (rec.expiresAt && Number(rec.expiresAt) > 0 && Number(rec.expiresAt) < Number(now)) {
      return null;
    }
    return rec;
  }

  async recordPartyRejection(electionId, partyId, { identityCommitment, reasonCode, evidenceHash, issuer }) {
    const election = this.requireElection(electionId);
    const party = this.requireExternalParty(election.id, partyId);
    if (party.status !== 'active') throw new HttpError(409, 'party is paused');
    if (!isValidReasonCode(reasonCode)) throw new HttpError(400, 'invalid reasonCode');
    const key = toBytes32(identityCommitment);
    if (this.activePartyRejection(election.id, party.id, key)) {
      throw new HttpError(409, 'already rejected by this party');
    }
    const record = {
      id: randomUUID(),
      electionId: String(election.id),
      partyId: party.id,
      identityCommitment: key,
      reasonCode: Number(reasonCode),
      evidenceHash: evidenceHash ? toBytes32(evidenceHash) : toBytes32(0),
      issuer: issuer || party.operatorHandle || 'external-party',
      issuedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.data.partyRejections.push(record);
    await this.persist();
    return { election, party, record };
  }

  async clearPartyRejection(electionId, partyId, { identityCommitment, evidenceHash, issuer }) {
    const election = this.requireElection(electionId);
    const party = this.requireExternalParty(election.id, partyId);
    const rec = this.activePartyRejection(election.id, party.id, identityCommitment);
    if (!rec) throw new HttpError(404, 'party rejection not found');
    rec.revokedAt = new Date().toISOString();
    rec.revokeEvidenceHash = evidenceHash ? toBytes32(evidenceHash) : toBytes32(0);
    rec.revokedBy = issuer || 'external-party';
    await this.persist();
    return { election, party, record: rec };
  }

  async recordPartyAttestation(
    electionId,
    partyId,
    { identityCommitment, expiresAt, evidenceHash, issuer },
  ) {
    const election = this.requireElection(electionId);
    const party = this.requireExternalParty(election.id, partyId);
    if (party.status !== 'active') throw new HttpError(409, 'party is paused');
    if (party.mode !== 'must_attest') {
      throw new HttpError(400, 'party is veto-only; attest does not apply');
    }
    const key = toBytes32(identityCommitment);
    const existing = (this.data.partyAttestations || []).find(
      (a) =>
        String(a.electionId) === String(election.id) &&
        a.partyId === party.id &&
        a.identityCommitment === key &&
        !a.revokedAt,
    );
    if (existing) {
      existing.expiresAt = expiresAt == null || expiresAt === '' ? 0 : Number(expiresAt);
      existing.evidenceHash = evidenceHash ? toBytes32(evidenceHash) : existing.evidenceHash;
      existing.issuer = issuer || existing.issuer;
      existing.issuedAt = new Date().toISOString();
      await this.persist();
      return { election, party, record: existing };
    }
    const record = {
      id: randomUUID(),
      electionId: String(election.id),
      partyId: party.id,
      identityCommitment: key,
      expiresAt: expiresAt == null || expiresAt === '' ? 0 : Number(expiresAt),
      evidenceHash: evidenceHash ? toBytes32(evidenceHash) : toBytes32(0),
      issuer: issuer || party.operatorHandle || 'external-party',
      issuedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.data.partyAttestations.push(record);
    await this.persist();
    return { election, party, record };
  }

  listPartyRejections(electionId, partyId) {
    const id = String(this.requireElection(electionId).id);
    return (this.data.partyRejections || []).filter(
      (r) => String(r.electionId) === id && (!partyId || r.partyId === partyId) && !r.revokedAt,
    );
  }

  async disqualify(electionId, { identityCommitment, reasonCode, evidenceHash, issuer }) {
    this.refuseIfStandby();
    const election = this.requireElection(electionId);
    if (election.rollFrozen && !election.lateUpdateAllowed) {
      throw new HttpError(409, 'roll frozen; late disqualification not allowed', {
        code: 'ROLL_FROZEN',
      });
    }
    if (!isValidReasonCode(reasonCode)) {
      throw new HttpError(400, 'invalid reasonCode');
    }
    const key = toBytes32(identityCommitment);
    if (this.isDisqualified(election.id, key)) {
      throw new HttpError(409, 'already disqualified');
    }
    const record = {
      electionId: String(election.id),
      identityCommitment: key,
      reasonCode: Number(reasonCode),
      evidenceHash: evidenceHash ? toBytes32(evidenceHash) : toBytes32(0),
      issuer: issuer || 'node',
      issuedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.data.disqualifications.push(record);
    this.rebuildDisqualificationTree(election);
    this.rebuildEligibleTree(election);
    await this.persist();
    return { election, record };
  }

  async revokeDisqualification(electionId, { identityCommitment, evidenceHash, issuer }) {
    const election = this.requireElection(electionId);
    if (election.rollFrozen && !election.lateUpdateAllowed) {
      throw new HttpError(409, 'roll frozen; late revoke not allowed', { code: 'ROLL_FROZEN' });
    }
    const key = toBytes32(identityCommitment);
    const rec = this.data.disqualifications.find(
      (d) =>
        String(d.electionId) === String(election.id) &&
        d.identityCommitment === key &&
        !d.revokedAt,
    );
    if (!rec) throw new HttpError(404, 'disqualification not found');
    rec.revokedAt = new Date().toISOString();
    rec.revokeEvidenceHash = evidenceHash ? toBytes32(evidenceHash) : toBytes32(0);
    rec.revokedBy = issuer || 'node';
    this.rebuildDisqualificationTree(election);
    this.rebuildEligibleTree(election);
    await this.persist();
    return { election, record: rec };
  }

  nullifierUsed(electionId, nullifier) {
    return Boolean(this.findVote(electionId, nullifier));
  }

  findVote(electionId, nullifier) {
    const key = toBytes32(nullifier);
    return (
      this.data.votes.find(
        (v) => !isSoftDeleted(v) && String(v.electionId) === String(electionId) && toBytes32(v.nullifier) === key,
      ) || null
    );
  }

  findReceiptByTokenHash(tokenHash) {
    if (!tokenHash) return null;
    const key = String(tokenHash).toLowerCase();
    return (this.data.receipts || []).find((r) => !isSoftDeleted(r) && String(r.tokenHash || '').toLowerCase() === key) || null;
  }

  findReceiptForVote(electionId, nullifier) {
    const key = toBytes32(nullifier);
    return (
      (this.data.receipts || []).find(
        (r) => !isSoftDeleted(r) && String(r.electionId) === String(electionId) && toBytes32(r.nullifier) === key,
      ) || null
    );
  }

  /** Kept for API compatibility. Records nothing: no email hint, no send time. */
  async markReceiptEmailed(id) {
    const rec = (this.data.receipts || []).find((r) => r.id === id);
    if (!rec) return null;
    return rec;
  }

  findReceiptByPdfSha256(pdfSha256) {
    const key = String(pdfSha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    return (this.data.receipts || []).find((r) => !isSoftDeleted(r) && String(r.pdfSha256 || '').toLowerCase() === key) || null;
  }

  async markReceiptPdfIssued(id, { pdfSha256, pdfProtected = true, pdfIntegrity = null } = {}) {
    const rec = (this.data.receipts || []).find((r) => r.id === id);
    if (!rec) return null;
    const hash = String(pdfSha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new HttpError(500, 'receipt PDF fingerprint missing', { code: 'RECEIPT_PDF_DRIFT' });
    }
    if (rec.pdfSha256 && String(rec.pdfSha256).toLowerCase() !== hash) {
      throw new HttpError(500, 'receipt PDF fingerprint changed', { code: 'RECEIPT_PDF_DRIFT' });
    }
    rec.pdfSha256 = hash;
    rec.pdfProtected = Boolean(pdfProtected);
    if (pdfIntegrity) rec.pdfIntegrity = String(pdfIntegrity);
    await this.persist();
    return rec;
  }

  /**
   * Persist an accepted vote. Internally { nullifier, ballotHash, electionId,
   * relayer, acceptedAt }. Public dashboards never see acceptedAt or a live count;
   * they wait for hourly disclosure. No passkey user id, no choice.
   *
   * One ballot per nullifier: any second submit (including a new ciphertext)
   * is 409 NULLIFIER_USED. Double voting is impossible.
   */
  async acceptVote(vote, envelope) {
    this.refuseIfStandby();
    const existing = this.findVote(vote.electionId, vote.nullifier);
    if (existing) {
      throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
    }
    const spentPassHash = vote.spentPassHash ? String(vote.spentPassHash).toLowerCase() : null;
    if (spentPassHash && this.votePassSpent(vote.electionId, spentPassHash)) {
      throw new HttpError(409, 'vote pass already used', { code: 'VOTE_PASS_SPENT' });
    }
    // relay.relayVote passes a bucket-coarsened time (coarseAcceptedAt); the
    // fallback is coarsened to the hour here too.
    const acceptedAt = Number.isFinite(Number(vote.acceptedAt))
      ? Math.floor(Number(vote.acceptedAt))
      : Math.floor(Date.now() / 3600000) * 3600;
    const ballotHash = toBytes32(vote.ballotHash);
    let pdfSha256 = null;
    if (vote.pdfSha256) {
      pdfSha256 = String(vote.pdfSha256).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pdfSha256)) {
        throw new HttpError(500, 'receipt PDF fingerprint missing', { code: 'RECEIPT_PDF_DRIFT' });
      }
    }
    const record = {
      nullifier: toBytes32(vote.nullifier),
      ballotHash,
      electionId: String(vote.electionId),
      relayer: vote.relayer || 'node',
      acceptedAt,
    };
    // Each collection gets its own random insert position, so array order (and
    // the zkv_rows `pos` column) is not arrival order and the three rows of
    // one ballot do not share an index. No userOpHash, no email fields.
    insertAtRandom(this.data.votes, record);
    if (vote.receiptTokenHash) {
      if (!Array.isArray(this.data.receipts)) this.data.receipts = [];
      insertAtRandom(this.data.receipts, {
        id: randomUUID(),
        electionId: record.electionId,
        nullifier: record.nullifier,
        ballotHash: record.ballotHash,
        tokenHash: String(vote.receiptTokenHash),
        acceptedAt,
        pdfSha256,
        pdfProtected: true,
        pdfIntegrity: vote.pdfIntegrity ? String(vote.pdfIntegrity) : null,
      });
    }
    if (envelope) {
      insertAtRandom(this.data.envelopes, {
        electionId: record.electionId,
        nullifier: record.nullifier,
        ballotHash: record.ballotHash,
        encryptedBallot: envelope.encryptedBallot,
        ...(Array.isArray(envelope.rankingPayload) ? { rankingPayload: envelope.rankingPayload } : {}),
      });
    }
    if (spentPassHash) {
      const key = String(vote.electionId);
      const list = Array.isArray(this.data.votePassSpent[key]) ? this.data.votePassSpent[key] : [];
      list.push(spentPassHash);
      list.sort();
      this.data.votePassSpent[key] = list;
    }
    const election = this.requireElection(vote.electionId);
    election.acceptedBallots += 1;
    await this.persist();
    return record;
  }

  /**
   * Undo one acceptVote that never made it onto the queue. Removes that
   * ballot's vote, receipt, and envelope, unspends its vote pass, and
   * decrements the counter. A published explorer block is left alone.
   */
  async revertAcceptedVote({ electionId, nullifier, spentPassHash = null } = {}) {
    this.refuseIfStandby();
    const key = toBytes32(nullifier);
    const electionKey = String(electionId);
    const keepVote = (row) =>
      isSoftDeleted(row) || String(row?.electionId) !== electionKey || toBytes32(row?.nullifier) !== key;
    const before = this.data.votes.length;
    this.data.votes = this.data.votes.filter(keepVote);
    const removed = before - this.data.votes.length;
    if (!removed) return false;
    this.data.receipts = (this.data.receipts || []).filter(keepVote);
    this.data.envelopes = (this.data.envelopes || []).filter(
      (row) => String(row?.electionId) !== electionKey || toBytes32(row?.nullifier) !== key,
    );
    if (spentPassHash) {
      const hash = String(spentPassHash).toLowerCase();
      const list = this.data.votePassSpent?.[electionKey];
      if (Array.isArray(list)) this.data.votePassSpent[electionKey] = list.filter((item) => item !== hash);
    }
    const election = this.getElection(electionId);
    if (election) election.acceptedBallots = Math.max(0, Number(election.acceptedBallots || 0) - removed);
    await this.persist();
    return true;
  }

  votePassSpent(electionId, hash) {
    const list = this.data.votePassSpent?.[String(electionId)];
    return Array.isArray(list) && list.includes(String(hash).toLowerCase());
  }

  listVotes(electionId) {
    return this.data.votes.filter((v) => !isSoftDeleted(v) && String(v.electionId) === String(electionId));
  }

  /**
   * Votes whose accept is past the disclosure horizon. Each nullifier appears
   * at most once.
   */
  listPublishedVotes(electionId, now, intervalSeconds, policy = null) {
    const election = this.getElection(electionId);
    const votes = this.listVotes(electionId);
    const base = policy && typeof policy === 'object' ? policy : {};
    // Choice sealing must not suppress the hourly ballot rows.
    const resolved = {
      now,
      intervalSeconds: base.intervalSeconds ?? intervalSeconds,
      delaySeconds: base.delaySeconds || 0,
      minBlockVotes: base.minBlockVotes ?? 1,
      minVotes: base.minVotes ?? 0,
      endTime: base.endTime ?? election?.cutoffTime ?? null,
      tallied: Boolean(base.tallied),
      submittedVotes: base.submittedVotes ?? votes.length,
      resultsSealed: false,
    };
    return selectPublicVotes(votes, resolved);
  }

  publishedAcceptedBallots(electionId, now, intervalSeconds, policy = null) {
    return this.listPublishedVotes(electionId, now, intervalSeconds, policy).length;
  }

  publishedAcceptedBallotsAll(now, intervalOrConfig) {
    if (intervalOrConfig && typeof intervalOrConfig === 'object') {
      const ids = new Set((this.data.votes || []).filter((v) => !isSoftDeleted(v)).map((v) => String(v.electionId)));
      let n = 0;
      for (const id of ids) {
        const election = this.getElection(id);
        const policy = electionDisclosurePolicy(election, intervalOrConfig, now);
        n += this.publishedAcceptedBallots(id, now, policy.intervalSeconds, policy);
      }
      return n;
    }
    return this.data.votes.filter((v) => {
      if (!v || isSoftDeleted(v)) return false;
      return isDisclosed(v.acceptedAt, now, intervalOrConfig);
    }).length;
  }

  listEnvelopes(electionId, { includeDeleted = false } = {}) {
    return this.data.envelopes.filter(
      (e) => String(e.electionId) === String(electionId) && (includeDeleted || !isSoftDeleted(e)),
    );
  }

  canApproveRegistration(user, election) {
    if (!user || !election) return false;
    return this.userHasJurisdictionRole(user, ['registrar', 'clerk'], election.jurisdictionId);
  }

  publicRegistrationRequest(request) {
    if (!request) return null;
    const user = this.getUser(request.userId);
    return {
      id: request.id,
      electionId: String(request.electionId),
      userId: request.userId,
      handle: user?.handle || null,
      identityCommitment: request.identityCommitment,
      status: request.status,
      note: request.note || null,
      requestedAt: request.requestedAt,
      reviewedAt: request.reviewedAt || null,
      reviewedBy: request.reviewedBy || null,
      denyReason: request.denyReason || null,
      credentials: user
        ? (user.authMethods || [])
            .filter((m) => isCredentialMethodType(m.type))
            .map((m) => publicCredential(m, { officer: true }))
        : [],
      ethAccounts: user ? publicIdentity(user).ethAccounts : [],
    };
  }

  listRegistrationRequests(electionId, { status } = {}) {
    const id = String(electionId);
    return this.data.registrationRequests
      .filter((r) => !isSoftDeleted(r) && String(r.electionId) === id && (!status || r.status === status))
      .map((r) => this.publicRegistrationRequest(r));
  }

  getRegistrationRequest(electionId, requestId) {
    const rec = this.data.registrationRequests.find(
      (r) => !isSoftDeleted(r) && String(r.electionId) === String(electionId) && r.id === String(requestId),
    );
    return rec || null;
  }

  findPendingRequestForUser(electionId, userId) {
    return (
      this.data.registrationRequests.find(
        (r) =>
          !isSoftDeleted(r) &&
          String(r.electionId) === String(electionId) &&
          r.userId === userId &&
          r.status === 'pending',
      ) || null
    );
  }

  findPendingRequestForCommitment(electionId, identityCommitment) {
    let key;
    try {
      key = toBytes32(identityCommitment);
    } catch {
      return null;
    }
    return (
      this.data.registrationRequests.find(
        (r) =>
          !isSoftDeleted(r) &&
          String(r.electionId) === String(electionId) &&
          r.identityCommitment === key &&
          r.status === 'pending',
      ) || null
    );
  }

  async createRegistrationRequest(electionId, { userId, identityCommitment, note } = {}) {
    const election = this.requireElection(electionId);
    if (election.rollFrozen) {
      throw new HttpError(409, 'roll is frozen', { code: 'ROLL_FROZEN' });
    }
    if (election.tally) throw new HttpError(409, 'election already tallied');
    if (!userId) throw new HttpError(400, 'userId required');
    const key = toBytes32(identityCommitment);
    if (this.isRegistered(election.id, key)) {
      throw new HttpError(409, 'already registered', { code: 'DUPLICATE_COMMITMENT' });
    }
    if (this.findLink(election.id, userId)) {
      throw new HttpError(409, 'already registered for this election', { code: 'ALREADY_REGISTERED' });
    }
    const pendingSameUser = this.findPendingRequestForUser(election.id, userId);
    if (pendingSameUser) {
      throw new HttpError(409, 'registration already pending civil review', {
        code: 'REQUEST_PENDING',
        requestId: pendingSameUser.id,
      });
    }
    const pendingSameLeaf = this.findPendingRequestForCommitment(election.id, key);
    if (pendingSameLeaf && pendingSameLeaf.userId !== userId) {
      throw new HttpError(409, 'this identity commitment is already pending for another person', {
        code: 'COMMITMENT_PENDING',
      });
    }
    if (pendingSameLeaf) {
      return { election, request: pendingSameLeaf, created: false };
    }
    const request = {
      id: randomUUID(),
      electionId: String(election.id),
      userId,
      identityCommitment: key,
      status: 'pending',
      note: note ? String(note).slice(0, 500) : null,
      requestedAt: new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
      denyReason: null,
    };
    this.data.registrationRequests.push(request);
    await this.persist();
    return { election, request, created: true };
  }

  async approveRegistrationRequest(electionId, requestId, { reviewer } = {}) {
    const election = this.requireElection(electionId);
    const request = this.getRegistrationRequest(election.id, requestId);
    if (!request) throw new HttpError(404, 'registration request not found');
    if (request.status === 'approved') {
      const row = this.listRegistrations(election.id).find(
        (r) => r.identityCommitment === request.identityCommitment,
      );
      return {
        election,
        request,
        alreadyApproved: true,
        identityCommitment: request.identityCommitment,
        leafIndex: row?.leafIndex ?? null,
        eligibleRoot: election.eligibleRoot,
      };
    }
    if (request.status !== 'pending') {
      throw new HttpError(409, 'registration request is not pending', {
        code: 'REQUEST_NOT_PENDING',
        status: request.status,
      });
    }
    const result = await this.registerCommitment(election.id, request.identityCommitment, {
      userId: request.userId,
      persist: false,
    });
    request.status = 'approved';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = reviewer?.id || reviewer?.handle || null;
    await this.persist();
    return { ...result, request };
  }

  async denyRegistrationRequest(electionId, requestId, { reviewer, reason } = {}) {
    const election = this.requireElection(electionId);
    const request = this.getRegistrationRequest(election.id, requestId);
    if (!request) throw new HttpError(404, 'registration request not found');
    if (request.status !== 'pending') {
      throw new HttpError(409, 'registration request is not pending', {
        code: 'REQUEST_NOT_PENDING',
        status: request.status,
      });
    }
    request.status = 'denied';
    request.reviewedAt = new Date().toISOString();
    request.reviewedBy = reviewer?.id || reviewer?.handle || null;
    request.denyReason = reason ? String(reason).slice(0, 500) : 'DENIED';
    await this.persist();
    return { election, request };
  }

  getAuthMethod(userId, methodId) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const method = (user.authMethods || []).find((m) => m.id === String(methodId));
    if (!method) throw new HttpError(404, 'credential not found', { code: 'CREDENTIAL_NOT_FOUND' });
    return { user, method };
  }

  async reviewCredential(userId, methodId, patch, actor) {
    const { user, method } = this.getAuthMethod(userId, methodId);
    if (!isCredentialMethodType(method.type)) {
      throw new HttpError(400, 'only smart cards and civic IDs can be reviewed this way');
    }
    applyCredentialReview(method, patch, actor);
    await this.persist();
    return { user, method };
  }

  listOfficeCredentials({ type, status } = {}) {
    const out = [];
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      ensurePersonFields(user);
      for (const method of user.authMethods || []) {
        if (!isCredentialMethodType(method.type)) continue;
        if (type && method.type !== type) continue;
        const pub = publicCredential(method, { officer: true });
        if (status && pub.status !== status) continue;
        out.push({
          ...pub,
          personId: user.id,
          handle: user.handle,
        });
      }
    }
    out.sort((a, b) => String(a.handle || '').localeCompare(String(b.handle || '')));
    return out;
  }

  findCredentialBySelector({ methodId, civicIdHash, fingerprint, personId } = {}) {
    const wantMethod = methodId ? String(methodId) : '';
    const wantCivic = civicIdHash ? String(civicIdHash).toLowerCase() : '';
    const wantFp = fingerprint ? String(fingerprint).toLowerCase() : '';
    for (const user of this.data.users) {
      if (isSoftDeleted(user)) continue;
      if (personId && user.id !== personId) continue;
      ensurePersonFields(user);
      for (const method of user.authMethods || []) {
        if (!isCredentialMethodType(method.type)) continue;
        if (wantMethod && method.id === wantMethod) return { user, method };
        if (
          wantCivic &&
          String(method.civicIdHash || method.fingerprint || '').toLowerCase() === wantCivic
        ) {
          return { user, method };
        }
        if (wantFp && String(method.fingerprint || '').toLowerCase() === wantFp) {
          return { user, method };
        }
      }
    }
    return null;
  }

  listRegistrations(electionId) {
    return this.data.registrations.filter((r) => String(r.electionId) === String(electionId));
  }

  listDisqualifications(electionId) {
    return this.data.disqualifications.filter((d) => String(d.electionId) === String(electionId));
  }

  getTallyGuardian(electionId) {
    const list = this.data.tallyGuardians || [];
    return list.find((g) => String(g.electionId) === String(electionId)) || null;
  }

  guardianMaterial(electionId) {
    return this.getTallyGuardian(electionId);
  }

  async enrollGuardian(electionId, entry) {
    const election = this.requireElection(electionId);
    const ceremony = election.tallyCeremony;
    if (!ceremony || ceremony.scheme !== GUARDIAN_SCHEME) {
      throw new HttpError(400, 'election has no guardian ceremony', { code: 'NO_CEREMONY' });
    }
    if (ceremony.status !== 'awaiting_guardians') {
      throw new HttpError(409, 'guardian roster is closed', { code: 'ROSTER_CLOSED' });
    }
    const roster = ceremony.roster || [];
    const guardianId = String(entry.guardianId || '').trim();
    if (!guardianId || guardianId.length > 80) {
      throw new HttpError(400, 'guardianId is required', { code: 'BAD_GUARDIAN' });
    }
    if (roster.some((g) => g.guardianId === guardianId)) {
      throw new HttpError(409, 'guardian already enrolled', { code: 'DUPLICATE_GUARDIAN' });
    }
    roster.push({
      index: roster.length + 1,
      guardianId,
      label: String(entry.label || '').slice(0, 120),
      transportPublicKey: entry.transportPublicKey,
      commitments: null,
    });
    ceremony.roster = roster;
    if (roster.length === ceremony.guardians) ceremony.status = 'awaiting_deals';
    await this.persist();
    return roster[roster.length - 1];
  }

  async saveGuardianDeal(electionId, deal) {
    const election = this.requireElection(electionId);
    const ceremony = election.tallyCeremony;
    const bucket = this.getTallyGuardian(electionId);
    if (!ceremony || !bucket) {
      throw new HttpError(400, 'election has no guardian ceremony', { code: 'NO_CEREMONY' });
    }
    if (ceremony.status !== 'awaiting_deals' && ceremony.status !== 'ready') {
      throw new HttpError(409, 'deals are accepted after the roster is full', { code: 'ROSTER_OPEN' });
    }
    const index = Number(deal.index);
    const member = (ceremony.roster || []).find((g) => g.index === index);
    if (!member) throw new HttpError(400, 'unknown guardian index', { code: 'UNKNOWN_GUARDIAN' });
    if ((bucket.deals || []).some((row) => row.index === index)) {
      throw new HttpError(409, 'guardian already dealt', { code: 'DUPLICATE_DEAL' });
    }
    member.commitments = deal.commitments;
    bucket.deals.push({
      index,
      guardianId: member.guardianId,
      commitments: deal.commitments,
      encryptedShares: deal.encryptedShares,
    });
    await this.persist();
    return bucket.deals;
  }

  async markCeremonyReady(electionId, { publicKey, publicKeyX, publicKeyY, verificationKeys }) {
    const election = this.requireElection(electionId);
    election.tallyPubKey = publicKey;
    election.tallyPubKeyX = publicKeyX;
    election.tallyPubKeyY = publicKeyY;
    election.tallyCeremony.publicKey = publicKey;
    election.tallyCeremony.publicKeyX = publicKeyX;
    election.tallyCeremony.publicKeyY = publicKeyY;
    election.tallyCeremony.verificationKeys = verificationKeys;
    election.tallyCeremony.status = 'ready';
    await this.persist();
    return election;
  }

  async saveGuardianPartials(electionId, { index, partials }) {
    const bucket = this.getTallyGuardian(electionId);
    if (!bucket) throw new HttpError(400, 'election has no guardian ceremony', { code: 'NO_CEREMONY' });
    const n = Number(index);
    bucket.partials = (bucket.partials || []).filter((row) => row.index !== n);
    bucket.partials.push({ index: n, partials });
    await this.persist();
    return bucket.partials;
  }

  async setTally(id, counts, extras = {}) {
    this.refuseIfStandby();
    const election = this.requireElection(id);
    if (election.tally) throw new HttpError(409, 'already tallied');
    election.tally = {
      counts: counts.map((n) => Number(n)),
      postedAt: new Date().toISOString(),
      source: extras.source || TALLY_SCHEME_SUM_ONLY,
      production: false,
      openedBallots: extras.openedBallots ?? null,
      aggregation: extras.aggregation || null,
      guardianThreshold: extras.guardianThreshold ?? null,
      countsHash: extras.countsHash || null,
      l1: extras.l1 || null,
      ballotMethod: extras.ballotMethod || election.ballotMethod || 'plurality',
    };
    if (Array.isArray(extras.questions) && extras.questions.length) {
      election.tally.questions = extras.questions;
    }
    await this.persist();
    return election;
  }

  async setTallyL1(id, l1) {
    const election = this.requireElection(id);
    if (!election.tally) throw new HttpError(409, 'election not yet tallied');
    election.tally.l1 = mergeTallyL1(election.tally.l1, l1);
    if (l1?.resultHash && !election.tally.countsHash) {
      election.tally.countsHash = l1.resultHash;
    }
    await this.persist();
    return election;
  }

  listMailOutbox() {
    const rows = Array.isArray(this.data.mailOutbox) ? this.data.mailOutbox : [];
    return rows.filter((row) => !isSoftDeleted(row)).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getMail(id) {
    const rows = Array.isArray(this.data.mailOutbox) ? this.data.mailOutbox : [];
    return rows.find((row) => !isSoftDeleted(row) && row.id === id) || null;
  }

  async saveMail(record) {
    if (!Array.isArray(this.data.mailOutbox)) this.data.mailOutbox = [];
    const existing = this.data.mailOutbox.find((row) => row.id === record.id);
    if (existing) {
      Object.assign(existing, record);
    } else {
      this.data.mailOutbox.push(record);
    }
    await this.persist();
    return existing || record;
  }

  _apiKeys() {
    if (!Array.isArray(this.data.apiKeys)) this.data.apiKeys = [];
    return this.data.apiKeys;
  }

  listApiKeys(userId) {
    return this._apiKeys()
      .filter((row) => !isSoftDeleted(row) && row.userId === userId)
      .map((row) => publicApiKey(row))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async createApiKey(userId, { name, level, expiresIn, nowMs = Date.now() } = {}) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const cleanName = normalizeApiKeyName(name);
    const cleanLevel = normalizeApiKeyLevel(level);
    const cleanExpiration = normalizeApiKeyExpiration(expiresIn);
    const active = this._apiKeys().filter((row) => !isSoftDeleted(row) && row.userId === userId && !row.revokedAt);
    if (active.length >= API_KEY_LIMIT) {
      throw new HttpError(409, 'api key limit reached', { code: 'API_KEY_LIMIT', limit: API_KEY_LIMIT });
    }
    const minted = mintApiKeySecret();
    const row = {
      id: randomUUID(),
      userId,
      name: cleanName,
      prefix: minted.prefix,
      secretHash: minted.secretHash,
      level: cleanLevel,
      expiresIn: cleanExpiration,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: apiKeyExpiresAt(cleanExpiration, nowMs),
      revokedAt: null,
      lastUsedAt: null,
    };
    this._apiKeys().push(row);
    await this.persist();
    return { record: publicApiKey(row), secret: minted.secret };
  }

  async revokeApiKey(userId, keyId, nowMs = Date.now()) {
    const row = this._apiKeys().find((item) => !isSoftDeleted(item) && item.id === keyId && item.userId === userId);
    if (!row) throw new HttpError(404, 'api key not found');
    if (!row.revokedAt) {
      row.revokedAt = new Date(nowMs).toISOString();
      await this.persist();
    }
    return publicApiKey(row);
  }

  /**
   * @returns {{ user: object, key: object } | { error: 'invalid' | 'revoked' | 'expired' }}
   */
  authenticateApiKey(secret, nowMs = Date.now()) {
    const token = String(secret || '').trim();
    if (!isApiKeySecret(token)) return { error: 'invalid' };
    const digest = hashApiKey(token);
    const row = this._apiKeys().find((item) => !isSoftDeleted(item) && apiKeyHashesEqual(item.secretHash, digest));
    if (!row) return { error: 'invalid' };
    if (row.revokedAt) return { error: 'revoked' };
    if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) return { error: 'expired' };
    const user = this.getUser(row.userId);
    if (!user) return { error: 'invalid' };
    return { user, key: row };
  }

  async touchApiKey(id, nowMs = Date.now()) {
    if (this.writerActive === false) return;
    const row = this._apiKeys().find((item) => item.id === id);
    if (!row) return;
    const prev = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
    if (prev && nowMs - prev < 60_000) return;
    row.lastUsedAt = new Date(nowMs).toISOString();
    await this.persist();
  }

  async setContactEmail(userId, contactEmail) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    user.contactEmail = contactEmail || '';
    await this.persist();
    return user;
  }

  async addNotification({ userId, type, title, body, electionId }) {
    if (!userId) return null;
    const n = {
      id: randomUUID(),
      userId,
      type,
      title,
      body,
      electionId: electionId ? String(electionId) : null,
      read: false,
      createdAt: new Date().toISOString(),
    };
    this.data.notifications.push(n);
    await this.persist();
    return n;
  }

  listNotifications(userId) {
    return this.data.notifications
      .filter((n) => !isSoftDeleted(n) && n.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async markNotificationRead(userId, id) {
    const n = this.data.notifications.find((x) => !isSoftDeleted(x) && x.id === id && x.userId === userId);
    if (!n) throw new HttpError(404, 'notification not found');
    n.read = true;
    await this.persist();
    return n;
  }

  async addTermsRecord(row) {
    if (!Array.isArray(this.data.termsAcceptances)) this.data.termsAcceptances = [];
    this.data.termsAcceptances.push(row);
    await this.persist();
    return row;
  }

  listTermsRecords({ userId = null, action = null } = {}) {
    if (!Array.isArray(this.data.termsAcceptances)) this.data.termsAcceptances = [];
    let rows = this.data.termsAcceptances.filter((r) => !isSoftDeleted(r));
    if (userId) rows = rows.filter((r) => r.userId === userId);
    if (action) rows = rows.filter((r) => r.action === action);
    return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  latestTermsAcceptance(userId) {
    return this.listTermsRecords({ userId, action: 'accept' })[0] || null;
  }

  getSite() {
    if (!this.data.site) this.data.site = defaultSite();
    this.data.site = { ...defaultSite(), ...this.data.site };
    this.data.site.contracts = { ...defaultSite().contracts, ...(this.data.site.contracts || {}) };
    this.data.site.sharedDeployment = true;
    this.data.site.nfp = true;
    return this.data.site;
  }

  async updateSite(patch = {}, actor = null) {
    const site = this.getSite();
    if (patch.title != null) {
      // Saving the current product name (or nothing) keeps following site-admin Branding.
      const title = sanitizeText(patch.title, 120);
      site.title = title && title !== brandName() && !LEGACY_DEFAULT_NAMES.includes(title) ? title : '';
    }
    if (patch.tagline != null) site.tagline = sanitizeText(patch.tagline, 400);
    if (patch.contracts && typeof patch.contracts === 'object') {
      for (const key of ['factory', 'ballotInbox', 'verifier']) {
        if (patch.contracts[key] == null) continue;
        const addr = sanitizeAddress(patch.contracts[key]);
        if (patch.contracts[key] !== '' && addr === null) {
          throw new HttpError(400, `invalid ${key} address`);
        }
        site.contracts[key] = addr || '';
      }
    }
    site.sharedDeployment = true;
    site.updatedAt = new Date().toISOString();
    if (actor?.id) site.updatedBy = actor.id;
    await this.persist();
    return this.getSite();
  }

  listPages({ publishedOnly = false, kind = null } = {}) {
    if (!Array.isArray(this.data.pages)) this.data.pages = [];
    let rows = this.data.pages.slice();
    if (publishedOnly) rows = rows.filter((p) => p.status === 'published');
    if (kind) rows = rows.filter((p) => p.kind === kind);
    return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  getPage(idOrSlug) {
    if (!Array.isArray(this.data.pages)) this.data.pages = [];
    const want = String(idOrSlug || '').trim();
    if (!want) return null;
    return (
      this.data.pages.find((p) => p.id === want) ||
      this.data.pages.find((p) => p.slug === want) ||
      null
    );
  }

  overlayPage(kind) {
    return this.listPages({ publishedOnly: true, kind }).find((p) => p.kind === kind) || null;
  }

  _assertUniqueSlug(slug, exceptId) {
    const taken = this.data.pages.some((p) => p.slug === slug && p.id !== exceptId);
    if (taken) throw new HttpError(409, 'slug taken');
  }

  async createPage(input = {}, actor = null) {
    if (!Array.isArray(this.data.pages)) this.data.pages = [];
    const kind = normalizeKind(input.kind);
    const slug = pageSlugForKind(kind, input.slug);
    if (!slug) throw new HttpError(400, 'invalid slug');
    if (kind === 'custom' && !normalizeSlug(slug)) throw new HttpError(400, 'invalid slug');
    this._assertUniqueSlug(slug, null);
    const title = sanitizeText(input.title, 200) || 'Untitled';
    const page = {
      id: randomUUID(),
      slug,
      kind,
      title,
      status: normalizeStatus(input.status),
      navLabel: sanitizeText(input.navLabel, 40),
      showInNav: Boolean(input.showInNav) && kind === 'custom',
      replaceBuiltin: Boolean(input.replaceBuiltin) && kind !== 'custom',
      jurisdictionId: input.jurisdictionId ? String(input.jurisdictionId) : null,
      blocks: sanitizeBlocks(input.blocks),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: actor?.id || null,
    };
    if (page.jurisdictionId && !this.getJurisdiction(page.jurisdictionId)) {
      throw new HttpError(400, 'unknown jurisdictionId');
    }
    this.data.pages.push(page);
    await this.persist();
    return page;
  }

  async updatePage(id, input = {}, actor = null) {
    const page = this.getPage(id);
    if (!page) throw new HttpError(404, 'page not found');
    if (input.kind != null) page.kind = normalizeKind(input.kind);
    if (input.slug != null || input.kind != null) {
      const slug = pageSlugForKind(page.kind, input.slug != null ? input.slug : page.slug);
      if (!slug) throw new HttpError(400, 'invalid slug');
      this._assertUniqueSlug(slug, page.id);
      page.slug = slug;
    }
    if (input.title != null) page.title = sanitizeText(input.title, 200) || page.title;
    if (input.status != null) page.status = normalizeStatus(input.status);
    if (input.navLabel != null) page.navLabel = sanitizeText(input.navLabel, 40);
    if (input.showInNav != null) page.showInNav = Boolean(input.showInNav) && page.kind === 'custom';
    if (input.replaceBuiltin != null) {
      page.replaceBuiltin = Boolean(input.replaceBuiltin) && page.kind !== 'custom';
    }
    if (input.jurisdictionId !== undefined) {
      const jid = input.jurisdictionId ? String(input.jurisdictionId) : null;
      if (jid && !this.getJurisdiction(jid)) throw new HttpError(400, 'unknown jurisdictionId');
      page.jurisdictionId = jid;
    }
    if (input.blocks != null) page.blocks = sanitizeBlocks(input.blocks);
    page.updatedAt = new Date().toISOString();
    page.updatedBy = actor?.id || null;
    await this.persist();
    return page;
  }

  async deletePage(id) {
    const page = this.getPage(id);
    if (!page) throw new HttpError(404, 'page not found');
    this.data.pages = this.data.pages.filter((p) => p.id !== page.id);
    await this.persist();
    return page;
  }

  getOutcomeReportTemplate() {
    return this.data.outcomeReportTemplate && typeof this.data.outcomeReportTemplate === 'object'
      ? this.data.outcomeReportTemplate
      : {
          heading: 'Official election outcome',
          letterhead: 'Office of civic elections',
          intro:
            'This certified report is issued after voting closed. It lists how many ballots were counted for each option, when the contest opened, and when it ended. Individual choices are never shown.',
          footer: 'NOT FOR PROFIT — civic public good. Not a commercial product.',
          contactLine: '',
          showJurisdiction: true,
        };
  }

  async updateOutcomeReportTemplate(template) {
    this.data.outcomeReportTemplate = template;
    this.data.outcomeReportTemplate.updatedAt = new Date().toISOString();
    await this.persist();
    return this.getOutcomeReportTemplate();
  }

  findOutcomeSubscription(userId, electionId) {
    if (!Array.isArray(this.data.outcomeSubscriptions)) this.data.outcomeSubscriptions = [];
    return (
      this.data.outcomeSubscriptions.find(
        (s) => !isSoftDeleted(s) && s.userId === userId && String(s.electionId) === String(electionId),
      ) || null
    );
  }

  listOutcomeSubscriptions(userId) {
    if (!Array.isArray(this.data.outcomeSubscriptions)) this.data.outcomeSubscriptions = [];
    return this.data.outcomeSubscriptions
      .filter((s) => !isSoftDeleted(s) && s.userId === userId)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  }

  listActiveOutcomeSubscribers(electionId) {
    if (!Array.isArray(this.data.outcomeSubscriptions)) this.data.outcomeSubscriptions = [];
    return this.data.outcomeSubscriptions.filter(
      (s) => !isSoftDeleted(s) && String(s.electionId) === String(electionId) && s.subscribed !== false,
    );
  }

  async upsertOutcomeSubscription({ userId, electionId, subscribed = true, source = 'manual' }) {
    if (!userId) throw new HttpError(400, 'userId required');
    this.requireElection(electionId);
    if (!Array.isArray(this.data.outcomeSubscriptions)) this.data.outcomeSubscriptions = [];
    const now = new Date().toISOString();
    let row = this.findOutcomeSubscription(userId, electionId);
    if (!row) {
      row = {
        id: randomUUID(),
        userId,
        electionId: String(electionId),
        subscribed: Boolean(subscribed),
        source,
        createdAt: now,
        updatedAt: now,
        unsubscribedAt: subscribed ? null : now,
      };
      this.data.outcomeSubscriptions.push(row);
    } else {
      row.subscribed = Boolean(subscribed);
      row.updatedAt = now;
      if (!subscribed) row.unsubscribedAt = now;
      else row.unsubscribedAt = null;
      if (source && !row.source) row.source = source;
    }
    await this.persist();
    return row;
  }

  getOutcomeReport(id) {
    if (!Array.isArray(this.data.outcomeReports)) this.data.outcomeReports = [];
    const want = String(id || '').trim();
    if (!want) return null;
    const compact = want.replace(/-/g, '').toLowerCase();
    return (
      this.data.outcomeReports.find((r) => r.id === want) ||
      this.data.outcomeReports.find((r) => String(r.id).replace(/-/g, '').toLowerCase() === compact) ||
      null
    );
  }

  getOutcomeReportForElection(electionId) {
    if (!Array.isArray(this.data.outcomeReports)) this.data.outcomeReports = [];
    const election = this.getElection(electionId);
    const id = election ? String(election.id) : String(electionId);
    return this.data.outcomeReports.find((r) => String(r.electionId) === id) || null;
  }

  findOutcomeReportByPdfSha256(hash) {
    if (!Array.isArray(this.data.outcomeReports)) this.data.outcomeReports = [];
    const key = String(hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    return this.data.outcomeReports.find((r) => String(r.pdfSha256 || '').toLowerCase() === key) || null;
  }

  listOutcomeReports() {
    if (!Array.isArray(this.data.outcomeReports)) this.data.outcomeReports = [];
    return this.data.outcomeReports.slice().sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')));
  }

  async saveOutcomeReport(row) {
    if (!Array.isArray(this.data.outcomeReports)) this.data.outcomeReports = [];
    const existing = this.getOutcomeReport(row.id) || this.getOutcomeReportForElection(row.electionId);
    if (existing) return existing;
    this.data.outcomeReports.push(row);
    await this.persist();
    return row;
  }

  hasOutcomeDelivery(reportId, userId) {
    if (!Array.isArray(this.data.outcomeReportDeliveries)) this.data.outcomeReportDeliveries = [];
    return this.data.outcomeReportDeliveries.some((d) => d.reportId === reportId && d.userId === userId);
  }

  async addOutcomeDelivery(row) {
    if (!Array.isArray(this.data.outcomeReportDeliveries)) this.data.outcomeReportDeliveries = [];
    if (this.hasOutcomeDelivery(row.reportId, row.userId)) {
      return this.data.outcomeReportDeliveries.find((d) => d.reportId === row.reportId && d.userId === row.userId);
    }
    const rec = {
      id: randomUUID(),
      reportId: row.reportId,
      userId: row.userId,
      emailHint: row.emailHint || null,
      emailed: Boolean(row.emailed),
      createdAt: new Date().toISOString(),
    };
    this.data.outcomeReportDeliveries.push(rec);
    await this.persist();
    return rec;
  }

  voterStatus(electionId, userId) {
    const link = this.findLink(electionId, userId);
    const pending = this.findPendingRequestForUser(electionId, userId);
    const denied =
      !pending &&
      [...this.data.registrationRequests]
        .reverse()
        .find(
          (r) =>
            String(r.electionId) === String(electionId) &&
            !isSoftDeleted(r) &&
            r.userId === userId &&
            r.status === 'denied',
        );
    if (!link) {
      return {
        registered: false,
        pending: Boolean(pending),
        requestId: pending?.id || denied?.id || null,
        requestStatus: pending ? 'pending' : denied ? 'denied' : null,
        disqualified: false,
        eligible: false,
        reasonCode: null,
        identityCommitment: pending?.identityCommitment || denied?.identityCommitment || null,
      };
    }
    const dq = this.isDisqualified(electionId, link.identityCommitment);
    const disqualified = Boolean(dq);
    return {
      registered: true,
      pending: false,
      requestId: null,
      requestStatus: 'approved',
      disqualified,
      eligible: !disqualified,
      reasonCode: dq ? dq.reasonCode : null,
      identityCommitment: link.identityCommitment,
    };
  }

  listPolls() {
    return this.data.polls || [];
  }

  getPoll(id) {
    const want = String(id ?? '');
    return (this.data.polls || []).find((poll) => poll.id === want) || null;
  }

  async savePoll(poll) {
    this.data.polls = this.data.polls || [];
    const index = this.data.polls.findIndex((row) => row.id === poll.id);
    if (index === -1) this.data.polls.push(poll);
    else this.data.polls[index] = poll;
    await this.persist();
    return poll;
  }

  listPollBallots(pollId) {
    return (this.data.pollBallots || []).filter((row) => !isSoftDeleted(row) && row.pollId === pollId);
  }

  getPollBallot(pollId, voter) {
    const who = String(voter || '').toLowerCase();
    return (
      (this.data.pollBallots || []).find(
        (row) => !isSoftDeleted(row) && row.pollId === pollId && String(row.voter || '').toLowerCase() === who,
      ) || null
    );
  }

  async insertPollBallot(ballot) {
    if (ballot.userId != null) delete ballot.userId;
    if (this.getPollBallot(ballot.pollId, ballot.voter)) {
      throw new HttpError(409, 'address already voted', { code: 'ALREADY_VOTED' });
    }
    this.data.pollBallots = this.data.pollBallots || [];
    this.data.pollBallots.push(ballot);
    await this.persist();
    return ballot;
  }

  async savePollBallot(ballot) {
    if (ballot.userId != null) delete ballot.userId;
    this.data.pollBallots = this.data.pollBallots || [];
    const index = this.data.pollBallots.findIndex(
      (row) =>
        !isSoftDeleted(row) &&
        row.pollId === ballot.pollId &&
        String(row.voter).toLowerCase() === String(ballot.voter).toLowerCase(),
    );
    if (index === -1) this.data.pollBallots.push(ballot);
    else this.data.pollBallots[index] = ballot;
    await this.persist();
    return ballot;
  }

  getPollResult(pollId) {
    return (this.data.pollResults || []).find((row) => !isSoftDeleted(row) && row.pollId === pollId) || null;
  }

  async commitPollTally(poll, ballots, result) {
    this.data.polls = this.data.polls || [];
    const index = this.data.polls.findIndex((row) => row.id === poll.id);
    if (index === -1) this.data.polls.push(poll);
    else this.data.polls[index] = poll;
    this.data.pollBallots = this.data.pollBallots || [];
    for (const ballot of ballots) {
      if (ballot.userId != null) delete ballot.userId;
      const at = this.data.pollBallots.findIndex(
        (row) =>
          !isSoftDeleted(row) &&
          row.pollId === ballot.pollId &&
          String(row.voter).toLowerCase() === String(ballot.voter).toLowerCase(),
      );
      if (at === -1) this.data.pollBallots.push(ballot);
      else this.data.pollBallots[at] = ballot;
    }
    this.data.pollResults = this.data.pollResults || [];
    const resultAt = this.data.pollResults.findIndex((row) => !isSoftDeleted(row) && row.pollId === poll.id);
    if (resultAt === -1) this.data.pollResults.push(result);
    else this.data.pollResults[resultAt] = result;
    await this.persist();
    return result;
  }
}
