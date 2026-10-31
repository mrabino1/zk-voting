// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {PoseidonT3} from "../hasher/PoseidonT3.sol";

/// @title IndexedRoot
/// @notice Empty indexed ballot set. Leaf 0 is Poseidon(Poseidon(0, 0), 0).
///         Every other leaf is 0. Index 0 is the left child at every level.
///         Production depth is 20. The same fold is in the node tree.
library IndexedRoot {
    uint256 internal constant DEPTH = 20;

    function empty(uint256 depth) internal pure returns (uint256 h) {
        uint256 sibling;
        h = PoseidonT3.hashLeftRight(PoseidonT3.hashLeftRight(0, 0), 0);
        for (uint256 i; i < depth; ++i) {
            h = PoseidonT3.hashLeftRight(h, sibling);
            sibling = PoseidonT3.hashLeftRight(sibling, sibling);
        }
    }
}
