// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IRepublicAccount, UserOp} from "./RepublicEntryPoint.sol";
import {WebAuthn} from "./WebAuthn.sol";

/// @title PasskeyAccount
/// @notice ERC-4337-lite smart account owned by a WebAuthn / P-256 key.
///
/// =============================================================================
/// UNLINKABILITY (read this before wiring anything to a ballot)
/// =============================================================================
/// The public address of this account IS THE CONTRACT ADDRESS (`address(this)`).
///
/// That address is used only to authorize a UserOp (register, or ask a relayer
/// to post a proof). It is NOT an identityCommitment, NOT a Merkle leaf, and
/// MUST NOT be written next to a ballot, nullifier, or choice.
///
/// Identity for voting is derived off-chain:
///   passkey PRF → HKDF → (trapdoor, nullifierSecret)
///   identityCommitment = poseidon(trapdoor, nullifierSecret)
///
/// `credIdHash` is keccak256(WebAuthn credential id). It is a device handle for
/// the Node's passkey wallet. It is NOT the vote identity. A coercer who sees
/// this contract address learns only that some person registered a gasless
/// account — they cannot read a choice or join it to the eligible-tree leaf.
/// =============================================================================
contract PasskeyAccount is IRepublicAccount {
    error ZeroAddress();
    error NotEntryPoint();
    error InvalidNonce();
    error InvalidSender();
    error InvalidSignature();
    error ExecuteFailed();

    /// @notice RepublicEntryPoint that is allowed to validate and execute.
    address public immutable entryPoint;

    /// @notice keccak256(WebAuthn credential id). NOT an identityCommitment.
    bytes32 public immutable credIdHash;

    /// @notice Uncompressed P-256 public key (x). Device-bound passkey.
    uint256 public immutable pubX;

    /// @notice Uncompressed P-256 public key (y).
    uint256 public immutable pubY;

    /// @notice Sequential nonce checked by the EntryPoint and incremented here.
    uint256 public nonce;

    /// @notice Optional secp256k1 signer for local Foundry tests (`vm.sign`).
    ///         Production civic accounts leave this at zero and use WebAuthn.
    ///         First valid 65-byte signature binds this address if it is unset.
    address public ethBackupSigner;

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    constructor(address entryPoint_, bytes32 credIdHash_, uint256 pubX_, uint256 pubY_) {
        if (entryPoint_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        credIdHash = credIdHash_;
        pubX = pubX_;
        pubY = pubY_;
    }

    receive() external payable {}

    /// @notice Execute a call from this account. Only the EntryPoint, after validation.
    function execute(address dest, uint256 value, bytes calldata data) external onlyEntryPoint {
        (bool ok, bytes memory ret) = dest.call{value: value}(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert ExecuteFailed();
        }
    }

    /// @notice Validate a UserOp signature and consume `op.nonce`.
    /// @dev Signature encodings:
    ///      - 65 bytes: secp256k1 ecrecover against `ethBackupSigner` (tests).
    ///      - otherwise: `abi.encode(authenticatorData, clientDataJSON, uint256[2] rs)`
    ///        passed to `WebAuthn.verify` with this account's P-256 key.
    function validateUserOp(UserOp calldata op, bytes32 userOpHash) external onlyEntryPoint returns (bool) {
        if (op.sender != address(this)) revert InvalidSender();
        if (op.nonce != nonce) revert InvalidNonce();
        if (!_isValidSignature(op.signature, userOpHash)) revert InvalidSignature();
        unchecked {
            nonce = op.nonce + 1;
        }
        return true;
    }

    function _isValidSignature(bytes calldata signature, bytes32 userOpHash) internal returns (bool) {
        if (signature.length == 65) {
            return _validateSecp256k1(signature, userOpHash);
        }
        (bytes memory authenticatorData, string memory clientDataJSON, uint256[2] memory rs) =
            abi.decode(signature, (bytes, string, uint256[2]));
        return WebAuthn.verify(authenticatorData, clientDataJSON, rs, pubX, pubY);
    }

    function _validateSecp256k1(bytes calldata signature, bytes32 userOpHash) internal returns (bool) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }

        address recovered = ecrecover(userOpHash, v, r, s);
        if (recovered == address(0)) {
            bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
            recovered = ecrecover(ethHash, v, r, s);
        }
        if (recovered == address(0)) return false;

        if (ethBackupSigner == address(0)) {
            ethBackupSigner = recovered;
            return true;
        }
        return recovered == ethBackupSigner;
    }
}
