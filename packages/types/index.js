/**
 * @fileoverview Shared JSDoc types and constants for ZK-Voting.
 *
 * NOT FOR PROFIT — civic public good, not a commercial product.
 *
 * Mirrors `smart-contracts/src/interfaces/ElectionParams.sol`,
 * `ReasonCodes.sol`, `Roles.sol`, and the Node / L2 explorer records.
 * This package is documentation-in-code: no runtime validation library
 * is implied. Callers still type-check at the edges (API, contract ABI).
 */

"use strict";

const AUTH_METHOD_TYPES = Object.freeze(["email", "passkey", "web3", "smart_card", "civic_id"]);

/** ZK-Voting L2 chain id (see docs/L2.md). */
const ZK_VOTING_CHAIN_ID = 27427;

const BallotMethod = Object.freeze({
  PLURALITY: "plurality",
  RANKED_CHOICE: "ranked_choice",
});

const QuestionType = Object.freeze({
  YES_NO: "YES_NO",
  SINGLE_CHOICE: "SINGLE_CHOICE",
  MULTI_CHOICE: "MULTI_CHOICE",
  RANKED: "RANKED",
  MEASURE: "MEASURE",
  ARTICLE: "ARTICLE",
});

/** Ethereum mainnet. Canonical court-grade settlement when chosen. */
const ETHEREUM_MAINNET_CHAIN_ID = 1;

/**
 * Election lifecycle. Matches `ElectionState` in ElectionParams.sol.
 * 0=Created 1=RollFrozen 2=Open 3=Closed 4=Tallied
 *
 * @enum {number}
 */
const ElectionState = Object.freeze({
  CREATED: 0,
  ROLL_FROZEN: 1,
  OPEN: 2,
  CLOSED: 3,
  TALLIED: 4,
});

/**
 * Public disqualification reason codes. Codes are visible on chain;
 * evidence stays off-chain. Matches `ReasonCodes.sol`.
 *
 * @enum {number}
 */
const ReasonCode = Object.freeze({
  NONE: 0,
  NOT_OF_AGE: 1,
  NOT_RESIDENT: 2,
  NOT_CITIZEN_OR_MEMBER: 3,
  DUPLICATE_IDENTITY: 4,
  DECEASED: 5,
  MOVED_OUT: 6,
  DISTRICT_MISMATCH: 7,
  ALREADY_VOTED: 8,
  COURT_ORDER: 9,
  INELIGIBLE_STATUS: 10,
  FRAUD_HOLD: 11,
  EXPIRED_OR_SUSPENDED: 12,
  SANCTION_OR_PROHIBITION: 13,
  OTHER: 14,
});

const REASON_CODE_LABELS = Object.freeze({
  1: "NOT_OF_AGE",
  2: "NOT_RESIDENT",
  3: "NOT_CITIZEN_OR_MEMBER",
  4: "DUPLICATE_IDENTITY",
  5: "DECEASED",
  6: "MOVED_OUT",
  7: "DISTRICT_MISMATCH",
  8: "ALREADY_VOTED",
  9: "COURT_ORDER",
  10: "INELIGIBLE_STATUS",
  11: "FRAUD_HOLD",
  12: "EXPIRED_OR_SUSPENDED",
  13: "SANCTION_OR_PROHIBITION",
  14: "OTHER",
});

