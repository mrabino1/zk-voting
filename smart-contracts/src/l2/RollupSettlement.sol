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
import {BabyJub} from "../zk/BabyJub.sol";
import {IndexedRoot} from "../zk/IndexedRoot.sol";

/// @title RollupSettlement
/// @notice L1 settlement for ZK-Voting L2 (app-specific ZK rollup). No token.
/// @dev The L2 commits a state root. Proofs are checked later, in order. Until a
///      batch verifier reports `verifiesTally()`, L1 itself adds the Baby Jubjub
///      ciphertexts and that sum is the tally. A verifier that reports `true`
///      replaces that sum: the aggregate proof must then bind the tally commitment.
///      Public inputs are the previous root, the new root, the data hash, the batch
///      index, the chunk digest, the tally commitment, the inbox Poseidon head,
///      the election id, the blob versioned hash, the consumed count, and blobY.
///      `dataHash` is the Poseidon fold in `computeSealedDataHash`. A production
///      circuit has to recompute that fold. The placeholder circuit does not.
///      An unproven batch does not publish turnout, a ballot-set root, an hour,
///      or a ciphertext. Anyone can roll a timed-out unproven batch back to the
///      last proven root. `mockMode` still publishes in the commit transaction.
///      Audit H-06: outside `mockMode` a batch verifier is mandatory.
///
///      Calldata batches are capped by `batchGasBudget`. The hard ceiling is
///      200,000,000 gas (`MAX_BATCH_GAS_BUDGET`); `setBatchGasBudget` reverts
///      above it. The default budget is 24,000,000, twelve percent of that
///      ceiling, so a batch stays a modest fraction of a block. It fits a block
///      of about 30M to 45M and leaves the rest of the block free. An operator
///      sharing a 30M block can set 12,000,000 (7 rows).
///      A local `submitHourlyBatch` measurement (on-chain Baby Jubjub sum,
///      four-option rows, `mockMode` off) fitted about 7,220,000 gas fixed, plus
///      about 225,000 per row, plus about 1,072,000 per four-row chunk, plus
///      about 4,100 gas times rows squared. The square term is why a single
///      per-row rate cannot price both a small batch and a 200M batch.
///      `modeledBatchGas` sits above that fit, including transaction calldata
///      the meter does not charge. `maxRows` is the largest row count whose
///      modeled gas is within `batchGasBudget`: 24 rows at the default, 7 rows
///      at 12,000,000, and 148 rows at 200,000,000. Those batches measured
///      21,407,996 and 170,303,976 gas. Both finished inside their budgets.
///      The meter is an internal `gasleft` delta, so a real transaction also
///      pays intrinsic gas and calldata (about 13,000 per four-option row).
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
    /// @notice How many option ciphertexts one batch may carry. Default 4.
    ///         The inbox stores four options, so the bound stays at 4 until it stores more.
    uint8 public maxOptions = 4;
    uint8 public constant MAX_OPTIONS_BOUND = 4;

    /// @notice L1 block gas ceiling. `setBatchGasBudget` reverts above this.
    uint256 public constant MAX_BATCH_GAS_BUDGET = 200_000_000;
    /// @notice Default budget. 24M is 12% of the 200M ceiling and fits in a 30M
    ///         block with room for the rest of the block. Set 12_000_000 when a
    ///         30M block must also carry other transactions (7 rows). Raise it,
    ///         up to 200M, only when the chain's block gas limit can hold the batch.
    uint256 public constant DEFAULT_BATCH_GAS_BUDGET = 24_000_000;
    /// @notice Fixed gas in `modeledBatchGas`. Above the measured intercept of
    ///         about 7,220,000, which also leaves room for the transaction overhead.
    uint256 public constant BATCH_BASE_GAS = 7_500_000;
    /// @notice Per-row gas in `modeledBatchGas`, above the measured ~225,000.
    uint256 public constant GAS_PER_CALLDATA_ROW = 250_000;
    /// @notice Gas for one four-row chunk digest in `modeledBatchGas`, above the
    ///         measured ~1,072,000.
    uint256 public constant GAS_PER_CHUNK = 1_200_000;
    /// @notice Square term in `modeledBatchGas`. The measured curve added about
    ///         4,100 gas times rows squared; 5,000 leaves headroom as batches grow.
    uint256 public constant GAS_PER_ROW_SQUARED = 5_000;
    /// @notice Operator-settable gas budget for one calldata batch. Default is
    ///         `DEFAULT_BATCH_GAS_BUDGET`. Cannot exceed `MAX_BATCH_GAS_BUDGET`.
    uint256 public batchGasBudget = DEFAULT_BATCH_GAS_BUDGET;
    /// @notice An unproven batch older than this can be rolled back by anyone.
    uint256 public constant PROOF_TIMEOUT = 1 hours;
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
        uint256 blobY;
        uint256 nextUnique;
        bytes32 hourlyProduct;
        bytes32 finalProduct;
        uint256 prevConsumed;
        bytes32 prevPoseidon;
        uint64 committedAt;
        bool exists;
    }

    /// @dev Chain head of batches that are committed and not yet proven.
    ///      Public turnout and posted roots stay on the proven maps.
    struct Working {
        uint256 uniqueCount;
        bytes32 hourlyProduct;
        bytes32 finalProduct;
        bytes32 lastRoot;
        uint256 h1x;
        uint256 h1y;
        uint256 h2x;
        uint256 h2y;
        uint256 f1x;
        uint256 f1y;
        uint256 f2x;
        uint256 f2y;
        bool hourlySet;
        bool finalSet;
        uint8 optionCount;
    }

    struct PendingLink {
        uint256 submissionId;
        uint256 oldSubmissionId;
        bool clearedOld;
    }

    struct DeferredRevote {
        uint256 submissionId;
        uint256 oldSubmissionId;
        bool applied;
    }

    mapping(uint64 => PendingResult) private _pending;
    mapping(uint64 => mapping(uint8 => OptionPoint)) private _pendingOpt;
    mapping(uint64 => bytes32[]) private _pendingTags;
    mapping(uint64 => PendingLink[]) private _pendingLinks;
    mapping(uint64 => uint256[]) private _pendingIncluded;
    mapping(uint256 => Working) private _working;
    mapping(uint256 => mapping(uint8 => OptionPoint)) private _workingOpt;
    mapping(uint256 => bool) private _dirty;
    mapping(uint256 => mapping(uint256 => bool)) private _hourPending;
    mapping(uint256 => mapping(bytes32 => bool)) private _tagPending;
    mapping(uint256 => mapping(uint256 => bool)) private _replacePending;
    mapping(uint256 => DeferredRevote[]) private _deferred;
    mapping(uint256 => uint64) public finalProvenAt;
    /// @notice A final batch has been committed. `finalBatchPosted` waits for its proof.
    mapping(uint256 => bool) private _finalCommitted;
    /// @notice A supplementary batch has been committed. The public flag waits for its proof.
    mapping(uint256 => bool) private _suppCommitted;

    /// @dev BLS12-381 scalar modulus. The point-evaluation precompile returns this word.
    uint256 public constant BLS_MODULUS =
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
        if (nextUnproven != batchCount) revert UnprovenBatch();
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
            nextUnproven = batchIndex + 1;
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

    /// @dev Poseidon chain of the sealed statement. The first sixteen words match
    ///      the historical batch statement. Later words bind the inbox chain, the
    ///      aggregate chunk digest, the tally commitment, and the blob.
    ///      A production circuit must recompute this exact fold into `dataHash`.
    ///      The point-evaluation precompile is not called here, so an off-chain
    ///      `eth_call` can build the hash. `_checkSealedHash` runs that check once.
    ///      For a non-zero `dataLength`, `blobZ` must already be
    ///      `blobChallenge(blobVersionedHash, nextPoseidon, chunkDigest)`.
    function computeSealedDataHash(SealedParams memory params, uint8 kind) public view returns (bytes32) {
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
        OptionPoint[] calldata options
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        _onlyOperator();
        _capRows(rows.length);
        uint256 hourIndex = block.timestamp / 1 hours;
        if (_hourPosted[params.electionId][hourIndex] || _hourPending[params.electionId][hourIndex]) {
            revert HourAlreadyPosted();
        }
        _prepareHourOrFinal(params, KIND_HOURLY, boundRoots, firstBallotTags, rows, options);
        _matchUnique(params);
        _matchProducts(params, true);
        _checkStatement(params, rows, options);
        _bindRows(params, KIND_HOURLY, rows, options);
        if (!_proofCarriesTally()) _requireOnChainTally(params, KIND_HOURLY, rows, options);
        _hourPending[params.electionId][hourIndex] = true;
        _commitSealed(params, KIND_HOURLY, hourIndex, options, firstBallotTags);
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
        OptionPoint[] calldata options
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        bool open = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE && !mockMode;
        if (!open) _onlyOperator();
        _requireCaughtUp();
        _capRows(rows.length);
        _prepareHourOrFinal(params, KIND_FINAL, boundRoots, firstBallotTags, rows, options);
        _matchProducts(params, false);
        _checkStatement(params, rows, options);
        _bindRows(params, KIND_FINAL, rows, options);
        _requireInboxHead(params);
        if (IBallotInbox(inbox).unconsumedCount(params.electionId) != 0) revert UnconsumedBallot();
        if (!_proofCarriesTally()) _requireOnChainTally(params, KIND_FINAL, rows, options);
        _finalCommitted[params.electionId] = true;
        _commitSealed(params, KIND_FINAL, 0, options, firstBallotTags);
        emit SealedBatchPosted(
            params.electionId,
            KIND_FINAL,
            params.batchIndex,
            params.ballotSetRoot,
            params.nextUnique,
            params.blobVersionedHash
        );
    }

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
    ) external {
        _requireNotPaused();
        _requireFactory();
        _requireLinked(params.electionId);
        (bool known, uint256 allowedAt) = _allowedAt(params.electionId);
        _authSupplementary(known, allowedAt);
        _requireCaughtUp();
        _capRows(rows.length);
        bool afterGrace = known && block.timestamp >= allowedAt + SUPPLEMENTARY_GRACE;
        if (!_finalPosted[params.electionId] && !afterGrace) revert FinalBatchRequired();
        if (_supplementaryPosted[params.electionId] || _suppCommitted[params.electionId]) {
            revert SupplementaryAlreadyPosted();
        }
        if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        if (params.hourlyProduct != _hourlyProductOf(params.electionId)) revert HourlyProductChanged();
        if (params.previousHourly != _hourlyProductOf(params.electionId)) revert ProductMismatch();
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
        if (IBallotInbox(inbox).unconsumedCount(params.electionId) != 0) revert UnconsumedBallot();
        _checkSealedHash(params, KIND_SUPPLEMENTARY);
        _coverPending(params.electionId, includedIds);
        if (!_proofCarriesTally()) _requireOnChainTally(params, KIND_SUPPLEMENTARY, rows, options);
        _suppCommitted[params.electionId] = true;
        for (uint256 i; i < includedIds.length; ++i) {
            _pendingIncluded[params.batchIndex].push(includedIds[i]);
        }
        _commitSealed(params, KIND_SUPPLEMENTARY, 0, options, new bytes32[](0));
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
            // First ballots from the last partial hour may land on the final batch.
            if (params.nextUnique < params.previousUnique) revert UniqueCountDecreased();
        }
        if (rows.length == 0) {
            if (params.chainHash != bytes32(0)) revert DataHashMismatch();
        }
        if (options.length > maxOptions) revert OptionTotalMismatch();
        if (params.ballotSetRoot == bytes32(0)) revert EmptyRoot();
        _checkBoundRoots(params.electionId, boundRoots);
        _checkFirstTags(params.electionId, firstBallotTags);
        if (params.tagHash != foldWords(firstBallotTags)) revert DataHashMismatch();
        if (params.boundRootHash != expectedBoundHash(boundRoots, _lastRootOf(params.electionId))) {
            revert DataHashMismatch();
        }
        _checkSealedHash(params, kind);
    }

    function _checkBoundRoots(uint256 electionId, bytes32[] calldata boundRoots) internal view {
        if (boundRoots.length > 4) revert BoundRootMismatch();
        if (boundRoots.length == 0) return;
        bytes32 last = _lastRootOf(electionId);
        bytes32 empty = bytes32(IndexedRoot.empty(IndexedRoot.DEPTH));
        for (uint256 i; i < boundRoots.length; ++i) {
            bytes32 root = boundRoots[i];
            if (root == bytes32(0)) revert BoundRootMismatch();
            // An unproven root is not posted. The next batch may still name it as
            // the chain head. `postedBallotRoot` stays false until the proof.
            bool known = _rootIndex[electionId][root] != 0 || root == empty || (last != bytes32(0) && root == last);
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
            if (tags[i] == bytes32(0) || _tagUsed[electionId][tags[i]] || _tagPending[electionId][tags[i]]) {
                revert DuplicateFirstBallot();
            }
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
        if (params.previousUnique != _uniqueOf(params.electionId)) revert UniqueCountMismatch();
    }

    function _matchProducts(SealedParams calldata params, bool hourly) internal view {
        if (params.previousHourly != _hourlyProductOf(params.electionId)) revert ProductMismatch();
        if (params.previousFinal != _finalProductOf(params.electionId)) revert ProductMismatch();
        Ciphertext memory stored = hourly ? _hourlyHead(params.electionId) : _finalOpening(params.electionId);
        if (
            params.prevC1X != stored.c1X || params.prevC1Y != stored.c1Y || params.prevC2X != stored.c2X
                || params.prevC2Y != stored.c2Y
        ) revert PointsMismatch();
    }

    /// @dev The first final or supplementary batch starts from the hourly ciphertext.
    ///      Later batches continue the final chain. Unproven commits are visible
    ///      here so the next batch can chain, and invisible to `hourlyCiphertext`.
    function _finalOpening(uint256 electionId) internal view returns (Ciphertext memory) {
        if (_dirty[electionId] && _working[electionId].finalSet) return _finalHead(electionId);
        if (_finalPosted[electionId]) return _finalPoints[electionId];
        Ciphertext memory fin = _finalPoints[electionId];
        if (fin.c1X != 0 || fin.c1Y != 0 || fin.c2X != 0 || fin.c2Y != 0) return fin;
        return _hourlyHead(electionId);
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

    /// @dev Commit the root and the statement. Public turnout, roots, and ciphertexts
    ///      wait for `_publish`. `mockMode` publishes in this transaction.
    function _commitSealed(
        SealedParams calldata params,
        uint8 kind,
        uint256 hourIndex,
        OptionPoint[] calldata options,
        bytes32[] memory tags
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
        pending.blobY = params.blobY;
        pending.nextUnique = params.nextUnique;
        pending.hourlyProduct = params.hourlyProduct;
        pending.finalProduct = params.finalProduct;
        pending.prevConsumed = params.prevConsumed;
        pending.prevPoseidon = params.prevPoseidon;
        pending.committedAt = uint64(block.timestamp);
        pending.exists = true;
        for (uint256 i; i < options.length; ++i) {
            _pendingOpt[index][uint8(i)] = options[i];
        }
        for (uint256 i; i < tags.length; ++i) {
            _pendingTags[index].push(tags[i]);
            _tagPending[params.electionId][tags[i]] = true;
        }
        _noteWorking(params, kind, options);
        unchecked {
            batchCount = index + 1;
        }
        emit BatchSubmitted(index, params.newStateRoot, params.dataHash, block.number);
        if (mockMode) _publish(index);
    }

    function _noteWorking(SealedParams calldata params, uint8 kind, OptionPoint[] calldata options) internal {
        Working storage w = _working[params.electionId];
        if (!_dirty[params.electionId]) {
            Ciphertext memory h = _hourlyPoints[params.electionId];
            Ciphertext memory f = _finalPoints[params.electionId];
            w.uniqueCount = postedUnique[params.electionId];
            w.hourlyProduct = _hourlyProduct[params.electionId];
            w.finalProduct = _finalProduct[params.electionId];
            w.lastRoot = _lastHourlyRoot[params.electionId];
            w.h1x = h.c1X;
            w.h1y = h.c1Y;
            w.h2x = h.c2X;
            w.h2y = h.c2Y;
            w.hourlySet = h.set || h.c1X != 0 || h.c1Y != 0 || h.c2X != 0 || h.c2Y != 0;
            w.f1x = f.c1X;
            w.f1y = f.c1Y;
            w.f2x = f.c2X;
            w.f2y = f.c2Y;
            w.finalSet = f.set || f.c1X != 0 || f.c1Y != 0 || f.c2X != 0 || f.c2Y != 0;
            _dirty[params.electionId] = true;
        }
        w.uniqueCount = params.nextUnique;
        w.hourlyProduct = params.hourlyProduct;
        w.finalProduct = params.finalProduct;
        if (kind != KIND_SUPPLEMENTARY) w.lastRoot = params.ballotSetRoot;
        if (kind == KIND_HOURLY) {
            w.h1x = params.nextC1X;
            w.h1y = params.nextC1Y;
            w.h2x = params.nextC2X;
            w.h2y = params.nextC2Y;
            w.hourlySet = true;
        } else {
            w.f1x = params.nextC1X;
            w.f1y = params.nextC1Y;
            w.f2x = params.nextC2X;
            w.f2y = params.nextC2Y;
            w.finalSet = true;
        }
        if (options.length > 0) {
            w.optionCount = uint8(options.length);
            for (uint256 i; i < options.length; ++i) {
                _workingOpt[params.electionId][uint8(i)] = options[i];
            }
        }
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
        // `dataLength` never skips the inbox step. A blob batch with rows still projects them.
        (uint256 n, bytes32 h) = projectConsumed(params.prevPoseidon, params.prevConsumed, params.electionId, rows);
        if (params.nextConsumed != n || params.nextPoseidon != h) revert UnconsumedBallot();
    }

    function _requireInboxHead(SealedParams calldata params) internal view {
        if (params.nextConsumed != IBallotInbox(inbox).acceptedCount(params.electionId)) revert UnconsumedBallot();
        if (params.nextPoseidon != IBallotInbox(inbox).acceptedPoseidon(params.electionId)) revert UnconsumedBallot();
    }

    function _requireCaughtUp() internal view {
        if (nextUnproven != batchCount) revert UnprovenBatch();
    }

    /// @dev Bind each row to the ballot the inbox accepted. The ciphertext sum, when
    ///      the verifier does not prove it, is checked by `_requireOnChainTally`.
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
            if (step != 0) revert UniqueStepMismatch();
            return;
        }
        uint256 firsts;
        for (uint256 i; i < rows.length; ++i) {
            firsts += _bindRow(params.electionId, params.batchIndex, kind, rows[i], n);
        }
        if (firsts != step) revert UniqueStepMismatch();
    }

    /// @dev One inbox read covers the primary and every option. The row must match that vector.
    ///      A re-vote in an hourly batch is recorded and applied when the final batch is proven.
    function _bindRow(uint256 electionId, uint64 batchIndex, uint8 kind, BallotRow calldata row, uint256 n)
        internal
        returns (uint256 first)
    {
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
        bool clearedOld;
        if (row.oldSubmissionId == 0) {
            first = 1;
        } else {
            _requireNewer(electionId, row.submissionId, row.oldSubmissionId);
            if (_replacePending[electionId][row.oldSubmissionId]) revert OldOptionsMismatch();
            _replacePending[electionId][row.oldSubmissionId] = true;
            // Hourly re-votes stay applied at final, so the stored ballot remains until then.
            clearedOld = kind != KIND_HOURLY;
            _clearStored(electionId, row.oldSubmissionId, n, clearedOld);
        }
        IBallotInbox(inbox).consumeForSettlement(electionId, row.submissionId, uint256(ballotHash));
        _bindOptions(row, n, acceptedN, set, opts);
        _pendingLinks[batchIndex].push(
            PendingLink({submissionId: row.submissionId, oldSubmissionId: row.oldSubmissionId, clearedOld: clearedOld})
        );
    }

    function _bindOptions(
        BallotRow calldata row,
        uint256 n,
        uint8 acceptedN,
        bool set,
        uint256[16] memory opts
    ) internal pure {
        if (n == 0) {
            if (row.options.length != 0) revert OptionTotalMismatch();
            return;
        }
        if (row.options.length != n) revert OptionTotalMismatch();
        if (!set || acceptedN != n) revert IBallotInbox.BallotHashMismatch();
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
    }

    /// @dev A replacement may be applied once. `clear` is false for an hourly re-vote,
    ///      whose ciphertext effect waits until the final batch.
    function _clearStored(uint256 electionId, uint256 oldSubmissionId, uint256 n, bool clear) internal {
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
        if (clear) old.set = false;
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

    function _rememberId(uint256 electionId, uint256 submissionId, uint8 n) internal {
        uint256 id = submissionId % SNARK_SCALAR_FIELD;
        StoredBallot storage saved = _stored[electionId][id];
        saved.n = n;
        saved.set = true;
    }

    function _markChunks(uint256 electionId, uint256[] memory included) internal {
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
            uint256[] memory input = _proofCarriesTally()
                ? sealedPublicInputs(batchIndex)
                : batchPublicInputs(
                    batchIndex,
                    _batches[batchIndex].prevStateRoot,
                    _batches[batchIndex].newStateRoot,
                    _batches[batchIndex].dataHash
                );
            if (!IGroth16Verifier(batchVerifier).verifyProof(a, b, c, input)) revert InvalidProof();
        }
        _publish(batchIndex);
    }

    function sealedPublicInputs(uint64 batchIndex) public view returns (uint256[] memory input) {
        Batch memory batch = _batches[batchIndex];
        PendingResult memory pending = _pending[batchIndex];
        input = new uint256[](11);
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
        input[10] = pending.blobY % SNARK_SCALAR_FIELD;
    }

    function projectConsumed(bytes32 prevPoseidon, uint256 prevCount, uint256 electionId, BallotRow[] memory rows)
        public
        view
        returns (uint256 nextCount, bytes32 nextPoseidon)
    {
        uint256 h = uint256(prevPoseidon);
        for (uint256 i; i < rows.length; ++i) {
            uint256 bh = uint256(IBallotInbox(inbox).ballotHashOf(electionId, rows[i].submissionId)) % SNARK_SCALAR_FIELD;
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
                bh = uint256(IBallotInbox(inbox).ballotHashOf(electionId, rows[idx].submissionId)) % SNARK_SCALAR_FIELD;
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
            _hourlyPoints[pending.electionId] = ct;
            _hourPosted[pending.electionId][pending.hourIndex] = true;
            _hourPending[pending.electionId][pending.hourIndex] = false;
            _hourClosedAt[pending.electionId][pending.hourIndex] = pending.committedAt;
            hourUnique[pending.electionId][pending.hourIndex] = pending.nextUnique;
            postedUnique[pending.electionId] = pending.nextUnique;
        } else {
            _finalCt[pending.electionId] = ct;
            _finalPoints[pending.electionId] = ct;
            postedUnique[pending.electionId] = pending.nextUnique;
            if (pending.kind == KIND_FINAL) {
                _finalPosted[pending.electionId] = true;
                _finalRoot[pending.electionId] = pending.ballotSetRoot;
                if (finalProvenAt[pending.electionId] == 0) finalProvenAt[pending.electionId] = uint64(block.timestamp);
            } else {
                _supplementaryPosted[pending.electionId] = true;
                emit SupplementaryPosted(pending.electionId);
                if (!_finalPosted[pending.electionId]) {
                    _finalPosted[pending.electionId] = true;
                    _finalRoot[pending.electionId] = _lastHourlyRoot[pending.electionId] == bytes32(0)
                        ? pending.ballotSetRoot
                        : _lastHourlyRoot[pending.electionId];
                    if (finalProvenAt[pending.electionId] == 0) {
                        finalProvenAt[pending.electionId] = uint64(block.timestamp);
                    }
                }
                uint256[] memory included = _pendingIncluded[index];
                if (included.length > 0) _markChunks(pending.electionId, included);
            }
        }
        if (pending.kind != KIND_SUPPLEMENTARY) {
            _lastHourlyRoot[pending.electionId] = pending.ballotSetRoot;
            _roots[pending.electionId].push(pending.ballotSetRoot);
            _rootIndex[pending.electionId][pending.ballotSetRoot] = _roots[pending.electionId].length;
        }
        _hourlyProduct[pending.electionId] = pending.hourlyProduct;
        _finalProduct[pending.electionId] = pending.finalProduct;
        for (uint8 k; k < pending.optionCount; ++k) {
            OptionPoint memory opt = _pendingOpt[index][k];
            _optionCt[pending.electionId][k] = Ciphertext(opt.c1X, opt.c1Y, opt.c2X, opt.c2Y, true);
        }
        _publishLinks(index, pending);
        bytes32[] storage tags = _pendingTags[index];
        for (uint256 i; i < tags.length; ++i) {
            _tagUsed[pending.electionId][tags[i]] = true;
            _tagPending[pending.electionId][tags[i]] = false;
        }
        proofVerified[index] = true;
        if (nextUnproven == index) {
            unchecked {
                nextUnproven = index + 1;
            }
        }
        if (!_electionStillPending(pending.electionId)) _dirty[pending.electionId] = false;
        emit BatchProofVerified(index, _batches[index].newStateRoot);
    }

    function _publishLinks(uint64 index, PendingResult memory pending) internal {
        PendingLink[] storage links = _pendingLinks[index];
        for (uint256 i; i < links.length; ++i) {
            PendingLink memory link = links[i];
            uint8 n = _acceptedN(pending.electionId, link.submissionId);
            if (link.oldSubmissionId == 0) {
                _rememberId(pending.electionId, link.submissionId, n);
            } else if (pending.kind == KIND_HOURLY) {
                _deferred[pending.electionId].push(
                    DeferredRevote({submissionId: link.submissionId, oldSubmissionId: link.oldSubmissionId, applied: false})
                );
            } else {
                _rememberId(pending.electionId, link.submissionId, n);
                _replacePending[pending.electionId][link.oldSubmissionId] = false;
            }
        }
        if (pending.kind != KIND_HOURLY) _applyDeferred(pending.electionId);
    }

    function _applyDeferred(uint256 electionId) internal {
        DeferredRevote[] storage list = _deferred[electionId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].applied) continue;
            uint8 n = _acceptedN(electionId, list[i].submissionId);
            if (_stored[electionId][list[i].oldSubmissionId].set) {
                _stored[electionId][list[i].oldSubmissionId].set = false;
            }
            _rememberId(electionId, list[i].submissionId, n);
            _replacePending[electionId][list[i].oldSubmissionId] = false;
            list[i].applied = true;
        }
    }

    function _acceptedN(uint256 electionId, uint256 submissionId) internal view returns (uint8 n) {
        (,,,, n,,,) = IBallotInbox(inbox).acceptedVector(electionId, submissionId);
    }

    /// @dev Blob versioned hash must be the transaction's `blobhash(0)`. The
    ///      evaluation point is derived on-chain. `dataLength == 0` skips the
    ///      precompile only. It does not skip the inbox projection.
    function _checkBlob(SealedParams memory params) internal view {
        if (params.dataLength == 0) {
            if (
                params.blobVersionedHash != bytes32(0) || params.blobZ != 0 || params.blobY != 0
                    || params.blobCommitment.length != 0 || params.blobOpeningProof.length != 0
            ) revert BlobRejected();
            return;
        }
        if (params.blobVersionedHash == bytes32(0) || blobhash(0) != params.blobVersionedHash) revert BlobRejected();
        uint256 z = blobChallenge(params.blobVersionedHash, params.nextPoseidon, params.chunkDigest);
        if (params.blobZ != z) revert BlobRejected();
        if (params.blobCommitment.length != 48 || params.blobOpeningProof.length != 48) revert BlobRejected();
        bytes memory input = bytes.concat(
            params.blobVersionedHash, abi.encode(z), abi.encode(params.blobY), params.blobCommitment, params.blobOpeningProof
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

    function blobChallenge(bytes32 versionedHash, bytes32 nextPoseidon, bytes32 chunkDigest)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(versionedHash, nextPoseidon, chunkDigest))) % BLS_MODULUS;
    }

    /// @notice Upper bound used to size `maxRows`. Above the measured
    ///         `submitHourlyBatch` curve, so a full batch stays inside the budget.
    function modeledBatchGas(uint256 rows) public pure returns (uint256) {
        uint256 chunks = (rows + 3) >> 2;
        return BATCH_BASE_GAS + GAS_PER_CALLDATA_ROW * rows + GAS_PER_CHUNK * chunks + GAS_PER_ROW_SQUARED * rows * rows;
    }

    /// @notice Largest row count whose `modeledBatchGas` fits in `batchGasBudget`.
    function maxRows() public view returns (uint256) {
        uint256 budget = batchGasBudget;
        if (budget <= BATCH_BASE_GAS) return 0;
        uint256 lo;
        uint256 hi = 512;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (modeledBatchGas(mid) <= budget) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    function setBatchGasBudget(uint256 budget) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (budget == 0 || budget > MAX_BATCH_GAS_BUDGET) revert BatchGasBudgetOutOfBounds();
        batchGasBudget = budget;
        emit BatchGasBudgetSet(budget);
    }

    function _capRows(uint256 n) internal view {
        if (n > maxRows()) revert TooManyRows();
    }

    function rollbackUnproven() external {
        if (nextUnproven == batchCount) revert UnprovenBatch();
        uint64 first = nextUnproven;
        if (block.timestamp < uint256(_pending[first].committedAt) + PROOF_TIMEOUT) revert ProofTimeoutPending();
        uint256 span = uint256(batchCount - first);
        uint256[] memory seen = new uint256[](span);
        uint256 nSeen;
        for (uint64 i = first; i < batchCount; ++i) {
            uint256 id = _pending[i].electionId;
            bool already;
            for (uint256 j; j < nSeen; ++j) {
                if (seen[j] == id) {
                    already = true;
                    break;
                }
            }
            if (!already) {
                seen[nSeen] = id;
                unchecked {
                    nSeen += 1;
                }
                consumedCount[id] = _pending[i].prevConsumed;
                consumedPoseidon[id] = _pending[i].prevPoseidon;
                _dirty[id] = false;
            }
            _undoBatch(i);
        }
        bytes32 restored = _batches[first].prevStateRoot;
        stateRoot = restored;
        batchCount = first;
        emit UnprovenRolledBack(first, restored);
    }

    function _undoBatch(uint64 index) internal {
        PendingResult memory pending = _pending[index];
        if (pending.kind == KIND_HOURLY) _hourPending[pending.electionId][pending.hourIndex] = false;
        if (pending.kind == KIND_FINAL) _finalCommitted[pending.electionId] = false;
        if (pending.kind == KIND_SUPPLEMENTARY) _suppCommitted[pending.electionId] = false;
        bytes32[] storage tags = _pendingTags[index];
        for (uint256 i; i < tags.length; ++i) {
            _tagPending[pending.electionId][tags[i]] = false;
        }
        PendingLink[] storage links = _pendingLinks[index];
        for (uint256 i; i < links.length; ++i) {
            IBallotInbox(inbox).unconsumeForSettlement(pending.electionId, links[i].submissionId);
            if (links[i].oldSubmissionId != 0) {
                _replacePending[pending.electionId][links[i].oldSubmissionId] = false;
                if (links[i].clearedOld) _stored[pending.electionId][links[i].oldSubmissionId].set = true;
            }
        }
        delete _pendingTags[index];
        delete _pendingLinks[index];
        delete _pendingIncluded[index];
        delete _pending[index];
        delete _batches[index];
    }

    function committedUnique(uint256 electionId) external view returns (uint256) {
        return _uniqueOf(electionId);
    }

    function committedHourlyProduct(uint256 electionId) external view returns (bytes32) {
        return _hourlyProductOf(electionId);
    }

    function committedFinalProduct(uint256 electionId) external view returns (bytes32) {
        return _finalProductOf(electionId);
    }

    function committedLastHourlyRoot(uint256 electionId) external view returns (bytes32) {
        return _lastRootOf(electionId);
    }

    function committedHourly(uint256 electionId) external view returns (Ciphertext memory) {
        return _hourlyHead(electionId);
    }

    function committedFinal(uint256 electionId) external view returns (Ciphertext memory) {
        return _finalHead(electionId);
    }

    function _uniqueOf(uint256 electionId) internal view returns (uint256) {
        if (_dirty[electionId]) return _working[electionId].uniqueCount;
        return postedUnique[electionId];
    }

    function _hourlyProductOf(uint256 electionId) internal view returns (bytes32) {
        if (_dirty[electionId]) return _working[electionId].hourlyProduct;
        return _hourlyProduct[electionId];
    }

    function _finalProductOf(uint256 electionId) internal view returns (bytes32) {
        if (_dirty[electionId]) return _working[electionId].finalProduct;
        return _finalProduct[electionId];
    }

    function _lastRootOf(uint256 electionId) internal view returns (bytes32) {
        if (_dirty[electionId]) return _working[electionId].lastRoot;
        return _lastHourlyRoot[electionId];
    }

    function _hourlyHead(uint256 electionId) internal view returns (Ciphertext memory ct) {
        if (_dirty[electionId] && _working[electionId].hourlySet) {
            Working storage w = _working[electionId];
            return Ciphertext(w.h1x, w.h1y, w.h2x, w.h2y, true);
        }
        return _hourlyPoints[electionId];
    }

    function _finalHead(uint256 electionId) internal view returns (Ciphertext memory ct) {
        if (_dirty[electionId] && _working[electionId].finalSet) {
            Working storage w = _working[electionId];
            return Ciphertext(w.f1x, w.f1y, w.f2x, w.f2y, true);
        }
        return _finalPoints[electionId];
    }

    function _optionHead(uint256 electionId, uint256 option) internal view returns (Ciphertext memory) {
        if (_dirty[electionId] && option < _working[electionId].optionCount) {
            OptionPoint memory opt = _workingOpt[electionId][uint8(option)];
            return Ciphertext(opt.c1X, opt.c1Y, opt.c2X, opt.c2Y, true);
        }
        return _optionCt[electionId][option];
    }

    function _electionStillPending(uint256 electionId) internal view returns (bool) {
        for (uint64 i = nextUnproven; i < batchCount; ++i) {
            if (_pending[i].exists && _pending[i].electionId == electionId && !proofVerified[i]) return true;
        }
        return false;
    }

    function _proofCarriesTally() internal view returns (bool) {
        if (batchVerifier == address(0)) return false;
        (bool ok, bytes memory ret) = batchVerifier.staticcall(abi.encodeWithSignature("verifiesTally()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    /// @dev On-chain Baby Jubjub sum. Hourly re-vote rows are skipped; their effect
    ///      is the unapplied deferred list, which the final and supplementary batches add.
    function _requireOnChainTally(
        SealedParams calldata params,
        uint8 kind,
        BallotRow[] calldata rows,
        OptionPoint[] calldata claimed
    ) internal view {
        uint256 n = claimed.length;
        if (rows.length != 0) {
            uint256 rowWidth = _vectorLen(rows);
            if (rowWidth != n) revert OptionTotalMismatch();
        }
        if (kind != KIND_HOURLY && _hasUnapplied(params.electionId)) {
            uint256 deferredWidth = _deferredWidth(params.electionId);
            if (n != deferredWidth) revert OptionTotalMismatch();
        }
        BabyJub.Run memory run;
        BabyJub.Run[4] memory acc;
        run = BabyJub.runAdd(run, params.prevC1X, params.prevC1Y, params.prevC2X, params.prevC2Y);
        uint256 width = n > 4 ? 4 : n;
        for (uint256 k; k < width; ++k) {
            Ciphertext memory prev = _optionHead(params.electionId, k);
            acc[k] = BabyJub.runAdd(acc[k], prev.c1X, prev.c1Y, prev.c2X, prev.c2Y);
        }
        if (kind != KIND_HOURLY) {
            DeferredRevote[] storage list = _deferred[params.electionId];
            for (uint256 i; i < list.length; ++i) {
                if (list[i].applied) continue;
                run = _absorbId(params.electionId, list[i].oldSubmissionId, false, run, acc, width);
                run = _absorbId(params.electionId, list[i].submissionId, true, run, acc, width);
            }
        }
        for (uint256 i; i < rows.length; ++i) {
            if (kind == KIND_HOURLY && rows[i].oldSubmissionId != 0) continue;
            if (rows[i].oldSubmissionId != 0) {
                run = _absorbId(params.electionId, rows[i].oldSubmissionId, false, run, acc, width);
            }
            run = BabyJub.runAdd(run, rows[i].c1X, rows[i].c1Y, rows[i].c2X, rows[i].c2Y);
            for (uint256 k; k < width; ++k) {
                OptionCipher calldata cur = rows[i].options[k];
                acc[k] = BabyJub.runAdd(acc[k], cur.c1X, cur.c1Y, cur.c2X, cur.c2Y);
            }
        }
        (uint256 x, uint256 y, uint256 u, uint256 v) = BabyJub.runOut(run);
        if (x != params.nextC1X || y != params.nextC1Y || u != params.nextC2X || v != params.nextC2Y) {
            revert PointsMismatch();
        }
        for (uint256 k; k < width; ++k) {
            (x, y, u, v) = BabyJub.runOut(acc[k]);
            if (x != claimed[k].c1X || y != claimed[k].c1Y || u != claimed[k].c2X || v != claimed[k].c2Y) {
                revert OptionTotalMismatch();
            }
        }
    }

    function _hasUnapplied(uint256 electionId) internal view returns (bool) {
        DeferredRevote[] storage list = _deferred[electionId];
        for (uint256 i; i < list.length; ++i) {
            if (!list[i].applied) return true;
        }
        return false;
    }

    function _deferredWidth(uint256 electionId) internal view returns (uint256) {
        DeferredRevote[] storage list = _deferred[electionId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i].applied) continue;
            return _acceptedN(electionId, list[i].submissionId);
        }
        return 0;
    }

    function _absorbId(
        uint256 electionId,
        uint256 submissionId,
        bool plus,
        BabyJub.Run memory run,
        BabyJub.Run[4] memory acc,
        uint256 width
    ) internal view returns (BabyJub.Run memory) {
        (uint256 ax, uint256 ay, uint256 au, uint256 av, uint8 acceptedN, bool set,, uint256[16] memory opts) =
            IBallotInbox(inbox).acceptedVector(electionId, submissionId);
        if (!set) revert IBallotInbox.BallotHashMismatch();
        if (width != 0 && acceptedN != width) revert OptionTotalMismatch();
        run = plus ? BabyJub.runAdd(run, ax, ay, au, av) : BabyJub.runSub(run, ax, ay, au, av);
        for (uint256 k; k < width; ++k) {
            uint256 o = k << 2;
            acc[k] = plus
                ? BabyJub.runAdd(acc[k], opts[o], opts[o + 1], opts[o + 2], opts[o + 3])
                : BabyJub.runSub(acc[k], opts[o], opts[o + 1], opts[o + 2], opts[o + 3]);
        }
        return run;
    }
}
