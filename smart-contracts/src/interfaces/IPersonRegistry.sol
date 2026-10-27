// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IPersonRegistry {
    error ZeroAddress();
    error ZeroPerson();
    error NotAdmin();
    error NotRegistrar();
    error AlreadyOwned(bytes32 personId);
    error NotVerified();
    error SameActive();

    event AddressVerified(bytes32 indexed personId, address indexed account);
    event ActiveAddressSet(bytes32 indexed personId, address indexed account, address previous);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);

    function admin() external view returns (address);

    function verified(bytes32 personId, address account) external view returns (bool);

    function activeAddress(bytes32 personId) external view returns (address);

    /// @notice Globally unique: a verified address belongs to at most one person.
    function personOf(address account) external view returns (bytes32);

    function roles(bytes32 role, address account) external view returns (bool);

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;

    /// @notice Internally verify that `account` belongs to `personId`.
    function verifyAddress(bytes32 personId, address account) external;

    /// @notice Register the single active Ethereum address for this person.
    function setActive(bytes32 personId, address account) external;

    function isVerified(bytes32 personId, address account) external view returns (bool);
}
