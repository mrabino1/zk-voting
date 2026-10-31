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

    event SealedBatchPosted(
        uint256 indexed electionId, uint8 kind, uint64 indexed batchIndex, bytes32 ballotSetRoot, uint256 uniqueCount
    );
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
    }

    struct Ciphertext {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        bool set;
    }

    /// @notice One option ciphertext and its 0/1 proof under the joint key.
    struct OptionCipher {
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        uint256[12] oneHot;
    }

    /// @notice One ballot in a batch. `oneHot` is the CDS proof under the joint key.
    ///         `oldSubmissionId` 0 is a first ballot and adds the ciphertext.
    ///         Any other value names the previous submission. The contract subtracts the
    ///         vector it stored for that submission. The previous ciphertexts are not
    ///         fields of this row. `options` is one ciphertext per choice, index-aligned.
    ///         Their sum is this row's ciphertext, each is 0 or 1, and `sumProof` shows
    ///         that sum encrypts 1. `sumProof` is A, B, z.
    struct BallotRow {
        uint256 submissionId;
        uint256 c1X;
        uint256 c1Y;
        uint256 c2X;
        uint256 c2Y;
        uint256 oldSubmissionId;
        uint256[12] oneHot;
        OptionCipher[] options;
        uint256[5] sumProof;
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

    function computeSealedDataHash(SealedParams memory params, uint8 kind) external pure returns (bytes32);

    function chainHashOf(BallotRow[] memory rows) external pure returns (bytes32);

    function postedUnique(uint256 electionId) external view returns (uint256);

    function hourUnique(uint256 electionId, uint256 hourIndex) external view returns (uint256);

    function optionCiphertext(uint256 electionId, uint256 option) external view returns (Ciphertext memory);

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
        BallotRow[] calldata rows,
        OptionPoint[] calldata options,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
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
