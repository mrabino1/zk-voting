// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IDisqualificationRegistry {
    error ZeroAddress();
    error UnknownElection();
    error NotDisqualificationOfficer();
    error NotClerk();
    error RollFrozen();
    error InvalidReasonCode();
    error ZeroCommitment();
    error AlreadyDisqualified();
    error NotDisqualified();
    error InvalidTreeDepth();
    error VotingStarted();
    error NotPartyRegistry();

    event Disqualified(
        uint256 indexed electionId, uint256 indexed identityCommitment, uint16 reasonCode, bytes32 evidenceHash
    );
    event DisqualificationRevoked(uint256 indexed electionId, uint256 indexed identityCommitment, bytes32 evidenceHash);
    /// @notice Audit M-01: the late-update switch is public and logged.
    event LateUpdateAllowedSet(uint256 indexed electionId, bool allowed);

    /// @notice Hasher used for the disqualification chain.
    function hasher() external view returns (address);

    /// @notice Factory that maps `electionId` to the Election clone.
    function factory() external view returns (address);

    /// @notice After freeze, updates revert unless this flag is set (default false).
    function lateUpdateAllowed(uint256 electionId) external view returns (bool);

    function disqualify(uint256 electionId, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash)
        external;

    function revoke(uint256 electionId, uint256 identityCommitment, bytes32 evidenceHash) external;

    /// @notice Party-registry veto. Idempotent. Does not clear an officer disqualification.
    function disqualifyByParty(uint256 electionId, uint256 identityCommitment, uint16 reasonCode, bytes32 evidenceHash)
        external;

    /// @notice Lift a party veto. No-op when the officer disqualification remains.
    function revokeByParty(uint256 electionId, uint256 identityCommitment, bytes32 evidenceHash) external;

    /// @notice Clerk may allow post-freeze updates. Default is false.
    function setLateUpdateAllowed(uint256 electionId, bool allowed) external;

    function isDisqualified(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    function merkleRoot(uint256 electionId) external view returns (bytes32);

    function reasonCodeOf(uint256 electionId, uint256 identityCommitment) external view returns (uint16);
}
