// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface IHasher {
    function hashLeftRight(uint256 left, uint256 right) external pure returns (uint256);
}
