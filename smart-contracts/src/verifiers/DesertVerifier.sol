// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IDesertVerifier} from "../interfaces/IDesertVerifier.sol";
import {StateTree} from "../libraries/StateTree.sol";

/// @title DesertVerifier
/// @notice Stateless check of one election leaf, with its accumulator, against an L2 state root.
/// @dev Used only in desert mode, to close an election from the last executed state when the
///      operator has stopped. Poseidon on L1 is expensive (≈ 40 hashes); this is an escape hatch.
contract DesertVerifier is IDesertVerifier {
    /// @inheritdoc IDesertVerifier
    function verifyElection(
        uint256 stateRoot,
        uint256 electionId,
        StateTree.ElectionLeaf calldata leaf,
        uint256[4][] calldata accumulator,
        uint256[] calldata siblings
    ) external pure returns (bool) {
        if (StateTree.accumulatorHash(accumulator) != leaf.accumulatorHash) return false;
        return StateTree.rootFrom(electionId, StateTree.leafHash(leaf), siblings) == stateRoot;
    }

    /// @inheritdoc IDesertVerifier
    function emptyStateRoot() external pure returns (uint256) {
        return StateTree.emptyRoot();
    }
}
