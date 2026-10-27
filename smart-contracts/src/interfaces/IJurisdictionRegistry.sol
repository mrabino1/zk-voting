// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IJurisdictionRegistry {
    error ZeroId();
    error ZeroAddress();
    error NotAdmin();
    error UnknownJurisdiction();
    error LastClerk();
    error JurisdictionExists();

    event JurisdictionCreated(bytes32 indexed jurisdictionId, address clerk, string name);
    event ClerkSet(bytes32 indexed jurisdictionId, address clerk);
    event ClerkGranted(bytes32 indexed jurisdictionId, address clerk);
    event ClerkRevoked(bytes32 indexed jurisdictionId, address clerk);
    event OfficerGranted(bytes32 indexed jurisdictionId, address officer);
    event OfficerRevoked(bytes32 indexed jurisdictionId, address officer);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);

    function admin() external view returns (address);

    function clerkOf(bytes32 jurisdictionId) external view returns (address);

    function nameOf(bytes32 jurisdictionId) external view returns (string memory);

    function clerks(bytes32 jurisdictionId, address account) external view returns (bool);

    function officers(bytes32 jurisdictionId, address account) external view returns (bool);

    function roles(bytes32 role, address account) external view returns (bool);

    function createJurisdiction(bytes32 jurisdictionId, address clerk, string calldata name) external;

    function setClerk(bytes32 jurisdictionId, address clerk) external;

    /// @notice Extra clerks may create elections. Officers (registrar, tally, …) may not.
    function grantClerk(bytes32 jurisdictionId, address clerk) external;

    function revokeClerk(bytes32 jurisdictionId, address clerk) external;

    function grantOfficer(bytes32 jurisdictionId, address officer) external;

    function revokeOfficer(bytes32 jurisdictionId, address officer) external;

    function isClerk(bytes32 jurisdictionId, address account) external view returns (bool);

    function isOfficer(bytes32 jurisdictionId, address account) external view returns (bool);

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;
}
