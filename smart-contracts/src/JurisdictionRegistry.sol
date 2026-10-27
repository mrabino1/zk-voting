// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IJurisdictionRegistry} from "./interfaces/IJurisdictionRegistry.sol";
import {Roles} from "./Roles.sol";

/// @title JurisdictionRegistry
/// @notice Maps a jurisdiction id to its clerks and reason-catalog owner.
///         Platform admin bootstraps; clerks create elections for that body.
contract JurisdictionRegistry is IJurisdictionRegistry {
    address public admin;
    mapping(bytes32 => address) public clerkOf;
    mapping(bytes32 => string) public nameOf;
    mapping(bytes32 => mapping(address => bool)) public clerks;
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
        // Audit L-04: never silently overwrite a live jurisdiction (use setClerk).
        if (clerkOf[jurisdictionId] != address(0)) revert JurisdictionExists();
        clerkOf[jurisdictionId] = clerk;
        nameOf[jurisdictionId] = name;
        clerks[jurisdictionId][clerk] = true;
        officers[jurisdictionId][clerk] = true;
        emit JurisdictionCreated(jurisdictionId, clerk, name);
    }

    function setClerk(bytes32 jurisdictionId, address clerk) external onlyAdmin {
        if (clerkOf[jurisdictionId] == address(0)) revert UnknownJurisdiction();
        if (clerk == address(0)) revert ZeroAddress();
        address previous = clerkOf[jurisdictionId];
        if (previous != clerk) {
            // By design the replaced clerk keeps officer rights (existing
            // behaviour); admin / new clerk removes them with revokeOfficer.
            clerks[jurisdictionId][previous] = false;
            emit ClerkRevoked(jurisdictionId, previous);
        }
        clerkOf[jurisdictionId] = clerk;
        clerks[jurisdictionId][clerk] = true;
        officers[jurisdictionId][clerk] = true;
        emit ClerkSet(jurisdictionId, clerk);
    }

    /// @notice Extra clerks may create elections. Officers (registrar, tally, …) may not.
    function grantClerk(bytes32 jurisdictionId, address clerk) external {
        if (msg.sender != admin && msg.sender != clerkOf[jurisdictionId]) revert NotAdmin();
        if (clerkOf[jurisdictionId] == address(0)) revert UnknownJurisdiction();
        if (clerk == address(0)) revert ZeroAddress();
        clerks[jurisdictionId][clerk] = true;
        officers[jurisdictionId][clerk] = true;
        emit ClerkGranted(jurisdictionId, clerk);
    }

    function revokeClerk(bytes32 jurisdictionId, address clerk) external {
        if (msg.sender != admin && msg.sender != clerkOf[jurisdictionId]) revert NotAdmin();
        if (clerk == address(0)) revert ZeroAddress();
        if (clerk == clerkOf[jurisdictionId]) revert LastClerk();
        clerks[jurisdictionId][clerk] = false;
        emit ClerkRevoked(jurisdictionId, clerk);
    }

    function grantOfficer(bytes32 jurisdictionId, address officer) external {
        if (msg.sender != admin && msg.sender != clerkOf[jurisdictionId]) revert NotAdmin();
        if (officer == address(0)) revert ZeroAddress();
        officers[jurisdictionId][officer] = true;
        emit OfficerGranted(jurisdictionId, officer);
    }

    function revokeOfficer(bytes32 jurisdictionId, address officer) external {
        if (msg.sender != admin && msg.sender != clerkOf[jurisdictionId]) revert NotAdmin();
        if (officer == address(0)) revert ZeroAddress();
        officers[jurisdictionId][officer] = false;
        emit OfficerRevoked(jurisdictionId, officer);
    }

    function isClerk(bytes32 jurisdictionId, address account) external view returns (bool) {
        return clerks[jurisdictionId][account];
    }

    function isOfficer(bytes32 jurisdictionId, address account) external view returns (bool) {
        return officers[jurisdictionId][account];
    }

    function grantRole(bytes32 role, address account) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    /// @notice Audit L-04: roles are revocable.
    function revokeRole(bytes32 role, address account) external onlyAdmin {
        roles[role][account] = false;
        emit RoleRevoked(role, account);
    }
}
