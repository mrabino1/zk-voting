// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IVoterRegistry {
    event VoterRegistered(uint256 indexed electionId, uint256 indexed identityCommitment, uint256 leafIndex);

    function register(uint256 electionId, uint256 identityCommitment) external;

    function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    /// @notice Registered and not currently disqualified.
    function isEligible(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    /// @notice Append-only registration roll. Includes disqualified commitments.
    ///         Voting uses `IElection.eligibleRoot`, not this root.
    function merkleRoot(uint256 electionId) external view returns (bytes32);

    function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256);

    function participantCount(uint256 electionId) external view returns (uint256);

    /// @notice Size of registered ∩ ¬currently-disqualified.
    function eligibleCount(uint256 electionId) external view returns (uint256);

    /// @notice Republish `Election.eligibleRoot` from the current intersection.
    ///         Only the disqualification registry may call this.
    function rebuildEligibleRoot(uint256 electionId) external returns (bytes32);
}
