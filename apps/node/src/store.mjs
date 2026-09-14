// NOT FOR PROFIT — civic public good, not a commercial product.
// JSON file store (no native addons). Jurisdictions ≈ DealPunchList organizations;
// elections ≈ rooms. Identity links (passkey user ↔ commitment) live in a
// separate collection from ballots and are never copied onto a vote record.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isDisclosed } from './disclosure.mjs';
import { HttpError } from './http.mjs';
import {
  ensurePersonFields,
  isAuthMethodType,
  normalizeEthAddress,
  normalizeFingerprint,
  sameEthAddress,
} from './identity.mjs';
import { emptyTree, insertLeaf, toBytes32 } from './merkle.mjs';
import { isRole } from './roles.mjs';
import { isValidReasonCode, reasonName } from './reasonCodes.mjs';

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

function emptyData() {
  return {
    meta: {
      nfp: true,
      app: 'zk-voting',
      version: 3,
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
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    const hasAdmin = this.data.users.some((u) => u.role === 'platform_admin');
    if (!hasAdmin) {
      const existing = this.getUserByHandle(handle);
      if (existing) {
        existing.role = 'platform_admin';
      } else {
        this.data.users.push({
          id: randomUUID(),
          handle,
          role: 'platform_admin',
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
    return this.data.elections.find((e) => String(e.id) === String(id)) || null;
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

  async grantJurisdictionRole(jurisdictionId, { address, role, handle }) {
    const jurisdiction = this.getJurisdiction(jurisdictionId);
    if (!jurisdiction) throw new HttpError(404, 'jurisdiction not found');
    if (!isRole(role)) throw new HttpError(400, 'invalid role');
    jurisdiction.officers = jurisdiction.officers || [];
    const grant = {
      address: address || '',
      handle: handle || '',
      role,
      grantedAt: new Date().toISOString(),
    };
    jurisdiction.officers.push(grant);
    const user =
      (handle && this.getUserByHandle(handle)) ||
      (address && this.getUserByHandle(address)) ||
      null;
    if (user && user.role !== 'platform_admin') {
      user.role = role;
    }
    await this.persist();
    return { jurisdiction, grant, user };
  }

  async createElection(params) {
    const id = this.data.meta.nextElectionId;
    this.data.meta.nextElectionId += 1;
    const tree = emptyTree(params.treeDepth);
    const dq = emptyTree(params.treeDepth);
    const election = {
      id,
      title: params.title,
      metadataURI: params.metadataURI || '',
      startTime: params.startTime,
      cutoffTime: params.cutoffTime,
      maxParticipants: params.maxParticipants,
      treeDepth: params.treeDepth,
      ballotSpecHash: params.ballotSpecHash,
      questions: params.questions,
      questionCount: params.questions.length,
      jurisdictionId: params.jurisdictionId,
      clerk: params.clerk || '',
      registrar: params.registrar || '',
      disqualificationOfficer: params.disqualificationOfficer || '',
      tallyOperator: params.tallyOperator || '',
      verifier: params.verifier || '',
      lateUpdateAllowed: Boolean(params.lateUpdateAllowed),
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
    };
    this.data.elections.push(election);
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
   * this is the product control when CHAIN_RPC is unset.
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
    const key = toBytes32(nullifier);
    return this.data.votes.some(
      (v) => String(v.electionId) === String(electionId) && toBytes32(v.nullifier) === key,
    );
  }

  /**
   * Persist an accepted vote. Internally { nullifier, ballotHash, electionId,
   * relayer, acceptedAt }. Public dashboards never see acceptedAt or a live count;
   * they wait for hourly disclosure. No passkey user id, no choice.
   */
  async acceptVote(vote, envelope) {
    if (this.nullifierUsed(vote.electionId, vote.nullifier)) {
      throw new HttpError(409, 'nullifier already used', { code: 'NULLIFIER_USED' });
    }
    const acceptedAt = Number.isFinite(Number(vote.acceptedAt))
      ? Math.floor(Number(vote.acceptedAt))
      : Math.floor(Date.now() / 1000);
    const record = {
      nullifier: toBytes32(vote.nullifier),
      ballotHash: toBytes32(vote.ballotHash),
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

  listPublishedVotes(electionId, now, intervalSeconds) {
    return this.listVotes(electionId).filter((v) => isDisclosed(v.acceptedAt, now, intervalSeconds));
  }

  publishedAcceptedBallots(electionId, now, intervalSeconds) {
    return this.listPublishedVotes(electionId, now, intervalSeconds).length;
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

  async setTally(id, counts) {
    const election = this.requireElection(id);
    if (election.tally) throw new HttpError(409, 'already tallied');
    election.tally = {
      counts: counts.map((n) => Number(n)),
      postedAt: new Date().toISOString(),
    };
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
