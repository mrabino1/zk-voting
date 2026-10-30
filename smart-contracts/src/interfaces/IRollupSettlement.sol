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

    function computeSealedDataHash(SealedParams memory params, uint8 kind) external pure returns (bytes32);

    function submitHourlyBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function submitFinalBatch(
        SealedParams calldata params,
        bytes32[] calldata boundRoots,
        bytes32[] calldata firstBallotTags,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function submitSupplementaryBatch(
        SealedParams calldata params,
        uint256[] calldata includedIds,
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
