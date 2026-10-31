// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IRollupSettlement {
    error ZeroAddress();
    error NotAuthorized();
    error BadBatchIndex();
    error PrevRootMismatch();
    error DataHashMismatch();
    error InvalidProof();
    error GenesisAlreadySet();
    error VerifierRequired();
    error UnsupportedRole();
    error AlreadySet();
    error HourlyWindowClosed();
    error FinalBatchTooEarly();
    error FinalBatchAlreadyPosted();
    error FinalBatchRequired();
    error TurnoutOnFinalBatch();
    error UniqueCountDecreased();
    error BoundRootMismatch();
    error DuplicateFirstBallot();
    error EmptyRoot();
    error SupplementaryTooEarly();
    error SupplementaryAlreadyPosted();
    error HourlyProductChanged();
    error PendingBallotOmitted();
    error UnknownBoundRoot();
    error UnknownInclusion();
    error FactoryUnset();
    error ProductMismatch();
    error UniqueCountMismatch();
    error HourAlreadyPosted();
    error PointsMismatch();
    error PointOffCurve();
    error OneHotRejected();
    error ContractPaused();
    error UniqueStepMismatch();
    error IdentityCiphertext();
    error OptionTotalMismatch();
    error SumToOneRejected();
    error ReplacementOnHourly();
    error OldOptionsMismatch();
    error UnconsumedBallot();
    error StaleReplacement();
    error UnprovenBatch();
    error OptionCapOutOfBounds();
    error BlobRejected();
    error TooManyRows();
    error BatchGasBudgetOutOfBounds();
    error ProofTimeoutPending();

    event SealedBatchPosted(
        uint256 indexed electionId,
        uint8 kind,
        uint64 indexed batchIndex,
        bytes32 ballotSetRoot,
        uint256 uniqueCount,
        bytes32 blobVersionedHash
    );
    event BatchProofVerified(uint64 indexed batchIndex, bytes32 newStateRoot);
    event MaxOptionsSet(uint8 maxOptions);
    event BatchGasBudgetSet(uint256 budget);
    event UnprovenRolledBack(uint64 indexed fromBatch, bytes32 stateRoot);
    event SupplementaryPosted(uint256 indexed electionId);

    /// @notice One hour, the same length as an hourly batch.
    ///         Long enough for an honest sequencer to land the supplementary batch,
    ///         and short enough that a stall cannot hold the tally for longer than one missed hour.
    function SUPPLEMENTARY_GRACE() external view returns (uint256);

    function KIND_HOURLY() external view returns (uint8);

    function KIND_FINAL() external view returns (uint8);

    function KIND_SUPPLEMENTARY() external view returns (uint8);

    struct SealedParams {
        uint256 electionId;
        uint64 batchIndex;
        bytes32 prevStateRoot;
        bytes32 newStateRoot;
        bytes32 dataHash;
        bytes32 ballotSetRoot;
        bytes32 hourlyProduct;
        bytes32 finalProduct;
        uint256 previousUnique;
        uint256 nextUnique;
        bytes32 chainHash;
        bytes32 tagHash;
        bytes32 boundRootHash;
        bytes32 previousHourly;
        bytes32 previousFinal;
        uint256 prevC1X;
        uint256 prevC1Y;
        uint256 prevC2X;
        uint256 prevC2Y;
        uint256 nextC1X;
        uint256 nextC1Y;
        uint256 nextC2X;
        uint256 nextC2Y;
        /// @notice Inbox Poseidon head before this batch.
        uint256 prevConsumed;
        bytes32 prevPoseidon;
        /// @notice Inbox Poseidon head after this batch. The final batch must match the inbox.
        uint256 nextConsumed;
        bytes32 nextPoseidon;
        /// @notice Poseidon fold of each 4-row chunk statement. One aggregate proof covers all of them.
        bytes32 chunkDigest;
        /// @notice Poseidon fold of the claimed option totals.
        ///         L1 recomputes that sum unless the batch verifier reports `verifiesTally()`.
        uint256 tallyCommitment;
        /// @notice Versioned hash of the blob that carries the ballot bytes. Zero when there is no blob.
        bytes32 blobVersionedHash;
        /// @notice Must equal `blobChallenge(versionedHash, nextPoseidon, chunkDigest)`.
        uint256 blobZ;
        uint256 blobY;
        /// @notice Blob payload length in bytes. Zero skips the point-evaluation precompile.
        ///         It never skips the inbox Poseidon step. Any `rows.length > 0` is projected.
        uint256 dataLength;
        bytes blobCommitment;
        bytes blobOpeningProof;
    }

    struct Ciphertext {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        bool set;
    }

    /// @notice One option ciphertext. The 0/1 proof is the per-ballot Groth16 checked at acceptance.
    struct OptionCipher {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
    }

    /// @notice One ballot in a batch. `oldSubmissionId` 0 is a first ballot.
    ///         Any other value names the previous submission, which may be replaced once.
    ///         `options` is one ciphertext per choice, index-aligned.
    ///         Acceptance already checked that each option is 0 or 1 and that the vector sums to 1.
    ///         L1 adds the points unless the batch verifier reports `verifiesTally()`.
    ///         A re-vote row may sit in an hourly batch; its tally effect is applied on the final batch.
    ///         The final batch may also carry first ballots from the last partial hour.
    struct BallotRow {
        uint256 submissionId;
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        uint256 oldSubmissionId;
        OptionCipher[] options;
    }

    /// @notice One choice ciphertext, index-aligned with the row vector.
    ///         Index 0 is the first choice, the same index `optionCiphertext` reads.
    struct OptionPoint {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
    }

    function setElectionFactory(address factory_) external;

    function setInbox(address inbox_) external;

    function electionFactory() external view returns (address);

    function inbox() external view returns (address);

    function supplementaryPosted(uint256 electionId) external view returns (bool);

    function lastHourlyRoot(uint256 electionId) external view returns (bytes32);

    function finalBatchPosted(uint256 electionId) external view returns (bool);

    function finalBatchRoot(uint256 electionId) external view returns (bytes32);

    function finalProduct(uint256 electionId) external view returns (bytes32);

    function hourlyProduct(uint256 electionId) external view returns (bytes32);

    function postedBallotRoot(uint256 electionId, bytes32 root) external view returns (bool);

    function supplementaryChainHash(uint256 electionId) external view returns (bytes32);

    function hashWords(bytes32[] calldata words) external pure returns (bytes32);

    function hourPosted(uint256 electionId, uint256 hourIndex) external view returns (bool);

    function hourClosedAt(uint256 electionId, uint256 hourIndex) external view returns (uint64);

    function hourlyCiphertext(uint256 electionId, uint256 hourIndex) external view returns (Ciphertext memory);

    function finalCiphertext(uint256 electionId) external view returns (Ciphertext memory);

    /// @notice Running hourly points chained into the next hourly batch.
    function chainedHourly(uint256 electionId) external view returns (Ciphertext memory);

    /// @notice Running final points chained into the next final or supplementary batch.
    function chainedFinal(uint256 electionId) external view returns (Ciphertext memory);

    function computeSealedDataHash(SealedParams memory params, uint8 kind) external view returns (bytes32);

    function maxOptions() external view returns (uint8);

    function MAX_OPTIONS_BOUND() external view returns (uint8);

    function setMaxOptions(uint8 n) external;

    /// @notice Hard ceiling for `batchGasBudget`. The setter reverts above this.
    function MAX_BATCH_GAS_BUDGET() external view returns (uint256);

    /// @notice Default calldata-batch gas budget. 24,000,000, well under the 200M ceiling.
    ///         12,000,000 is a lower setting that fits a block of about 30M (7 rows).
    function DEFAULT_BATCH_GAS_BUDGET() external view returns (uint256);

    /// @notice Per-row term in `modeledBatchGas`. 250,000.
    function GAS_PER_CALLDATA_ROW() external view returns (uint256);

    /// @notice Fixed term in `modeledBatchGas`. 7,500,000.
    function BATCH_BASE_GAS() external view returns (uint256);

    /// @notice Four-row chunk term in `modeledBatchGas`. 1,200,000.
    function GAS_PER_CHUNK() external view returns (uint256);

    /// @notice Square term in `modeledBatchGas`. 5,000 gas times rows squared.
    function GAS_PER_ROW_SQUARED() external view returns (uint256);

    function batchGasBudget() external view returns (uint256);

    /// @notice Modeled gas of a calldata batch of `rows` four-option ballots.
    function modeledBatchGas(uint256 rows) external pure returns (uint256);

    /// @notice Row cap for one calldata batch: the largest `rows` with
    ///         `modeledBatchGas(rows) <= batchGasBudget`.
    function maxRows() external view returns (uint256);

    function setBatchGasBudget(uint256 budget) external;

    /// @notice How long an unproven batch may sit before anyone may roll it back.
    function PROOF_TIMEOUT() external view returns (uint256);

    /// @notice Drop every unproven batch and restore the last proven state root,
    ///         batch count, and consumed inbox head. Callable by anyone after `PROOF_TIMEOUT`.
    function rollbackUnproven() external;

    /// @notice `block.timestamp` when the final batch was proven. Zero until that proof.
    function finalProvenAt(uint256 electionId) external view returns (uint64);

    /// @notice Evaluation point bound to the blob, the inbox head, and the chunk digest.
    function blobChallenge(bytes32 versionedHash, bytes32 nextPoseidon, bytes32 chunkDigest)
        external
        pure
        returns (uint256);

    /// @notice Chain head including batches that are committed and not yet proven.
    ///         Public turnout, posted roots, and the POLL gate do not read these.
    function committedUnique(uint256 electionId) external view returns (uint256);

    function committedHourlyProduct(uint256 electionId) external view returns (bytes32);

    function committedFinalProduct(uint256 electionId) external view returns (bytes32);

    function committedLastHourlyRoot(uint256 electionId) external view returns (bytes32);

    function committedHourly(uint256 electionId) external view returns (Ciphertext memory);

    function committedFinal(uint256 electionId) external view returns (Ciphertext memory);

    function proofVerified(uint64 batchIndex) external view returns (bool);

    function nextUnproven() external view returns (uint64);

    function consumedCount(uint256 electionId) external view returns (uint256);

    function consumedPoseidon(uint256 electionId) external view returns (bytes32);

    /// @notice Prove the next committed batch. Roots commit first; proofs catch up in order.
    function verifyCommittedProof(
        uint64 batchIndex,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function sealedPublicInputs(uint64 batchIndex) external view returns (uint256[] memory input);

    function projectConsumed(bytes32 prevPoseidon, uint256 prevCount, uint256 electionId, BallotRow[] memory rows)
        external
        view
        returns (uint256 nextCount, bytes32 nextPoseidon);

    function chunkDigestOf(uint256 electionId, BallotRow[] memory rows) external view returns (bytes32);

    function chunkStatement(uint256 electionId, BallotRow[] memory rows, uint256 chunkIndex)
        external
        view
        returns (uint256);

    function tallyCommitmentOf(OptionPoint[] memory options) external pure returns (uint256);

    function chainHashOf(BallotRow[] memory rows) external pure returns (bytes32);

    function postedUnique(uint256 electionId) external view returns (uint256);

    function hourUnique(uint256 electionId, uint256 hourIndex) external view returns (uint256);

    function optionCiphertext(uint256 electionId, uint256 option) external view returns (Ciphertext memory);

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
    ) external;

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
    ) external;

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options
    ) external;

    event BatchSubmitted(uint64 indexed batchIndex, bytes32 newStateRoot, bytes32 dataHash, uint256 l1Block);
    event GenesisSet(bytes32 stateRoot);
    event SequencerSet(address indexed sequencer);
    event ProverSet(address indexed prover);

    struct Batch {
        bytes32 prevStateRoot;
        bytes32 newStateRoot;
        bytes32 dataHash;
        uint256 l1Block;
        uint256 dataLength;
    }

    function SEQUENCER_ROLE() external view returns (bytes32);

    function PROVER_ROLE() external view returns (bytes32);

    function admin() external view returns (address);

    function sequencer() external view returns (address);

    function prover() external view returns (address);

    function batchVerifier() external view returns (address);

    function mockMode() external view returns (bool);

    function stateRoot() external view returns (bytes32);

    function batchCount() external view returns (uint64);

    /// @notice Every L2 state root this contract has settled.
    function isSettledRoot(bytes32 root) external view returns (bool);

    function grantRole(bytes32 role, address account) external;

    function setGenesis(bytes32 genesisRoot) external;

    function computeDataHash(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot)
        external
        pure
        returns (bytes32);

    function hashBatch(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot) external pure returns (bytes32);

    function submitBatch(
        uint64 batchIndex,
        bytes32 prevStateRoot,
        bytes32 newStateRoot,
        bytes32 dataHash,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function batchPublicInputs(uint64 batchIndex, bytes32 prevStateRoot, bytes32 newStateRoot, bytes32 dataHash)
        external
        pure
        returns (uint256[] memory input);

    function getBatch(uint64 batchIndex) external view returns (Batch memory);
}
