// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {HashScheme} from "./hasher/HashScheme.sol";

/// @title IdentityCommitment
/// @notice Leaf and nullifier helpers. Default EVM tests use keccak-dev-v1.
/// @dev Production: Poseidon(trapdoor, nullifierSecret). The leaf is NEVER a
///      wallet address. Proving-path circuits use `standInLeaf` until Poseidon is wired.
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

    /// @notice Matches `ComputeNullifier()` in `circuits/identity.circom` (standin-v0).
    function standInNullifier(uint256 nullifierSecret, uint256 electionId) internal pure returns (uint256) {
        return HashScheme.hashLeftRightStandIn(nullifierSecret, electionId);
    }
}
