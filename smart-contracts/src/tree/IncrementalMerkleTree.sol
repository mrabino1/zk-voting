// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";

/// @title IncrementalMerkleTree
/// @notice Semaphore-style incremental binary tree. Depth 16–32.
///         Production circuits hash with Poseidon (`poseidon-bn254-x5-t3-v1`).
///         Unit tests inject `KeccakHasher` (`keccak-dev-v1`). The local proving
///         path may inject `StandInHasher` so the tree matches Circom. Max leaves = 2**depth.
library IncrementalMerkleTree {
    uint8 internal constant MIN_DEPTH = 16;
    uint8 internal constant MAX_DEPTH = 32;

    error InvalidDepth();
    error TreeFull();
    error NotInitialized();

    struct Data {
        uint8 depth;
        uint256 nextIndex;
        uint256 currentRoot;
        mapping(uint256 => uint256) filledSubtrees;
        mapping(uint256 => uint256) zeros;
        bool initialized;
    }

    function init(Data storage tree, uint8 depth, IHasher hasher) internal {
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert InvalidDepth();
        uint256 z = 0;
        tree.zeros[0] = 0;
        for (uint8 i = 0; i < depth;) {
            z = hasher.hashLeftRight(z, z);
            tree.zeros[i + 1] = z;
            tree.filledSubtrees[i] = tree.zeros[i];
            unchecked {
                ++i;
            }
        }
        tree.depth = depth;
        tree.currentRoot = z;
        tree.nextIndex = 0;
        tree.initialized = true;
    }

    function insert(Data storage tree, uint256 leaf, IHasher hasher) internal returns (uint256 index, bytes32 newRoot) {
        if (!tree.initialized) revert NotInitialized();
        index = tree.nextIndex;
        if (index >= (uint256(1) << tree.depth)) revert TreeFull();

        uint256 currentIndex = index;
        uint256 currentHash = leaf;
        uint8 depth = tree.depth;
        for (uint8 i = 0; i < depth;) {
            if (currentIndex % 2 == 0) {
                tree.filledSubtrees[i] = currentHash;
                currentHash = hasher.hashLeftRight(currentHash, tree.zeros[i]);
            } else {
                currentHash = hasher.hashLeftRight(tree.filledSubtrees[i], currentHash);
            }
            currentIndex /= 2;
            unchecked {
                ++i;
            }
        }
        tree.nextIndex = index + 1;
        tree.currentRoot = currentHash;
        newRoot = bytes32(currentHash);
    }

    function root(Data storage tree) internal view returns (bytes32) {
        return bytes32(tree.currentRoot);
    }
}
