// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {SealedVoteInbox} from "./SealedVoteInbox.sol";
import {SealedVoteKey} from "./SealedVoteKey.sol";
import {ElectionParams, ElectionType, TallyScheme} from "../interfaces/ElectionParams.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";
import {ITallyVerifier} from "../interfaces/ITallyVerifier.sol";
import {TallyPublicInputs} from "../zk/TallyPublicInputs.sol";
import {CappedVerifierCall} from "../zk/CappedVerifierCall.sol";

/// @title SealedVoteTally
/// @notice Tally, decryption, interim hash, and disclosure for a VOTE.
///         POLL keeps using `Tally`. Nothing here succeeds before cutoff, and
///         the result hashes are write-once once the challenge window has closed.
/// @dev Decryption reverts until `SealedVoteKey` has released the scalar, which
///      itself reverts until cutoff and until the time-lock opening is valid.
///      There is no view that returns a plaintext or a share count of ballots
///      from this contract. Turnout lives on `SealedVoteInbox` and stays at
///      zero until the reveal, which is also after cutoff.
contract SealedVoteTally {
    uint256 public constant MAX_TALLY_OPTIONS = 256;

    IElectionFactory public immutable factory;
    SealedVoteInbox public immutable inbox;
    SealedVoteKey public immutable key;

    mapping(uint256 => uint256[]) private _counts;
    mapping(uint256 => bool) private _tallied;
    mapping(uint256 => bytes32) private _aggregateHash;
    mapping(uint256 => uint8) private _postedScheme;
    mapping(uint256 => bytes32) private _decryptionHash;
    mapping(uint256 => bytes32) private _interimHash;
    mapping(uint256 => bytes32) private _disclosureHash;

    address public tallyProofVerifier;
    uint256 private _reentrancyLock;

    error NotVote();
    error NotTallyOperator();
    error UnknownElection();
    error TooEarly(uint256 electionId);
    error KeyNotReleased(uint256 electionId);
    error CeremonyIncomplete(uint256 electionId);
    error NotSuperAdmin();
    error TallyVerifierNotSet();
    error TallyVerifierAlreadySet();
    error MockVerifierNotAllowed();
    error ContractPaused();
    error ReentrantCall();

    event TallyProofVerifierSet(address indexed verifier);

    modifier nonReentrant() {
        if (_reentrancyLock != 0) revert ReentrantCall();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    constructor(address factory_, address inbox_, address key_) {
        if (factory_ == address(0) || inbox_ == address(0) || key_ == address(0)) revert UnknownElection();
        factory = IElectionFactory(factory_);
        inbox = SealedVoteInbox(inbox_);
        key = SealedVoteKey(key_);
    }

    function setTallyProofVerifier(address verifier_) external {
        if (!factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        if (verifier_ == address(0)) revert UnknownElection();
        if (tallyProofVerifier != address(0)) revert TallyVerifierAlreadySet();
        if (_reportsMock(verifier_) && !_factoryAllowsMock()) revert MockVerifierNotAllowed();
        tallyProofVerifier = verifier_;
        emit TallyProofVerifierSet(verifier_);
    }

    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireReady(electionId);
        _submitTally(electionId, counts, a, b, c);
    }

    function submitAggregateTally(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireReady(electionId);
        _submitAggregate(electionId, counts, aggregateHash_, a, b, c);
    }

    /// @notice Write-once plaintext hash. Requires a posted tally and a released key.
    function submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash) external {
        _requireReady(electionId);
        _submitDecryption(electionId, aggregatePlaintextHash);
    }

    function postInterimResult(uint256 electionId, bytes32 resultHash) external {
        _requireReady(electionId);
        _postInterim(electionId, resultHash);
    }

    function disclose(uint256 electionId, bytes32 disclosureHash_) external {
        _requireReady(electionId);
        _disclose(electionId, disclosureHash_);
    }

    function tally(uint256 electionId) external view returns (uint256[] memory) {
        return _counts[electionId];
    }

    function isTallied(uint256 electionId) external view returns (bool) {
        return _tallied[electionId];
    }

    function decryptionHash(uint256 electionId) external view returns (bytes32) {
        return _decryptionHash[electionId];
    }

    function interimResult(uint256 electionId) external view returns (bytes32) {
        return _interimHash[electionId];
    }

    function disclosureHash(uint256 electionId) external view returns (bytes32) {
        return _disclosureHash[electionId];
    }

    function aggregateHash(uint256 electionId) external view returns (bytes32) {
        return _aggregateHash[electionId];
    }

    function _submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal nonReentrant {
        _bodyTally(electionId, counts, bytes32(0), false, a, b, c);
    }

    function _submitAggregate(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal nonReentrant {
        if (aggregateHash_ == bytes32(0)) revert ITallyVerifier.AggregateHashRequired();
        _bodyTally(electionId, counts, aggregateHash_, true, a, b, c);
    }

    function _bodyTally(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        bool aggregate,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal {
        _requireNotPaused();
        if (counts.length == 0) revert ITallyVerifier.EmptyCounts();
        if (counts.length > MAX_TALLY_OPTIONS) revert ITallyVerifier.CountsTooLong();
        if (_tallied[electionId]) revert ITallyVerifier.AlreadyTallied();
        ElectionParams memory p = _operator(electionId);
        if (aggregate && p.tallyScheme != TallyScheme.AGGREGATE) revert ITallyVerifier.NotAggregateScheme();
        if (!aggregate && p.tallyScheme == TallyScheme.AGGREGATE) revert ITallyVerifier.AggregateRequired();
        uint256 accepted = inbox.acceptedBallots(electionId);
        uint256 total = _sum(counts);
        if (total != accepted) revert ITallyVerifier.CountMismatch();
        bytes32 countsHash = keccak256(abi.encodePacked(counts));
        bytes32 root = inbox.ballotRoot(electionId);
        // Word 6 binds the proof to the dealt joint key. Params may also carry
        // that point; `finalize` rejects a mismatch. A zero params key is not
        // substituted in.
        if (!key.isComplete(electionId)) revert CeremonyIncomplete(electionId);
        (uint256 kx, uint256 ky) = key.publicKey(electionId);
        uint256[] memory input = TallyPublicInputs.instance(
            electionId,
            accepted,
            countsHash,
            root,
            aggregateHash_,
            TallyPublicInputs.tallyKeyHashOf(bytes32(kx), bytes32(ky))
        );
        _verify(input, a, b, c);
        _tallied[electionId] = true;
        _counts[electionId] = counts;
        _postedScheme[electionId] = aggregate ? TallyScheme.AGGREGATE : TallyScheme.SUM_ONLY;
        if (aggregate) _aggregateHash[electionId] = aggregateHash_;
        inbox.noteTallied(electionId);
        emit ITallyVerifier.TallyPosted(electionId, countsHash, total);
        if (aggregate) emit ITallyVerifier.AggregateTallyPosted(electionId, countsHash, aggregateHash_, root, total);
    }

    function _submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash) internal nonReentrant {
        _requireNotPaused();
        if (aggregatePlaintextHash == bytes32(0)) revert ITallyVerifier.EmptyCommitment();
        _operator(electionId);
        if (!key.isReleased(electionId)) revert KeyNotReleased(electionId);
        if (!_tallied[electionId]) revert ITallyVerifier.DecryptionBeforeTally(electionId);
        if (_decryptionHash[electionId] != bytes32(0)) revert ITallyVerifier.ResultAlreadyFinal(electionId);
        _decryptionHash[electionId] = aggregatePlaintextHash;
        emit ITallyVerifier.AggregateDecrypted(electionId, aggregatePlaintextHash);
    }

    function _postInterim(uint256 electionId, bytes32 resultHash) internal nonReentrant {
        _requireNotPaused();
        if (resultHash == bytes32(0)) revert ITallyVerifier.EmptyCommitment();
        _operator(electionId);
        if (_interimHash[electionId] != bytes32(0)) revert ITallyVerifier.ResultAlreadyFinal(electionId);
        _interimHash[electionId] = resultHash;
        emit ITallyVerifier.InterimResultPosted(electionId, resultHash);
    }

    function _disclose(uint256 electionId, bytes32 disclosureHash_) internal nonReentrant {
        _requireNotPaused();
        if (disclosureHash_ == bytes32(0)) revert ITallyVerifier.EmptyCommitment();
        _operator(electionId);
        if (_disclosureHash[electionId] != bytes32(0)) revert ITallyVerifier.ResultAlreadyFinal(electionId);
        _disclosureHash[electionId] = disclosureHash_;
        emit ITallyVerifier.DisclosurePosted(electionId, disclosureHash_);
    }

    /// @dev View. Reverts before the challenge window so the locked body never runs.
    function _requireReady(uint256 electionId) internal view {
        if (block.timestamp < inbox.tallyAllowedAt(electionId)) revert TooEarly(electionId);
    }

    function _operator(uint256 electionId) internal view returns (ElectionParams memory p) {
        p = _voteParams(electionId);
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
    }

    function _voteParams(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
        if (p.electionType != ElectionType.VOTE) revert NotVote();
    }

    function _verify(
        uint256[] memory input,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal view {
        address verifier = tallyProofVerifier;
        if (verifier == address(0)) revert TallyVerifierNotSet();
        if (!CappedVerifierCall.accepted(verifier, a, b, c, input)) revert ITallyVerifier.InvalidProof();
    }

    function _requireNotPaused() internal view {
        if (factory.isPaused()) revert ContractPaused();
    }

    function _reportsMock(address verifier_) internal view returns (bool) {
        (bool ok, bytes memory ret) = verifier_.staticcall(abi.encodeWithSignature("isMock()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _factoryAllowsMock() internal view returns (bool) {
        return factory.allowMockVerifiers();
    }

    function _sum(uint256[] calldata counts) internal pure returns (uint256 total) {
        for (uint256 i; i < counts.length; ++i) {
            total += counts[i];
        }
    }
}
