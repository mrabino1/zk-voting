// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {HashScheme} from "../../src/hasher/HashScheme.sol";
import {PoseidonHasher} from "../../src/hasher/PoseidonHasher.sol";
import {IdentityCommitment} from "../../src/IdentityCommitment.sol";

/// @notice Poseidon(2) matches circomlib / the vote circuit. Not a ceremony.
contract PoseidonTest is Test {
    /// @dev circomlib Poseidon([1, 2]).
    uint256 internal constant POSEIDON_1_2 =
        7853200120776062878684798364095072458815029376092732009249414926327459813530;
    uint256 internal constant POSEIDON_0_0 =
        14744269619966411208579211824598458697587494354926760081771325075741142829156;
    uint256 internal constant POSEIDON_2_3 =
        17197790661637433027297685226742709599380837544520340689137581733613433332983;

    function testPoseidonVectorsMatchJsAndCircomlib() public {
        PoseidonHasher h = new PoseidonHasher();
        assertEq(h.schemeId(), HashScheme.POSEIDON_BN254_X5_T3_V1);
        assertEq(h.hashLeftRight(1, 2), POSEIDON_1_2);
        assertEq(h.hashLeftRight(0, 0), POSEIDON_0_0);
        assertEq(h.hashLeftRight(2, 3), POSEIDON_2_3);
        assertEq(IdentityCommitment.poseidonLeaf(1, 2), POSEIDON_1_2);
        assertEq(IdentityCommitment.poseidonNullifier(3, 1), h.hashLeftRight(3, 1));
        assertTrue(h.hashLeftRight(1, 2) != HashScheme.hashLeftRightStandIn(1, 2));
    }
}
