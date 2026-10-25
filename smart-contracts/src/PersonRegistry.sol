// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Roles} from "./Roles.sol";

/// @title PersonRegistry
/// @notice One person (bytes32 id, never a legal name) may have many internally
///         verified Ethereum addresses and exactly one **active** address.
///
/// The vote Merkle leaf is still an identityCommitment, never `activeAddress`.
/// This registry only answers: which EOA / smart account is this person using
/// for gasless ops right now, and has the clerk verified these wallets as
/// belonging to that unique person.
contract PersonRegistry {
    error ZeroAddress();
    error ZeroPerson();
    error NotAdmin();
    error NotRegistrar();
    error AlreadyOwned(bytes32 personId);
    error NotVerified();
    error SameActive();

    event AddressVerified(bytes32 indexed personId, address indexed account);
    event ActiveAddressSet(bytes32 indexed personId, address indexed account, address previous);

    address public immutable admin;
    mapping(bytes32 => mapping(address => bool)) public verified;
    mapping(bytes32 => address) public activeAddress;
    /// @notice Globally unique: a verified address belongs to at most one person.
    mapping(address => bytes32) public personOf;
    mapping(bytes32 => mapping(address => bool)) public roles;

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        roles[Roles.PLATFORM_ADMIN_ROLE][admin_] = true;
        roles[Roles.REGISTRAR_ROLE][admin_] = true;
    }

    function grantRole(bytes32 role, address account) external {
        if (msg.sender != admin) revert NotAdmin();
        if (account == address(0)) revert ZeroAddress();
        roles[role][account] = true;
    }

    /// @notice Internally verify that `account` belongs to `personId`.
    ///         Does not change the active address. The same address cannot be
    ///         verified for a second person.
    function verifyAddress(bytes32 personId, address account) external {
        _requireRegistrar();
        if (personId == bytes32(0)) revert ZeroPerson();
        if (account == address(0)) revert ZeroAddress();
        bytes32 owner = personOf[account];
        if (owner != bytes32(0) && owner != personId) revert AlreadyOwned(owner);
        if (verified[personId][account]) return;
        verified[personId][account] = true;
        personOf[account] = personId;
        emit AddressVerified(personId, account);
    }

    /// @notice Register the single active Ethereum address for this person.
    ///         `account` must already be internally verified. Previous active
    ///         stays verified (internal), but is no longer active.
    function setActive(bytes32 personId, address account) external {
        _requireRegistrar();
        if (personId == bytes32(0)) revert ZeroPerson();
        if (account == address(0)) revert ZeroAddress();
        if (!verified[personId][account]) revert NotVerified();
        address previous = activeAddress[personId];
        if (previous == account) revert SameActive();
        activeAddress[personId] = account;
        emit ActiveAddressSet(personId, account, previous);
    }

    function isVerified(bytes32 personId, address account) external view returns (bool) {
        return verified[personId][account];
    }

    function _requireRegistrar() internal view {
        if (
            msg.sender != admin &&
            !roles[Roles.REGISTRAR_ROLE][msg.sender] &&
            !roles[Roles.PLATFORM_ADMIN_ROLE][msg.sender]
        ) {
            revert NotRegistrar();
        }
    }
}
