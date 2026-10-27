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

    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifier, bytes32 ballotHash, address relayer);

    function MAX_VOTE_BATCH() external view returns (uint256);

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

    function acceptedBallots(uint256 electionId) external view returns (uint256);

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
}
