// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";
import {IHashScheme} from "../interfaces/IHashScheme.sol";
import {HashScheme} from "./HashScheme.sol";
import {PoseidonT3} from "./PoseidonT3.sol";

/// @title PoseidonHasher
/// @notice `republic.hash.poseidon-bn254-x5-t3-v1`. Matches the vote circuit Hasher().
/// @dev Wiring this hasher does not install a Groth16 verifying key and is not a ceremony.
///      Foundry unit tests keep KeccakHasher. Do not mix schemes in one tree.
contract PoseidonHasher is IHasher, IHashScheme {
    function schemeId() external pure returns (bytes32) {
        return HashScheme.POSEIDON_BN254_X5_T3_V1;
    }

    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256) {
        return PoseidonT3.hashLeftRight(left, right);
    }
}
