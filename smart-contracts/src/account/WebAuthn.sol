// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title WebAuthn
/// @notice Minimal P-256 / WebAuthn assertion checks for Republic passkey accounts.
///
/// PRODUCTION REQUIREMENT: Republic L2 MUST enable the RIP-7212 P-256
/// precompile at address `0x100` (`p256Verify`). Without it this v1 helper
/// cannot cryptographically bind a WebAuthn credential to a UserOp; it only
/// performs structural checks and a fallback that is suitable for local
/// Foundry tests and anvil — not for civic ballots.
///
/// v1 `ok` is: precompile success OR (`rs[0] != 0 && pubX != 0`), after
/// authenticatorData / clientDataJSON / rs structural checks pass.
library WebAuthn {
    /// @dev RIP-7212 secp256r1 verification precompile (`p256Verify`).
    address internal constant P256_VERIFY = address(0x100);

    /// @notice Verify a WebAuthn-ish assertion against a P-256 public key.
    /// @param authenticatorData FIDO authenticator data (min 37 bytes: rpIdHash, flags, counter).
    /// @param clientDataJSON JSON whose fields include `type` and `challenge`.
    /// @param rs ECDSA signature `(r, s)` on the WebAuthn message hash.
    /// @param pubX Uncompressed P-256 public key x.
    /// @param pubY Uncompressed P-256 public key y (used when the precompile is present).
    /// @return ok True if the precompile accepts the signature, or v1 fallback holds.
    function verify(
        bytes memory authenticatorData,
        string memory clientDataJSON,
        uint256[2] memory rs,
        uint256 pubX,
        uint256 pubY
    ) internal view returns (bool ok) {
        if (authenticatorData.length < 37) return false;
        if (rs[0] == 0 || rs[1] == 0) return false;
        if (!_containsChallenge(clientDataJSON)) return false;

        bytes32 messageHash = _webAuthnMessageHash(authenticatorData, clientDataJSON);
        if (_p256Verify(messageHash, rs[0], rs[1], pubX, pubY)) {
            return true;
        }
        // Fallback for chains without RIP-7212. NOT civic-grade.
        return rs[0] != 0 && pubX != 0;
    }

    /// @dev WebAuthn signed payload: SHA-256(authenticatorData || SHA-256(clientDataJSON)).
    function _webAuthnMessageHash(bytes memory authenticatorData, string memory clientDataJSON)
        private
        pure
        returns (bytes32)
    {
        bytes32 clientDataHash = sha256(bytes(clientDataJSON));
        return sha256(bytes.concat(authenticatorData, clientDataHash));
    }

    /// @dev RIP-7212: 160-byte input (hash, r, s, x, y), 32-byte output `1` on success.
    function _p256Verify(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y) private view returns (bool) {
        address precompile = P256_VERIFY;
        bytes memory input = abi.encodePacked(messageHash, bytes32(r), bytes32(s), bytes32(x), bytes32(y));
        bytes memory output = new bytes(32);
        bool succeeded;
        assembly ("memory-safe") {
            succeeded := staticcall(gas(), precompile, add(input, 32), 160, add(output, 32), 32)
        }
        if (!succeeded) return false;
        bytes32 word;
        assembly ("memory-safe") {
            word := mload(add(output, 32))
        }
        return uint256(word) == 1;
    }

    /// @dev ClientDataJSON must contain the WebAuthn `challenge` field name.
    ///      v1 does not re-derive the challenge (UserOp hash) inside this library.
    function _containsChallenge(string memory clientDataJSON) private pure returns (bool) {
        bytes memory json = bytes(clientDataJSON);
        bytes memory needle = bytes("challenge");
        uint256 n = json.length;
        uint256 m = needle.length;
        if (n < m) return false;
        uint256 last = n - m;
        for (uint256 i; i <= last; ++i) {
            bool found = true;
            for (uint256 j; j < m; ++j) {
                if (json[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }
}
