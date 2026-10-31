// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, ElectionType} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";
import {IVoterRegistry} from "./interfaces/IVoterRegistry.sol";
import {CappedVerifierCall} from "./zk/CappedVerifierCall.sol";
import {BallotDigest} from "./zk/BallotDigest.sol";
import {IndexedRoot} from "./zk/IndexedRoot.sol";
import {PoseidonT3} from "./hasher/PoseidonT3.sol";

/// @title BallotInbox
/// @notice Accepts gasless vote proofs. `msg.sender` is the relayer/bundler.
/// @dev There is NO function that takes a voter address. The passkey smart
///      account is not an argument; unlinkability depends on that.
///
///      With no settlement, public input 2 is the once-only voter id
///      `Poseidon(nullifierSecret, electionId)`. A new ballot hash cannot mint a
///      second voter. The acceptance counter stays private until cutoff.
///      With a settlement, public input 2 is the submission id
///      `Poseidon(Poseidon(nullifierSecret, electionId), ballotHash)`. The voter
///      id is not a public input and is not hashed again here. Sealed accepts
///      do not publish a live count. Turnout is the unique count on the hourly
///      batch. A sealed proof has six public inputs. The sixth is the indexed
///      ballot-set root. The empty root is valid only at depth 20.
///      Receipts list hashes only.
///
///      Audit H-05: `ballotHash` (public input 3) is a BN254 field element.
///      An `EG` ballot commits to the ordered option-ciphertext vector
///      (Poseidon fold of the primary and each option, in order). Any other
///      ciphertext is `uint256(keccak256(encryptedBallot)) mod r`.
///      External-party vetoes and missing attestations live in
///      the roots the proof already binds. This contract has no argument for
///      an identity commitment. Audit H-03: ballots are refused while a paged
///      eligible-root rebuild is pending.
///
///      `msg.sender` must be a factory allowlisted relayer. When
///      `disclosureInterval` is non-zero, only `submitVoteBatch` is accepted,
///      and the batch is recorded in nullifier order inside one transaction.
contract BallotInbox is IBallotInbox {
    uint256 public constant MAX_VOTE_BATCH = 64;

    /// @notice Force-in rows held for the supplementary batch.
    uint256 public constant MAX_PENDING = 64;

    /// @notice How many force-in ids `markSealed` accepts in one call.
    uint256 public constant SEAL_CHUNK = 8;

    /// @notice Calldata bound for one ciphertext. Aggregate envelopes are far smaller.
    uint256 public constant MAX_BALLOT_BYTES = 32 * 1024;

    /// @notice BN254 scalar field modulus r.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IElectionFactory private immutable _factory;

    /// @inheritdoc IBallotInbox
    function factory() external view returns (address) {
        return address(_factory);
    }

    mapping(uint256 => mapping(uint256 => bool)) private _nullifierUsed;
    /// @dev Legacy unique count. Not a public getter. Sealed turnout is on the settlement.
    mapping(uint256 => uint256) private _acceptedBallots;
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHashOf;
    mapping(uint256 => bytes32[]) private _ballotHashList;
    mapping(uint256 => bytes32) private _ballotRoot;
    mapping(uint256 => uint64) private _lastBatchAt;

    /// @dev Appended slot. 1 while a submission is inside `nonReentrant`.
    uint256 private _reentrancyLock;

    /// @notice Per-election settlement. Unset keeps the once-only voter nullifier and the per-acceptance count.
    mapping(uint256 => address) public settlementOf;
    /// @notice Per-election ceremony. A sealed election refuses ballots until its joint key is posted.
    mapping(uint256 => address) public ceremonyOf;

    struct Inclusion {
        bytes32 boundRoot;
        uint64 receivedAt;
        bool pending;
        bool included;
    }

    mapping(uint256 => mapping(uint256 => Inclusion)) private _forcedIn;
    /// @notice Force-in rows in arrival order. Coverage walks this index, not a nested search.
    mapping(uint256 => uint256) public pendingCount;
    mapping(uint256 => mapping(uint256 => uint256)) public pendingIdAt;
    /// @notice Chunked bitmap. Bit `index % 256` of chunk `index / 256` is set while that row is pending.
    mapping(uint256 => mapping(uint256 => uint256)) public pendingChunk;
    /// @notice Next unsealed force-in index. Chunked finalization walks forward from here.
    mapping(uint256 => uint256) public pendingCursor;
    /// @notice Accepted submissions already included in a settled batch. A second settle reverts.
    mapping(uint256 => mapping(uint256 => bool)) private _settledSubmission;
    /// @notice Accepted submissions waiting for a settled batch. Appended after the settled map.
    mapping(uint256 => uint256) public unconsumedCount;

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert ReentrantCall();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        _factory = IElectionFactory(factory_);
    }

    /// @inheritdoc IBallotInbox
    /// @dev Only an allowlisted relayer. The voter address is not an argument.
    ///      A non-zero factory disclosure interval forces `submitVoteBatch`.
    function submitVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) external nonReentrant {
        _requireNotPaused();
        _requireRelayer();
        if (_disclosureInterval() != 0) revert UseVoteBatch();
        _acceptOne(electionId, a, b, c, publicInputs, encryptedBallot);
    }

    /// @inheritdoc IBallotInbox
    function submitVoteBatch(
        uint256 electionId,
        uint256[2][] calldata a,
        uint256[2][2][] calldata b,
        uint256[2][] calldata c,
        uint256[][] calldata publicInputs,
        bytes[] calldata encryptedBallots
    ) external nonReentrant {
        _requireNotPaused();
        _requireRelayer();
        uint256 n = encryptedBallots.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_VOTE_BATCH) revert BatchTooLarge();
        if (a.length != n || b.length != n || c.length != n || publicInputs.length != n) {
            revert BatchLengthMismatch();
        }
        _requireBatchWindow(electionId);

        uint256[] memory nullifiers = new uint256[](n);
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            (uint256 nullifier, bytes32 ballotHash) =
                _checkOne(electionId, a[i], b[i], c[i], publicInputs[i], encryptedBallots[i]);
            for (uint256 j; j < i; ++j) {
                if (nullifiers[j] == nullifier) revert DuplicateNullifier();
            }
            nullifiers[i] = nullifier;
            hashes[i] = ballotHash;
        }

        uint256[] memory order = _nullifierOrder(nullifiers);
        for (uint256 i; i < n; ++i) {
            uint256 j = order[i];
            _recordAcceptance(electionId, nullifiers[j], hashes[j]);
        }
        _lastBatchAt[electionId] = uint64(block.timestamp);
        // Count only. A yes/no split here would publish the batch tally.
        emit VoteBatchAccepted(electionId, n, msg.sender);
    }

    /// @inheritdoc IBallotInbox
    function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    /// @notice Turnout once it is allowed to be public.
    ///         A VOTE reverts until cutoff, including when a settlement is set.
    ///         A sealed POLL returns the unique count last written by an hourly
    ///         or supplementary batch. A legacy election reverts until cutoff, then
    ///         returns the private acceptance counter. There is no live getter.
    function closedBallotCount(uint256 electionId) external view returns (uint256) {
        ElectionParams memory p = _getElection(electionId).params();
        if (p.electionType == ElectionType.VOTE && block.timestamp < p.cutoffTime) revert TurnoutNotPublished();
        address settlement = settlementOf[electionId];
        if (settlement != address(0)) {
            (bool ok, bytes memory ret) =
                settlement.staticcall(abi.encodeWithSignature("postedUnique(uint256)", electionId));
            if (!ok || ret.length < 32) revert TurnoutNotPublished();
            return abi.decode(ret, (uint256));
        }
        if (block.timestamp < p.cutoffTime) revert TurnoutNotPublished();
        return _acceptedBallots[electionId];
    }

    /// @notice Indexed empty root. Only depth 20 is a valid bound word.
    function emptyBallotRoot(uint256 depth) public pure returns (uint256) {
        if (depth != IndexedRoot.DEPTH) revert BadTreeDepth();
        return IndexedRoot.empty(depth);
    }

    /// @inheritdoc IBallotInbox
    function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32) {
        return _ballotHashOf[electionId][nullifier % SNARK_SCALAR_FIELD];
    }

    /// @inheritdoc IBallotInbox
    function ballotRoot(uint256 electionId) external view returns (bytes32) {
        return _ballotRoot[electionId];
    }

    /// @inheritdoc IBallotInbox
    function ballotHashAt(uint256 electionId, uint256 index) external view returns (bytes32) {
        return _ballotHashList[electionId][index];
    }

    function _requireNotPaused() internal view {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("isPaused()"));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert ContractPaused();
    }

    function _requireNotTallied(uint256 electionId) internal view {
        // Audit M-04: fail closed. The tally module is set once in the factory
        // (M-03); a failing read or a reverting `isTallied` blocks the ballot
        // instead of silently skipping the check. Zero means no tally module
        // is wired, so nothing can have been tallied yet.
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("tallyVerifier()"));
        if (!ok || ret.length < 32) revert TallyStatusUnavailable();
        address tally = abi.decode(ret, (address));
        if (tally == address(0)) return;
        try ITallyVerifier(tally).isTallied(electionId) returns (bool done) {
            if (done) revert AlreadyTallied();
        } catch {
            revert TallyStatusUnavailable();
        }
    }

    function _getElection(uint256 electionId) internal view returns (IElection election) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        election = IElection(electionAddr);
    }

    function _acceptOne(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal {
        (uint256 nullifier, bytes32 ballotHash) = _checkOne(electionId, a, b, c, publicInputs, encryptedBallot);
        _recordAcceptance(electionId, nullifier, ballotHash);
    }

    function _checkOne(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal view returns (uint256 nullifier, bytes32 ballotHash) {
        if (encryptedBallot.length == 0) revert EmptyBallot();
        if (encryptedBallot.length > MAX_BALLOT_BYTES) revert BallotTooLarge();
        if (settlementOf[electionId] != address(0)) _requireEg(encryptedBallot);
        _requireInputShape(electionId, publicInputs);

        IElection election = _getElection(electionId);
        address verifier = _requireOpen(election);
        _requireNotTallied(electionId);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);

        // Spent key is public input 2. Legacy elections put the voter id there.
        // Sealed elections put the submission id there. It is not hashed again.
        nullifier = publicInputs[2] % SNARK_SCALAR_FIELD;
        if (nullifier == 0) revert InvalidNullifier();
        ballotHash = bytes32(publicInputs[3]);

        if (!CappedVerifierCall.accepted(verifier, a, b, c, publicInputs)) revert InvalidProof();
        if (_nullifierUsed[electionId][nullifier]) revert NullifierUsed();
        _requireKey(electionId, election.params().electionType);
    }

    function _requireRelayer() internal view {
        (bool ok, bytes memory ret) =
            address(_factory).staticcall(abi.encodeWithSignature("isRelayer(address)", msg.sender));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert NotRelayer();
    }

    function _disclosureInterval() internal view returns (uint64) {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("disclosureInterval()"));
        if (!ok || ret.length < 32) return 0;
        return uint64(abi.decode(ret, (uint256)));
    }

    /// @dev First batch waits one interval after the election opens. Later
    ///      batches wait one interval after the previous batch. A one-ballot
    ///      batch is still one person's choice; that is the single-voter case.
    function _requireBatchWindow(uint256 electionId) internal view {
        uint64 interval = _disclosureInterval();
        if (interval == 0) return;
        IElection election = _getElection(electionId);
        uint64 floor = _lastBatchAt[electionId];
        if (floor == 0) floor = election.params().startTime;
        if (block.timestamp < uint256(floor) + interval) revert BatchTooEarly();
    }

    /// @dev Ascending nullifier order. Ties cannot occur; duplicates revert earlier.
    function _nullifierOrder(uint256[] memory nullifiers) internal pure returns (uint256[] memory order) {
        uint256 n = nullifiers.length;
        order = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            order[i] = i;
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = order[i];
            uint256 keyNull = nullifiers[key];
            uint256 j = i;
            while (j > 0 && nullifiers[order[j - 1]] > keyNull) {
                order[j] = order[j - 1];
                unchecked {
                    --j;
                }
            }
            order[j] = key;
        }
    }

    /// @dev OPEN ≡ roll frozen AND now ∈ [startTime, cutoffTime).
    function _requireOpen(IElection election) internal view returns (address verifier) {
        if (!election.rollFrozen()) revert RollNotFrozen();
        ElectionParams memory p = election.params();
        if (block.timestamp < p.startTime || block.timestamp >= p.cutoffTime) {
            revert OutsideVotingWindow();
        }
        verifier = p.verifier;
        if (verifier == address(0)) revert ZeroVerifier();
    }

    function _requireBoundInstance(
        IElection election,
        uint256 electionId,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal view {
        if (publicInputs[0] != uint256(election.eligibleRoot())) {
            revert EligibleRootMismatch();
        }
        if (publicInputs[1] != uint256(election.disqualificationRoot())) {
            revert DisqualificationRootMismatch();
        }
        if (publicInputs[4] != electionId) revert ElectionIdMismatch();

        if (publicInputs[3] != ballotHashOfCiphertext(encryptedBallot)) revert BallotHashMismatch();

        address voters = election.voterRegistry();
        if (voters != address(0)) {
            (bool ok, bytes memory ret) =
                voters.staticcall(abi.encodeWithSelector(IVoterRegistry.eligibleRootPending.selector, electionId));
            if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert EligibleRootPending();
        }
    }

    /// @notice Field-safe ballot hash.
    /// @dev Aggregate ballots start with `AG` and a 32-byte Poseidon tag. The
    ///      tag is the hash. A canonical `EG` ballot is the ordered-vector digest:
    ///      130 bytes is n = 0, and `162 + n * 128` bytes carries n in 0..4 plus
    ///      n option ciphertexts. Any other ciphertext, including a truncated `EG`
    ///      blob, uses `uint256(keccak256(ciphertext)) mod r`.
    function ballotHashOfCiphertext(bytes calldata encryptedBallot) public pure returns (uint256) {
        if (encryptedBallot.length >= 34 && encryptedBallot[0] == 0x41 && encryptedBallot[1] == 0x47) {
            bytes32 tag;
            assembly ("memory-safe") {
                tag := calldataload(add(encryptedBallot.offset, 2))
            }
            return uint256(tag) % SNARK_SCALAR_FIELD;
        }
        if (encryptedBallot.length >= 130 && encryptedBallot[0] == 0x45 && encryptedBallot[1] == 0x47) {
            uint256 digest = _egDigest(encryptedBallot);
            if (digest != 0 || _egCanonical(encryptedBallot)) return digest;
        }
        return uint256(keccak256(encryptedBallot)) % SNARK_SCALAR_FIELD;
    }

    /// @dev Zero means "not a canonical EG blob", unless the digest itself is zero.
    function _egCanonical(bytes calldata blob) private pure returns (bool) {
        if (blob.length == 130) return true;
        if (blob.length < 162) return false;
        uint256 n = _coord(blob, 130);
        return n <= 4 && blob.length == 162 + n * 128;
    }

    function _egDigest(bytes calldata blob) private pure returns (uint256) {
        uint256 c1x = _coord(blob, 2);
        uint256 c1y = _coord(blob, 34);
        uint256 c2x = _coord(blob, 66);
        uint256 c2y = _coord(blob, 98);
        if (blob.length == 130) {
            return PoseidonT3.hashLeftRight(BallotDigest.ciphertextHash(c1x, c1y, c2x, c2y), 0);
        }
        if (blob.length < 162) return 0;
        uint256 n = _coord(blob, 130);
        if (n > 4 || blob.length != 162 + n * 128) return 0;
        uint256 h = PoseidonT3.hashLeftRight(BallotDigest.ciphertextHash(c1x, c1y, c2x, c2y), n);
        for (uint256 i; i < n; ++i) {
            uint256 off = 162 + i * 128;
            h = PoseidonT3.hashLeftRight(
                h,
                BallotDigest.ciphertextHash(_coord(blob, off), _coord(blob, off + 32), _coord(blob, off + 64), _coord(blob, off + 96))
            );
        }
        return h;
    }

    function _coord(bytes calldata blob, uint256 offset) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := calldataload(add(blob.offset, offset))
        }
    }

    function _requireEg(bytes calldata encryptedBallot) internal pure {
        if (encryptedBallot.length < 130 || encryptedBallot[0] != 0x45 || encryptedBallot[1] != 0x47) {
            revert EgCiphertextRequired();
        }
    }

    function _recordAcceptance(uint256 electionId, uint256 nullifier, bytes32 ballotHash) internal {
        uint256 key = nullifier % SNARK_SCALAR_FIELD;
        _nullifierUsed[electionId][key] = true;
        _ballotHashOf[electionId][key] = ballotHash;
        _ballotHashList[electionId].push(ballotHash);
        _ballotRoot[electionId] = keccak256(abi.encodePacked(_ballotRoot[electionId], ballotHash));
        if (settlementOf[electionId] == address(0)) {
            unchecked {
                _acceptedBallots[electionId] += 1;
            }
        } else {
            unchecked {
                unconsumedCount[electionId] += 1;
            }
        }
        emit VoteAccepted(electionId, nullifier, ballotHash, msg.sender);
    }

    function setSettlement(uint256 electionId, address settlement_) external {
        _requireFactoryAdmin();
        _requireBeforeStart(electionId);
        if (settlement_ == address(0)) revert ZeroAddress();
        address cur = settlementOf[electionId];
        if (cur != address(0) && cur != settlement_) revert SettlementAlreadySet();
        settlementOf[electionId] = settlement_;
    }

    function setCeremony(uint256 electionId, address ceremony_) external {
        _requireFactoryAdmin();
        _requireBeforeStart(electionId);
        if (ceremony_ == address(0)) revert ZeroAddress();
        address cur = ceremonyOf[electionId];
        if (cur != address(0) && cur != ceremony_) revert CeremonyAlreadySet();
        ceremonyOf[electionId] = ceremony_;
    }

    function receiptDigest(uint256 electionId, RelayerReceipt calldata receipt) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                electionId,
                receipt.submissionId,
                receipt.ballotHash,
                receipt.ciphertextHash,
                receipt.boundRoot,
                receipt.receivedAt
            )
        );
    }

    function forceIn(
        uint256 electionId,
        RelayerReceipt calldata receipt,
        bytes calldata signature,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) external nonReentrant {
        _requireNotPaused();
        _inclusionWindow(electionId, receipt);
        _checkSigned(electionId, receipt, signature, publicInputs, encryptedBallot);
        if (!_rootPosted(electionId, receipt.boundRoot)) revert UnknownBoundRoot();
        _acceptIncluded(electionId, a, b, c, publicInputs, encryptedBallot);
        _pushForced(electionId, receipt);
    }

    function pendingForcedIn(uint256 electionId) external view returns (uint256[] memory ids) {
        uint256 n = pendingCount[electionId];
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = pendingIdAt[electionId][i];
        }
    }

    function forcedInRoot(uint256 electionId, uint256 submissionId) external view returns (bytes32 root, bool pending) {
        Inclusion storage row = _forcedIn[electionId][submissionId];
        return (row.boundRoot, row.pending);
    }

    /// @inheritdoc IBallotInbox
    function consumeForSettlement(uint256 electionId, uint256 submissionId, uint256 cipherHash) external {
        if (msg.sender != settlementOf[electionId] || msg.sender == address(0)) revert NotAuthorized();
        uint256 id = submissionId % SNARK_SCALAR_FIELD;
        if (id == 0 || !_nullifierUsed[electionId][id]) revert UnknownSubmission();
        if (_ballotHashOf[electionId][id] != bytes32(cipherHash)) revert BallotHashMismatch();
        if (_settledSubmission[electionId][id]) revert SubmissionAlreadySettled();
        _settledSubmission[electionId][id] = true;
        unconsumedCount[electionId] -= 1;
    }

    function markSealed(uint256 electionId, uint256[] calldata submissionIds) external {
        if (msg.sender != settlementOf[electionId] || msg.sender == address(0)) revert NotAuthorized();
        uint256 n = submissionIds.length;
        if (n == 0) return;
        if (n > SEAL_CHUNK) revert UnknownInclusion();
        uint256 cursor = pendingCursor[electionId];
        for (uint256 i; i < n; ++i) {
            uint256 index = cursor + i;
            uint256 id = submissionIds[i];
            if (id != pendingIdAt[electionId][index]) revert UnknownInclusion();
            uint256 chunk = index >> 8;
            uint256 bit = index & 255;
            uint256 word = pendingChunk[electionId][chunk];
            if ((word & (uint256(1) << bit)) == 0) revert UnknownInclusion();
            pendingChunk[electionId][chunk] = word ^ (uint256(1) << bit);
            _forcedIn[electionId][id].pending = false;
            _forcedIn[electionId][id].included = true;
        }
        uint256 next = cursor + n;
        pendingCursor[electionId] = next;
        if (next == pendingCount[electionId]) {
            pendingCount[electionId] = 0;
            pendingCursor[electionId] = 0;
        }
    }

    function _requireFactoryAdmin() internal view {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("admin()"));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != msg.sender) revert NotAuthorized();
    }

    function _requireBeforeStart(uint256 electionId) internal view {
        if (block.timestamp >= _getElection(electionId).params().startTime) revert LinksLocked();
    }

    function _requireInputShape(uint256 electionId, uint256[] calldata publicInputs) internal view {
        uint256 expect = settlementOf[electionId] == address(0) ? 5 : 6;
        if (publicInputs.length != expect) revert InvalidPublicInputs();
        if (expect == 6) _requireBoundWord(electionId, publicInputs[5]);
    }

    /// @dev A posted ballot-set root, or the empty Merkle root before any batch.
    function _requireBoundWord(uint256 electionId, uint256 word) internal view {
        if (word == 0) revert UnknownBoundRoot();
        bytes32 root = bytes32(word);
        if (_rootPosted(electionId, root)) return;
        if (_lastHourlyRoot(electionId) == bytes32(0) && word == emptyBallotRoot(IndexedRoot.DEPTH)) {
            return;
        }
        revert UnknownBoundRoot();
    }

    function _lastHourlyRoot(uint256 electionId) internal view returns (bytes32 root) {
        address settlement = settlementOf[electionId];
        if (settlement == address(0)) return bytes32(0);
        (bool ok, bytes memory ret) =
            settlement.staticcall(abi.encodeWithSignature("lastHourlyRoot(uint256)", electionId));
        if (!ok || ret.length < 32) return bytes32(0);
        root = abi.decode(ret, (bytes32));
    }

    function _requireKey(uint256 electionId, uint8 electionType) internal view {
        if (settlementOf[electionId] == address(0)) return;
        address ceremony = ceremonyOf[electionId];
        if (ceremony == address(0)) revert KeyNotPosted();
        (bool ok, bytes memory ret) =
            ceremony.staticcall(abi.encodeWithSignature("keyPosted(uint256,uint8)", electionId, electionType));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert KeyNotPosted();
    }

    function _inclusionWindow(uint256 electionId, RelayerReceipt calldata receipt) internal view {
        IElection election = _getElection(electionId);
        ElectionParams memory p = election.params();
        uint256 allowedAt = _tallyAllowedAt(electionId);
        if (block.timestamp < p.cutoffTime || block.timestamp >= allowedAt) revert ForceInClosed();
        if (receipt.receivedAt >= p.cutoffTime) revert ReceiptAfterCutoff();
        _requireNotTallied(electionId);
    }

    function _tallyAllowedAt(uint256 electionId) internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("tallyVerifier()"));
        if (!ok || ret.length < 32) revert TallyStatusUnavailable();
        address tally = abi.decode(ret, (address));
        if (tally == address(0)) revert TallyStatusUnavailable();
        (ok, ret) = tally.staticcall(abi.encodeWithSignature("tallyAllowedAt(uint256)", electionId));
        if (!ok || ret.length < 32) revert TallyStatusUnavailable();
        return abi.decode(ret, (uint256));
    }

    function _checkSigned(
        uint256 electionId,
        RelayerReceipt calldata receipt,
        bytes calldata signature,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal view {
        if (keccak256(encryptedBallot) != receipt.ciphertextHash) revert ReceiptMismatch();
        _requireInputShape(electionId, publicInputs);
        uint256 spentId = publicInputs[2] % SNARK_SCALAR_FIELD;
        if (spentId != receipt.submissionId % SNARK_SCALAR_FIELD) revert ReceiptMismatch();
        if (bytes32(publicInputs[3]) != receipt.ballotHash) revert ReceiptMismatch();
        if (publicInputs[3] != ballotHashOfCiphertext(encryptedBallot)) revert BallotHashMismatch();
        address who = _signer(receiptDigest(electionId, receipt), signature);
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("isRelayer(address)", who));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert BadSignature();
    }

    function _signer(bytes32 digest, bytes calldata signature) internal pure returns (address who) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        who = ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)), v, r, s);
        if (who == address(0)) revert BadSignature();
    }

    function _rootPosted(uint256 electionId, bytes32 root) internal view returns (bool) {
        if (root == bytes32(0)) return false;
        address settlement = settlementOf[electionId];
        if (settlement == address(0)) return false;
        (bool ok, bytes memory ret) =
            settlement.staticcall(abi.encodeWithSignature("postedBallotRoot(uint256,bytes32)", electionId, root));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _acceptIncluded(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal {
        IElection election = _getElection(electionId);
        if (!election.rollFrozen()) revert RollNotFrozen();
        if (settlementOf[electionId] != address(0)) _requireEg(encryptedBallot);
        address verifier = election.params().verifier;
        if (verifier == address(0)) revert ZeroVerifier();
        _requireInputShape(electionId, publicInputs);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);
        uint256 spent = publicInputs[2] % SNARK_SCALAR_FIELD;
        if (spent == 0) revert InvalidNullifier();
        if (!CappedVerifierCall.accepted(verifier, a, b, c, publicInputs)) revert InvalidProof();
        if (_nullifierUsed[electionId][spent]) revert NullifierUsed();
        _requireKey(electionId, election.params().electionType);
        _recordAcceptance(electionId, spent, bytes32(publicInputs[3]));
    }

    function _pushForced(uint256 electionId, RelayerReceipt calldata receipt) internal {
        if (pendingCount[electionId] >= MAX_PENDING) revert PendingListFull();
        uint256 id = receipt.submissionId % SNARK_SCALAR_FIELD;
        _forcedIn[electionId][id] =
            Inclusion({boundRoot: receipt.boundRoot, receivedAt: receipt.receivedAt, pending: true, included: false});
        uint256 idx = pendingCount[electionId];
        pendingIdAt[electionId][idx] = id;
        uint256 chunk = idx >> 8;
        uint256 bit = idx & 255;
        pendingChunk[electionId][chunk] |= uint256(1) << bit;
        unchecked {
            pendingCount[electionId] = idx + 1;
        }
    }
}
