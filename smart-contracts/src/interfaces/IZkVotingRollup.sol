// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Guardians} from "../libraries/Guardians.sol";
import {StateTree} from "../libraries/StateTree.sol";

/// @title IZkVotingRollup
/// @notice The single L1 contract of ZK-Voting. See `docs/ROLLUP.md`.
interface IZkVotingRollup {
    // ---------------------------------------------------------------- types

    enum Status {
        None,
        /// @dev Guardians are running the key ceremony.
        KeyGen,
        /// @dev Key fixed. Roll open until `startTime`, ballots in `[startTime, cutoffTime)`.
        Scheduled,
        /// @dev CLOSE requested, waiting for the batch that carries it to execute.
        Closing,
        /// @dev Final accumulator on L1. Waiting for guardian shares.
        Closed,
        /// @dev Totals decrypted and certified.
        Finalized,
        /// @dev Fewer ballots than `minBallots`. Never decrypted.
        Withheld,
        /// @dev The key ceremony did not finish before `startTime`, or desert mode froze the
        ///      election before it closed.
        Halted
    }

    struct ElectionConfig {
        bytes32 jurisdictionId;
        uint64 startTime;
        uint64 cutoffTime;
        uint8 optionCount;
        /// @notice Anonymity floor. A smaller turnout is never decrypted.
        uint32 minBallots;
        address registrar;
        address officer;
        address[] guardians;
        uint8 threshold;
        /// @notice Hash of the ballot text the voters see (question, options, language).
        bytes32 ballotSpecHash;
        string metadataURI;
    }

    struct ElectionInfo {
        bytes32 jurisdictionId;
        bytes32 configHash;
        bytes32 ballotSpecHash;
        uint64 startTime;
        uint64 cutoffTime;
        uint64 createdAt;
        uint8 optionCount;
        uint8 threshold;
        uint8 guardianCount;
        uint32 minBallots;
        uint32 ballotCount;
        Status status;
        bool viaDesert;
        address clerk;
        address registrar;
        address officer;
        uint256 jointKeyX;
        uint256 jointKeyY;
    }

    /// @notice What L1 keeps per batch. Only its hash is stored.
    struct StoredBatchInfo {
        uint64 batchNumber;
        uint64 timestamp;
        uint64 priorityOperations;
        bytes32 priorityOpsHash;
        bytes32 onchainOpsHash;
        bytes32 stateRoot;
        bytes32 commitment;
    }

    struct CommitBatchInfo {
        bytes32 newStateRoot;
        uint64 timestamp;
        bytes pubdata;
    }

    struct PriorityRequest {
        bytes32 hashedPubdata;
        uint64 expiration;
        uint8 opType;
    }

    // --------------------------------------------------------------- events

    event GovernorTransferStarted(address indexed governor, address indexed pending);
    event GovernorTransferred(address indexed previous, address indexed governor);
    event OperatorSet(address indexed operator, bool active);
    event JurisdictionCreated(bytes32 indexed jurisdictionId, address indexed admin, string name);
    event JurisdictionAdminSet(bytes32 indexed jurisdictionId, address indexed admin);
    event ClerkSet(bytes32 indexed jurisdictionId, address indexed clerk, bool active);

    event ElectionCreated(
        uint32 indexed electionId,
        bytes32 indexed jurisdictionId,
        bytes32 configHash,
        uint64 startTime,
        uint64 cutoffTime,
        uint8 optionCount,
        string metadataURI
    );
    event GuardianCommitted(uint32 indexed electionId, uint8 indexed guardianIndex);
    event ShareDisputeOpened(uint32 indexed electionId, uint8 indexed dealerIndex, uint8 indexed recipientIndex);
    event ShareDisputeClosed(uint32 indexed electionId, uint8 indexed dealerIndex);
    event DealerExcluded(uint32 indexed electionId, uint8 indexed dealerIndex);
    event KeyFinalized(uint32 indexed electionId, uint256 jointKeyX, uint256 jointKeyY);
    event ElectionHalted(uint32 indexed electionId);

