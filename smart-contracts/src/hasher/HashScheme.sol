// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

/// @title HashScheme
/// @notice Versioned HashLeftRight identifiers shared by Solidity, JS, and circuits.
/// @dev Production target is Poseidon (bn254, x^5, t=3). Until that is vendored:
///      - Foundry / Node tests use `KECCAK_DEV_V1` (`KeccakHasher`).
///      - Local Groth16 proving-path uses `STANDIN_V0` (matches `circuits/hasher/standin.circom`).
///      Neither keccak nor the bilinear stand-in is a ceremony-grade hasher.
library HashScheme {
    /// @notice Circom stand-in: `out = a + b + a*b` over Fr. NOT collision-resistant.
    bytes32 internal constant STANDIN_V0 = keccak256("republic.hash.standin-v0");

    /// @notice EVM-test keccak256(left || right). Matches `KeccakHasher`.
    bytes32 internal constant KECCAK_DEV_V1 = keccak256("republic.hash.keccak-dev-v1");

    /// @notice Production target. Not wired. Do not run a trusted setup until this is live
    ///         in-circuit, in JS witness builders, and in the on-chain `IHasher`.
    bytes32 internal constant POSEIDON_BN254_X5_T3_V1 = keccak256("republic.hash.poseidon-bn254-x5-t3-v1");

    /// @notice bn254 scalar field (Fr). Circom / Groth16 public inputs live here.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function idOf(string memory name) internal pure returns (bytes32) {
        return keccak256(bytes(name));
    }

    function isStandIn(bytes32 id) internal pure returns (bool) {
        return id == STANDIN_V0;
    }

    function isKeccakDev(bytes32 id) internal pure returns (bool) {
        return id == KECCAK_DEV_V1;
    }

    function isProductionPoseidon(bytes32 id) internal pure returns (bool) {
        return id == POSEIDON_BN254_X5_T3_V1;
    }

    /// @notice Circom `Hasher()` body. `hash(x, 0) == x`, so zero siblings collapse a path.
    function hashLeftRightStandIn(uint256 left, uint256 right) internal pure returns (uint256) {
        uint256 f = SNARK_SCALAR_FIELD;
        uint256 a = left % f;
        uint256 b = right % f;
        return addmod(addmod(a, b, f), mulmod(a, b, f), f);
    }
}
