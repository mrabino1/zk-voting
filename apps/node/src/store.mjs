// NOT FOR PROFIT — civic public good, not a commercial product.
// JSON file store (no native addons). Jurisdictions ≈ DealPunchList organizations;
// elections ≈ rooms. Identity links (passkey user ↔ commitment) live in a
// separate collection from ballots and are never copied onto a vote record.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isDisclosed } from './disclosure.mjs';
import {
  electionMatchesRef,
  mintShortCode,
  mintUuid,
  parseOnChainElectionId,
} from './electionIds.mjs';
import { HttpError } from './http.mjs';
import {
  ensurePersonFields,
  isAuthMethodType,
  normalizeEthAddress,
  normalizeFingerprint,
  sameEthAddress,
} from './identity.mjs';
import { emptyTree, insertLeaf, toBytes32 } from './merkle.mjs';
import { isOfficerRole, isPlatformOperator, isRole } from './roles.mjs';
import { isValidReasonCode, reasonName } from './reasonCodes.mjs';
import {
  DEMO_KEY_WARNING,
  TALLY_SCHEME_OPENS_BALLOTS,
  TALLY_SCHEME_SUM_ONLY,
  generateDemoGuardian,
  normalizeTallyScheme,
  publicCeremonyView,
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
export function publishedVoteSlice(vote, now, intervalSeconds) {
  if (!vote) return null;
  if (!isDisclosed(vote.acceptedAt, now, intervalSeconds)) return null;
  return vote;
}

function emptyData() {
  return {
    meta: {
      nfp: true,
      app: 'zk-voting',
      version: 4,
      nextElectionId: 1,
    },
    users: [],
    sessions: [],
    jurisdictions: [],
    elections: [],
    registrations: [],
    identityLinks: [],
    disqualifications: [],
    votes: [],
    envelopes: [],
    notifications: [],
    tallyGuardians: [],
    externalParties: [],
    partyRejections: [],
    partyAttestations: [],
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
  if (next.alreadyPosted || next.status === 'already_posted') {
    return {
      ...next,
      txHash: next.txHash || prev.txHash || null,
      chainId: next.chainId || prev.chainId || null,
      mirror: next.mirror || prev.mirror || null,
      settlement: next.settlement || prev.settlement || null,
    };
  }
  return next;
}

export class Store {
  constructor(filePath, data) {
    this.filePath = filePath;
    this.data = data;
    this._write = Promise.resolve();
  }

  static async open(config) {
    await fs.mkdir(config.dataDir, { recursive: true });
    const filePath = path.join(config.dataDir, 'republic.json');
    let data;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = { ...emptyData(), ...JSON.parse(raw) };
      data.externalParties = data.externalParties || [];
      data.partyRejections = data.partyRejections || [];
      data.partyAttestations = data.partyAttestations || [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      data = emptyData();
    }
    const store = new Store(filePath, data);
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
    store.ensureElectionPublicIds();
    store.rebuildAllEligibility();
    await store.persist();
    return store;
  }

  async persist() {
    this._write = this._write.then(async () => {
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.filePath);
    });
    return this._write;
  }

  async seed(config) {
    const handle = String(config.adminHandle || 'admin').trim() || 'admin';
    const hasSuper = this.data.users.some((u) => u.role === 'platform_super_admin');
    if (!hasSuper) {
      const existing = this.getUserByHandle(handle);
      if (existing) {
        existing.role = 'platform_super_admin';
      } else {
        this.data.users.push({
          id: randomUUID(),
          handle,
          role: 'platform_super_admin',
          createdAt: new Date().toISOString(),
          credentials: [],
          authMethods: [],
          ethAccounts: [],
          activeEthAddress: null,
          personKeyHash: null,
        });
      }
    }
    if (this.data.jurisdictions.length === 0) {
      this.data.jurisdictions.push({
        id: 'demo',
        name: 'Demo jurisdiction',
        metadataURI: '',
        officers: [],
        createdAt: new Date().toISOString(),
      });
    }
  }

  snapshot() {
    return clone(this.data);
  }

  requireElection(id) {
    const election = this.getElection(id);
    if (!election) throw new HttpError(404, 'election not found');
    return election;
  }

  getElection(id) {
    const want = String(id ?? '').trim();
    if (!want) return null;
    return (
      this.data.elections.find((e) => electionMatchesRef(e, want) || electionIdMatches(e, want)) ||
      null
    );
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

  getUser(id) {
    const user = this.data.users.find((u) => u.id === id) || null;
    return user ? ensurePersonFields(user) : null;
  }

  getUserByHandle(handle) {
    const h = String(handle || '').trim().toLowerCase();
    if (!h) return null;
    const user = this.data.users.find((u) => u.handle.toLowerCase() === h) || null;
    return user ? ensurePersonFields(user) : null;
  }

  createUser({ handle, role = 'voter' }) {
    const trimmed = String(handle || '').trim();
    if (!trimmed) throw new HttpError(400, 'handle required');
    if (!isRole(role)) throw new HttpError(400, 'invalid role');
    if (this.getUserByHandle(trimmed)) throw new HttpError(409, 'handle taken');
    const user = ensurePersonFields({
      id: randomUUID(),
      handle: trimmed,
      role,
      createdAt: new Date().toISOString(),
      credentials: [],
      authMethods: [],
      ethAccounts: [],
      activeEthAddress: null,
      personKeyHash: null,
    });
    this.data.users.push(user);
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
    return this.data.users.slice();
  }

  getSession(id) {
    if (!id) return null;
    const session = this.data.sessions.find((s) => s.id === id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) return null;
    return session;
  }

  async createSession(userId, ttlMs) {
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > Date.now());
    const session = {
      id: randomUUID(),
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
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
    user.credentials.push(credential);
    this._addAuthMethodUnchecked(user, {
      type: 'passkey',
      credentialId: credential.id,
      label: 'Passkey',
      verifiedBy: 'self',
    });
    return credential;
  }

  findCredential(credentialId) {
    for (const user of this.data.users) {
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
      ensurePersonFields(user);
      if (sameEthAddress(user.activeEthAddress, addr)) return user;
      if (user.ethAccounts.some((a) => sameEthAddress(a.address, addr))) return user;
    }
    return null;
  }

  findUserByPersonKeyHash(hash) {
    const key = String(hash || '').toLowerCase();
    if (!key) return null;
    const user = this.data.users.find((u) => String(u.personKeyHash || '').toLowerCase() === key) || null;
    return user ? ensurePersonFields(user) : null;
  }

  findUserByAuthMethod({ type, credentialId, address, fingerprint }) {
    for (const user of this.data.users) {
      ensurePersonFields(user);
      const hit = user.authMethods.find((m) => {
        if (type && m.type !== type) return false;
        if (credentialId && m.credentialId === credentialId) return true;
        if (address && sameEthAddress(m.address, address)) return true;
        if (fingerprint && String(m.fingerprint || '').toLowerCase() === String(fingerprint).toLowerCase()) {
          return true;
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
    const existing = this.findUserByAuthMethod({
      type,
      credentialId: fields.credentialId,
      address: fields.address,
      fingerprint: fields.fingerprint,
    });
    if (existing && existing.user.id !== user.id) {
      throw new HttpError(409, 'authenticator already bound to another person', {
        code: 'METHOD_OWNED',
      });
    }
    if (existing && existing.user.id === user.id) return existing.method;
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
    };
    user.authMethods.push(method);
    return method;
  }

  async addAuthMethod(userId, fields) {
    const user = this.getUser(userId);
    if (!user) throw new HttpError(404, 'user not found');
    const method = this._addAuthMethodUnchecked(user, fields);
    await this.persist();
    return { user, method };
  }

  async addEthAccount(userId, { address, source = 'web3', methodId = null }) {
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
      return { user, account: existing, created: false };
    }
    const account = {
      address: addr,
      source: String(source || 'web3'),
      verified: true,
      verifiedAt: new Date().toISOString(),
      methodId: methodId || null,
    };
    user.ethAccounts.push(account);
    if (!user.activeEthAddress) user.activeEthAddress = addr;
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

  getJurisdiction(id) {
    return this.data.jurisdictions.find((j) => String(j.id) === String(id)) || null;
  }

  async createJurisdiction({ id, name, metadataURI = '' }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new HttpError(400, 'name required');
    const jurisdiction = {
      id: id ? String(id) : randomUUID(),
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
      return { jurisdiction, grant: existing, user };
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
    return { jurisdiction, grant, user };
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
    const id = mintUuid();
    if (this.getElection(id)) throw new HttpError(409, 'election id collision');
    const shortCode = this._uniqueShortCode();
    const onChainElectionId = this._allocateOnChainElectionId(params.onChainElectionId);
    const tree = emptyTree(params.treeDepth);
    const dq = emptyTree(params.treeDepth);
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
      const guardian = await generateDemoGuardian();
      if (!this.data.tallyGuardians) this.data.tallyGuardians = [];
      this.data.tallyGuardians.push({
        electionId: String(id),
        scheme: guardian.scheme,
        threshold: 1,
        guardians: 1,
        production: false,
        warning: DEMO_KEY_WARNING,
        publicKeyRaw: guardian.publicKeyRaw,
        publicKeyX: guardian.publicKeyX,
        publicKeyY: guardian.publicKeyY,
        privateJwk: guardian.privateJwk,
        createdAt: new Date().toISOString(),
      });
      tallyPubKey = guardian.publicKeyRaw;
      tallyPubKeyX = guardian.publicKeyX;
      tallyPubKeyY = guardian.publicKeyY;
      tallyCeremony = publicCeremonyView(guardian);
    }
    const election = {
      id,
      shortCode,
      onChainElectionId,
      aliases: [],
      title: params.title,
      metadataURI: params.metadataURI || '',
      startTime: params.startTime,
      cutoffTime: params.cutoffTime,
      maxParticipants: params.maxParticipants,
      treeDepth: params.treeDepth,
      ballotSpecHash: params.ballotSpecHash,
      ballotMethod: params.ballotMethod || 'plurality',
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
      staff: [],
      createdAt: new Date().toISOString(),
    };
    this.data.elections.push(election);
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

  async registerCommitment(electionId, identityCommitment, { userId } = {}) {
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
    this.rebuildEligibleTree(election);
    const eligibleLeafIndex = election.eligibleTree.leaves.indexOf(key);
    await this.persist();
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
        (l) => l.userId === userId && String(l.electionId) === String(electionId),
      ) || null
    );
  }

  findUserIdForCommitment(electionId, identityCommitment) {
    const key = toBytes32(identityCommitment);
    const link = this.data.identityLinks.find(
      (l) => String(l.electionId) === String(electionId) && l.identityCommitment === key,
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
   */
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

  rebuildDisqualificationTree(election) {
    const tree = emptyTree(election.treeDepth);
    for (const d of this.data.disqualifications) {
      if (String(d.electionId) !== String(election.id) || d.revokedAt) continue;
      insertLeaf(tree, d.identityCommitment);
    }
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
   * Node-path vote gate. The circuit still may not prove non-disqualification;
   * this is the product control when CHAIN_RPC is unset. External parties are
   * checked separately (live, including after roll freeze).
   */
  assertCanVote(electionId, identityCommitment) {
    if (identityCommitment == null || identityCommitment === '') {
      throw new HttpError(400, 'identityCommitment required to vote on the Node path', {
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
      (u) => u.role === 'platform_admin' || u.role === 'platform_super_admin',
    );
  }

  async approveAdmin({ userId, handle } = {}) {
    const user = this.resolveOfficerUser({ userId, handle });
    if (!user) throw new HttpError(404, 'user not found');
    if (user.role === 'platform_super_admin') {
      throw new HttpError(400, 'cannot change a platform super admin with this approval');
    }
    user.role = 'platform_admin';
    user.approvedAsAdminAt = new Date().toISOString();
    await this.persist();
    return user;
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

  async approveElectionStaff(electionId, { address, handle, userId } = {}) {
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
    election.staff = election.staff || [];
    const exists = election.staff.some(
      (grant) =>
        (user && this.officerMatchesUser(grant, user)) ||
        (trimmedUserId && grant.userId === trimmedUserId) ||
        (trimmedHandle &&
          String(grant.handle || '').trim().toLowerCase() === trimmedHandle.toLowerCase()),
    );
    if (exists) {
      return { election, staff: election.staff, user };
    }
    election.staff.push({
      userId: user?.id || trimmedUserId || '',
      handle: user?.handle || trimmedHandle,
      address: trimmedAddress || user?.activeEthAddress || '',
      role: 'election_staff',
      grantedAt: new Date().toISOString(),
    });
    await this.persist();
    return { election, staff: election.staff, user };
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
        (v) => String(v.electionId) === String(electionId) && toBytes32(v.nullifier) === key,
      ) || null
    );
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
    const existing = this.findVote(vote.electionId, vote.nullifier);
    if (existing) {
      throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
    }
    const acceptedAt = Number.isFinite(Number(vote.acceptedAt))
      ? Math.floor(Number(vote.acceptedAt))
      : Math.floor(Date.now() / 1000);
    const ballotHash = toBytes32(vote.ballotHash);
    const record = {
      nullifier: toBytes32(vote.nullifier),
      ballotHash,
      electionId: String(vote.electionId),
      relayer: vote.relayer || 'node',
      acceptedAt,
    };
    this.data.votes.push(record);
    if (envelope) {
      this.data.envelopes.push({
        electionId: record.electionId,
        nullifier: record.nullifier,
        ballotHash: record.ballotHash,
        encryptedBallot: envelope.encryptedBallot,
        ...(Array.isArray(envelope.rankingPayload) ? { rankingPayload: envelope.rankingPayload } : {}),
      });
    }
    const election = this.requireElection(vote.electionId);
    election.acceptedBallots += 1;
    await this.persist();
    return record;
  }

  listVotes(electionId) {
    return this.data.votes.filter((v) => String(v.electionId) === String(electionId));
  }

  /**
   * Votes whose accept is past the disclosure horizon. Each nullifier appears
   * at most once.
   */
  listPublishedVotes(electionId, now, intervalSeconds) {
    return this.listVotes(electionId).flatMap((vote) => {
      const slice = publishedVoteSlice(vote, now, intervalSeconds);
      return slice ? [slice] : [];
    });
  }

  publishedAcceptedBallots(electionId, now, intervalSeconds) {
    return this.listPublishedVotes(electionId, now, intervalSeconds).length;
  }

  publishedAcceptedBallotsAll(now, intervalSeconds) {
    return this.data.votes.filter((v) => isDisclosed(v.acceptedAt, now, intervalSeconds)).length;
  }

  listEnvelopes(electionId) {
    return this.data.envelopes.filter((e) => String(e.electionId) === String(electionId));
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

  async setTally(id, counts, extras = {}) {
    const election = this.requireElection(id);
    if (election.tally) throw new HttpError(409, 'already tallied');
    election.tally = {
      counts: counts.map((n) => Number(n)),
      postedAt: new Date().toISOString(),
      source: extras.source || TALLY_SCHEME_SUM_ONLY,
      production: false,
      openedBallots: extras.openedBallots ?? null,
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
      .filter((n) => n.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async markNotificationRead(userId, id) {
    const n = this.data.notifications.find((x) => x.id === id && x.userId === userId);
    if (!n) throw new HttpError(404, 'notification not found');
    n.read = true;
    await this.persist();
    return n;
  }

  voterStatus(electionId, userId) {
    const link = this.findLink(electionId, userId);
    if (!link) {
      return {
        registered: false,
        disqualified: false,
        eligible: false,
        reasonCode: null,
        identityCommitment: null,
      };
    }
    const dq = this.isDisqualified(electionId, link.identityCommitment);
    const disqualified = Boolean(dq);
    return {
      registered: true,
      disqualified,
      eligible: !disqualified,
      reasonCode: dq ? dq.reasonCode : null,
      identityCommitment: link.identityCommitment,
    };
  }
}