/**
 * @typedef {Object} ElectionParams
 * @property {string} title Human-readable title. Not the ballot spec.
 * @property {string} metadataURI URI of the canonical ballot JSON / extra metadata.
 * @property {number|bigint} startTime Unix seconds, inclusive. Poll is not open before this.
 * @property {number|bigint} cutoffTime Unix seconds, exclusive. Poll is closed at this instant.
 * @property {number} maxParticipants `0` means unlimited. Otherwise registry insert reverts at cap.
 * @property {number} treeDepth Merkle depth 16..32. Must match the compiled `Vote(levels)` circuit.
 * @property {string} ballotSpecHash `0x`-prefixed keccak256 of the canonical ballot JSON (bytes32).
 * @property {string} clerk Address with CLERK_ROLE for this election (freeze, open/close).
 * @property {string} registrar Address allowed to insert identity commitments.
 * @property {string} disqualificationOfficer Address allowed to write DisqualificationRegistry.
 * @property {string} tallyOperator Address allowed to submit tally proofs.
 * @property {string} verifier Groth16 verifier (`IGroth16Verifier`) or MockVerifier in tests.
 * @property {number} questionCount Number of aspects / questions on the ballot.
 * @property {BallotQuestion[]} [questions] Canonical questions hashed into `ballotSpecHash`.
 * @property {string} jurisdictionId bytes32 id of the owning jurisdiction.
 * @property {string} [tallyPubKeyX] P-256 pubkey X (bytes32 hex). Zero = no tally encryption key.
 * @property {string} [tallyPubKeyY] P-256 pubkey Y (bytes32 hex).
 * @property {number} [tallyScheme] 0 = SUM_ONLY (legacy). 1 = OPENS_BALLOTS.
 * @property {"plurality"|"ranked_choice"} [ballotMethod] Counting flavor. Default
 *   `plurality`. `ranked_choice` is instant-runoff. On-chain v1 may omit this
 *   field and keep it only inside `ballotSpecHash`.
 */

/**
 * One external page linked from a ballot option's supporting-info card.
 *
 * @typedef {Object} BallotOptionLink
 * @property {string} label
 * @property {string} url http(s) URL
 */

/**
 * One candidate / measure choice. Legacy ballots may be a plain string or
 * `{ id, label }` only. Empty optional fields are omitted from the keccak
 * preimage so old elections keep a stable `ballotSpecHash`.
 *
 * @typedef {Object} BallotOption
 * @property {string} id
 * @property {string} label Display name (candidate, Yes/No, measure choice).
 * @property {string} [summary] Short blurb on the option list.
 * @property {string} [body] Plain or markdown supporting information.
 * @property {string} [imageUrl] Optional portrait / logo http(s) URL.
 * @property {BallotOptionLink[]} [links] External pages (campaign site, full text).
 */

/**
 * One decision on a ballot (office, measure, article). Node authoring +
 * plurality or instant-runoff (IRV) tally. `RANKED` always uses IRV.
 *
 * @typedef {Object} BallotQuestion
 * @property {string} id
 * @property {"YES_NO"|"SINGLE_CHOICE"|"MULTI_CHOICE"|"MEASURE"|"ARTICLE"|"RANKED"} type
 * @property {"plurality"|"ranked_choice"} [ballotMethod]
 * @property {string} prompt
 * @property {string} [description]
 * @property {number} [maxSelections] Required for MULTI_CHOICE; omitted from the
 *   keccak preimage for single-choice / yes-no so older hashes stay stable.
 *   RANKED uses options.length.
 * @property {BallotOption[]} options Ordered options. For RANKED this is the
 *   printed candidate order, not the voter's ranking.
 */

/**
 * Node / SPA election record. Public URLs use `id` (UUID). Circuit and
 * `BallotInbox` use `onChainElectionId` (`uint256`).
 *
 * @typedef {Object} ElectionRecord
 * @property {string} id Canonical public id (UUID v5 bound to factory +
 *   on-chain id + jurisdiction; legacy records may be UUID v4) used in
 *   `/vote/:id` and `GET /api/elections/:id`.
 * @property {string} shortCode Opaque url-safe alias (10 chars). `/v/:shortCode`
 *   and `/e/:shortCode` resolve to the same election.
 * @property {string} onChainElectionId Decimal string of the Solidity
 *   `uint256 electionId` assigned by `ElectionFactory` (`++electionCount`).
 * @property {string|null} [factoryAddress] Shared ElectionFactory. L1
 *   certification keys by this address plus `onChainElectionId` plus
 *   `jurisdictionId`, never by the public UUID.
 * @property {string|null} [certificationId] `keccak256(abi.encode(DOMAIN,
 *   factory, electionId, jurisdictionId))`.
 * @property {string[]} [aliases] Legacy ids that still resolve (fixtures).
 */

