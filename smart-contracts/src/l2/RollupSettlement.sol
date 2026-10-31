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
import {IndexedRoot} from "../zk/IndexedRoot.sol";

/// @title RollupSettlement
/// @notice L1 settlement for ZK-Voting L2 (app-specific ZK rollup). No token.
/// @dev The L2 computes the new state root and the tally. L1 checks one aggregate
///      proof of that statement and the public inputs: previous root, new root,
///      tally commitment, inbox Poseidon chain, counts, election id, and the blob
///      versioned hash. Hourly batches commit the root first. Proofs are verified
///      later, in order. An unproven root does not publish a ciphertext or finalize
///      an election. `mockMode` still publishes in the commit transaction because
///      there is no proof to defer; it is a constructor-time dev flag.
///      Audit H-06: outside `mockMode` a batch verifier is mandatory.
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
    /// @notice Kept so existing admin calls still resolve. Chunk proofs are aggregated
    ///         into the one batch proof. This address is not consulted.
    address public chunkVerifier;
    bool public mockMode;
    /// @notice How many option ciphertexts one batch may carry. Default 4. Bounds are 1..MAX_OPTIONS_BOUND.
    uint8 public maxOptions = 4;
    uint8 public constant MAX_OPTIONS_BOUND = 16;
    /// @notice Next committed batch whose aggregate proof has not been accepted.
    uint64 public nextUnproven;
    mapping(uint64 => bool) public proofVerified;
    /// @notice Poseidon head of ballots a proven or committed batch has absorbed.
    mapping(uint256 => uint256) public consumedCount;
    mapping(uint256 => bytes32) public consumedPoseidon;
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

    /// @dev Result fields copied into the public ciphertext maps when the proof is accepted.
    struct PendingResult {
        uint256 electionId;
        uint256 hourIndex;
        uint8 kind;
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        uint8 optionCount;
        bytes32 chunkDigest;
        uint256 tallyCommitment;
        bytes32 nextPoseidon;
        uint256 nextConsumed;
        bytes32 blobVersionedHash;
        bytes32 ballotSetRoot;
        bool exists;
    }

    mapping(uint64 => PendingResult) private _pending;
    mapping(uint64 => mapping(uint8 => OptionPoint)) private _pendingOpt;
    /// @notice A final batch has been committed. `finalBatchPosted` waits for its proof.
    mapping(uint256 => bool) private _finalCommitted;
    /// @notice A supplementary batch has been committed. The public flag waits for its proof.
    mapping(uint256 => bool) private _suppCommitted;

    /// @dev BLS12-381 scalar modulus. The point-evaluation precompile returns this word.
    uint256 internal constant BLS_MODULUS =
        52435875175126190479447740508185965837690552500527637822603658699938581184513;
    /// @notice Unique voters on one posted hour. The hourly gate reads this, not a live counter.
    mapping(uint256 => mapping(uint256 => uint256)) public hourUnique;
    /// @notice Option ciphertexts, index-aligned with each ballot's choice vector.
    mapping(uint256 => mapping(uint256 => Ciphertext)) private _optionCt;

    /// @notice A submission this contract has applied. The ciphertext itself stays in the inbox.
    ///         `set` is cleared when a later batch subtracts it, so it cannot be subtracted twice.
    struct StoredBallot {
        uint8 n;
        bool set;
    }

    /// @notice Settled-submission flag, keyed by submission id. One slot.
    mapping(uint256 => mapping(uint256 => StoredBallot)) private _stored;

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
        proofVerified[batchIndex] = true;
        unchecked {
            batchCount += 1;
            nextUnproven = batchCount;
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

    function setChunkVerifier(address verifier_) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (verifier_ == address(0)) revert ZeroAddress();
        chunkVerifier = verifier_;
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

    /// @dev Poseidon chain of the sealed statement. The first sixteen words match
    ///      the historical batch statement. Later words bind the inbox chain, the
    ///      aggregate chunk digest, the tally commitment, and the blob.
    ///      A non-zero `dataLength` also checks `blobhash` and the point-evaluation
    ///      precompile at 0x0A. `_checkSealedHash` repeats that check.
    function computeSealedDataHash(SealedParams memory params, uint8 kind) public view returns (bytes32) {
        _checkBlob(params);
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
        uint256[27] memory words;
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
        words[16] = params.prevConsumed;
        words[17] = params.nextConsumed;
        words[18] = uint256(params.prevPoseidon) % SNARK_SCALAR_FIELD;
        words[19] = uint256(params.nextPoseidon) % SNARK_SCALAR_FIELD;
        words[20] = uint256(params.chunkDigest) % SNARK_SCALAR_FIELD;
        words[21] = params.tallyCommitment;
        words[22] = uint256(params.blobVersionedHash) % SNARK_SCALAR_FIELD;
        words[23] = params.dataLength;
        words[24] = params.blobZ;
        words[25] = params.blobY;
        words[26] = uint256(keccak256(abi.encodePacked(params.blobCommitment, params.blobOpeningProof)))
            % SNARK_SCALAR_FIELD;
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
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata
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
        _checkStatement(params, rows, options);
        _bindRows(params, KIND_HOURLY, rows, options);
        _commitSealed(params, KIND_HOURLY, hourIndex, options);
        _consumeTags(params.electionId, firstBallotTags);
        _rememberRoot(params);
        _storePoints(params, true);
        _hourPosted[params.electionId][hourIndex] = true;
        _hourClosedAt[params.electionId][hourIndex] = uint64(block.timestamp);
        postedUnique[params.electionId] = params.nextUnique;
        hourUnique[params.electionId][hourIndex] = params.nextUnique;
        emit SealedBatchPosted(
            params.electionId,
            KIND_HOURLY,
            params.batchIndex,
            params.ballotSetRoot,
            params.nextUnique,
            params.blobVersionedHash
        );
    }

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        bool open = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE && !mockMode;
        if (!open) _onlyOperator();
        _requireCaughtUp();
        _prepareHourOrFinal(params, KIND_FINAL, boundRoots, firstBallotTags, rows, options);
        _matchProducts(params, false);
        _checkStatement(params, rows, options);
        _bindRows(params, KIND_FINAL, rows, options);
        _requireInboxHead(params);
        _finalCommitted[params.electionId] = true;
        _commitSealed(params, KIND_FINAL, 0, options);
        _rememberRoot(params);
        _storePoints(params, false);
        emit SealedBatchPosted(
            params.electionId,
            KIND_FINAL,
            params.batchIndex,
            params.ballotSetRoot,
            params.previousUnique,
            params.blobVersionedHash
        );
    }

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        _authSupplementary(known, allowedAt);
        _requireCaughtUp();
        bool afterGrace = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE;
        if (!_finalPosted[params.electionId] && !afterGrace) revert FinalBatchRequired();
        if (_supplementaryPosted[params.electionId] || _suppCommitted[params.electionId]) {
            revert SupplementaryAlreadyPosted();
        }
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        if (params.hourlyProduct != _hourlyProduct[params.electionId]) revert HourlyProductChanged();
        if (params.previousHourly != _hourlyProduct[params.electionId]) revert ProductMismatch();
        if (rows.length == 0) {
            if (params.chainHash != bytes32(0)) revert DataHashMismatch();
        }
        if (uint256(params.tagHash) != foldScalars(includedIds)) revert DataHashMismatch();
        if (options.length > maxOptions) revert OptionTotalMismatch();
        _matchUnique(params);
        _matchProducts(params, false);
        _checkStatement(params, rows, options);
        _bindRows(params, KIND_SUPPLEMENTARY, rows, options);
        _requireInboxHead(params);
        _checkSealedHash(params, KIND_SUPPLEMENTARY);
        _coverPending(params.electionId, includedIds);
        _suppCommitted[params.electionId] = true;
        _commitSealed(params, KIND_SUPPLEMENTARY, 0, options);
        _finalProduct[params.electionId] = params.finalProduct;
        _storePoints(params, false);
        postedUnique[params.electionId] = params.nextUnique;
        _markChunks(params.electionId, includedIds);
        emit SupplementaryPosted(params.electionId);
        emit SealedBatchPosted(
            params.electionId,
            KIND_SUPPLEMENTARY,
            params.batchIndex,
            params.ballotSetRoot,
            params.nextUnique,
            params.blobVersionedHash
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
            if (_finalPosted[params.electionId] || _finalCommitted[params.electionId]) {
                revert FinalBatchAlreadyPosted();
            }
            if (params.nextUnique != params.previousUnique) revert TurnoutOnFinalBatch();
        }
        if (rows.length == 0) {
            if (params.chainHash != bytes32(0)) revert DataHashMismatch();
        }
        if (options.length > maxOptions) revert OptionTotalMismatch();
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
        _checkBlob(params);
        if (params.dataHash != computeSealedDataHash(params, kind)) revert DataHashMismatch();
    }

    /// @dev Commit the root and the statement. The aggregate proof is checked later by
    ///      `verifyCommittedProof`, except in `mockMode`, which publishes immediately.
    function _commitSealed(
        SealedParams calldata params,
        uint8 kind,
        uint256 hourIndex,
        OptionPoint[] calldata options
    ) internal {
        uint64 index = params.batchIndex;
        _batches[index] = Batch({
            prevStateRoot: params.prevStateRoot,
            newStateRoot: params.newStateRoot,
            dataHash: params.dataHash,
            l1Block: block.number,
            dataLength: params.dataLength
        });
        stateRoot = params.newStateRoot;
        consumedCount[params.electionId] = params.nextConsumed;
        consumedPoseidon[params.electionId] = params.nextPoseidon;
        PendingResult storage pending = _pending[index];
        pending.electionId = params.electionId;
        pending.kind = kind;
        pending.hourIndex = hourIndex;
        pending.c1X = params.nextC1X;
        pending.c1Y = params.nextC1Y;
        pending.c2X = params.nextC2X;
        pending.c2Y = params.nextC2Y;
        pending.optionCount = uint8(options.length);
        pending.chunkDigest = params.chunkDigest;
        pending.tallyCommitment = params.tallyCommitment;
        pending.nextPoseidon = params.nextPoseidon;
        pending.nextConsumed = params.nextConsumed;
        pending.blobVersionedHash = params.blobVersionedHash;
        pending.ballotSetRoot = params.ballotSetRoot;
        pending.exists = true;
        for (uint256 i; i < options.length; ++i) {
            _pendingOpt[index][uint8(i)] = options[i];
        }
        unchecked {
            batchCount = index + 1;
        }
        emit BatchSubmitted(index, params.newStateRoot, params.dataHash, block.number);
        if (mockMode) _publish(index);
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

    /// @dev One aggregate statement. Each chunk has its own digest. A proof that reuses
    ///      one chunk's statement for another chunk does not match `chunkDigest`.
    function _checkStatement(
        SealedParams calldata params,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
    ) internal view {
        if (params.chunkDigest != chunkDigestOf(params.electionId, rows)) revert DataHashMismatch();
        if (params.tallyCommitment != tallyCommitmentOf(options)) revert OptionTotalMismatch();
        if (
            params.prevConsumed != consumedCount[params.electionId]
                || params.prevPoseidon != consumedPoseidon[params.electionId]
        ) revert UnconsumedBallot();
        if (params.dataLength == 0) {
            (uint256 n, bytes32 h) =
                projectConsumed(params.prevPoseidon, params.prevConsumed, params.electionId, rows);
            if (params.nextConsumed != n || params.nextPoseidon != h) revert UnconsumedBallot();
        }
    }

    function _requireInboxHead(SealedParams calldata params) internal view {
        if (params.nextConsumed != IBallotInbox(inbox).acceptedCount(params.electionId)) revert UnconsumedBallot();
        if (params.nextPoseidon != IBallotInbox(inbox).acceptedPoseidon(params.electionId)) revert UnconsumedBallot();
    }

    function _requireCaughtUp() internal view {
        if (nextUnproven != batchCount) revert UnprovenBatch();
    }

    /// @dev Bind each row to the ballot the inbox accepted. The tally sum is not computed
    ///      here. The aggregate proof attests that the committed ciphertext is that sum.
    function _bindRows(
        SealedParams calldata params,
        uint8 kind,
        BallotRow[] calldata rows,
        OptionPoint[] calldata claimed
    ) internal {
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        uint256 step = params.nextUnique - params.previousUnique;
        uint256 n = _vectorLen(rows);
        if (rows.length != 0 && claimed.length != n) revert OptionTotalMismatch();
        if (n > maxOptions || claimed.length > maxOptions) revert OptionTotalMismatch();
        if (rows.length == 0) {
            if (
                params.prevC1X != params.nextC1X || params.prevC1Y != params.nextC1Y
                    || params.prevC2X != params.nextC2X || params.prevC2Y != params.nextC2Y
            ) revert PointsMismatch();
            if (step != 0) revert UniqueStepMismatch();
            for (uint256 i; i < claimed.length; ++i) {
                if (!_isIdentity(claimed[i].c1X, claimed[i].c1Y, claimed[i].c2X, claimed[i].c2Y)) {
                    revert OptionTotalMismatch();
                }
            }
            return;
        }
        uint256 firsts;
        for (uint256 i; i < rows.length; ++i) {
            firsts += _bindRow(params.electionId, kind, rows[i], n);
        }
        if (firsts != step) revert UniqueStepMismatch();
    }

    /// @dev One inbox read covers the primary and every option. The row must match that vector.
    function _bindRow(uint256 electionId, uint8 kind, BallotRow calldata row, uint256 n)
        internal
        returns (uint256 first)
    {
        if (row.oldSubmissionId != 0 && kind == KIND_HOURLY) revert ReplacementOnHourly();
        if (_isIdentity(row.c1X, row.c1Y, row.c2X, row.c2Y)) revert IdentityCiphertext();
        (
            uint256 ax,
            uint256 ay,
            uint256 au,
            uint256 av,
            uint8 acceptedN,
            bool set,
            bytes32 ballotHash,
            uint256[16] memory opts
        ) = IBallotInbox(inbox).acceptedVector(electionId, row.submissionId);
        if (!set) {
            IBallotInbox(inbox).consumeForSettlement(electionId, row.submissionId, 0);
        }
        if (ax != row.c1X || ay != row.c1Y || au != row.c2X || av != row.c2Y) {
            revert IBallotInbox.BallotHashMismatch();
        }
        if (row.oldSubmissionId == 0) {
            first = 1;
        } else {
            _requireNewer(electionId, row.submissionId, row.oldSubmissionId);
            if (!_stored[electionId][row.oldSubmissionId].set) revert OldOptionsMismatch();
        }
        IBallotInbox(inbox).consumeForSettlement(electionId, row.submissionId, uint256(ballotHash));
        _bindOptions(electionId, row, n, acceptedN, set, opts);
    }

    function _bindOptions(
        uint256 electionId,
        BallotRow calldata row,
        uint256 n,
        uint8 acceptedN,
        bool set,
        uint256[16] memory opts
    ) internal {
        if (n == 0) {
            if (row.options.length != 0) revert OptionTotalMismatch();
            if (row.oldSubmissionId != 0) _clearStored(electionId, row.oldSubmissionId, 0);
            _remember(electionId, row);
            return;
        }
        if (row.options.length != n) revert OptionTotalMismatch();
        if (!set || acceptedN != n) revert IBallotInbox.BallotHashMismatch();
        if (row.oldSubmissionId != 0) _clearStored(electionId, row.oldSubmissionId, n);
        uint256 stored = n;
        if (stored > 4) stored = 4;
        for (uint256 k; k < stored; ++k) {
            OptionCipher calldata cur = row.options[k];
            if (_isIdentity(cur.c1X, cur.c1Y, cur.c2X, cur.c2Y)) revert IdentityCiphertext();
            uint256 o = k << 2;
            if (opts[o] != cur.c1X || opts[o + 1] != cur.c1Y || opts[o + 2] != cur.c2X || opts[o + 3] != cur.c2Y) {
                revert IBallotInbox.BallotHashMismatch();
            }
        }
        for (uint256 k = stored; k < n; ++k) {
            OptionCipher calldata cur = row.options[k];
            if (_isIdentity(cur.c1X, cur.c1Y, cur.c2X, cur.c2Y)) revert IdentityCiphertext();
        }
        _remember(electionId, row);
    }

    /// @dev A replacement may be applied once. The curve subtraction is inside the proof.
    function _clearStored(uint256 electionId, uint256 oldSubmissionId, uint256 n) internal {
        StoredBallot storage old = _stored[electionId][oldSubmissionId];
        if (!old.set) revert OldOptionsMismatch();
        if ((n == 0 && old.n != 0) || (n != 0 && old.n != n)) revert OldOptionsMismatch();
        (,,,, uint8 acceptedN, bool set,, uint256[16] memory opts) =
            IBallotInbox(inbox).acceptedVector(electionId, oldSubmissionId);
        if (!set || (n != 0 && acceptedN != n)) revert OldOptionsMismatch();
        uint256 stored = n;
        if (stored > 4) stored = 4;
        for (uint256 j; j < stored; ++j) {
            uint256 o = j << 2;
            if (_isIdentity(opts[o], opts[o + 1], opts[o + 2], opts[o + 3])) revert IdentityCiphertext();
        }
        old.set = false;
    }

    function _requireNewer(uint256 electionId, uint256 submissionId, uint256 oldSubmissionId) internal view {
        uint64 newer = IBallotInbox(inbox).acceptanceSeq(electionId, submissionId);
        uint64 older = IBallotInbox(inbox).acceptanceSeq(electionId, oldSubmissionId);
        if (newer == 0 || older == 0 || newer <= older) revert StaleReplacement();
    }

    function _vectorLen(BallotRow[] calldata rows) internal pure returns (uint256 n) {
        for (uint256 i; i < rows.length; ++i) {
            uint256 len = rows[i].options.length;
            if (i == 0) n = len;
            else if (len != n) revert OptionTotalMismatch();
        }
    }

    function _remember(uint256 electionId, BallotRow calldata row) internal {
        uint256 id = row.submissionId % SNARK_SCALAR_FIELD;
        StoredBallot storage saved = _stored[electionId][id];
        saved.n = uint8(row.options.length);
        saved.set = true;
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

    function _isIdentity(uint256 c1x, uint256 c1y, uint256 c2x, uint256 c2y) internal pure returns (bool) {
        return c1x == 0 && c1y == 0 && c2x == 0 && c2y == 0;
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

    function setMaxOptions(uint8 n) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (n == 0 || n > MAX_OPTIONS_BOUND) revert OptionCapOutOfBounds();
        if (batchCount != 0) revert AlreadySet();
        maxOptions = n;
        emit MaxOptionsSet(n);
    }

    /// @notice Prove `batchIndex`. It must be the oldest committed batch that is still unproven.
    function verifyCommittedProof(
        uint64 batchIndex,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        if (proofVerified[batchIndex]) return;
        if (batchIndex != nextUnproven) revert UnprovenBatch();
        if (!_pending[batchIndex].exists) revert BadBatchIndex();
        if (!mockMode) {
            uint256[] memory input = sealedPublicInputs(batchIndex);
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }
        _publish(batchIndex);
    }

    function sealedPublicInputs(uint64 batchIndex) public view returns (uint256[] memory input) {
        Batch memory batch = _batches[batchIndex];
        PendingResult memory pending = _pending[batchIndex];
        input = new uint256[](10);
        input[0] = uint256(batch.prevStateRoot) % SNARK_SCALAR_FIELD;
        input[1] = uint256(batch.newStateRoot) % SNARK_SCALAR_FIELD;
        input[2] = uint256(batch.dataHash) % SNARK_SCALAR_FIELD;
        input[3] = uint256(batchIndex);
        input[4] = uint256(pending.chunkDigest) % SNARK_SCALAR_FIELD;
        input[5] = pending.tallyCommitment % SNARK_SCALAR_FIELD;
        input[6] = uint256(pending.nextPoseidon) % SNARK_SCALAR_FIELD;
        input[7] = pending.electionId % SNARK_SCALAR_FIELD;
        input[8] = uint256(pending.blobVersionedHash) % SNARK_SCALAR_FIELD;
        input[9] = pending.nextConsumed % SNARK_SCALAR_FIELD;
    }

    function projectConsumed(bytes32 prevPoseidon, uint256 prevCount, uint256 electionId, BallotRow[] memory rows)
        public
        view
        returns (uint256 nextCount, bytes32 nextPoseidon)
    {
        uint256 h = uint256(prevPoseidon);
        for (uint256 i; i < rows.length; ++i) {
            uint256 bh = uint256(IBallotInbox(inbox).ballotHashOf(electionId, rows[i].submissionId));
            h = PoseidonT3.hashLeftRight(h, bh);
        }
        nextCount = prevCount + rows.length;
        nextPoseidon = bytes32(h);
    }

    function chunkDigestOf(uint256 electionId, BallotRow[] memory rows) public view returns (bytes32) {
        uint256 chunks = (rows.length + 3) / 4;
        uint256 h;
        for (uint256 i; i < chunks; ++i) {
            h = PoseidonT3.hashLeftRight(h, chunkStatement(electionId, rows, i));
        }
        return bytes32(h);
    }

    function chunkStatement(uint256 electionId, BallotRow[] memory rows, uint256 chunkIndex)
        public
        view
        returns (uint256 ch)
    {
        for (uint256 j; j < 4; ++j) {
            uint256 idx = chunkIndex * 4 + j;
            uint256 sid;
            uint256 bh;
            if (idx < rows.length) {
                sid = rows[idx].submissionId % SNARK_SCALAR_FIELD;
                bh = uint256(IBallotInbox(inbox).ballotHashOf(electionId, rows[idx].submissionId));
            }
            ch = PoseidonT3.hashLeftRight(ch, sid);
            ch = PoseidonT3.hashLeftRight(ch, bh);
        }
    }

    function tallyCommitmentOf(OptionPoint[] memory options) public pure returns (uint256 h) {
        for (uint256 i; i < options.length; ++i) {
            h = PoseidonT3.hashLeftRight(h, options[i].c1X);
            h = PoseidonT3.hashLeftRight(h, options[i].c1Y);
            h = PoseidonT3.hashLeftRight(h, options[i].c2X);
            h = PoseidonT3.hashLeftRight(h, options[i].c2Y);
        }
    }

    function _publish(uint64 index) internal {
        PendingResult memory pending = _pending[index];
        if (!pending.exists || proofVerified[index]) revert UnprovenBatch();
        isSettledRoot[_batches[index].newStateRoot] = true;
        Ciphertext memory ct = Ciphertext(pending.c1X, pending.c1Y, pending.c2X, pending.c2Y, true);
        if (pending.kind == KIND_HOURLY) {
            _hourCt[pending.electionId][pending.hourIndex] = ct;
        } else {
            _finalCt[pending.electionId] = ct;
            if (pending.kind == KIND_FINAL) {
                _finalPosted[pending.electionId] = true;
                _finalRoot[pending.electionId] = pending.ballotSetRoot;
            } else {
                _supplementaryPosted[pending.electionId] = true;
                if (!_finalPosted[pending.electionId]) {
                    _finalPosted[pending.electionId] = true;
                    _finalRoot[pending.electionId] = _lastHourlyRoot[pending.electionId] == bytes32(0)
                        ? pending.ballotSetRoot
                        : _lastHourlyRoot[pending.electionId];
                }
            }
        }
        for (uint8 k; k < pending.optionCount; ++k) {
            OptionPoint memory opt = _pendingOpt[index][k];
            _optionCt[pending.electionId][k] = Ciphertext(opt.c1X, opt.c1Y, opt.c2X, opt.c2Y, true);
        }
        proofVerified[index] = true;
        if (nextUnproven == index) {
            unchecked {
                nextUnproven = index + 1;
            }
        }
        emit BatchProofVerified(index, _batches[index].newStateRoot);
    }

    /// @dev Blob versioned hash must be the transaction's `blobhash(0)`, and the
    ///      point-evaluation precompile at 0x0A must accept the opening.
    function _checkBlob(SealedParams memory params) internal view {
        if (params.dataLength == 0) {
            if (
                params.blobVersionedHash != bytes32(0) || params.blobCommitment.length != 0
                    || params.blobOpeningProof.length != 0
            ) revert BlobRejected();
            return;
        }
        if (params.blobVersionedHash == bytes32(0) || blobhash(0) != params.blobVersionedHash) revert BlobRejected();
        if (params.blobCommitment.length != 48 || params.blobOpeningProof.length != 48) revert BlobRejected();
        bytes memory input = bytes.concat(
            params.blobVersionedHash,
            abi.encode(params.blobZ),
            abi.encode(params.blobY),
            params.blobCommitment,
            params.blobOpeningProof
        );
        (bool ok, bytes memory ret) = address(0x0A).staticcall(input);
        if (!ok || ret.length != 64) revert BlobRejected();
        uint256 fieldElements;
        uint256 modulus;
        assembly ("memory-safe") {
            fieldElements := mload(add(ret, 32))
            modulus := mload(add(ret, 64))
        }
        if (fieldElements != 4096 || modulus != BLS_MODULUS) revert BlobRejected();
    }
}
