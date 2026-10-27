// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./ElectionParams.sol";

interface IElection {
    error AlreadyInitialized();
    error NotFactory();
    error NotClerk();
    error NotRegistry();
    error ZeroAddress();

    /// @notice Audit M-01: every root change is public; `afterStart` marks
    ///         a mid-election (late) update observers should scrutinise.
    event RootsUpdated(bytes32 eligibleRoot, bytes32 disqualificationRoot, bool afterStart);
    /// @notice Audit L-02: roll freeze is part of the public audit trail.
    event RollFrozen(uint256 indexed electionId, address indexed clerk);

    function initialize(
        uint256 electionId,
        ElectionParams calldata params,
        address factory,
        address voterRegistry,
        address disqualificationRegistry,
        address inbox
    ) external;

    function electionId() external view returns (uint256);

    function params() external view returns (ElectionParams memory);

    function eligibleRoot() external view returns (bytes32);

    function disqualificationRoot() external view returns (bytes32);

    function freezeRoll() external;

    function rollFrozen() external view returns (bool);

    function participantCount() external view returns (uint256);

    function state() external view returns (uint8);

    function factory() external view returns (address);

    function inbox() external view returns (address);

    function voterRegistry() external view returns (address);

    function disqualificationRegistry() external view returns (address);

    function setRoots(bytes32 eligibleRoot_, bytes32 disqualificationRoot_) external;

    function bumpParticipantCount() external;
}
