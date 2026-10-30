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

/// @title BallotInbox
/// @notice Accepts gasless vote proofs. `msg.sender` is the relayer/bundler.
/// @dev There is NO function that takes a voter address. The passkey smart
///      account is not an argument; unlinkability depends on that.
///
///      Coercion slice (not MACI, not last-ballot-counts): a nullifier is
///      accepted **once**. Any second `submitVote` for that nullifier reverts
///      `NullifierUsed`, including a new ciphertext. Voters may change their
///      mind privately on the ballot form before submit. Double voting remains
///      impossible. Receipts list hashes only and cannot prove choice.
///
///      Audit H-05: `ballotHash` (public input 3) is
///      `uint256(keccak256(encryptedBallot)) mod r` so it is always a BN254
///      field element. External-party vetoes and missing attestations live in
///      the roots the proof already binds. This contract has no argument for
///      an identity commitment. Audit H-03: ballots are refused while a paged
///      eligible-root rebuild is pending.
///
///      `msg.sender` must be a factory allowlisted relayer. When
///      `disclosureInterval` is non-zero, only `submitVoteBatch` is accepted,
///      and the batch is recorded in nullifier order inside one transaction.
contract BallotInbox is IBallotInbox {
    uint256 public constant MAX_VOTE_BATCH = 64;

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
    mapping(uint256 => uint256) private _acceptedBallots;
    mapping(uint256 => mapping(uint256 => bytes32)) private _ballotHashOf;
    mapping(uint256 => bytes32[]) private _ballotHashList;
    mapping(uint256 => bytes32) private _ballotRoot;
    mapping(uint256 => uint64) private _lastBatchAt;

    /// @dev Appended slot. 1 while a submission is inside `nonReentrant`.
    uint256 private _reentrancyLock;

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
    ) external {
        // Reject a sealed VOTE before the reentrancy lock so a refused call
        // does not write this contract. POLL never takes this branch.
        _rejectIfSealed(electionId);
        _submitVoteLocked(electionId, a, b, c, publicInputs, encryptedBallot);
    }

    function _submitVoteLocked(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) internal nonReentrant {
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
    ) external {
        _rejectIfSealed(electionId);
        _submitVoteBatchLocked(electionId, a, b, c, publicInputs, encryptedBallots);
    }

    function _submitVoteBatchLocked(
        uint256 electionId,
        uint256[2][] calldata a,
        uint256[2][2][] calldata b,
        uint256[2][] calldata c,
        uint256[][] calldata publicInputs,
        bytes[] calldata encryptedBallots
    ) internal nonReentrant {
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

    /// @inheritdoc IBallotInbox
    function acceptedBallots(uint256 electionId) external view returns (uint256) {
        return _acceptedBallots[electionId];
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
        if (publicInputs.length != 5) revert InvalidPublicInputs();

        IElection election = _getElection(electionId);
        address verifier = _requireOpen(election);
        _requireNotTallied(electionId);
        _requireBoundInstance(election, electionId, publicInputs, encryptedBallot);

        // Spent key is the field residue. keccak-dev-v1 nullifiers are full
        // keccak words; reducing them keeps one key per field element. A residue
        // of zero is not a nullifier (it is the unset word, and every multiple
        // of r would otherwise alias it).
        nullifier = publicInputs[2] % SNARK_SCALAR_FIELD;
        if (nullifier == 0) revert InvalidNullifier();
        ballotHash = bytes32(publicInputs[3]);

        if (!CappedVerifierCall.accepted(verifier, a, b, c, publicInputs)) revert InvalidProof();
        if (_nullifierUsed[electionId][nullifier]) revert NullifierUsed();
    }

    /// @dev VOTE turnout must not move this inbox. The check is a read of the
    ///      election type and returns before any storage write.
    function _rejectIfSealed(uint256 electionId) internal view {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) return;
        if (IElection(electionAddr).electionType() == ElectionType.VOTE) {
            revert SealedBallotNotAccepted(electionId);
        }
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
    ///      tag is the hash, so the vote circuit can bind one choice without
    ///      hashing the whole ciphertext with keccak. Any other ciphertext
    ///      still uses `uint256(keccak256(ciphertext)) mod r`.
    function ballotHashOfCiphertext(bytes calldata encryptedBallot) public pure returns (uint256) {
        if (encryptedBallot.length >= 34 && encryptedBallot[0] == 0x41 && encryptedBallot[1] == 0x47) {
            bytes32 tag;
            assembly {
                tag := calldataload(add(encryptedBallot.offset, 2))
            }
            return uint256(tag) % SNARK_SCALAR_FIELD;
        }
        return uint256(keccak256(encryptedBallot)) % SNARK_SCALAR_FIELD;
    }

    function _recordAcceptance(uint256 electionId, uint256 nullifier, bytes32 ballotHash) internal {
        uint256 key = nullifier % SNARK_SCALAR_FIELD;
        _nullifierUsed[electionId][key] = true;
        _ballotHashOf[electionId][key] = ballotHash;
        _ballotHashList[electionId].push(ballotHash);
        _ballotRoot[electionId] = keccak256(abi.encodePacked(_ballotRoot[electionId], ballotHash));
        unchecked {
            _acceptedBallots[electionId] += 1;
        }
        emit VoteAccepted(electionId, nullifier, ballotHash, msg.sender);
    }
}
