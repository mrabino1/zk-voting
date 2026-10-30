// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams, ElectionType, TallyScheme} from "./interfaces/ElectionParams.sol";
import {GuardianCeremony} from "./GuardianCeremony.sol";
import {IBallotInbox} from "./interfaces/IBallotInbox.sol";
import {IElection} from "./interfaces/IElection.sol";
import {IElectionFactory} from "./interfaces/IElectionFactory.sol";
import {IRollupSettlement} from "./interfaces/IRollupSettlement.sol";
import {ITallyVerifier} from "./interfaces/ITallyVerifier.sol";
import {ChaumPedersen} from "./zk/ChaumPedersen.sol";
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
    /// @notice Hash of the decrypted aggregate totals. Not a list of openings.
    mapping(uint256 => bytes32) private _decryptionHash;
    mapping(uint256 => bytes32) private _interimHash;
    mapping(uint256 => bytes32) private _disclosureHash;
    /// @dev Set by the one post-cutoff write. A pre-cutoff value does not set it.
    mapping(uint256 => bool) private _interimFinal;
    mapping(uint256 => bool) private _disclosureFinal;
    mapping(uint256 => bytes32[]) private _components;

    /// @notice Groth16 verifier for the `TallyPublicInputs` instance. Set once.
    address public tallyProofVerifier;

    /// @dev Appended slot. 1 while a tally submission is inside `nonReentrant`.
    uint256 private _reentrancyLock;

    mapping(uint256 => uint64) private _challengeWindow;
    address public rollupSettlement;
    address public ceremony;

    struct StoredPartial {
        uint256 dX;
        uint256 dY;
        bytes32 proofHash;
        bool posted;
    }

    /// @notice POLL hourly partials. Not the one post-cutoff interim write.
    mapping(uint256 => mapping(uint256 => mapping(address => StoredPartial))) private _hourlyPartial;
    mapping(uint256 => mapping(address => StoredPartial)) private _finalPartial;
    mapping(uint256 => uint256) private _finalPartialCount;

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
    function submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash) external nonReentrant {
        _requireNotPaused();
        if (aggregatePlaintextHash == bytes32(0)) revert EmptyCommitment();
        // Same clock as tally posting: challenge window, supplementary batch, and VOTE stays sealed until cutoff.
        // The argument is one aggregate hash. There is no openings array.
        (,, ElectionParams memory p) = _authorize(electionId);
        if (!_tallied[electionId]) revert DecryptionBeforeTally(electionId);
        _requirePartials(electionId, p.electionType);
        if (_decryptionHash[electionId] != bytes32(0)) revert ResultAlreadyFinal(electionId);
        _decryptionHash[electionId] = aggregatePlaintextHash;
        emit AggregateDecrypted(electionId, aggregatePlaintextHash);
    }

    /// @inheritdoc ITallyVerifier
    function postInterimResult(uint256 electionId, bytes32 resultHash) external nonReentrant {
        _requireNotPaused();
        if (resultHash == bytes32(0)) revert EmptyCommitment();
        ElectionParams memory p = _operatorParams(electionId);
        _revertIfVoteSealed(electionId, p);
        // A pre-cutoff interim may be replaced until cutoff. The one write at or
        // after cutoff is the certified final value, even when an interim is
        // already stored. It requires a posted tally. A later write reverts.
        _revertIfFinalBeforeTally(electionId, p);
        _revertIfFinal(electionId, p, _interimFinal[electionId]);
        if (block.timestamp >= p.cutoffTime) _interimFinal[electionId] = true;
        _interimHash[electionId] = resultHash;
        emit InterimResultPosted(electionId, resultHash);
    }

    /// @inheritdoc ITallyVerifier
    function disclose(uint256 electionId, bytes32 disclosureHash_) external nonReentrant {
        _requireNotPaused();
        if (disclosureHash_ == bytes32(0)) revert EmptyCommitment();
        ElectionParams memory p = _operatorParams(electionId);
        _revertIfVoteSealed(electionId, p);
        _revertIfFinalBeforeTally(electionId, p);
        _revertIfFinal(electionId, p, _disclosureFinal[electionId]);
        if (block.timestamp >= p.cutoffTime) _disclosureFinal[electionId] = true;
        _disclosureHash[electionId] = disclosureHash_;
        emit DisclosurePosted(electionId, disclosureHash_);
    }

    /// @inheritdoc ITallyVerifier
    function addTallyComponent(uint256 electionId, bytes32 componentHash) external nonReentrant {
        _requireNotPaused();
        if (componentHash == bytes32(0)) revert EmptyCommitment();
        ElectionParams memory p = _operatorParams(electionId);
        _revertIfVoteSealed(electionId, p);
        if (block.timestamp >= p.cutoffTime) revert TallyComponentsClosed(electionId);
        bytes32[] storage list = _components[electionId];
        if (list.length >= MAX_TALLY_OPTIONS) revert TooManyTallyComponents();
        list.push(componentHash);
        emit TallyComponentAdded(electionId, list.length - 1, componentHash);
    }

    /// @inheritdoc ITallyVerifier
    function decryptionHash(uint256 electionId) external view returns (bytes32) {
        return _decryptionHash[electionId];
    }

    /// @inheritdoc ITallyVerifier
    function interimResult(uint256 electionId) external view returns (bytes32) {
        return _interimHash[electionId];
    }

    /// @inheritdoc ITallyVerifier
    function disclosureHash(uint256 electionId) external view returns (bytes32) {
        return _disclosureHash[electionId];
    }

    /// @inheritdoc ITallyVerifier
    function tallyComponentCount(uint256 electionId) external view returns (uint256) {
        return _components[electionId].length;
    }

    /// @inheritdoc ITallyVerifier
    function tallyComponentAt(uint256 electionId, uint256 index) external view returns (bytes32) {
        if (index >= _components[electionId].length) revert TallyComponentOutOfRange(index);
        return _components[electionId][index];
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
        // VOTE publishes nothing before the end. POLL keeps the cutoff rule below.
        _revertIfVoteSealed(electionId, p);
        // CLOSED once cutoff and the challenge window have both passed.
        if (block.timestamp < p.cutoffTime + _challengeWindow[electionId]) revert ChallengeWindowOpen(electionId);
        _requireSupplementary(electionId);
        verifier = tallyProofVerifier;
        if (verifier == address(0)) revert TallyVerifierNotSet();
        inbox = election.inbox();
    }

    function _operatorParams(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
        if (msg.sender != p.tallyOperator) revert NotTallyOperator();
    }

    function _revertIfVoteSealed(uint256 electionId, ElectionParams memory p) internal view {
        if (p.electionType == ElectionType.VOTE && block.timestamp < p.cutoffTime) {
            revert ResultsSealedUntilEnd(electionId);
        }
    }

    /// @dev The certified final hash is posted only after `submitTally`.
    function _revertIfFinalBeforeTally(uint256 electionId, ElectionParams memory p) internal view {
        if (block.timestamp >= p.cutoffTime && !_tallied[electionId]) revert FinalBeforeTally(electionId);
    }

    /// @dev The post-cutoff write of this field has already happened.
    ///      A hash stored only before cutoff does not count.
    function _revertIfFinal(uint256 electionId, ElectionParams memory p, bool alreadyFinal) internal view {
        if (block.timestamp >= p.cutoffTime && alreadyFinal) {
            revert ResultAlreadyFinal(electionId);
        }
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

    function setChallengeWindow(uint256 electionId, uint64 secondsAfterCutoff) external {
        ElectionParams memory p = _operatorParams(electionId);
        if (block.timestamp >= p.startTime) revert ChallengeWindowLocked(electionId);
        if (secondsAfterCutoff == 0) revert ZeroChallengeWindow();
        if (_challengeWindow[electionId] != 0) revert ChallengeWindowAlreadySet(electionId);
        _challengeWindow[electionId] = secondsAfterCutoff;
    }

    function challengeWindow(uint256 electionId) external view returns (uint64) {
        return _challengeWindow[electionId];
    }

    function tallyAllowedAt(uint256 electionId) public view returns (uint256) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        return uint256(IElection(electionAddr).params().cutoffTime) + _challengeWindow[electionId];
    }

    function setRollupSettlement(address settlement_) external {
        if (!_factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        if (settlement_ == address(0)) revert ZeroAddress();
        if (rollupSettlement != address(0) && rollupSettlement != settlement_) revert SettlementAlreadySet();
        rollupSettlement = settlement_;
    }

    function setCeremony(address ceremony_) external {
        if (!_factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        if (ceremony_ == address(0)) revert ZeroAddress();
        if (ceremony != address(0) && ceremony != ceremony_) revert CeremonyAlreadySet();
        ceremony = ceremony_;
    }

    function submitHourlyPartial(
        uint256 electionId,
        uint256 hourIndex,
        uint256 c1X,
        uint256 c1Y,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z
    ) external nonReentrant {
        _requireNotPaused();
        ElectionParams memory p = _paramsOf(electionId);
        _storePartial(
            _hourlyPartial[electionId][hourIndex][msg.sender],
            electionId,
            p.electionType,
            c1X,
            c1Y,
            dX,
            dY,
            aX,
            aY,
            bX,
            bY,
            z
        );
    }

    function hourlyPartialPosted(uint256 electionId, uint256 hourIndex, address guardian) external view returns (bool) {
        return _hourlyPartial[electionId][hourIndex][guardian].posted;
    }

    function submitFinalPartial(
        uint256 electionId,
        uint256 c1X,
        uint256 c1Y,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z
    ) external nonReentrant {
        _requireNotPaused();
        _requireSupplementary(electionId);
        if (block.timestamp < tallyAllowedAt(electionId)) revert FinalPartialTooEarly(electionId);
        ElectionParams memory p = _paramsOf(electionId);
        _storePartial(
            _finalPartial[electionId][msg.sender], electionId, p.electionType, c1X, c1Y, dX, dY, aX, aY, bX, bY, z
        );
        unchecked {
            _finalPartialCount[electionId] += 1;
        }
    }

    function finalPartialCount(uint256 electionId) external view returns (uint256) {
        return _finalPartialCount[electionId];
    }

    function _requireSupplementary(uint256 electionId) internal view {
        if (rollupSettlement == address(0)) return;
        if (!IRollupSettlement(rollupSettlement).supplementaryPosted(electionId)) {
            revert SupplementaryBatchRequired(electionId);
        }
    }

    function _requirePartials(uint256 electionId, uint8 electionType) internal view {
        if (ceremony == address(0)) return;
        if (!GuardianCeremony(ceremony).keyPosted(electionId, electionType)) return;
        uint256 k = GuardianCeremony(ceremony).threshold(electionId, electionType);
        if (_finalPartialCount[electionId] < k) revert NotEnoughPartials(electionId);
    }

    function _paramsOf(uint256 electionId) internal view returns (ElectionParams memory p) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        p = IElection(electionAddr).params();
    }

    function _storePartial(
        StoredPartial storage slot,
        uint256 electionId,
        uint8 electionType,
        uint256 c1X,
        uint256 c1Y,
        uint256 dX,
        uint256 dY,
        uint256 aX,
        uint256 aY,
        uint256 bX,
        uint256 bY,
        uint256 z
    ) internal {
        if (slot.posted) revert PartialAlreadyPosted();
        if (ceremony == address(0)) revert NotGuardian();
        (uint256 pkX, uint256 pkY, bool guardian) =
            GuardianCeremony(ceremony).guardianPk(electionId, electionType, msg.sender);
        if (!guardian) revert NotGuardian();
        if (!ChaumPedersen.verify(pkX, pkY, c1X, c1Y, dX, dY, aX, aY, bX, bY, z)) revert InvalidPartial();
        slot.dX = dX;
        slot.dY = dY;
        slot.proofHash = keccak256(abi.encode(aX, aY, bX, bY, z));
        slot.posted = true;
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
