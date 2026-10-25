// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PasskeyAccount} from "./PasskeyAccount.sol";

/// @title PasskeyAccountFactory
/// @notice CREATE2 factory for passkey smart accounts.
/// @dev `credIdHash` is keccak256(WebAuthn credential id). It is a device
///      handle for the gasless account. It is NOT the vote identity
///      (identityCommitment) and MUST NOT be used as a Merkle leaf.
contract PasskeyAccountFactory {
    error ZeroAddress();

    /// @notice Emitted when a new account is deployed. `credIdHash` is NOT a vote identity.
    event AccountCreated(address indexed account, bytes32 indexed credIdHash);

    address public immutable entryPoint;

    constructor(address entryPoint_) {
        if (entryPoint_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
    }

    /// @notice Deploy (or return existing) CREATE2 account for this passkey.
    function createAccount(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt)
        external
        returns (address account)
    {
        account = getAddress(credIdHash, pubX, pubY, salt);
        if (account.code.length > 0) {
            return account;
        }
        PasskeyAccount deployed = new PasskeyAccount{salt: salt}(entryPoint, credIdHash, pubX, pubY);
        account = address(deployed);
        emit AccountCreated(account, credIdHash);
    }

    /// @notice Predict the CREATE2 address for these passkey parameters and salt.
    function getAddress(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt) public view returns (address) {
        bytes32 bytecodeHash = keccak256(_creationCode(credIdHash, pubX, pubY));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash)))));
    }

    function _creationCode(bytes32 credIdHash, uint256 pubX, uint256 pubY) internal view returns (bytes memory) {
        return abi.encodePacked(type(PasskeyAccount).creationCode, abi.encode(entryPoint, credIdHash, pubX, pubY));
    }
}
