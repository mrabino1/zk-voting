// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Roles} from "./Roles.sol";

/// @title JurisdictionRegistry
/// @notice Maps a jurisdiction id to its clerks and reason-catalog owner.
///         Platform admin bootstraps; clerks create elections for that body.
contract JurisdictionRegistry {
    error ZeroId();
    error ZeroAddress();
    error NotAdmin();
    error UnknownJurisdiction();

    event JurisdictionCreated(bytes32 indexed jurisdictionId, address clerk, string name);
    event ClerkSet(bytes32 indexed jurisdictionId, address clerk);

    address public admin;
    mapping(bytes32 => address) public clerkOf;
    mapping(bytes32 => string) public nameOf;
    mapping(bytes32 => mapping(address => bool)) public officers;
    mapping(bytes32 => mapping(address => bool)) public roles;

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        roles[Roles.PLATFORM_ADMIN_ROLE][admin_] = true;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function createJurisdiction(bytes32 jurisdictionId, address clerk, string calldata name) external onlyAdmin {
        if (jurisdictionId == bytes32(0)) revert ZeroId();
        if (clerk == address(0)) revert ZeroAddress();
        clerkOf[jurisdictionId] = clerk;
        nameOf[jurisdictionId] = name;
        officers[jurisdictionId][clerk] = true;
        emit JurisdictionCreated(jurisdictionId, clerk, name);
    }

    function setClerk(bytes32 jurisdictionId, address clerk) external onlyAdmin {
        if (clerkOf[jurisdictionId] == address(0)) revert UnknownJurisdiction();
        if (clerk == address(0)) revert ZeroAddress();
        clerkOf[jurisdictionId] = clerk;
        officers[jurisdictionId][clerk] = true;
        emit ClerkSet(jurisdictionId, clerk);
    }

    function grantOfficer(bytes32 jurisdictionId, address officer) external {
        if (msg.sender != admin && msg.sender != clerkOf[jurisdictionId]) revert NotAdmin();
        if (officer == address(0)) revert ZeroAddress();
        officers[jurisdictionId][officer] = true;
    }

    function isClerk(bytes32 jurisdictionId, address account) external view returns (bool) {
        return clerkOf[jurisdictionId] == account || officers[jurisdictionId][account];
    }

    function grantRole(bytes32 role, address account) external onlyAdmin {
        roles[role][account] = true;
    }
}