    event VotersRegistered(uint32 indexed electionId, uint256 count);
    event VoterDisqualified(uint32 indexed electionId, uint256 indexed commitment, uint16 reasonCode);
    event BallotForced(uint32 indexed electionId, uint64 indexed requestId, bytes payload);
    event CloseRequested(uint32 indexed electionId);

    /// @notice The operator's feed of L1 requests. `pubdata` is the request part of the op.
    event PriorityRequestQueued(uint64 indexed requestId, uint8 indexed opType, bytes pubdata, uint64 expiration);

    event BatchCommitted(uint64 indexed batchNumber, bytes32 stateRoot, bytes32 commitment);
    event BatchVerified(uint64 indexed batchNumber);
    event BatchExecuted(uint64 indexed batchNumber, bytes32 stateRoot);
    event BatchesReverted(uint64 totalBatchesCommitted);
    event DesertModeActivated(uint64 expiredRequestId);

    event ElectionClosed(uint32 indexed electionId, uint32 ballotCount, bool withheld, bool viaDesert);
    event DecryptionSharesPosted(uint32 indexed electionId, uint8 indexed guardianIndex);
    event ResultFinalized(uint32 indexed electionId, bytes32 resultHash, uint256[] counts);

    // --------------------------------------------------------------- errors

    error NotGovernor();
    error NotPendingGovernor();
    error NotOperator();
    error NotJurisdictionAdmin();
    error NotClerk();
    error NotRegistrar();
    error NotOfficer();
    error ZeroAddress();
    error MockVerifierOnLocalChainOnly();

    error JurisdictionExists();
    error UnknownJurisdiction();
    error UnknownElection();
    error WrongStatus(Status status);
    error BadElectionConfig();
    error BadInput();
    error TooEarly();
    error TooLate();

    error DesertMode();
    error NotDesertMode();
    error NoExpiredRequest();
    error BadStoredBatch();
    error BadTimestamp();
    error PriorityOpMismatch();
    error MissingPriorityOps();
    error BatchNotCommitted();
    error BatchNotVerified();
    error InvalidProof();
    error OnchainOpsMismatch();
    error CannotRevertExecuted();

    error BadDesertProof();
    error CountMismatch();
    error DecryptionMismatch();

    // ------------------------------------------------------------ functions

    function createElection(ElectionConfig calldata config) external returns (uint32 electionId);

    function registerVoters(uint32 electionId, uint256[] calldata commitments) external;

    function disqualify(uint32 electionId, uint256 commitment, uint16 reasonCode) external;

    function forceBallot(uint32 electionId, uint256 nullifier, uint256 ballotCommitment, bytes calldata payload)
        external
        returns (uint64 requestId);

    function closeElection(uint32 electionId) external;

    function commitBatch(StoredBatchInfo calldata last, CommitBatchInfo calldata next) external;

    function verifyBatch(StoredBatchInfo calldata batch, uint256[8] calldata proof) external;

    function executeBatches(StoredBatchInfo[] calldata batches, bytes[] calldata onchainOps) external;

    function revertBatches(StoredBatchInfo calldata newLast) external;

    function activateDesertMode() external;

    function desertClose(
        uint32 electionId,
        StateTree.ElectionLeaf calldata leaf,
        uint256[4][] calldata accumulator,
        uint256[] calldata siblings
    ) external;

    function postDecryptionShares(uint32 electionId, Guardians.Share[] calldata shares) external;

    function finalizeResult(uint32 electionId, uint256[] calldata counts, uint8[] calldata guardianIndexes) external;

    function election(uint32 electionId) external view returns (ElectionInfo memory);

    function result(uint32 electionId) external view returns (uint256[] memory counts, bytes32 resultHash);

    function accumulator(uint32 electionId) external view returns (uint256[4][] memory);
}
