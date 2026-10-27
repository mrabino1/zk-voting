// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface ITallyVerifier {
    event TallyPosted(uint256 indexed electionId, bytes32 countsHash, uint256 total);
    /// @notice Aggregate result. `aggregateHash` commits to the summed ciphertext,
    ///         not to a per-ballot opening list.
    event AggregateTallyPosted(
        uint256 indexed electionId, bytes32 countsHash, bytes32 aggregateHash, bytes32 ballotRoot, uint256 total
    );

    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    /// @notice Aggregate path: `counts` is the option histogram and `aggregateHash`
    ///         binds the homomorphic product. There is no per-ballot openings array.
    function submitAggregateTally(
        uint256 electionId,
        uint256[] calldata counts,
        bytes32 aggregateHash_,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function tally(uint256 electionId) external view returns (uint256[] memory);

    function isTallied(uint256 electionId) external view returns (bool);
}
