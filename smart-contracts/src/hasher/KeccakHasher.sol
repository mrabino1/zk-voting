// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IHasher} from "../interfaces/IHasher.sol";

/// @title KeccakHasher
/// @notice Development hasher. Production circuits use Poseidon; this is the
///         EVM-test stand-in so Foundry tests do not need a trusted setup.
contract KeccakHasher is IHasher {
    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(left, right)));
    }
}
