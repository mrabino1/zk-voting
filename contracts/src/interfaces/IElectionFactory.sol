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
    event PartyRegistryCreated(uint256 indexed electionId, address indexed registry);
    event AdminApproved(address indexed account);
    event AdminRevoked(address indexed account);
    event ElectionStaffApproved(uint256 indexed electionId, address indexed account);
    event ElectionStaffRevoked(uint256 indexed electionId, address indexed account);

    function createElection(ElectionParams calldata params) external returns (uint256 electionId, address election);

    function getElection(uint256 electionId) external view returns (address);

    function getPartyRegistry(uint256 electionId) external view returns (address);

    function electionCount() external view returns (uint256);

    function implementation() external view returns (address);

    function isSuperAdmin(address account) external view returns (bool);

    function isPlatformAdmin(address account) external view returns (bool);

    function isElectionStaff(uint256 electionId, address account) external view returns (bool);
}
