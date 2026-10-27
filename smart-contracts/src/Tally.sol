// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, TallyScheme} from "./interfaces/ElectionParams.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";
import {TallyPublicInputs} from "./zk/TallyPublicInputs.sol";
import {CappedVerifierCall} from "./zk/CappedVerifierCall.sol";

/// @title Tally
/// @notice Posts a proven (or mock-verified) option-count vector after cutoff.
/// @dev Two additive schemes (ElectionParams.tallyScheme):
///      0 SUM_ONLY — any `counts` with sum == acceptedBallots (legacy demo).
///        This does not reveal an individual ciphertext. It also does not
///        prove the histogram. A real aggregate proof is scheme 1.
///      1 AGGREGATE — operator submits `counts` plus one `aggregateHash`
///        of the homomorphic product. There is no per-ballot openings array,
///        in calldata or in storage. Ranked ballots are not opened here;
///        the application refuses ranked tally until a shuffle exists.
///        MockVerifier does not prove decryption; do not treat it as a ceremony.
///
///      Public inputs: `TallyPublicInputs` (TALLY_SOL_V2, every word reduced
///      mod r). Not the same encoding as `circuits/tally.circom`. See that
///      file's header. Word 5 is `aggregateHash`.
///
///      Audit H-01: tally proofs are verified by a dedicated, set-once
///      `tallyProofVerifier`, never by the election's *vote* verifier. Until a
///      super admin installs one, every tally submission reverts
///      `TallyVerifierNotSet`. A verifier reporting `isMock() == true` is
///      refused unless the factory explicitly allows mock verifiers (dev / test).
contract Tally is ITallyVerifier {
    /// @notice Option-vector bound. A histogram is not one integer per ballot.
    uint256 public constant MAX_TALLY_OPTIONS = 256;

    IElectionFactory private immutable _factory;

    /// @inheritdoc ITallyVerifier
    function factory() external view returns (address) {
        return address(_factory);
    }

    mapping(uint256 => uint256[]) private _counts;
    mapping(uint256 => bool) private _tallied;
    mapping(uint256 => bytes32) private _aggregateHash;
    mapping(uint256 => uint8) private _postedScheme;

    /// @notice Groth16 verifier for the `TallyPublicInputs` instance. Set once.
    address public tallyProofVerifier;

    /// @dev Appended slot. 1 while a tally submission is inside `nonReentrant`.
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

    /// @notice Install the tally proof verifier. Super admin only; set once.
    function setTallyProofVerifier(address verifier_) external {
        if (!_factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        if (verifier_ == address(0)) revert ZeroAddress();
        if (tallyProofVerifier != address(0)) revert TallyVerifierAlreadySet();
        if (_reportsMock(verifier_) && !_factoryAllowsMock()) revert MockVerifierNotAllowed();
        tallyProofVerifier = verifier_;
        emit TallyProofVerifierSet(verifier_);
    }

    /// @inheritdoc ITallyVerifier
    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external nonReentrant {
        _requireNotPaused();
        if (counts.length == 0) revert EmptyCounts();
        if (counts.length > MAX_TALLY_OPTIONS) revert CountsTooLong();
        if (_tallied[electionId]) revert AlreadyTallied();

        (address inbox, address verifier, ElectionParams memory p) = _authorize(electionId);
        if (p.tallyScheme == TallyScheme.AGGREGATE) revert AggregateRequired();

        uint256 accepted = IBallotInbox(inbox).acceptedBallots(electionId);
        uint256 total = _sum(counts);
        if (total != accepted) revert CountMismatch();

        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        bytes32 root = IBallotInbox(inbox).ballotRoot(electionId);
        _verify(
            verifier,
            TallyPublicInputs.instance(
                electionId,
                accepted,
                countsHash,
                root,
                bytes32(0),
                TallyPublicInputs.tallyKeyHashOf(p.tallyPubKeyX, p.tallyPubKeyY)
            ),
            a,
            b,
            c
        );

        _tallied[electionId] = true;
        _counts[electionId] = counts;
        _postedScheme[electionId] = TallyScheme.SUM_ONLY;

        emit TallyPosted(electionId, countsHash, total);
    }

    /// @inheritdoc ITallyVerifier
    function submitAggregateTally(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external nonReentrant {
        _requireNotPaused();
        if (counts.length == 0) revert EmptyCounts();
        if (counts.length > MAX_TALLY_OPTIONS) revert CountsTooLong();
        if (aggregateHash_ == bytes32(0)) revert AggregateHashRequired();
        if (_tallied[electionId]) revert AlreadyTallied();

        (address inbox, address verifier, ElectionParams memory p) = _authorize(electionId);
        if (p.tallyScheme != TallyScheme.AGGREGATE) revert NotAggregateScheme();

        uint256 accepted = IBallotInbox(inbox).acceptedBallots(electionId);
        uint256 total = _sum(counts);
        if (total != accepted) revert CountMismatch();

        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        bytes32 root = IBallotInbox(inbox).ballotRoot(electionId);

        _verify(
            verifier,
            TallyPublicInputs.instance(
                electionId,
                accepted,
                countsHash,
                root,
                aggregateHash_,
                TallyPublicInputs.tallyKeyHashOf(p.tallyPubKeyX, p.tallyPubKeyY)
            ),
            a,
            b,
            c
        );

        _tallied[electionId] = true;
        _counts[electionId] = counts;
        _aggregateHash[electionId] = aggregateHash_;
        _postedScheme[electionId] = TallyScheme.AGGREGATE;

        emit TallyPosted(electionId, countsHash, total);
        emit AggregateTallyPosted(electionId, countsHash, aggregateHash_, root, total);
    }

    /// @inheritdoc ITallyVerifier
    function tally(uint256 electionId) external view returns (uint256[] memory) {
        return _counts[electionId];
    }

    /// @inheritdoc ITallyVerifier
    /// @dev Election.state() should treat TALLIED when this returns true.
    function isTallied(uint256 electionId) external view returns (bool) {
        return _tallied[electionId];
    }

    /// @notice Single commitment to the aggregated ciphertext. Not a list of choices.
    function aggregateHash(uint256 electionId) external view returns (bytes32) {
        return _aggregateHash[electionId];
    }

    function postedScheme(uint256 electionId) external view returns (uint8) {
        return _postedScheme[electionId];
    }

    /// @dev Operator-only, after cutoff. Returns the election inbox, the tally
    ///      proof verifier (never the vote verifier), and params.
    function _authorize(uint256 electionId)
        internal
        view
        returns (address inbox, address verifier, ElectionParams memory p)
    {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();

        IElection election = IElection(electionAddr);
        p = election.params();
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
        // CLOSED: voting window is [startTime, cutoffTime). Cutoff is exclusive.
        if (block.timestamp < p.cutoffTime) revert ElectionNotClosed();
        verifier = tallyProofVerifier;
        if (verifier == address(0)) revert TallyVerifierNotSet();
        inbox = election.inbox();
    }

    function _requireNotPaused() internal view {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("isPaused()"));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert ContractPaused();
    }

    function _reportsMock(address verifier_) internal view returns (bool) {
        (bool ok, bytes memory ret) = verifier_.staticcall(abi.encodeWithSignature("isMock()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _factoryAllowsMock() internal view returns (bool) {
        (bool ok, bytes memory ret) = address(_factory).staticcall(abi.encodeWithSignature("allowMockVerifiers()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _sum(uint256[] calldata counts) internal pure returns (uint256 total) {
        uint256 n = counts.length;
        for (uint256 i = 0; i < n; ++i) {
            total += counts[i];
        }
    }

    function _verify(
        address verifier,
        uint256[] memory input,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal view {
        if (!CappedVerifierCall.accepted(verifier, a, b, c, input)) revert InvalidProof();
    }
}
