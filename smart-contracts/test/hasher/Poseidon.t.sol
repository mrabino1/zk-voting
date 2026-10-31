// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

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
        // External calls so the permutation is not copied into this function.
        assertEq(this.poseidonLeaf(1, 2), POSEIDON_1_2);
        assertEq(this.passkeyLeaf(2, 3), this.poseidonLeaf(2, 3));
        assertTrue(this.passkeyLeaf(2, 3) != IdentityCommitment.keccakLeaf(2, 3));
        assertEq(this.poseidonNullifier(3, 1), h.hashLeftRight(3, 1));
        assertTrue(h.hashLeftRight(1, 2) != HashScheme.hashLeftRightStandIn(1, 2));
    }

    function poseidonLeaf(uint256 a, uint256 b) external pure returns (uint256) {
        return IdentityCommitment.poseidonLeaf(a, b);
    }

    function passkeyLeaf(uint256 a, uint256 b) external pure returns (uint256) {
        return IdentityCommitment.demoPasskeyLeaf(a, b);
    }

    function poseidonNullifier(uint256 secret, uint256 electionId) external pure returns (uint256) {
        return IdentityCommitment.poseidonNullifier(secret, electionId);
    }
}
