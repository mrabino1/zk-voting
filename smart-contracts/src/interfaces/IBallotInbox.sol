// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IBallotInbox {
    error ZeroAddress();
    error UnknownElection();
    error EmptyBallot();
    error InvalidPublicInputs();
    error RollNotFrozen();
    error OutsideVotingWindow();
    error ZeroVerifier();
    error EligibleRootMismatch();
    error DisqualificationRootMismatch();
    error ElectionIdMismatch();
    error BallotHashMismatch();
    error NullifierUsed();
    error InvalidProof();
    error AlreadyTallied();
    error EligibleRootPending();
    error TallyStatusUnavailable();
    error NotRelayer();
    error UseVoteBatch();
    error EmptyBatch();
    error BatchTooLarge();
    error BatchLengthMismatch();
    error BatchTooEarly();
    error DuplicateNullifier();
    error InvalidNullifier();
    error BallotTooLarge();
    error ContractPaused();
    error ReentrantCall();
    error NotAuthorized();
    error SettlementAlreadySet();
    error CeremonyAlreadySet();
    error KeyNotPosted();
    error BadSignature();
    error ReceiptMismatch();
    error ReceiptAfterCutoff();
    error ForceInClosed();
    error BoundRootMismatch();
    error UnknownBoundRoot();
    error UnknownInclusion();
    error PendingListFull();
    error LinksLocked();
    error TurnoutNotPublished();
    error BadTreeDepth();
    error EgCiphertextRequired();
    error UnknownSubmission();
    error SubmissionAlreadySettled();

    struct RelayerReceipt {
        uint256 submissionId;
        bytes32 ballotHash;
        bytes32 ciphertextHash;
        bytes32 boundRoot;
        uint64 receivedAt;
    }

    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifier, bytes32 ballotHash, address relayer);

    /// @notice One batch landed. `count` is the number of ballots, not a choice total.
    event VoteBatchAccepted(uint256 indexed electionId, uint256 count, address relayer);

    function MAX_VOTE_BATCH() external view returns (uint256);

    /// @notice Largest ciphertext `submitVote` / `submitVoteBatch` will read.
    function MAX_BALLOT_BYTES() external view returns (uint256);

    /// @notice BN254 scalar field modulus r.
    function SNARK_SCALAR_FIELD() external view returns (uint256);

    /// @notice Factory that maps `electionId` to the Election clone.
    function factory() external view returns (address);

    function submitVote(
        uint256 electionId,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) external;

    function nullifierUsed(uint256 electionId, uint256 nullifier) external view returns (bool);

    /// @notice Public turnout. A VOTE reverts until cutoff. A sealed POLL returns the
    ///         last posted unique count. A legacy election reverts until cutoff.
    function closedBallotCount(uint256 electionId) external view returns (uint256);

    /// @notice Accepted submissions not yet included in a settled batch.
    function unconsumedCount(uint256 electionId) external view returns (uint256);

    function emptyBallotRoot(uint256 depth) external pure returns (uint256);

    function pendingCount(uint256 electionId) external view returns (uint256);

    function pendingIdAt(uint256 electionId, uint256 index) external view returns (uint256);

    function pendingChunk(uint256 electionId, uint256 chunk) external view returns (uint256);

    function ballotHashOf(uint256 electionId, uint256 nullifier) external view returns (bytes32);

    /// @notice Hash-chain of accepted ballot hashes: `keccak256(prev || hash)`, starting at 0.
    function ballotRoot(uint256 electionId) external view returns (bytes32);

    function ballotHashAt(uint256 electionId, uint256 index) external view returns (bytes32);

    /// @notice Relayer-only batch. When the factory disclosure interval is
    ///         non-zero, `submitVote` reverts and ballots must arrive together.
    ///         Acceptance is recorded in nullifier order, in this one transaction.
    function submitVoteBatch(
        uint256 electionId,
        uint256[2][] calldata a,
        uint256[2][2][] calldata b,
        uint256[2][] calldata c,
        uint256[][] calldata publicInputs,
        bytes[] calldata encryptedBallots
    ) external;

    function ballotHashOfCiphertext(bytes calldata encryptedBallot) external pure returns (uint256);

    function settlementOf(uint256 electionId) external view returns (address);

    function ceremonyOf(uint256 electionId) external view returns (address);

    function setSettlement(uint256 electionId, address settlement_) external;

    function setCeremony(uint256 electionId, address ceremony_) external;

    /// @notice Covers chain id, this inbox, and the receipt fields, including `boundRoot`.
    function receiptDigest(uint256 electionId, RelayerReceipt calldata receipt) external view returns (bytes32);

    /// @notice Include an omitted ballot while `block.timestamp < tallyAllowedAt`.
    ///         The ballot is checked against `receipt.boundRoot`.
    function forceIn(
        uint256 electionId,
        RelayerReceipt calldata receipt,
        bytes calldata signature,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs,
        bytes calldata encryptedBallot
    ) external;

    function pendingForcedIn(uint256 electionId) external view returns (uint256[] memory);

    function forcedInRoot(uint256 electionId, uint256 submissionId) external view returns (bytes32 root, bool pending);

    function markSealed(uint256 electionId, uint256[] calldata submissionIds) external;

    /// @notice Spend an accepted submission inside a settled batch. Settlement only.
    ///         `cipherHash` is the ordered-vector ballot digest, and it must match the stored ballot hash.
    function consumeForSettlement(uint256 electionId, uint256 submissionId, uint256 cipherHash) external;
}
