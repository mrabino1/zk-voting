// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface ITallyVerifier {
    event TallyPosted(uint256 indexed electionId, bytes32 countsHash, uint256 total);
    event OpenedTallyPosted(
        uint256 indexed electionId, bytes32 countsHash, bytes32 openingsHash, bytes32 ballotRoot, uint256 total
    );

    function submitTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    /// @notice OPENS_BALLOTS path: `openings[i]` is the option index of accepted ballot `i`.
    ///         `histogram(openings) == counts` and `openings.length == acceptedBallots`.
    function submitOpenedTally(
        uint256 electionId,
        uint256[] calldata counts,
        uint256[] calldata openings,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external;

    function tally(uint256 electionId) external view returns (uint256[] memory);

    function isTallied(uint256 electionId) external view returns (bool);
}
