// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PoseidonT3} from "./PoseidonT3.sol";

/// @title StateTree
/// @notice L2 state commitments, mirrored by `voting_node/l2/rollup/state.mjs`.
/// @dev `stateRoot` is a Poseidon sparse Merkle tree of depth `ELECTION_TREE_DEPTH` keyed by
///      election id. Bit `i` of the id picks the side at level `i`, counting from the leaf.
///      An empty leaf is 0. An election leaf is
///      `fold(configHash, eligibleRoot, nullifierRoot, accumulatorHash, ballotCount, status)`.
library StateTree {
    uint256 internal constant ELECTION_TREE_DEPTH = 32;
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 internal constant STATUS_OPEN = 1;
    uint256 internal constant STATUS_CLOSED = 2;

    struct ElectionLeaf {
        uint256 configHash;
        uint256 eligibleRoot;
        uint256 nullifierRoot;
        uint256 accumulatorHash;
        uint256 ballotCount;
        uint256 status;
    }

    /// @notice `H(…H(H(x0, x1), x2)…, xn)`. One word folds to itself; none folds to 0.
    function fold(uint256[] memory words) internal pure returns (uint256 h) {
        uint256 n = words.length;
        if (n == 0) return 0;
        h = words[0];
        for (uint256 i = 1; i < n; ++i) {
            h = PoseidonT3.hashLeftRight(h, words[i]);
        }
    }

    function leafHash(ElectionLeaf memory leaf) internal pure returns (uint256) {
        uint256[] memory w = new uint256[](6);
        w[0] = leaf.configHash;
        w[1] = leaf.eligibleRoot;
        w[2] = leaf.nullifierRoot;
        w[3] = leaf.accumulatorHash;
        w[4] = leaf.ballotCount;
        w[5] = leaf.status;
        return fold(w);
    }

    /// @notice Fold of `(c1x, c1y, c2x, c2y)` for every option, in option order.
    function accumulatorHash(uint256[4][] memory acc) internal pure returns (uint256) {
        uint256[] memory w = new uint256[](acc.length * 4);
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < 4; ++j) {
                w[i * 4 + j] = acc[i][j];
            }
        }
        return fold(w);
    }

    /// @notice Root of the election tree given one leaf and its siblings, leaf level first.
    function rootFrom(uint256 electionId, uint256 leaf, uint256[] memory siblings) internal pure returns (uint256 h) {
        if (siblings.length != ELECTION_TREE_DEPTH) revert BadProofLength();
        h = leaf;
        for (uint256 i; i < ELECTION_TREE_DEPTH; ++i) {
            h = (electionId >> i) & 1 == 0
                ? PoseidonT3.hashLeftRight(h, siblings[i])
                : PoseidonT3.hashLeftRight(siblings[i], h);
        }
    }

    /// @notice Root of the empty election tree.
    function emptyRoot() internal pure returns (uint256 h) {
        for (uint256 i; i < ELECTION_TREE_DEPTH; ++i) {
            h = PoseidonT3.hashLeftRight(h, h);
        }
    }

    error BadProofLength();
}
