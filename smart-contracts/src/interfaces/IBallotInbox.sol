// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IBallotInbox {
    event VoteAccepted(uint256 indexed electionId, uint256 indexed nullifier, bytes32 ballotHash, address relayer);

    /// @notice Last-ballot-counts: a later valid proof for the same nullifier replaced `previousBallotHash`.
    /// @dev Indexed fields match VoteAccepted (electionId, nullifier only). Relayer is not indexed.
    event VoteSuperseded(
        uint256 indexed electionId,
        uint256 indexed nullifier,
        bytes32 previousBallotHash,
        bytes32 ballotHash,
        uint32 generation,
        address relayer
    );

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

    /// @notice 0 if unused; 1 on first accept; increments on each supersession.
    function voteGeneration(uint256 electionId, uint256 nullifier) external view returns (uint32);

    function ballotHashSuperseded(uint256 electionId, uint256 nullifier, bytes32 ballotHash)
        external
        view
        returns (bool);
}
