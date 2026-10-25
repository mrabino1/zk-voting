// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {HashScheme} from "../../src/hasher/HashScheme.sol";
import {KeccakHasher} from "../../src/hasher/KeccakHasher.sol";
import {StandInHasher} from "../../src/hasher/StandInHasher.sol";
import {IdentityCommitment} from "../../src/IdentityCommitment.sol";
import {IHasher} from "../../src/interfaces/IHasher.sol";
import {IncrementalMerkleTree} from "../../src/tree/IncrementalMerkleTree.sol";

contract TreeHarness {
    using IncrementalMerkleTree for IncrementalMerkleTree.Data;

    IncrementalMerkleTree.Data internal tree;

    function init(uint8 depth, IHasher hasher) external {
        IncrementalMerkleTree.init(tree, depth, hasher);
    }

    function insert(uint256 leaf, IHasher hasher) external returns (uint256 index, bytes32 newRoot) {
        return IncrementalMerkleTree.insert(tree, leaf, hasher);
    }

    function root() external view returns (bytes32) {
        return IncrementalMerkleTree.root(tree);
    }
}

/// @notice Versioned hasher: keccak for unit tests, stand-in aligned with Circom.
contract HashSchemeTest is Test {
    function testSchemeIdsAreStableKeccakOfNames() public pure {
        assertEq(HashScheme.STANDIN_V0, keccak256("republic.hash.standin-v0"));
        assertEq(HashScheme.KECCAK_DEV_V1, keccak256("republic.hash.keccak-dev-v1"));
        assertEq(HashScheme.POSEIDON_BN254_X5_T3_V1, keccak256("republic.hash.poseidon-bn254-x5-t3-v1"));
        assertTrue(HashScheme.isStandIn(HashScheme.STANDIN_V0));
        assertTrue(HashScheme.isKeccakDev(HashScheme.KECCAK_DEV_V1));
        assertTrue(HashScheme.isProductionPoseidon(HashScheme.POSEIDON_BN254_X5_T3_V1));
        assertFalse(HashScheme.isProductionPoseidon(HashScheme.STANDIN_V0));
    }

    function testStandInVectorsMatchCircom() public {
        StandInHasher h = new StandInHasher();
        assertEq(h.schemeId(), HashScheme.STANDIN_V0);
        assertEq(h.hashLeftRight(0, 0), 0);
        assertEq(h.hashLeftRight(1, 2), 5);
        assertEq(h.hashLeftRight(2, 3), 11);
        assertEq(h.hashLeftRight(1, 0), 1);
        uint256 f = HashScheme.SNARK_SCALAR_FIELD;
        assertEq(h.hashLeftRight(f - 1, 2), f - 1);
        assertEq(IdentityCommitment.standInLeaf(2, 3), 11);
        assertEq(IdentityCommitment.standInNullifier(3, 1), HashScheme.hashLeftRightStandIn(3, 1));
    }

    function testKeccakHasherKeepsSchemeId() public {
        KeccakHasher h = new KeccakHasher();
        assertEq(h.schemeId(), HashScheme.KECCAK_DEV_V1);
        uint256 got = h.hashLeftRight(1, 2);
        assertEq(got, uint256(keccak256(abi.encodePacked(uint256(1), uint256(2)))));
        assertEq(IdentityCommitment.toLeaf(2, 3), IdentityCommitment.keccakLeaf(2, 3));
    }

    function testStandInSingleLeafRootEqualsLeaf() public {
        StandInHasher h = new StandInHasher();
        TreeHarness t = new TreeHarness();
        t.init(16, h);
        assertEq(t.root(), bytes32(0));
        uint256 leaf = IdentityCommitment.standInLeaf(2, 3);
        (, bytes32 root) = t.insert(leaf, h);
        assertEq(uint256(root), leaf);
    }

    function testStandInTwoLeavesNonDegenerate() public {
        StandInHasher h = new StandInHasher();
        TreeHarness t = new TreeHarness();
        t.init(16, h);
        uint256 leaf = IdentityCommitment.standInLeaf(2, 3);
        uint256 sibling = IdentityCommitment.standInLeaf(5, 7);
        t.insert(leaf, h);
        (, bytes32 root) = t.insert(sibling, h);
        assertEq(uint256(root), HashScheme.hashLeftRightStandIn(leaf, sibling));
        assertEq(uint256(root), 575);
    }
}
