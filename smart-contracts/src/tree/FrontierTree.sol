// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";

/// @title FrontierTree
/// @notice Append-only binary Merkle tree kept as a "binary counter" frontier.
///         `append` costs amortized ~2 hashes (at most `depth`), `root` costs
///         exactly `depth` hashes and never depends on the number of leaves.
/// @dev Produces the same root as `IncrementalMerkleTree` / `EligibleSet.rootOf`
///      for the same leaves, depth and hasher (zeros[0] = 0,
///      zeros[i+1] = H(zeros[i], zeros[i])). Audit H-03.
library FrontierTree {
    uint8 internal constant MIN_DEPTH = 16;
    uint8 internal constant MAX_DEPTH = 32;

    error InvalidDepth();
    error TreeFull();

    struct Data {
        uint8 depth;
        uint256 count;
        /// @dev frontier[level] = root of the most recent complete subtree of
        ///      size 2**level. Only read for levels whose bit is set in `count`.
        mapping(uint256 => uint256) frontier;
        mapping(uint256 => uint256) zeros;
    }

    /// @notice Initialise zeros for `depth` (once) and empty the tree.
    function reset(Data storage t, uint8 depth, IHasher hasher) internal {
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) revert InvalidDepth();
        if (t.depth != depth) {
            uint256 z = 0;
            t.zeros[0] = 0;
            for (uint8 i = 0; i < depth;) {
                z = hasher.hashLeftRight(z, z);
                t.zeros[i + 1] = z;
                unchecked {
                    ++i;
                }
            }
            t.depth = depth;
        }
        t.count = 0;
    }

    function append(Data storage t, uint256 leaf, IHasher hasher) internal {
        uint256 idx = t.count;
        if (idx >= (uint256(1) << t.depth)) revert TreeFull();
        uint256 node = leaf;
        uint256 level;
        while (idx & 1 == 1) {
            node = hasher.hashLeftRight(t.frontier[level], node);
            idx >>= 1;
            unchecked {
                ++level;
            }
        }
        t.frontier[level] = node;
        unchecked {
            t.count += 1;
        }
    }

    function root(Data storage t, IHasher hasher) internal view returns (uint256 cur) {
        uint8 depth = t.depth;
        uint256 c = t.count;
        if (c == (uint256(1) << depth)) return t.frontier[depth];
        cur = 0;
        for (uint256 level; level < depth;) {
            if ((c >> level) & 1 == 1) {
                cur = hasher.hashLeftRight(t.frontier[level], cur);
            } else {
                cur = hasher.hashLeftRight(cur, t.zeros[level]);
            }
            unchecked {
                ++level;
            }
        }
    }
}
