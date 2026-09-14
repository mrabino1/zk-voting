// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IBallotInbox {
    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifier, bytes32 ballotHash, address relayer);

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
}
