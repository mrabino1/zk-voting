// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

interface ISettledRoots {
    function isSettledRoot(bytes32 root) external view returns (bool);
}
