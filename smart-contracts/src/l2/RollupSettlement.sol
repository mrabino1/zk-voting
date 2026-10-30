// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../interfaces/ElectionParams.sol";
import {IBallotInbox} from "../interfaces/IBallotInbox.sol";
import {IElection} from "../interfaces/IElection.sol";
import {IElectionFactory} from "../interfaces/IElectionFactory.sol";
import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";
import {IRollupSettlement} from "../interfaces/IRollupSettlement.sol";
import {PoseidonT3} from "../hasher/PoseidonT3.sol";

/// @title RollupSettlement
/// @notice L1 settlement for ZK-Voting L2 (app-specific ZK rollup). No token.
/// @dev Audit H-06: outside `mockMode` a batch verifier is mandatory (constructor
///      reverts `VerifierRequired`) and every batch is verified. Public inputs
///      are reduced mod r so a snarkjs verifier never rejects them for being
///      out of field. `mockMode` is a constructor-time, explicit dev/test flag.
contract RollupSettlement is IRollupSettlement {
    bytes32 public constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");
    bytes32 public constant PROVER_ROLE = keccak256("PROVER_ROLE");

    /// @notice BN254 scalar field modulus r.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    address public admin;
    address public sequencer;
    address public prover;
    address public batchVerifier;
    bool public mockMode;
    bytes32 public stateRoot;
    uint64 public batchCount;
    mapping(uint64 => Batch) private _batches;
    /// @notice Audit M-05: every L2 state root this contract has settled
    ///         (genesis or a batch's `newStateRoot`), for `L1TallyMirror`.
    mapping(bytes32 => bool) public isSettledRoot;

    /// @notice One hour. An honest sequencer can land the supplementary batch in that time.
    ///         A stall cannot hold the tally for longer than one missed hour.
    uint256 public constant SUPPLEMENTARY_GRACE = 1 hours;
    uint8 public constant KIND_HOURLY = 1;
    uint8 public constant KIND_FINAL = 2;
    uint8 public constant KIND_SUPPLEMENTARY = 3;

    address public electionFactory;
    address public inbox;
    mapping(uint256 => bool) private _supplementaryPosted;
    mapping(uint256 => bytes32) private _lastHourlyRoot;
    mapping(uint256 => bool) private _finalPosted;
    mapping(uint256 => bytes32) private _finalRoot;
    mapping(uint256 => bytes32) private _hourlyProduct;
    mapping(uint256 => bytes32) private _finalProduct;
    mapping(uint256 => bytes32[]) private _roots;
    mapping(uint256 => mapping(bytes32 => uint256)) private _rootIndex;
    mapping(uint256 => mapping(bytes32 => bool)) private _tagUsed;
    mapping(uint256 => mapping(uint256 => bool)) private _hourPosted;
    mapping(uint256 => mapping(uint256 => uint64)) private _hourClosedAt;
    mapping(uint256 => mapping(uint256 => Ciphertext)) private _hourCt;
    mapping(uint256 => Ciphertext) private _finalCt;
    mapping(uint256 => Ciphertext) private _hourlyPoints;
    mapping(uint256 => Ciphertext) private _finalPoints;

    constructor(address admin_, address sequencer_, address prover_, address batchVerifier_, bool mockMode_) {
        if (admin_ == address(0) || sequencer_ == address(0) || prover_ == address(0)) revert ZeroAddress();
        if (!mockMode_ && batchVerifier_ == address(0)) revert VerifierRequired();
        admin = admin_;
        sequencer = sequencer_;
        prover = prover_;
        batchVerifier = batchVerifier_;
        mockMode = mockMode_;
    }

    modifier onlyOperator() {
        if (msg.sender != sequencer && msg.sender != prover && msg.sender != admin) revert NotAuthorized();
        _;
    }

    /// @notice Rotate the sequencer or prover. Admin only; other roles revert.
    function grantRole(bytes32 role, address account) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (account == address(0)) revert ZeroAddress();
        if (role == SEQUENCER_ROLE) {
            sequencer = account;
            emit SequencerSet(account);
        } else if (role == PROVER_ROLE) {
            prover = account;
            emit ProverSet(account);
        } else {
            revert UnsupportedRole();
        }
    }

    function setGenesis(bytes32 genesisRoot) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (batchCount != 0) revert GenesisAlreadySet();
        stateRoot = genesisRoot;
        isSettledRoot[genesisRoot] = true;
        emit GenesisSet(genesisRoot);
    }

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(batchIndex, prevStateRoot, newStateRoot));
    }

    function hashBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot) external pure returns (bytes32) {
        return computeDataHash(batchIndex, prevStateRoot, newStateRoot);
    }

    function submitBatch(
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external onlyOperator {
        if (batchIndex != batchCount) revert BadBatchIndex();
        if (prevStateRoot != stateRoot) revert PrevRootMismatch();
        if (dataHash != computeDataHash(batchIndex, prevStateRoot, newStateRoot)) revert DataHashMismatch();

        if (!mockMode) {
            uint256[] memory input = batchPublicInputs(batchIndex, prevStateRoot, newStateRoot, dataHash);
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }

        _batches[batchIndex] = Batch({
            prevStateRoot: prevStateRoot,
            newStateRoot: newStateRoot,
            dataHash: dataHash,
            l1Block: block.number,
            dataLength: 0
        });
        stateRoot = newStateRoot;
        isSettledRoot[newStateRoot] = true;
        unchecked {
            batchCount += 1;
        }
        emit BatchSubmitted(batchIndex, newStateRoot, dataHash, block.number);
    }

    /// @notice Groth16 instance for a batch; every word is reduced mod r.
    function batchPublicInputs(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash)
        public
        pure
        returns (uint256[] memory input)
    {
        input = new uint256[](4);
        input[0] = uint256(prevStateRoot) % SNARK_SCALAR_FIELD;
        input[1] = uint256(newStateRoot) % SNARK_SCALAR_FIELD;
        input[2] = uint256(dataHash) % SNARK_SCALAR_FIELD;
        input[3] = uint256(batchIndex);
    }

    function getBatch(uint64 batchIndex) external view returns (Batch memory) {
        return _batches[batchIndex];
    }

    function setElectionFactory(address factory_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (factory_ == address(0)) revert ZeroAddress();
        if (electionFactory != address(0) && electionFactory != factory_) revert AlreadySet();
        electionFactory = factory_;
    }

    function setInbox(address inbox_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (inbox_ == address(0)) revert ZeroAddress();
        if (inbox != address(0) && inbox != inbox_) revert AlreadySet();
        inbox = inbox_;
    }

    function supplementaryPosted(uint256 electionId) external view returns (bool) {
        return _supplementaryPosted[electionId];
    }

    function lastHourlyRoot(uint256 electionId) external view returns (bytes32) {
        return _lastHourlyRoot[electionId];
    }

    function finalBatchPosted(uint256 electionId) external view returns (bool) {
        return _finalPosted[electionId];
    }

    function finalBatchRoot(uint256 electionId) external view returns (bytes32) {
        return _finalRoot[electionId];
    }

    function finalProduct(uint256 electionId) external view returns (bytes32) {
        return _finalProduct[electionId];
    }

    function hourlyProduct(uint256 electionId) external view returns (bytes32) {
        return _hourlyProduct[electionId];
    }

    function postedBallotRoot(uint256 electionId, bytes32 root) external view returns (bool) {
        if (root == bytes32(0)) return false;
        return _rootIndex[electionId][root] != 0;
    }

    function hourPosted(uint256 electionId, uint256 hourIndex) external view returns (bool) {
        return _hourPosted[electionId][hourIndex];
    }

    function hourClosedAt(uint256 electionId, uint256 hourIndex) external view returns (uint64) {
        return _hourClosedAt[electionId][hourIndex];
    }

    function hourlyCiphertext(uint256 electionId, uint256 hourIndex) external view returns (Ciphertext memory) {
        return _hourCt[electionId][hourIndex];
    }

    function finalCiphertext(uint256 electionId) external view returns (Ciphertext memory) {
        return _finalCt[electionId];
    }

    function chainedHourly(uint256 electionId) external view returns (Ciphertext memory) {
        return _hourlyPoints[electionId];
    }

    function chainedFinal(uint256 electionId) external view returns (Ciphertext memory) {
        return _finalPoints[electionId];
    }

    function supplementaryChainHash(uint256 electionId) public view returns (bytes32) {
        return keccak256(abi.encodePacked(_roots[electionId]));
    }

    function hashWords(bytes32[] calldata words) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(words));
    }

    /// @dev Poseidon chain, same order as `circuits/batch_transition_lib.circom`.
    ///      `pointTag` is the Poseidon fold of the eight curve coordinates, reduced mod r.
    function computeSealedDataHash(SealedParams memory params, uint8 kind) public pure returns (bytes32) {
        uint256 pointTag = foldScalars(
            _eight(
                params.prevC1X,
                params.prevC1Y,
                params.prevC2X,
                params.prevC2Y,
                params.nextC1X,
                params.nextC1Y,
                params.nextC2X,
                params.nextC2Y
            )
        );
        uint256[16] memory words;
        words[0] = kind;
        words[1] = params.electionId;
        words[2] = params.batchIndex;
        words[3] = uint256(params.prevStateRoot) % SNARK_SCALAR_FIELD;
        words[4] = uint256(params.newStateRoot) % SNARK_SCALAR_FIELD;
        words[5] = uint256(params.ballotSetRoot) % SNARK_SCALAR_FIELD;
        words[6] = uint256(params.previousHourly) % SNARK_SCALAR_FIELD;
        words[7] = uint256(params.hourlyProduct) % SNARK_SCALAR_FIELD;
        words[8] = uint256(params.previousFinal) % SNARK_SCALAR_FIELD;
        words[9] = uint256(params.finalProduct) % SNARK_SCALAR_FIELD;
        words[10] = params.previousUnique;
        words[11] = params.nextUnique;
        words[12] = uint256(params.chainHash) % SNARK_SCALAR_FIELD;
        words[13] = uint256(params.tagHash) % SNARK_SCALAR_FIELD;
        words[14] = uint256(params.boundRootHash) % SNARK_SCALAR_FIELD;
        words[15] = pointTag;
        uint256 h;
        for (uint256 i; i < words.length; ++i) {
            h = PoseidonT3.hashLeftRight(h, words[i]);
        }
        return bytes32(h);
    }

    /// @notice Poseidon fold. An empty list folds to 0. Each word is reduced mod r.
    function foldWords(bytes32[] memory words) public pure returns (bytes32) {
        uint256 h;
        for (uint256 i; i < words.length; ++i) {
            h = PoseidonT3.hashLeftRight(h, uint256(words[i]) % SNARK_SCALAR_FIELD);
        }
        return bytes32(h);
    }

    function foldScalars(uint256[] memory words) public pure returns (uint256 h) {
        for (uint256 i; i < words.length; ++i) {
            h = PoseidonT3.hashLeftRight(h, words[i] % SNARK_SCALAR_FIELD);
        }
    }

    function _eight(
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d,
        uint256 e,
        uint256 f,
        uint256 g,
        uint256 h
    ) private pure returns (uint256[] memory words) {
        words = new uint256[](8);
        words[0] = a;
        words[1] = b;
        words[2] = c;
        words[3] = d;
        words[4] = e;
        words[5] = f;
        words[6] = g;
        words[7] = h;
    }

    /// @notice Fold of the bound-root list, or of the previous ballot-set root when the list is empty.
    function expectedBoundHash(bytes32[] memory bound, bytes32 lastRoot) public pure returns (bytes32) {
        if (bound.length == 0) {
            bytes32[] memory one = new bytes32[](1);
            one[0] = lastRoot;
            return foldWords(one);
        }
        return foldWords(bound);
    }

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireFactory();
        _onlyOperator();
        uint256 hourIndex = block.timestamp / 1 hours;
        if (_hourPosted[params.electionId][hourIndex]) revert HourAlreadyPosted();
        _prepareHourOrFinal(params, KIND_HOURLY, boundRoots, firstBallotTags);
        _matchUnique(params);
        _matchProducts(params, true);
        _verifyAndStore(params, a, b, c);
        _consumeTags(params.electionId, firstBallotTags);
        _rememberRoot(params);
        _storePoints(params, true);
        _hourPosted[params.electionId][hourIndex] = true;
        _hourClosedAt[params.electionId][hourIndex] = uint64(block.timestamp);
        _hourCt[params.electionId][hourIndex] =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        _commitUnique(params.electionId, params.nextUnique);
        emit SealedBatchPosted(
            params.electionId, KIND_HOURLY, params.batchIndex, params.ballotSetRoot, params.nextUnique
        );
    }

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireFactory();
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        bool open = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE && !mockMode;
        if (!open) _onlyOperator();
        _prepareHourOrFinal(params, KIND_FINAL, boundRoots, firstBallotTags);
        _matchProducts(params, false);
        _verifyAndStore(params, a, b, c);
        _finalPosted[params.electionId] = true;
        _finalRoot[params.electionId] = params.ballotSetRoot;
        _rememberRoot(params);
        _storePoints(params, false);
        emit SealedBatchPosted(
            params.electionId, KIND_FINAL, params.batchIndex, params.ballotSetRoot, params.previousUnique
        );
    }

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireFactory();
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        _authSupplementary(known, allowedAt);
        bool afterGrace = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE;
        if (!_finalPosted[params.electionId] && !afterGrace) revert FinalBatchRequired();
        if (_supplementaryPosted[params.electionId]) revert SupplementaryAlreadyPosted();
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        if (params.hourlyProduct != _hourlyProduct[params.electionId]) revert HourlyProductChanged();
        if (params.previousHourly != _hourlyProduct[params.electionId]) revert ProductMismatch();
        if (params.chainHash != supplementaryChainHash(params.electionId)) revert DataHashMismatch();
        _matchUnique(params);
        _matchProducts(params, false);
        _checkSealedHash(params, KIND_SUPPLEMENTARY);
        _coverPending(params.electionId, includedIds);
        _verifyAndStore(params, a, b, c);
        _finalProduct[params.electionId] = params.finalProduct;
        _storePoints(params, false);
        _finalCt[params.electionId] =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        if (!_finalPosted[params.electionId]) {
            _finalPosted[params.electionId] = true;
            _finalRoot[params.electionId] = _lastHourlyRoot[params.electionId] == bytes32(0)
                ? params.ballotSetRoot
                : _lastHourlyRoot[params.electionId];
        }
        _commitUnique(params.electionId, params.nextUnique);
        if (inbox == address(0)) revert NotAuthorized();
        IBallotInbox(inbox).markSealed(params.electionId, includedIds);
        _supplementaryPosted[params.electionId] = true;
        emit SupplementaryPosted(params.electionId);
        emit SealedBatchPosted(
            params.electionId, KIND_SUPPLEMENTARY, params.batchIndex, params.ballotSetRoot, params.nextUnique
        );
    }

    function _onlyOperator() internal view {
        if (msg.sender != sequencer && msg.sender != prover && msg.sender != admin) revert NotAuthorized();
    }

    function _prepareHourOrFinal(
        SealedParams calldata params,
        uint8 kind,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags
    ) internal view {
        (bool known, uint64 cutoff,) = _cutoff(params.electionId);
        if (kind == KIND_HOURLY) {
            if (known && block.timestamp >= cutoff) revert HourlyWindowClosed();
            if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        } else {
            if (known && block.timestamp < cutoff) revert FinalBatchTooEarly();
            if (_finalPosted[params.electionId]) revert FinalBatchAlreadyPosted();
            if (params.nextUnique != params.previousUnique) revert TurnoutOnFinalBatch();
        }
        if (params.chainHash != bytes32(0)) revert DataHashMismatch();
        if (params.ballotSetRoot == bytes32(0)) revert EmptyRoot();
        _checkBoundRoots(params.electionId, boundRoots);
        _checkFirstTags(params.electionId, firstBallotTags);
        if (params.tagHash != foldWords(firstBallotTags)) revert DataHashMismatch();
        if (params.boundRootHash != expectedBoundHash(boundRoots, _lastHourlyRoot[params.electionId])) {
            revert DataHashMismatch();
        }
        _checkSealedHash(params, kind);
    }

    function _checkBoundRoots(uint256 electionId, bytes32[] calldata boundRoots) internal view {
        bytes32 expect = _lastHourlyRoot[electionId];
        for (uint256 i; i < boundRoots.length; ++i) {
            if (boundRoots[i] != expect) revert BoundRootMismatch();
        }
    }

    function _checkFirstTags(uint256 electionId, bytes32[] calldata tags) internal view {
        uint256 n = tags.length;
        for (uint256 i; i < n; ++i) {
            if (tags[i] == bytes32(0) || _tagUsed[electionId][tags[i]]) revert DuplicateFirstBallot();
            for (uint256 j; j < i; ++j) {
                if (tags[i] == tags[j]) revert DuplicateFirstBallot();
            }
        }
    }

    function _consumeTags(uint256 electionId, bytes32[] calldata tags) internal {
        for (uint256 i; i < tags.length; ++i) {
            _tagUsed[electionId][tags[i]] = true;
        }
    }

    function _matchUnique(SealedParams calldata params) internal view {
        if (inbox == address(0)) revert NotAuthorized();
        if (params.previousUnique != IBallotInbox(inbox).acceptedBallots(params.electionId)) {
            revert UniqueCountMismatch();
        }
    }

    function _matchProducts(SealedParams calldata params, bool hourly) internal view {
        if (params.previousHourly != _hourlyProduct[params.electionId]) revert ProductMismatch();
        if (params.previousFinal != _finalProduct[params.electionId]) revert ProductMismatch();
        Ciphertext storage stored = hourly ? _hourlyPoints[params.electionId] : _finalPoints[params.electionId];
        if (
            params.prevC1X != stored.c1X || params.prevC1Y != stored.c1Y || params.prevC2X != stored.c2X
                || params.prevC2Y != stored.c2Y
        ) revert PointsMismatch();
    }

    function _storePoints(SealedParams calldata params, bool hourly) internal {
        Ciphertext memory next =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        if (hourly) _hourlyPoints[params.electionId] = next;
        else _finalPoints[params.electionId] = next;
    }

    /// @dev A stored batch always has a ciphertext, including the identity point (count 0).
    function _pointsSet(SealedParams calldata) internal pure returns (bool) {
        return true;
    }

    function _requireFactory() internal view {
        if (electionFactory == address(0)) revert FactoryUnset();
    }

    function _checkSealedHash(SealedParams calldata params, uint8 kind) internal view {
        if (params.batchIndex != batchCount) revert BadBatchIndex();
        if (params.prevStateRoot != stateRoot) revert PrevRootMismatch();
        if (params.dataHash != computeSealedDataHash(params, kind)) revert DataHashMismatch();
    }

    function _verifyAndStore(
        SealedParams calldata params,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) internal {
        if (!mockMode) {
            uint256[] memory input = batchPublicInputs(
                params.batchIndex, params.prevStateRoot, params.newStateRoot, params.dataHash
            );
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }
        _batches[params.batchIndex] = Batch({
            prevStateRoot: params.prevStateRoot,
            newStateRoot: params.newStateRoot,
            dataHash: params.dataHash,
            l1Block: block.number,
            dataLength: 0
        });
        stateRoot = params.newStateRoot;
        isSettledRoot[params.newStateRoot] = true;
        unchecked {
            batchCount += 1;
        }
        emit BatchSubmitted(params.batchIndex, params.newStateRoot, params.dataHash, block.number);
    }

    function _rememberRoot(SealedParams calldata params) internal {
        _lastHourlyRoot[params.electionId] = params.ballotSetRoot;
        _roots[params.electionId].push(params.ballotSetRoot);
        _rootIndex[params.electionId][params.ballotSetRoot] = _roots[params.electionId].length;
        _hourlyProduct[params.electionId] = params.hourlyProduct;
        _finalProduct[params.electionId] = params.finalProduct;
    }

    function _commitUnique(uint256 electionId, uint256 uniqueCount) internal {
        if (inbox == address(0)) revert NotAuthorized();
        (bool ok, bytes memory ret) =
            inbox.staticcall(abi.encodeWithSignature("settlementOf(uint256)", electionId));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(this)) revert NotAuthorized();
        IBallotInbox(inbox).commitUniqueCount(electionId, uniqueCount);
    }

    function _coverPending(uint256 electionId, uint256[] calldata included) internal view {
        if (inbox == address(0)) revert NotAuthorized();
        IBallotInbox box = IBallotInbox(inbox);
        uint256 n = box.pendingCount(electionId);
        if (included.length != n) revert PendingBallotOmitted();
        for (uint256 i; i < n; ++i) {
            if (included[i] != box.pendingIdAt(electionId, i)) revert PendingBallotOmitted();
            (bytes32 root, bool pending) = box.forcedInRoot(electionId, included[i]);
            if (!pending || root == bytes32(0) || _rootIndex[electionId][root] == 0) revert UnknownBoundRoot();
        }
    }

    function _authSupplementary(bool known, uint256 allowedAt) internal view {
        if (!known || block.timestamp < allowedAt) revert SupplementaryTooEarly();
        // A mock settlement never grows a real proof, so the grace stays operator-only.
        // Outside mock mode the grace is the permissionless liveness path.
        if (mockMode || block.timestamp < allowedAt + SUPPLEMENTARY_GRACE) _onlyOperator();
    }

    function _allowedAt(uint256 electionId) internal view returns (bool known, uint256 allowedAt) {
        (known,, allowedAt) = _cutoff(electionId);
    }

    function _cutoff(uint256 electionId) internal view returns (bool known, uint64 cutoff, uint256 allowedAt) {
        if (electionFactory == address(0)) revert FactoryUnset();
        address el = IElectionFactory(electionFactory).getElection(electionId);
        if (el == address(0)) return (false, 0, 0);
        ElectionParams memory params = IElection(el).params();
        cutoff = params.cutoffTime;
        address tally = IElectionFactory(electionFactory).tallyVerifier();
        if (tally == address(0)) revert FactoryUnset();
        (bool ok, bytes memory ret) = tally.staticcall(abi.encodeWithSignature("tallyAllowedAt(uint256)", electionId));
        if (!ok || ret.length < 32) revert FactoryUnset();
        allowedAt = abi.decode(ret, (uint256));
        known = true;
    }
}