/**
 * How this person proved who they are. A person may hold every type.
 *
 * @typedef {Object} AuthMethod
 * @property {string} id
 * @property {"email"|"passkey"|"web3"|"smart_card"|"civic_id"} type
 * @property {boolean} verified
 * @property {"self"|"registrar"|"provider"} [verifiedBy]
 * @property {string} [verifiedAt] ISO-8601
 * @property {string} [label]
 * @property {string} [credentialId] passkey
 * @property {string} [address] checksummed web3 address
 * @property {string} [fingerprint] smart-card digest
 * @property {string} [subject]
 * @property {string} [issuer]
 * @property {"drivers_license"|"passport"} [kind]
 * @property {"active"|"pending_review"|"revoked"|"expired"} [status]
 * @property {string} [expiresAt]
 * @property {string} [provider] `manual` until a DMV connector is configured
 */

/**
 * Internally verified Ethereum account. Many per person; at most one is active.
 *
 * @typedef {Object} EthAccount
 * @property {string} address Checksummed EOA or smart-account address.
 * @property {string} [source] passkey | web3 | registrar
 * @property {boolean} verified
 * @property {"self"|"registrar"} [verifiedBy]
 * @property {boolean} active Exactly one verified account is active per person.
 * @property {string} [verifiedAt]
 */

/**
 * Public person record. The vote Merkle leaf is still an identityCommitment,
 * never `activeEthAddress`.
 *
 * @typedef {Object} PersonIdentity
 * @property {string} personId Node user id (UUID).
 * @property {boolean} personKeyBound Registrar bound a keccak256 civil-file token.
 * @property {AuthMethod[]} authMethods
 * @property {EthAccount[]} ethAccounts
 * @property {string|null} activeEthAddress
 * @property {number} verifiedEthAddressCount
 */

/**
 * Instant-runoff round. Counts are aggregate; individual rankings stay in the
 * operator envelope on the Node demo path.
 *
 * @typedef {Object} IrvRound
 * @property {number} round
 * @property {Record<string, number>} counts First-preference among remaining.
 * @property {number} continuing
 * @property {number} exhausted
 * @property {string[]} remaining
 * @property {string|null} eliminated
 * @property {string|null} winner
 * @property {boolean} [tieBroken]
 */

/**
 * Encrypted / committed ballot plus the Groth16 proof that the voter is
 * eligible, not double-voting, and bound to this election. Choice is
 * not a public field.
 *
 * `publicInputs` MUST be `[root, disqRoot, nullifier, ballotHash, electionId]`
 * (see `@zk-voting/proof-helpers` `serializePublicInputs`).
 *
 * The vote POST must not include `answers`, `identityCommitment`, `address`,
 * or `credentialId`. `stripBallotPii` drops those keys if a client sends them.
 *
 * @typedef {Object} VoteEnvelope
 * @property {string|bigint} electionId On-chain election id (`uint256`),
 *   not the public UUID. See `ElectionRecord.onChainElectionId`.
 * @property {string} root Eligible-set Merkle root (bytes32 / uint256 hex).
 * @property {string} disqRoot Disqualification-set Merkle root.
 * @property {string} nullifier Unique per (voter, election). Spent at most once;
 *   a second ballot for the same nullifier is rejected. Double voting is impossible.
 * @property {string} ballotHash Hash / commitment of `encryptedBallot`.
 * @property {string} encryptedBallot Hex bytes of the tally-pubkey ECIES envelope
 *   (`RTv1` + P-256 eph pub + AES-GCM) when `tallyScheme == opens_ballots`, or
 *   the legacy seed-keyed AES-GCM stand-in. Does not reveal the option in the clear.
 *   Opening an `opens_ballots` envelope takes t Feldman guardian partials after cutoff.
 * @property {bigint[]|string[]} publicInputs Length-5 array documented above.
 * @property {Groth16Proof} proof Pairing-shaped Groth16 proof.
 * @property {string} [relayer] Address that submits the UserOp / tx (bundler).
 */

