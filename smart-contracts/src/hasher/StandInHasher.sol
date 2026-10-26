// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";
import {IHashScheme} from "../interfaces/IHashScheme.sol";
import {HashScheme} from "./HashScheme.sol";

/// @title StandInHasher
/// @notice Matches `circuits/hasher/standin.circom` (`zk-voting.hash.standin-v0`).
/// @dev Use only on the local proving path so JS witnesses, Circom, and the
///      Solidity tree share one HashLeftRight. NOT Poseidon. NOT for a binding election.
///      `hashLeftRight(x, 0) == x`, so an all-zero Merkle path is degenerate.
contract StandInHasher is IHasher, IHashScheme {
    function schemeId() external pure returns (bytes32) {
        return HashScheme.STANDIN_V0;
    }

    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256) {
        return HashScheme.hashLeftRightStandIn(left, right);
    }
}
