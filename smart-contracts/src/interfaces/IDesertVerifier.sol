// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {StateTree} from "../libraries/StateTree.sol";

interface IDesertVerifier {
    /// @notice True when `leaf` sits at `electionId` under `stateRoot` and `accumulator`
    ///         folds to `leaf.accumulatorHash`. `siblings` run from the leaf level up.
    function verifyElection(
        uint256 stateRoot,
        uint256 electionId,
        StateTree.ElectionLeaf calldata leaf,
        uint256[4][] calldata accumulator,
        uint256[] calldata siblings
    ) external pure returns (bool);

    /// @notice Root of the empty L2 state, the genesis root of the rollup.
    function emptyStateRoot() external pure returns (uint256);
}
