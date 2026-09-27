// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";
import {EligibleSet} from "./EligibleSet.sol";

/// @title DisqualificationSet
/// @notice Indexed Merkle chain of currently-disqualified identity commitments.
/// @dev Same shape as the vote circuit (`circuits/vote_lib.circom`):
///
///      sorted commitments `v0 < v1 < … < v_{k-1}` (none may be 0)
///      leaf 0   = Hash(0, v0)        or Hash(0, 0) when the set is empty
///      leaf i+1 = Hash(v_i, v_{i+1})
///      leaf k   = Hash(v_{k-1}, 0)   where 0 means "no successor"
///
///      Non-membership of `target` is an inclusion proof of one link
///      `Hash(low, next)` plus `low < target` and (`next == 0` or `target < next`).
///      A member is a boundary of the chain, so no gap covers it.
///
///      The hasher is the election's `IHasher`. Poseidon matches the circuit.
///      Foundry unit tests inject `KeccakHasher` and check the same relation.
library DisqualificationSet {
    error UnsortedOrZero();
    error NotAGap();

    struct Gap {
        uint256 index;
        uint256 low;
        uint256 next;
    }

    /// @notice Chain leaves for a strictly increasing, non-zero commitment list.
    function chainLeaves(uint256[] memory sortedCommitments, IHasher hasher)
        internal
        pure
        returns (uint256[] memory leaves)
    {
        uint256 n = sortedCommitments.length;
        uint256 prev;
        for (uint256 i; i < n; ++i) {
            if (sortedCommitments[i] <= prev) revert UnsortedOrZero();
            prev = sortedCommitments[i];
        }
        leaves = new uint256[](n + 1);
        uint256 firstNext = n == 0 ? 0 : sortedCommitments[0];
        leaves[0] = hasher.hashLeftRight(0, firstNext);
        for (uint256 i; i < n; ++i) {
            uint256 next = i + 1 < n ? sortedCommitments[i + 1] : 0;
            leaves[i + 1] = hasher.hashLeftRight(sortedCommitments[i], next);
        }
    }

    /// @notice Incremental root of `chainLeaves`, depth 16–32.
    function rootOf(uint256[] memory sortedCommitments, uint8 depth, IHasher hasher) internal pure returns (uint256) {
        return EligibleSet.rootOf(chainLeaves(sortedCommitments, hasher), depth, hasher);
    }

    /// @notice Index of the chain link whose open interval contains `target`.
    /// @dev Reverts when `target` is a member (no accepting non-membership witness).
    function gapFor(uint256[] memory sortedCommitments, uint256 target) internal pure returns (Gap memory gap) {
        uint256 n = sortedCommitments.length;
        for (uint256 i; i <= n; ++i) {
            uint256 low = i == 0 ? 0 : sortedCommitments[i - 1];
            uint256 next = i < n ? sortedCommitments[i] : 0;
            if (low == target || next == target) revert NotAGap();
            if (low < target && (next == 0 || target < next)) {
                gap.index = i;
                gap.low = low;
                gap.next = next;
                return gap;
            }
        }
        revert NotAGap();
    }

    /// @notice Vote-circuit non-membership check against `disqRoot`.
    function verifyNonMembership(
        uint256 leaf,
        uint256 low,
        uint256 next,
        uint256[] memory pathElements,
        uint8[] memory pathIndices,
        uint256 disqRoot,
        IHasher hasher
    ) internal pure returns (bool) {
        if (!(low < leaf)) return false;
        if (!(next == 0 || leaf < next)) return false;
        uint256 chainLeaf = hasher.hashLeftRight(low, next);
        return EligibleSet.verifyInclusion(chainLeaf, pathElements, pathIndices, disqRoot, hasher);
    }
}
