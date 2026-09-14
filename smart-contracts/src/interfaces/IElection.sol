// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./ElectionParams.sol";

interface IElection {
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
