// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "./ElectionParams.sol";

interface IElectionFactory {
    event ElectionCreated(
        uint256 indexed electionId,
        address indexed election,
        bytes32 indexed jurisdictionId,
        uint64 startTime,
        uint64 cutoffTime
    );

    function createElection(ElectionParams calldata params) external returns (uint256 electionId, address election);

    function getElection(uint256 electionId) external view returns (address);

    function electionCount() external view returns (uint256);

    function implementation() external view returns (address);
}
