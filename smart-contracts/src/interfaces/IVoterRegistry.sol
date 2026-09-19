// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IVoterRegistry {
    event VoterRegistered(uint256 indexed electionId, uint256 indexed identityCommitment, uint256 leafIndex);

    function register(uint256 electionId, uint256 identityCommitment) external;

    function isRegistered(uint256 electionId, uint256 identityCommitment) external view returns (bool);

    function merkleRoot(uint256 electionId) external view returns (bytes32);

    function leafIndexOf(uint256 electionId, uint256 identityCommitment) external view returns (uint256);

    function participantCount(uint256 electionId) external view returns (uint256);
}
