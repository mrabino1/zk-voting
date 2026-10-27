// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IPasskeyAccountFactory} from "../interfaces/IPasskeyAccountFactory.sol";
import {PasskeyAccount} from "./PasskeyAccount.sol";

/// @title PasskeyAccountFactory
/// @notice CREATE2 factory for passkey smart accounts.
/// @dev `credIdHash` is keccak256(WebAuthn credential id). It is a device
///      handle for the gasless account. It is NOT the vote identity
///      (identityCommitment) and MUST NOT be used as a Merkle leaf.
contract PasskeyAccountFactory is IPasskeyAccountFactory {
    address public immutable entryPoint;

    constructor(address entryPoint_) {
        if (entryPoint_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
    }

    /// @notice Deploy (or return existing) CREATE2 account for this passkey.
    ///         No secp256k1 backup signer: WebAuthn only (production default).
    function createAccount(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt)
        external
        returns (address account)
    {
        return _create(credIdHash, pubX, pubY, address(0), salt);
    }

    /// @notice Deploy (or return existing) CREATE2 account with an explicit,
    ///         immutable secp256k1 backup signer (audit C-02: no TOFU binding).
    function createAccountWithBackupSigner(
        bytes32 credIdHash,
        uint256 pubX,
        uint256 pubY,
        address ethBackupSigner,
        bytes32 salt
    ) external returns (address account) {
        return _create(credIdHash, pubX, pubY, ethBackupSigner, salt);
    }

    /// @notice Predict the CREATE2 address for these passkey parameters and salt (no backup signer).
    function getAddress(bytes32 credIdHash, uint256 pubX, uint256 pubY, bytes32 salt) public view returns (address) {
        return getAddressWithBackupSigner(credIdHash, pubX, pubY, address(0), salt);
    }

    /// @notice Predict the CREATE2 address including the backup signer.
    function getAddressWithBackupSigner(
        bytes32 credIdHash,
        uint256 pubX,
        uint256 pubY,
        address ethBackupSigner,
        bytes32 salt
    ) public view returns (address) {
        bytes32 bytecodeHash = keccak256(_creationCode(credIdHash, pubX, pubY, ethBackupSigner));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash)))));
    }

    function _create(bytes32 credIdHash, uint256 pubX, uint256 pubY, address ethBackupSigner, bytes32 salt)
        internal
        returns (address account)
    {
        account = getAddressWithBackupSigner(credIdHash, pubX, pubY, ethBackupSigner, salt);
        if (account.code.length > 0) {
            return account;
        }
        PasskeyAccount deployed = new PasskeyAccount{salt: salt}(entryPoint, credIdHash, pubX, pubY, ethBackupSigner);
        account = address(deployed);
        emit AccountCreated(account, credIdHash);
    }

    function _creationCode(bytes32 credIdHash, uint256 pubX, uint256 pubY, address ethBackupSigner)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(PasskeyAccount).creationCode, abi.encode(entryPoint, credIdHash, pubX, pubY, ethBackupSigner)
        );
    }
}
