// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title WebAuthn
/// @notice P-256 / WebAuthn assertion checks for ZK-Voting passkey accounts.
///
/// PRODUCTION REQUIREMENT: ZK-Voting L2 MUST enable the RIP-7212 / EIP-7951
/// P-256 precompile at address `0x100` (`p256Verify`). Without it every
/// WebAuthn signature fails closed. There is no structural fallback.
///
/// An assertion is accepted only when ALL of the following hold
/// (audit C-01, 2026-10-24):
///   1. authenticatorData is at least 37 bytes and has the User Present flag.
///   2. clientDataJSON contains `"type":"webauthn.get"`.
///   3. clientDataJSON contains `"challenge":"<base64url(challenge)>"`, where
///      `challenge` is the caller-supplied 32-byte value (the UserOp hash).
///   4. 0 < r, s < n (P-256 group order).
///   5. The precompile returns exactly 32 bytes equal to 1 for
///      sha256(authenticatorData || sha256(clientDataJSON)).
///
/// High-s signatures are accepted: authenticators do not normalise `s`, and
/// replay is prevented by the account nonce, not by signature uniqueness.
library WebAuthn {
    /// @dev RIP-7212 secp256r1 verification precompile (`p256Verify`).
    address internal constant P256_VERIFY = address(0x100);

    /// @dev P-256 group order n.
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    /// @dev authenticatorData flags byte offset and User Present bit.
    uint256 private constant FLAGS_OFFSET = 32;
    bytes1 private constant FLAG_UP = 0x01;

    bytes internal constant TYPE_GET = bytes('"type":"webauthn.get"');
    bytes internal constant CHALLENGE_PREFIX = bytes('"challenge":"');

    /// @notice Verify a WebAuthn assertion against a P-256 public key and challenge.
    /// @param authenticatorData FIDO authenticator data (min 37 bytes: rpIdHash, flags, counter).
    /// @param clientDataJSON Client data JSON; must embed `challenge` (base64url, unpadded).
    /// @param rs ECDSA signature `(r, s)` on the WebAuthn message hash.
    /// @param pubX Uncompressed P-256 public key x.
    /// @param pubY Uncompressed P-256 public key y.
    /// @param challenge The 32-byte value the signature must commit to (UserOp hash).
    /// @return ok True only if every check above passes. Never true without the precompile.
    function verify(
        bytes memory authenticatorData,
        string memory clientDataJSON,
        uint256[2] memory rs,
        uint256 pubX,
        uint256 pubY,
        bytes32 challenge
    ) internal view returns (bool ok) {
        if (authenticatorData.length < 37) return false;
        if (authenticatorData[FLAGS_OFFSET] & FLAG_UP != FLAG_UP) return false;
        if (rs[0] == 0 || rs[0] >= P256_N || rs[1] == 0 || rs[1] >= P256_N) return false;

        bytes memory json = bytes(clientDataJSON);
        if (!_contains(json, TYPE_GET)) return false;
        bytes memory expectedChallenge = bytes.concat(CHALLENGE_PREFIX, base64Url(challenge), bytes('"'));
        if (!_contains(json, expectedChallenge)) return false;

        bytes32 messageHash = sha256(bytes.concat(authenticatorData, sha256(json)));
        return _p256Verify(messageHash, rs[0], rs[1], pubX, pubY);
    }

    /// @notice Unpadded base64url encoding of 32 bytes (43 characters).
    function base64Url(bytes32 data) internal pure returns (bytes memory out) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);
        uint256 v = uint256(data);
        // 32 bytes = 256 bits = 42 full sextets (252 bits) + 4 bits padded to a sextet.
        for (uint256 i; i < 42; ++i) {
            out[i] = table[(v >> (250 - 6 * i)) & 0x3f];
        }
        out[42] = table[(v & 0x0f) << 2];
    }

    /// @dev RIP-7212: 160-byte input (hash, r, s, x, y). Success is exactly one
    ///      32-byte word equal to 1. Empty return data (invalid sig, or no
    ///      precompile on this chain) is a failure.
    function _p256Verify(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y) private view returns (bool) {
        address precompile = P256_VERIFY;
        bytes memory input = abi.encodePacked(messageHash, bytes32(r), bytes32(s), bytes32(x), bytes32(y));
        bool succeeded;
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0)
            succeeded := staticcall(gas(), precompile, add(input, 32), 160, ptr, 32)
            size := returndatasize()
            word := mload(ptr)
        }
        return succeeded && size == 32 && word == 1;
    }

    function _contains(bytes memory haystack, bytes memory needle) private pure returns (bool) {
        uint256 n = haystack.length;
        uint256 m = needle.length;
        if (m == 0) return true;
        if (n < m) return false;
        uint256 last = n - m;
        for (uint256 i; i <= last; ++i) {
            if (haystack[i] != needle[0]) continue;
            bool found = true;
            for (uint256 j = 1; j < m; ++j) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }
}
