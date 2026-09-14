// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title L1TallyMirror
/// @notice Court-grade copy of an L2 tally hash. Individual ballots are not posted.
contract L1TallyMirror {
    error ZeroAddress();
    error NotAuthorized();
    error AlreadyPosted();

    event ElectionCertified(uint256 indexed electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot);

    address public admin;
    address public related;

    mapping(uint256 => bytes32) public resultHashOf;
    mapping(uint256 => uint256) public totalBallotsOf;
    mapping(uint256 => bytes32) public claimedStateRoot;
    mapping(address => bool) public publishers;

    constructor(address admin_, address related_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        related = related_;
        publishers[admin_] = true;
    }

    function setPublisher(address account, bool allowed) external {
        if (msg.sender != admin) revert NotAuthorized();
        publishers[account] = allowed;
    }

    function postResult(uint256 electionId, bytes32 resultHash, uint256 totalBallots, bytes32 l2StateRoot) external {
        if (!publishers[msg.sender] && msg.sender != admin) revert NotAuthorized();
        if (resultHashOf[electionId] != bytes32(0)) revert AlreadyPosted();
        resultHashOf[electionId] = resultHash;
        totalBallotsOf[electionId] = totalBallots;
        claimedStateRoot[electionId] = l2StateRoot;
        emit ElectionCertified(electionId, resultHash, totalBallots, l2StateRoot);
    }
}
