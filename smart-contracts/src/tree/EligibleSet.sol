// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";

/// @title EligibleSet
/// @notice Incremental Merkle root of `registered ∩ ¬currently-disqualified`,
///         in registration order. Same shape as `IncrementalMerkleTree`:
///         depth 16–32, sibling zeros from `IHasher.hashLeftRight`.
/// @dev The vote circuit proves inclusion in this root and non-membership in
///      the disqualification chain (`DisqualificationSet`). A disqualified
///      commitment has no path here, so an honest inclusion witness fails.
library EligibleSet {
    error InvalidDepth();
    error TreeFull();
    error InvalidIndex();

    struct Proof {
        uint256[] pathElements;
        uint8[] pathIndices;
        uint256 root;
    }

    function rootOf(uint256[] memory leaves, uint8 depth, IHasher hasher) internal pure returns (uint256) {
        if (depth < 16 || depth > 32) revert InvalidDepth();
        if (leaves.length > (uint256(1) << depth)) revert TreeFull();

        uint256[] memory zeros = _zeros(depth, hasher);
        uint256[] memory filled = new uint256[](depth);
        for (uint8 i = 0; i < depth;) {
            filled[i] = zeros[i];
            unchecked {
                ++i;
            }
        }

        uint256 currentRoot = zeros[depth];
        for (uint256 n = 0; n < leaves.length; ++n) {
            uint256 currentIndex = n;
            uint256 currentHash = leaves[n];
            for (uint8 i = 0; i < depth;) {
                if (currentIndex % 2 == 0) {
                    filled[i] = currentHash;
                    currentHash = hasher.hashLeftRight(currentHash, zeros[i]);
                } else {
                    currentHash = hasher.hashLeftRight(filled[i], currentHash);
                }
                currentIndex /= 2;
                unchecked {
                    ++i;
                }
            }
            currentRoot = currentHash;
        }
        return currentRoot;
    }

    /// @notice Inclusion path for `leaves[index]`, matching `circuits/vote.circom`
    ///         `MerkleTreeInclusionProof` (0 = current is left, 1 = right).
    function inclusionProof(uint256[] memory leaves, uint256 index, uint8 depth, IHasher hasher)
        internal
        pure
        returns (Proof memory proof)
    {
        if (depth < 16 || depth > 32) revert InvalidDepth();
        if (index >= leaves.length) revert InvalidIndex();

        uint256[] memory zeros = _zeros(depth, hasher);
        proof.pathElements = new uint256[](depth);
        proof.pathIndices = new uint8[](depth);

        uint256[] memory layer = new uint256[](leaves.length);
        for (uint256 i = 0; i < leaves.length; ++i) {
            layer[i] = leaves[i];
        }

        uint256 idx = index;
        for (uint8 level = 0; level < depth;) {
            uint256 bit = idx & 1;
            proof.pathIndices[level] = uint8(bit);
            if (bit == 0) {
                uint256 rightIdx = idx + 1;
                proof.pathElements[level] = rightIdx < layer.length ? layer[rightIdx] : zeros[level];
            } else {
                proof.pathElements[level] = layer[idx - 1];
            }

            uint256 nextLen = (layer.length + 1) / 2;
            uint256[] memory next = new uint256[](nextLen);
            for (uint256 i = 0; i < layer.length; i += 2) {
                uint256 left = layer[i];
                uint256 right = (i + 1 < layer.length) ? layer[i + 1] : zeros[level];
                next[i / 2] = hasher.hashLeftRight(left, right);
            }
            layer = next;
            idx >>= 1;
            unchecked {
                ++level;
            }
        }

        proof.root = layer.length == 0 ? zeros[depth] : layer[0];
    }

    /// @notice Vote-circuit inclusion check: replay the path and compare to `root`.
    /// @dev `depth` is the tree depth (16–32) the root was built at. The path
    ///      must be exactly `depth` levels, as in the fixed-depth circuit. A
    ///      shorter path would let an internal node (or, with an empty path,
    ///      the root itself) pass as a leaf.
    function verifyInclusion(
        uint256 leaf,
        uint256[] memory pathElements,
        uint8[] memory pathIndices,
        uint256 root,
        uint8 depth,
        IHasher hasher
    ) internal pure returns (bool) {
        if (depth < 16 || depth > 32) return false;
        if (pathElements.length != depth || pathIndices.length != depth) return false;
        uint256 h = leaf;
        for (uint256 i = 0; i < pathElements.length; ++i) {
            uint8 s = pathIndices[i];
            if (s > 1) return false;
            uint256 sib = pathElements[i];
            if (s == 0) h = hasher.hashLeftRight(h, sib);
            else h = hasher.hashLeftRight(sib, h);
        }
        return h == root;
    }

    function _zeros(uint8 depth, IHasher hasher) private pure returns (uint256[] memory zeros) {
        zeros = new uint256[](uint256(depth) + 1);
        uint256 z = 0;
        zeros[0] = 0;
        for (uint8 i = 0; i < depth;) {
            z = hasher.hashLeftRight(z, z);
            zeros[uint256(i) + 1] = z;
            unchecked {
                ++i;
            }
        }
    }
}
