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
import {Bn128} from "./zk/Bn128.sol";
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

    /// @notice Armed at creation when the operator has not written a window. Zero is refused.
    uint256 public constant MIN_CHALLENGE_WINDOW = 1 hours;

    /// @notice POLL hourly partials wait this long after the hour closes and after the gate.
    uint256 public constant HOURLY_PARTIAL_DELAY = 30 minutes;

    /// @notice Unique ballots that open a POLL hour without waiting for cutoff.
    uint256 public constant HOURLY_BALLOT_GATE = 100;

    /// @dev Final partials use this hour index in the Chaum-Pedersen challenge.
    uint256 internal constant FINAL_HOUR = type(uint256).max;

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
    /// @dev True after the operator's one custom write. The armed minimum does not set this.
    mapping(uint256 => bool) private _windowCustom;
    mapping(uint256 => address) public settlementOf;
    mapping(uint256 => address) public ceremonyOf;

    struct StoredPartial {
        uint256 dX;
        uint256 dY;
        uint256 index;
        bool posted;
    }

    mapping(uint256 => address[]) private _finalGuardians;

    /// @notice POLL hourly partials. Not the one post-cutoff interim write.
    mapping(uint256 => mapping(uint256 => mapping(address => StoredPartial))) private _hourlyPartial;
    mapping(uint256 => mapping(address => StoredPartial)) private _finalPartial;
    mapping(uint256 => uint256) private _finalPartialCount;

    struct OptionCiphertext {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        bool set;
    }

    /// @notice Option 0 is the supplementary final ciphertext. Options 1.. are posted here.
    mapping(uint256 => mapping(uint256 => OptionCiphertext)) private _optionCt;

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
    function submitDecryption(uint256 electionId, bytes32 aggregatePlaintextHash, uint8[] calldata subset)
        external
        nonReentrant
    {
        _requireNotPaused();
        if (aggregatePlaintextHash == bytes32(0)) revert EmptyCommitment();
        // Same clock as tally posting: challenge window, supplementary batch, and VOTE stays sealed until cutoff.
        // `subset` picks which posted guardian indexes open the ciphertext. Legacy elections ignore it.
        (,, ElectionParams memory p) = _authorize(electionId);
        if (!_tallied[electionId]) revert DecryptionBeforeTally(electionId);
        _checkDecryption(electionId, p.electionType, aggregatePlaintextHash, subset);
        if (_decryptionHash[electionId] != bytes32(0)) revert ResultAlreadyFinal(electionId);
        _decryptionHash[electionId] = aggregatePlaintextHash;
        emit AggregateDecrypted(electionId, aggregatePlaintextHash);
    }

    /// @notice Ciphertext for option `option` (1-based extra options). Option 0 is the final batch ciphertext.
    ///         The identity point with `set` true is a count of zero, not a missing ciphertext.
    function postOptionCiphertext(
        uint256 electionId,
        uint8 option,
        uint256 c1X,
        uint256 c1Y,
        uint256 c2X,
        uint256 c2Y
    ) external {
        ElectionParams memory p = _operatorParams(electionId);
        if (option == 0) revert CiphertextMissing();
        if (p.electionType == ElectionType.VOTE && block.timestamp < p.cutoffTime) revert ResultsSealedUntilEnd(electionId);
        if (_optionCt[electionId][option].set) revert ResultAlreadyFinal(electionId);
        _optionCt[electionId][option] = OptionCiphertext({c1X: c1X, c1Y: c1Y, c2X: c2X, c2Y: c2Y, set: true});
    }

    /// @inheritdoc ITallyVerifier
    function postInterimResult(uint256 electionId, bytes32 resultHash) external nonReentrant {
        _requireNotPaused();
        if (resultHash == bytes32(0)) revert EmptyCommitment();
        ElectionParams memory p = _operatorParams(electionId);
        _revertIfVoteSealed(electionId, p);
        _revertIfZeroWindow(electionId, p);
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
        _revertIfZeroWindow(electionId, p);
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
        // CLOSED once cutoff and a nonzero challenge window have both passed.
        uint64 window = _challengeWindow[electionId];
        if (window == 0) revert ZeroChallengeWindow();
        if (block.timestamp < uint256(p.cutoffTime) + window) revert ChallengeWindowOpen(electionId);
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

    function _revertIfZeroWindow(uint256 electionId, ElectionParams memory p) internal view {
        if (block.timestamp >= p.cutoffTime && _challengeWindow[electionId] == 0) revert ZeroChallengeWindow();
    }

    function _requireLinksOpen(uint256 electionId) internal view {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        if (block.timestamp >= IElection(electionAddr).params().startTime) revert LinksLocked();
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
        if (secondsAfterCutoff < MIN_CHALLENGE_WINDOW) revert ChallengeWindowTooShort();
        if (_windowCustom[electionId]) revert ChallengeWindowAlreadySet(electionId);
        _challengeWindow[electionId] = secondsAfterCutoff;
        _windowCustom[electionId] = true;
    }

    /// @notice Factory arms the minimum when the slot is still zero. The operator may replace it once.
    function armChallengeWindow(uint256 electionId) external {
        if (msg.sender != address(_factory)) revert NotElectionFactory();
        if (_windowCustom[electionId] || _challengeWindow[electionId] != 0) return;
        _challengeWindow[electionId] = uint64(MIN_CHALLENGE_WINDOW);
    }

    function challengeWindow(uint256 electionId) external view returns (uint64) {
        return _challengeWindow[electionId];
    }

    function tallyAllowedAt(uint256 electionId) public view returns (uint256) {
        address electionAddr = _factory.getElection(electionId);
        if (electionAddr == address(0)) revert UnknownElection();
        uint64 window = _challengeWindow[electionId];
        if (window == 0) revert ZeroChallengeWindow();
        return uint256(IElection(electionAddr).params().cutoffTime) + window;
    }

    function setRollupSettlement(uint256 electionId, address settlement_) external {
        if (!_factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        _requireLinksOpen(electionId);
        if (settlement_ == address(0)) revert ZeroAddress();
        address cur = settlementOf[electionId];
        if (cur != address(0) && cur != settlement_) revert SettlementAlreadySet();
        settlementOf[electionId] = settlement_;
    }

    function setCeremony(uint256 electionId, address ceremony_) external {
        if (!_factory.isSuperAdmin(msg.sender)) revert NotSuperAdmin();
        _requireLinksOpen(electionId);
        if (ceremony_ == address(0)) revert ZeroAddress();
        address cur = ceremonyOf[electionId];
        if (cur != address(0) && cur != ceremony_) revert CeremonyAlreadySet();
        ceremonyOf[electionId] = ceremony_;
    }

    function submitHourlyPartial(
        uint256 electionId,
        uint256 hourIndex,
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
        if (p.electionType != ElectionType.POLL) revert NotPoll();
        address settlement = settlementOf[electionId];
        if (settlement == address(0)) revert CiphertextMissing();
        IRollupSettlement rollup = IRollupSettlement(settlement);
        if (!rollup.hourPosted(electionId, hourIndex)) revert HourNotPosted();
        if (block.timestamp < uint256(rollup.hourClosedAt(electionId, hourIndex)) + HOURLY_PARTIAL_DELAY) {
            revert HourGateClosed();
        }
        address inbox = IElection(_factory.getElection(electionId)).inbox();
        uint256 ballots = IBallotInbox(inbox).firstBallots(electionId);
        if (ballots < HOURLY_BALLOT_GATE && block.timestamp < uint256(p.cutoffTime) + HOURLY_PARTIAL_DELAY) {
            revert HourGateClosed();
        }
        IRollupSettlement.Ciphertext memory ct = rollup.hourlyCiphertext(electionId, hourIndex);
        if (!ct.set) revert CiphertextMissing();
        _storePartial(
            _hourlyPartial[electionId][hourIndex][msg.sender],
            electionId,
            p.electionType,
            ct.c1X,
            ct.c1Y,
            dX,
            dY,
            aX,
            aY,
            bX,
            bY,
            z,
            hourIndex,
            false
        );
    }

    function hourlyPartialPosted(uint256 electionId, uint256 hourIndex, address guardian) external view returns (bool) {
        return _hourlyPartial[electionId][hourIndex][guardian].posted;
    }

    function submitFinalPartial(
        uint256 electionId,
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
        address settlement = settlementOf[electionId];
        if (settlement == address(0)) revert CiphertextMissing();
        IRollupSettlement.Ciphertext memory ct = IRollupSettlement(settlement).finalCiphertext(electionId);
        if (!ct.set) revert CiphertextMissing();
        _storePartial(
            _finalPartial[electionId][msg.sender],
            electionId,
            p.electionType,
            ct.c1X,
            ct.c1Y,
            dX,
            dY,
            aX,
            aY,
            bX,
            bY,
            z,
            FINAL_HOUR,
            true
        );
    }

    function finalPartialCount(uint256 electionId) external view returns (uint256) {
        return _finalPartialCount[electionId];
    }

    function _requireSupplementary(uint256 electionId) internal view {
        address settlement = settlementOf[electionId];
        if (settlement == address(0)) return;
        if (!IRollupSettlement(settlement).supplementaryPosted(electionId)) {
            revert SupplementaryBatchRequired(electionId);
        }
    }

    /// @dev No ceremony and no settlement keeps the legacy write-once hash.
    ///      A sealed election opens each option to `M = counts[i] · G`.
    ///      The identity ciphertext is a count of zero and does not need shares.
    function _checkDecryption(
        uint256 electionId,
        uint8 electionType,
        bytes32 plaintextHash,
        uint8[] calldata subset
    ) internal view {
        address cerAddr = ceremonyOf[electionId];
        address settlement = settlementOf[electionId];
        if (cerAddr == address(0) && settlement == address(0)) return;
        if (cerAddr == address(0) || settlement == address(0)) revert KeyNotPosted();
        GuardianCeremony cer = GuardianCeremony(cerAddr);
        if (!cer.keyPosted(electionId, electionType)) revert KeyNotPosted();
        uint256 k = cer.threshold(electionId, electionType);
        uint256[] memory counts = _counts[electionId];
        if (keccak256(abi.encode(counts)) != plaintextHash) revert PlaintextMismatch();
        bool needShares;
        for (uint256 i; i < counts.length; ++i) {
            (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, bool set) = _optionPoint(electionId, i);
            if (!set) revert CiphertextMissing();
            if (c1x == 0 && c1y == 0 && c2x == 0 && c2y == 0) {
                if (counts[i] != 0) revert PlaintextMismatch();
                continue;
            }
            needShares = true;
            if (subset.length != k) revert NotEnoughPartials(electionId);
            (uint256 mx, uint256 my) = _combine(electionId, electionType, c2x, c2y, subset);
            (bool ok, uint256 ex, uint256 ey) = Bn128.mul(1, 2, counts[i]);
            if (!ok || mx != ex || my != ey) revert PlaintextMismatch();
        }
        if (!needShares && subset.length != 0) revert InvalidPartial();
    }

    function _optionPoint(uint256 electionId, uint256 option)
        internal
        view
        returns (uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y, bool set)
    {
        if (option == 0) {
            IRollupSettlement.Ciphertext memory ct = IRollupSettlement(settlementOf[electionId]).finalCiphertext(electionId);
            return (ct.c1X, ct.c1Y, ct.c2X, ct.c2Y, ct.set);
        }
        OptionCiphertext storage row = _optionCt[electionId][option];
        return (row.c1X, row.c1Y, row.c2X, row.c2Y, row.set);
    }

    function _combine(
        uint256 electionId,
        uint8 electionType,
        uint256 c2x,
        uint256 c2y,
        uint8[] calldata subset
    ) internal view returns (uint256 mx, uint256 my) {
        GuardianCeremony cer = GuardianCeremony(ceremonyOf[electionId]);
        uint256 k = subset.length;
        if (k == 0 || k > 16) revert NotEnoughPartials(electionId);
        uint256[16] memory idx;
        uint256[16] memory dx;
        uint256[16] memory dy;
        for (uint256 i; i < k; ++i) {
            uint8 index = subset[i];
            if (index == 0) revert InvalidPartial();
            for (uint256 j; j < i; ++j) {
                if (subset[j] == index) revert InvalidPartial();
            }
            address who = cer.guardianAt(electionId, electionType, index);
            StoredPartial storage part = _finalPartial[electionId][who];
            if (!part.posted || part.index != index) revert InvalidPartial();
            (uint256 pkX,, bool okGuardian) = cer.guardianPk(electionId, electionType, who);
            if (!okGuardian || pkX == 0) revert InvalidPartial();
            idx[i] = part.index;
            dx[i] = part.dX;
            dy[i] = part.dY;
        }
        mx = c2x;
        my = c2y;
        for (uint256 i; i < k; ++i) {
            uint256 lambda = _lambda(idx, i, k);
            (bool ok, uint256 sx, uint256 sy) = Bn128.mul(dx[i], dy[i], lambda);
            if (!ok) revert InvalidPartial();
            (uint256 nx, uint256 ny) = Bn128.neg(sx, sy);
            (ok, mx, my) = Bn128.add(mx, my, nx, ny);
            if (!ok) revert InvalidPartial();
        }
    }

    /// @dev λ_i(0) = Π_{j≠i} x_j * inv(x_j - x_i) mod r. Indices are the 1-based post order.
    function _lambda(uint256[16] memory idx, uint256 i, uint256 k) internal pure returns (uint256) {
        uint256 num = 1;
        uint256 den = 1;
        uint256 xi = idx[i] % Bn128.R;
        for (uint256 j; j < k; ++j) {
            if (j == i) continue;
            uint256 xj = idx[j] % Bn128.R;
            num = mulmod(num, xj, Bn128.R);
            den = mulmod(den, addmod(xj, Bn128.R - xi, Bn128.R), Bn128.R);
        }
        return mulmod(num, _inv(den), Bn128.R);
    }

    function _inv(uint256 a) internal pure returns (uint256 res) {
        res = 1;
        uint256 base = a % Bn128.R;
        uint256 exp = Bn128.R - 2;
        while (exp > 0) {
            if (exp & 1 == 1) res = mulmod(res, base, Bn128.R);
            base = mulmod(base, base, Bn128.R);
            exp >>= 1;
        }
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
        uint256 z,
        uint256 hourIndex,
        bool finalPartial
    ) internal {
        if (slot.posted) revert PartialAlreadyPosted();
        address cer = ceremonyOf[electionId];
        if (cer == address(0)) revert NotGuardian();
        (uint256 pkX, uint256 pkY, bool guardian) =
            GuardianCeremony(cer).guardianPk(electionId, electionType, msg.sender);
        if (!guardian) revert NotGuardian();
        if (
            !ChaumPedersen.verify(
                pkX, pkY, c1X, c1Y, dX, dY, aX, aY, bX, bY, z, electionId, hourIndex, msg.sender
            )
        ) revert InvalidPartial();
        slot.dX = dX;
        slot.dY = dY;
        slot.index = GuardianCeremony(cer).guardianIndex(electionId, electionType, msg.sender);
        slot.posted = true;
        if (finalPartial) {
            _finalGuardians[electionId].push(msg.sender);
            unchecked {
                _finalPartialCount[electionId] += 1;
            }
        }
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
