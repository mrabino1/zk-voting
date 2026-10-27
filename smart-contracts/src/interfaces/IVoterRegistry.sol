// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IVoterRegistry {
    error ZeroAddress();
    error UnknownElection();
    error NotRegistrar();
    error ZeroCommitment();
    error AlreadyRegistered();
    error RollFrozen();
    error CapReached();
    error RegistrationClosed();
    error NotDisqualificationRegistry();
    error NoRebuildPending();

    event VoterRegistered(uint256 indexed electionId, uint256 indexed identityCommitment, uint256 leafIndex);
    event EligibleRebuildStarted(uint256 indexed electionId, uint256 rollSize);
    event EligibleRebuildProgress(uint256 indexed electionId, uint256 cursor, uint256 rollSize);
    event EligibleRootPublished(uint256 indexed electionId, bytes32 eligibleRoot, uint256 eligibleCount);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);

    /// @notice Roll entries processed per rebuild page.
    function REBUILD_BATCH() external view returns (uint256);

    /// @notice Hasher used for the registration and eligible trees.
    function hasher() external view returns (address);

    /// @notice Factory that maps `electionId` to the Election clone.
    function factory() external view returns (address);

    function roles(bytes32 role, address account) external view returns (bool);

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;

    function register(uint256 electionId, uint256 identityCommitment) external;

    function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    /// @notice Registered, not disqualified, and not missing a required attestation.
    function isEligible(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    /// @notice Append-only registration roll. Includes disqualified commitments.
    ///         Voting uses `IElection.eligibleRoot`, not this root.
    function merkleRoot(uint256 electionId) external view returns (bytes32);

    function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256);

    function participantCount(uint256 electionId) external view returns (uint256);

    /// @notice Size of registered ∩ ¬currently-disqualified.
    function eligibleCount(uint256 electionId) external view returns (uint256);

    /// @notice Start republishing `Election.eligibleRoot` from the current
    ///         intersection (paged, see `continueEligibleRebuild`). The
    ///         disqualification registry or this election's party registry
    ///         may call this.
    function rebuildEligibleRoot(uint256 electionId) external returns (bytes32);

    /// @notice Process up to `maxLeaves` (0 = default batch) roll entries of a
    ///         pending eligible-root rebuild. Permissionless. Returns true once
    ///         the new root is published.
    function continueEligibleRebuild(uint256 electionId, uint256 maxLeaves) external returns (bool done);

    /// @notice True while a disqualify / revoke rebuild has not been finished;
    ///         `BallotInbox` refuses ballots meanwhile.
    function eligibleRootPending(uint256 electionId) external view returns (bool);
}
