// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";
import {IHashScheme} from "../interfaces/IHashScheme.sol";
import {HashScheme} from "./HashScheme.sol";

/// @title KeccakHasher
/// @notice `zk-voting.hash.keccak-dev-v1`. Default hasher for Foundry unit tests
///         and the Node Merkle tree so tests do not need a trusted setup.
/// @dev The vote circuit uses Poseidon (`PoseidonHasher`). This keccak tree is the
///      unit-test / demo default. Do not mix keccak leaves with Poseidon proofs.
contract KeccakHasher is IHasher, IHashScheme {
    function schemeId() external pure returns (bytes32) {
        return HashScheme.KECCAK_DEV_V1;
    }

    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(left, right)));
    }
}