/**
 * Groth16 proof points as the Solidity verifier expects them.
 *
 * @typedef {Object} Groth16Proof
 * @property {[string, string]} a G1 point.
 * @property {[[string, string], [string, string]]} b G2 point.
 * @property {[string, string]} c G1 point.
 */

/**
 * One ZK-Voting L2 block as the explorer shows it. Transaction origins
 * are typically the bundler, not the voter.
 *
 * @typedef {Object} Block
 * @property {number|bigint} number Block height.
 * @property {string} hash Block hash (`0x` + 32 bytes).
 * @property {string} parentHash Parent block hash.
 * @property {number|bigint} timestamp Unix seconds.
 * @property {string} stateRoot Post-state root.
 * @property {string} [receiptsRoot] Optional receipts trie root.
 * @property {number} chainId Always `27427` on ZK-Voting L2.
 * @property {string} sequencer Sequencer address that proposed the block.
 * @property {BlockTx[]} transactions Ordered txs / UserOps included.
 * @property {BlockOutcome[]} outcomes Derived events the explorer indexes:
 *   registration inserts (commitments only), votes accepted (nullifier +
 *   ballotHash, never the choice), disqualifications (reason codes),
 *   tally posts, rollup batches.
 */

/**
 * @typedef {Object} BlockTx
 * @property {string} hash Transaction hash.
 * @property {string} from msg.sender. For votes this is the relayer/bundler.
 * @property {string} to Contract called.
 * @property {string} [input] Calldata (may be truncated in UI).
 * @property {number} [status] 1 success, 0 revert.
 */

/**
 * @typedef {Object} BlockOutcome
 * @property {"register"|"vote"|"disqualify"|"revoke"|"tally"|"l1_certify"|"batch"|"freeze"} type
 * @property {string|bigint} [electionId]
 * @property {string} [identityCommitment] Registration leaf only; never a name.
 * @property {string} [nullifier]
 * @property {string} [ballotHash]
 * @property {number} [reasonCode]
 * @property {string} [countsHash]
 * @property {string} [resultHash] L1TallyMirror result hash (same as countsHash).
 * @property {string} [dataHash] Rollup batch calldata hash.
 */

/**
 * Administrative owner of a roll and of elections.
 *
 * @typedef {Object} Jurisdiction
 * @property {string} id bytes32 (or hex) jurisdiction id used on chain.
 * @property {string} name Display name (city, county, nation, union, …).
 * @property {string} [metadataURI] Public policy / reason-catalog document.
 * @property {string} [chainId] Decimal string of the execution chain
 *   (`27427` for ZK-Voting L2, `1` for Ethereum mainnet).
 * @property {string} [factory] ElectionFactory address on that chain.
 * @property {string[]} [reasonCatalog] Enabled reason code labels. Protocol
 *   default is the README catalog; jurisdictions may disable codes, not
 *   hide mass purges.
 * @property {JurisdictionOfficers} [officers] Role-bearing addresses.
 * @property {boolean} [lateUpdateAllowed] If true, disqualifications after
 *   roll freeze are allowed. Default false; discouraged.
 */

/**
 * @typedef {Object} JurisdictionOfficers
 * @property {string} [platformAdmin]
 * @property {string} [clerk]
 * @property {string} [registrar]
 * @property {string} [disqualificationOfficer]
 * @property {string} [tallyOperator]
 * @property {string} [relayer]
 */

/**
 * @param {number} code
 * @returns {string}
 */
function reasonCodeLabel(code) {
  const n = Number(code);
  return REASON_CODE_LABELS[n] || `UNKNOWN(${n})`;
}

/**
 * @param {number} state
 * @returns {string}
 */
function electionStateLabel(state) {
  const names = ["Created", "RollFrozen", "Open", "Closed", "Tallied"];
  const n = Number(state);
  return names[n] || `Unknown(${n})`;
}

module.exports = {
  ZK_VOTING_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
  ElectionState,
  ReasonCode,
  REASON_CODE_LABELS,
  AUTH_METHOD_TYPES,
  BallotMethod,
  QuestionType,
  reasonCodeLabel,
  electionStateLabel,
};
