// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {HashScheme} from "./hasher/HashScheme.sol";
import {PoseidonT3} from "./hasher/PoseidonT3.sol";

/// @title IdentityCommitment
/// @notice Leaf and nullifier helpers. Default EVM tests use keccak-dev-v1.
/// @dev Vote circuit: Poseidon(trapdoor, nullifierSecret). The leaf is NEVER a
///      wallet address. `toLeaf` stays keccak so existing unit tests keep their roots.
///      Poseidon wiring is not a Groth16 ceremony.
library IdentityCommitment {
    /// @notice Default test leaf: keccak256(trapdoor || nullifierSecret).
    function toLeaf(uint256 trapdoor, uint256 nullifierSecret) internal pure returns (uint256) {
        return keccakLeaf(trapdoor, nullifierSecret);
    }

    function nullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return keccakNullifier(nullifierSecret, electionId);
    }

    function keccakLeaf(uint256 trapdoor, uint256 nullifierSecret) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(trapdoor, nullifierSecret)));
    }

    function keccakNullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(nullifierSecret, electionId)));
    }

    /// @notice Matches `IdentityCommitment()` in `circuits/identity.circom` (standin-v0).
    function standInLeaf(uint256 trapdoor, uint256 nullifierSecret) internal pure returns (uint256) {
        return HashScheme.hashLeftRightStandIn(trapdoor, nullifierSecret);
    }

    /// @notice Matches `ComputeNullifier()` for the legacy stand-in (not the circuit).
    function standInNullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return HashScheme.hashLeftRightStandIn(nullifierSecret, electionId);
    }

    /// @notice Matches `IdentityCommitment()` in `circuits/identity.circom` (Poseidon).
    function poseidonLeaf(uint256 trapdoor, uint256 nullifierSecret) internal pure returns (uint256) {
        return PoseidonT3.hashLeftRight(trapdoor, nullifierSecret);
    }

    /// @notice Matches `ComputeNullifier()` in `circuits/identity.circom` (Poseidon).
    function poseidonNullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return PoseidonT3.hashLeftRight(nullifierSecret, electionId);
    }
}
