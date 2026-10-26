// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingAccount, UserOp} from "./ZkVotingEntryPoint.sol";
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
contract PasskeyAccount is IZkVotingAccount {
    error ZeroAddress();
    error NotEntryPoint();
    error InvalidNonce();
    error InvalidSender();
    error InvalidSignature();
    error ExecuteFailed();

    /// @notice ZkVotingEntryPoint that is allowed to validate and execute.
    address public immutable entryPoint;

    /// @notice keccak256(WebAuthn credential id). NOT an identityCommitment.
    bytes32 public immutable credIdHash;

    /// @notice Uncompressed P-256 public key (x). Device-bound passkey.
    uint256 public immutable pubX;

    /// @notice Uncompressed P-256 public key (y).
    uint256 public immutable pubY;

    /// @notice Sequential nonce checked by the EntryPoint and incremented here.
    uint256 public nonce;

    /// @notice Optional secp256k1 backup signer, fixed at deployment (audit C-02).
    ///         Production civic accounts leave this at zero and use WebAuthn only;
    ///         with zero, every 65-byte signature is rejected. There is no
    ///         trust-on-first-use binding.
    address public immutable ethBackupSigner;

    /// @dev secp256k1 n / 2. Signatures with a larger `s` are malleable and rejected.
    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    constructor(address entryPoint_, bytes32 credIdHash_, uint256 pubX_, uint256 pubY_, address ethBackupSigner_) {
        if (entryPoint_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        credIdHash = credIdHash_;
        pubX = pubX_;
        pubY = pubY_;
        ethBackupSigner = ethBackupSigner_;
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
    ///      - 65 bytes `r ‖ s ‖ v`: secp256k1 over the raw `userOpHash`, accepted only
    ///        when a non-zero `ethBackupSigner` was fixed at deployment (low-s only).
    ///      - otherwise: `abi.encode(authenticatorData, clientDataJSON, uint256[2] rs)`
    ///        passed to `WebAuthn.verify`, whose challenge MUST be `userOpHash`.
    function validateUserOp(UserOp calldata op, bytes32 userOpHash) external onlyEntryPoint returns (bool) {
        if (op.sender != address(this)) revert InvalidSender();
        if (op.nonce != nonce) revert InvalidNonce();
        if (!_isValidSignature(op.signature, userOpHash)) revert InvalidSignature();
        unchecked {
            nonce = op.nonce + 1;
        }
        return true;
    }

    function _isValidSignature(bytes calldata signature, bytes32 userOpHash) internal view returns (bool) {
        if (signature.length == 65) {
            return _validateSecp256k1(signature, userOpHash);
        }
        (bytes memory authenticatorData, string memory clientDataJSON, uint256[2] memory rs) =
            abi.decode(signature, (bytes, string, uint256[2]));
        return WebAuthn.verify(authenticatorData, clientDataJSON, rs, pubX, pubY, userOpHash);
    }

    function _validateSecp256k1(bytes calldata signature, bytes32 userOpHash) internal view returns (bool) {
        address signer = ethBackupSigner;
        if (signer == address(0)) return false;
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
        if (v != 27 && v != 28) return false;
        if (uint256(s) > SECP256K1_HALF_N) return false;

        address recovered = ecrecover(userOpHash, v, r, s);
        return recovered != address(0) && recovered == signer;
    }
}
