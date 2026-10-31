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
import {BallotDigest} from "../zk/BallotDigest.sol";
import {Bn128} from "../zk/Bn128.sol";
import {IndexedRoot} from "../zk/IndexedRoot.sol";
import {OneHot} from "../zk/OneHot.sol";

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
    /// @notice Unique voters published by the last hourly or supplementary batch.
    mapping(uint256 => uint256) public postedUnique;
    /// @notice Unique voters on one posted hour. The hourly gate reads this, not a live counter.
    mapping(uint256 => mapping(uint256 => uint256)) public hourUnique;
    /// @notice Option ciphertexts, index-aligned with each ballot's choice vector.
    mapping(uint256 => mapping(uint256 => Ciphertext)) private _optionCt;

    /// @notice Primary ciphertext of a submission this contract has applied.
    struct StoredBallot {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        uint8 n;
        uint256 vectorHash;
        bool set;
    }

    /// @notice Settled primary and option-vector hash, keyed by submission id.
    mapping(uint256 => mapping(uint256 => StoredBallot)) private _stored;
    /// @notice Settled option points for that submission. Proof words are not stored.
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Ciphertext))) private _storedOpt;

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
    ///      `pointTag` is the Poseidon fold of the eight running coordinates, reduced mod r.
    ///      Option totals are not in this hash. The contract sums them from the ballot rows.
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

    /// @notice Poseidon fold of each ballot link, matching the batch circuit's chainHash.
    function chainHashOf(BallotRow[] memory rows) public pure returns (bytes32) {
        uint256 h;
        for (uint256 i; i < rows.length; ++i) {
            h = PoseidonT3.hashLeftRight(h, _link(rows[i]));
        }
        return bytes32(h);
    }

    /// @dev Six words: submission, the new primary, and the previous submission id.
    ///      `isFirst` and the previous ciphertext are not in the public fold.
    function _link(BallotRow memory row) private pure returns (uint256 h) {
        h = PoseidonT3.hashLeftRight(h, row.submissionId % SNARK_SCALAR_FIELD);
        h = PoseidonT3.hashLeftRight(h, row.c1X % SNARK_SCALAR_FIELD);
        h = PoseidonT3.hashLeftRight(h, row.c1Y % SNARK_SCALAR_FIELD);
        h = PoseidonT3.hashLeftRight(h, row.c2X % SNARK_SCALAR_FIELD);
        h = PoseidonT3.hashLeftRight(h, row.c2Y % SNARK_SCALAR_FIELD);
        h = PoseidonT3.hashLeftRight(h, row.oldSubmissionId % SNARK_SCALAR_FIELD);
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

    function optionCiphertext(uint256 electionId, uint256 option) external view returns (Ciphertext memory) {
        if (_optionCt[electionId][option].set) return _optionCt[electionId][option];
        if (option == 0) return _finalCt[electionId];
        return _optionCt[electionId][option];
    }

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        _onlyOperator();
        uint256 hourIndex = block.timestamp / 1 hours;
        if (_hourPosted[params.electionId][hourIndex]) revert HourAlreadyPosted();
        _prepareHourOrFinal(params, KIND_HOURLY, boundRoots, firstBallotTags, rows, options);
        _matchUnique(params);
        _matchProducts(params, true);
        _checkRows(params, KIND_HOURLY, rows);
        _verifyAndStore(params, a, b, c);
        _consumeTags(params.electionId, firstBallotTags);
        _rememberRoot(params);
        _storePoints(params, true);
        _storeOptions(params.electionId, KIND_HOURLY, rows, options);
        _hourPosted[params.electionId][hourIndex] = true;
        _hourClosedAt[params.electionId][hourIndex] = uint64(block.timestamp);
        _hourCt[params.electionId][hourIndex] =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        postedUnique[params.electionId] = params.nextUnique;
        hourUnique[params.electionId][hourIndex] = params.nextUnique;
        emit SealedBatchPosted(
            params.electionId, KIND_HOURLY, params.batchIndex, params.ballotSetRoot, params.nextUnique
        );
    }

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        bool open = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE && !mockMode;
        if (!open) _onlyOperator();
        _prepareHourOrFinal(params, KIND_FINAL, boundRoots, firstBallotTags, rows, options);
        _matchProducts(params, false);
        _checkRows(params, KIND_FINAL, rows);
        if (IBallotInbox(inbox).unconsumedCount(params.electionId) != 0) revert UnconsumedBallot();
        _verifyAndStore(params, a, b, c);
        _finalPosted[params.electionId] = true;
        _finalRoot[params.electionId] = params.ballotSetRoot;
        _rememberRoot(params);
        _storePoints(params, false);
        _storeOptions(params.electionId, KIND_FINAL, rows, options);
        _finalCt[params.electionId] =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        emit SealedBatchPosted(
            params.electionId, KIND_FINAL, params.batchIndex, params.ballotSetRoot, params.previousUnique
        );
    }

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        _authSupplementary(known, allowedAt);
        bool afterGrace = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE;
        if (!_finalPosted[params.electionId] && !afterGrace) revert FinalBatchRequired();
        if (_supplementaryPosted[params.electionId]) revert SupplementaryAlreadyPosted();
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        if (params.hourlyProduct != _hourlyProduct[params.electionId]) revert HourlyProductChanged();
        if (params.previousHourly != _hourlyProduct[params.electionId]) revert ProductMismatch();
        if (params.chainHash != chainHashOf(rows)) revert DataHashMismatch();
        if (uint256(params.tagHash) != foldScalars(includedIds)) revert DataHashMismatch();
        if (options.length > 4) revert OptionTotalMismatch();
        _matchUnique(params);
        _matchProducts(params, false);
        _checkRows(params, KIND_SUPPLEMENTARY, rows);
        _checkSealedHash(params, KIND_SUPPLEMENTARY);
        _coverPending(params.electionId, includedIds);
        _verifyAndStore(params, a, b, c);
        _finalProduct[params.electionId] = params.finalProduct;
        _storePoints(params, false);
        _storeOptions(params.electionId, KIND_SUPPLEMENTARY, rows, options);
        _finalCt[params.electionId] =
            Ciphertext(params.nextC1X, params.nextC1Y, params.nextC2X, params.nextC2Y, _pointsSet(params));
        if (!_finalPosted[params.electionId]) {
            _finalPosted[params.electionId] = true;
            _finalRoot[params.electionId] = _lastHourlyRoot[params.electionId] == bytes32(0)
                ? params.ballotSetRoot
                : _lastHourlyRoot[params.electionId];
        }
        postedUnique[params.electionId] = params.nextUnique;
        _markChunks(params.electionId, includedIds);
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
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
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
        if (params.chainHash != chainHashOf(rows)) revert DataHashMismatch();
        if (options.length > 4) revert OptionTotalMismatch();
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
        if (boundRoots.length > 4) revert BoundRootMismatch();
        if (boundRoots.length == 0) return;
        bytes32 last = _lastHourlyRoot[electionId];
        bytes32 empty = bytes32(IndexedRoot.empty(IndexedRoot.DEPTH));
        for (uint256 i; i < boundRoots.length; ++i) {
            bytes32 root = boundRoots[i];
            if (root == bytes32(0)) revert BoundRootMismatch();
            bool known = _rootIndex[electionId][root] != 0 || root == empty;
            if (!known) revert BoundRootMismatch();
            if (i == 0) {
                bytes32 expect = last == bytes32(0) ? empty : last;
                if (root != expect) revert BoundRootMismatch();
            }
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
        if (params.previousUnique != postedUnique[params.electionId]) revert UniqueCountMismatch();
    }

    function _matchProducts(SealedParams calldata params, bool hourly) internal view {
        if (params.previousHourly != _hourlyProduct[params.electionId]) revert ProductMismatch();
        if (params.previousFinal != _finalProduct[params.electionId]) revert ProductMismatch();
        Ciphertext memory stored =
            hourly ? _hourlyPoints[params.electionId] : _finalOpening(params.electionId);
        if (
            params.prevC1X != stored.c1X || params.prevC1Y != stored.c1Y || params.prevC2X != stored.c2X
                || params.prevC2Y != stored.c2Y
        ) revert PointsMismatch();
    }

    /// @dev The first final or supplementary batch starts from the hourly ciphertext.
    ///      Later batches continue the final chain.
    function _finalOpening(uint256 electionId) internal view returns (Ciphertext memory) {
        if (_finalPosted[electionId]) return _finalPoints[electionId];
        Ciphertext memory fin = _finalPoints[electionId];
        if (fin.c1X != 0 || fin.c1Y != 0 || fin.c2X != 0 || fin.c2Y != 0) return fin;
        return _hourlyPoints[electionId];
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

    function _requireLinked(uint256 electionId) internal view {
        if (inbox == address(0)) revert NotAuthorized();
        (bool ok, bytes memory ret) = inbox.staticcall(abi.encodeWithSignature("settlementOf(uint256)", electionId));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != address(this)) revert NotAuthorized();
    }

    function _requireNotPaused() internal view {
        if (electionFactory == address(0)) return;
        (bool ok, bytes memory ret) = electionFactory.staticcall(abi.encodeWithSignature("isPaused()"));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) revert ContractPaused();
    }

    /// @dev A first ballot (`oldSubmissionId` 0) adds the ciphertext.
    ///      A replacement is rejected on the hourly path before it is consumed.
    ///      On a final or supplementary batch the stored vector is subtracted and the new one is added.
    ///      The number of first ballots must equal `nextUnique - previousUnique`.
    ///      Each row spends an accepted inbox submission whose ballot hash is the ordered vector.
    function _checkRows(SealedParams calldata params, uint8 kind, BallotRow[] calldata rows) internal {
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        uint256 step = params.nextUnique - params.previousUnique;
        uint256 x = params.prevC1X;
        uint256 y = params.prevC1Y;
        uint256 u = params.prevC2X;
        uint256 v = params.prevC2Y;
        if (rows.length == 0) {
            if (x != params.nextC1X || y != params.nextC1Y || u != params.nextC2X || v != params.nextC2Y) {
                revert PointsMismatch();
            }
            if (step != 0) revert UniqueStepMismatch();
            return;
        }
        (uint256 pkX, uint256 pkY) = _joint(params.electionId);
        uint256 firsts;
        for (uint256 i; i < rows.length; ++i) {
            uint256 addFirst;
            (x, y, u, v, addFirst) = _settlePrimary(params.electionId, kind, rows[i], pkX, pkY, x, y, u, v);
            firsts += addFirst;
        }
        if (firsts != step) revert UniqueStepMismatch();
        if (x != params.nextC1X || y != params.nextC1Y || u != params.nextC2X || v != params.nextC2Y) {
            revert PointsMismatch();
        }
    }

    function _settlePrimary(
        uint256 electionId,
        uint8 kind,
        BallotRow calldata row,
        uint256 pkX,
        uint256 pkY,
        uint256 x,
        uint256 y,
        uint256 u,
        uint256 v
    ) internal returns (uint256, uint256, uint256, uint256, uint256) {
        if (row.oldSubmissionId != 0 && kind == KIND_HOURLY) revert ReplacementOnHourly();
        if (_isIdentity(row.c1X, row.c1Y, row.c2X, row.c2Y)) revert IdentityCiphertext();
        if (!_pointOk(row.c1X, row.c1Y, row.c2X, row.c2Y)) revert PointOffCurve();
        if (!OneHot.verify(
                pkX,
                pkY,
                row.c1X,
                row.c1Y,
                row.c2X,
                row.c2Y,
                row.oneHot,
                electionId,
                row.submissionId,
                type(uint256).max
            )) revert OneHotRejected();
        uint256 first;
        if (row.oldSubmissionId == 0) {
            first = 1;
            (x, y, u, v) = _addCt(x, y, u, v, row.c1X, row.c1Y, row.c2X, row.c2Y);
        } else {
            (uint256 ox, uint256 oy, uint256 ou, uint256 ov) = _loadOldPrimary(electionId, row.oldSubmissionId);
            (x, y, u, v) = _subCt(x, y, u, v, ox, oy, ou, ov);
            (x, y, u, v) = _addCt(x, y, u, v, row.c1X, row.c1Y, row.c2X, row.c2Y);
        }
        IBallotInbox(inbox).consumeForSettlement(electionId, row.submissionId, _cipherHash(row));
        return (x, y, u, v, first);
    }

    /// @dev Recompute the stored option-vector hash and, when it is non-empty, the sum.
    function _loadOldPrimary(uint256 electionId, uint256 oldSubmissionId)
        internal
        view
        returns (uint256 ox, uint256 oy, uint256 ou, uint256 ov)
    {
        StoredBallot storage old = _stored[electionId][oldSubmissionId];
        if (!old.set) revert OldOptionsMismatch();
        if (!Bn128.validPoint(old.c1X, old.c1Y) || !Bn128.validPoint(old.c2X, old.c2Y)) revert PointOffCurve();
        if (_storedVectorHash(electionId, oldSubmissionId, old.n) != old.vectorHash) revert OldOptionsMismatch();
        if (old.n > 0) _requireStoredSum(electionId, oldSubmissionId, old);
        return (old.c1X, old.c1Y, old.c2X, old.c2Y);
    }

    function _storedVectorHash(uint256 electionId, uint256 submissionId, uint256 n) internal view returns (uint256 h) {
        h = PoseidonT3.hashLeftRight(0, n);
        for (uint256 j; j < n; ++j) {
            Ciphertext storage o = _storedOpt[electionId][submissionId][j];
            h = PoseidonT3.hashLeftRight(h, BallotDigest.ciphertextHash(o.c1X, o.c1Y, o.c2X, o.c2Y));
        }
    }

    function _requireStoredSum(uint256 electionId, uint256 submissionId, StoredBallot storage old) internal view {
        uint256 sx;
        uint256 sy;
        uint256 su;
        uint256 sv;
        for (uint256 j; j < old.n; ++j) {
            Ciphertext storage o = _storedOpt[electionId][submissionId][j];
            if (!Bn128.validPoint(o.c1X, o.c1Y) || !Bn128.validPoint(o.c2X, o.c2Y)) revert PointOffCurve();
            (sx, sy, su, sv) = _addCt(sx, sy, su, sv, o.c1X, o.c1Y, o.c2X, o.c2Y);
        }
        if (sx != old.c1X || sy != old.c1Y || su != old.c2X || sv != old.c2Y) revert OldOptionsMismatch();
    }

    function _cipherHash(BallotRow calldata row) internal pure returns (uint256) {
        return BallotDigest.commit(row.c1X, row.c1Y, row.c2X, row.c2Y, row.options);
    }

    /// @dev Option totals are the sum of the row vectors. A claimed point that differs reverts.
    ///      An empty vector may publish the identity (count 0) at each claimed index.
    function _storeOptions(
        uint256 electionId,
        uint8 kind,
        BallotRow[] calldata rows,
        OptionPoint[] calldata claimed
    ) internal {
        uint256 n = _vectorLen(rows);
        if (rows.length != 0 && claimed.length != n) revert OptionTotalMismatch();
        if (n > 4) revert OptionTotalMismatch();
        if (n == 0) {
            for (uint256 i; i < claimed.length; ++i) {
                if (!_isIdentity(claimed[i].c1X, claimed[i].c1Y, claimed[i].c2X, claimed[i].c2Y)) {
                    revert OptionTotalMismatch();
                }
                _optionCt[electionId][i] = Ciphertext(0, 0, 0, 0, true);
            }
            for (uint256 r; r < rows.length; ++r) {
                if (rows[r].oldSubmissionId != 0) {
                    if (kind == KIND_HOURLY) revert ReplacementOnHourly();
                    _subtractStoredOptions(electionId, rows[r].oldSubmissionId);
                }
                _remember(electionId, rows[r]);
            }
            return;
        }
        (uint256 pkX, uint256 pkY) = _joint(electionId);
        for (uint256 i; i < rows.length; ++i) {
            _foldRowOptions(electionId, kind, rows[i], n, pkX, pkY);
        }
        for (uint256 j; j < n; ++j) {
            Ciphertext storage ct = _optionCt[electionId][j];
            if (
                ct.c1X != claimed[j].c1X || ct.c1Y != claimed[j].c1Y || ct.c2X != claimed[j].c2X
                    || ct.c2Y != claimed[j].c2Y
            ) revert OptionTotalMismatch();
        }
    }

    function _vectorLen(BallotRow[] calldata rows) internal pure returns (uint256 n) {
        for (uint256 i; i < rows.length; ++i) {
            uint256 len = rows[i].options.length;
            if (i == 0) n = len;
            else if (len != n) revert OptionTotalMismatch();
        }
    }

    function _foldRowOptions(
        uint256 electionId,
        uint8 kind,
        BallotRow calldata row,
        uint256 n,
        uint256 pkX,
        uint256 pkY
    ) internal {
        (uint256 sx, uint256 sy, uint256 su, uint256 sv) = _sumChecked(row, pkX, pkY, electionId);
        if (sx != row.c1X || sy != row.c1Y || su != row.c2X || sv != row.c2Y) revert OptionTotalMismatch();
        if (!OneHot.verifySum(pkX, pkY, sx, sy, su, sv, row.sumProof, electionId, row.submissionId)) {
            revert SumToOneRejected();
        }
        if (row.oldSubmissionId != 0 && kind == KIND_HOURLY) revert ReplacementOnHourly();
        if (row.oldSubmissionId != 0) _subtractStoredOptions(electionId, row.oldSubmissionId);
        for (uint256 j; j < n; ++j) {
            OptionCipher calldata cur = row.options[j];
            _bump(electionId, j, cur.c1X, cur.c1Y, cur.c2X, cur.c2Y, true);
        }
        _remember(electionId, row);
    }

    function _subtractStoredOptions(uint256 electionId, uint256 oldSubmissionId) internal {
        StoredBallot storage old = _stored[electionId][oldSubmissionId];
        if (!old.set) revert OldOptionsMismatch();
        for (uint256 j; j < old.n; ++j) {
            Ciphertext storage o = _storedOpt[electionId][oldSubmissionId][j];
            if (_isIdentity(o.c1X, o.c1Y, o.c2X, o.c2Y)) revert IdentityCiphertext();
            _bump(electionId, j, o.c1X, o.c1Y, o.c2X, o.c2Y, false);
        }
    }

    function _remember(uint256 electionId, BallotRow calldata row) internal {
        uint256 id = row.submissionId % SNARK_SCALAR_FIELD;
        StoredBallot storage saved = _stored[electionId][id];
        saved.c1X = row.c1X;
        saved.c1Y = row.c1Y;
        saved.c2X = row.c2X;
        saved.c2Y = row.c2Y;
        saved.n = uint8(row.options.length);
        saved.vectorHash = BallotDigest.vectorHash(row.options);
        saved.set = true;
        for (uint256 j; j < row.options.length; ++j) {
            _storedOpt[electionId][id][j] =
                Ciphertext(row.options[j].c1X, row.options[j].c1Y, row.options[j].c2X, row.options[j].c2Y, true);
        }
    }

    function _sumChecked(BallotRow calldata row, uint256 pkX, uint256 pkY, uint256 electionId)
        internal
        view
        returns (uint256 sx, uint256 sy, uint256 su, uint256 sv)
    {
        uint256 n = row.options.length;
        for (uint256 j; j < n; ++j) {
            OptionCipher calldata o = row.options[j];
            if (_isIdentity(o.c1X, o.c1Y, o.c2X, o.c2Y)) revert IdentityCiphertext();
            if (!_pointOk(o.c1X, o.c1Y, o.c2X, o.c2Y)) revert PointOffCurve();
            if (!OneHot.verify(
                    pkX, pkY, o.c1X, o.c1Y, o.c2X, o.c2Y, o.oneHot, electionId, row.submissionId, j
                )) revert OneHotRejected();
            (sx, sy, su, sv) = _addCt(sx, sy, su, sv, o.c1X, o.c1Y, o.c2X, o.c2Y);
        }
    }

    function _bump(
        uint256 electionId,
        uint256 option,
        uint256 x,
        uint256 y,
        uint256 u,
        uint256 v,
        bool add
    ) internal {
        if (!Bn128.validPoint(x, y) || !Bn128.validPoint(u, v)) revert PointOffCurve();
        Ciphertext storage ct = _optionCt[electionId][option];
        uint256 nx;
        uint256 ny;
        uint256 nu;
        uint256 nv;
        if (add) (nx, ny, nu, nv) = _addCt(ct.c1X, ct.c1Y, ct.c2X, ct.c2Y, x, y, u, v);
        else (nx, ny, nu, nv) = _subCt(ct.c1X, ct.c1Y, ct.c2X, ct.c2Y, x, y, u, v);
        ct.c1X = nx;
        ct.c1Y = ny;
        ct.c2X = nu;
        ct.c2Y = nv;
        ct.set = true;
    }

    function _markChunks(uint256 electionId, uint256[] calldata included) internal {
        if (inbox == address(0)) revert NotAuthorized();
        uint256 n = included.length;
        if (n == 0) {
            IBallotInbox(inbox).markSealed(electionId, included);
            return;
        }
        uint256 offset;
        while (offset < n) {
            uint256 len = n - offset;
            if (len > 8) len = 8;
            uint256[] memory chunk = new uint256[](len);
            for (uint256 j; j < len; ++j) {
                chunk[j] = included[offset + j];
            }
            IBallotInbox(inbox).markSealed(electionId, chunk);
            offset += len;
        }
    }

    function _joint(uint256 electionId) internal view returns (uint256 x, uint256 y) {
        (bool ok, bytes memory ret) = inbox.staticcall(abi.encodeWithSignature("ceremonyOf(uint256)", electionId));
        if (!ok || ret.length < 32) revert OneHotRejected();
        address cer = abi.decode(ret, (address));
        if (cer == address(0)) revert OneHotRejected();
        uint8 electionType = _electionType(electionId);
        (ok, ret) = cer.staticcall(abi.encodeWithSignature("jointKey(uint256,uint8)", electionId, electionType));
        if (!ok || ret.length < 64) revert OneHotRejected();
        (x, y) = abi.decode(ret, (uint256, uint256));
        if (!Bn128.validPoint(x, y) || (x == 0 && y == 0)) revert OneHotRejected();
    }

    function _electionType(uint256 electionId) internal view returns (uint8) {
        address el = IElectionFactory(electionFactory).getElection(electionId);
        return IElection(el).params().electionType;
    }

    function _pointOk(uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) internal view returns (bool) {
        return Bn128.validPoint(c1x, c1y) && Bn128.validPoint(c2x, c2y);
    }

    function _isIdentity(uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) internal pure returns (bool) {
        return c1x == 0 && c1y == 0 && c2x == 0 && c2y == 0;
    }

    function _addCt(
        uint256 x,
        uint256 y,
        uint256 u,
        uint256 v,
        uint256 ax,
        uint256 ay,
        uint256 bx,
        uint256 by
    ) internal view returns (uint256, uint256, uint256, uint256) {
        (bool ok1, uint256 nx, uint256 ny) = Bn128.ecAdd(x, y, ax, ay);
        if (!ok1) revert PointOffCurve();
        (bool ok2, uint256 nu, uint256 nv) = Bn128.ecAdd(u, v, bx, by);
        if (!ok2) revert PointOffCurve();
        return (nx, ny, nu, nv);
    }

    function _subCt(
        uint256 x,
        uint256 y,
        uint256 u,
        uint256 v,
        uint256 ax,
        uint256 ay,
        uint256 bx,
        uint256 by
    ) internal view returns (uint256, uint256, uint256, uint256) {
        (bool ok1, uint256 nx, uint256 ny) = Bn128.ecSub(x, y, ax, ay);
        if (!ok1) revert PointOffCurve();
        (bool ok2, uint256 nu, uint256 nv) = Bn128.ecSub(u, v, bx, by);
        if (!ok2) revert PointOffCurve();
        return (nx, ny, nu, nv);
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
