// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {IHasher} from "../src/interfaces/IHasher.sol";
import {KeccakHasher} from "../src/hasher/KeccakHasher.sol";
import {IncrementalMerkleTree} from "../src/tree/IncrementalMerkleTree.sol";

contract MerkleTreeHarness {
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

    function nextIndex() external view returns (uint256) {
        return tree.nextIndex;
    }
}

/// @notice Library depth bounds and uninitialized insert. TreeFull is 2**depth.
contract MerkleTreeHarnessTest is Test {
    MerkleTreeHarness internal harness;
    KeccakHasher internal hasher;

    function setUp() public {
        harness = new MerkleTreeHarness();
        hasher = new KeccakHasher();
    }

    function testInitDepthZeroReverts() public {
        vm.expectRevert(IncrementalMerkleTree.InvalidDepth.selector);
        harness.init(0, hasher);
    }

    function testInitDepthFifteenReverts() public {
        vm.expectRevert(IncrementalMerkleTree.InvalidDepth.selector);
        harness.init(15, hasher);
    }

    function testInitDepthThirtyThreeReverts() public {
        vm.expectRevert(IncrementalMerkleTree.InvalidDepth.selector);
        harness.init(33, hasher);
    }

    function testInsertBeforeInitReverts() public {
        vm.expectRevert(IncrementalMerkleTree.NotInitialized.selector);
        harness.insert(1, hasher);
    }

    function testInitDepthSixteenAndInsert() public {
        harness.init(16, hasher);
        (uint256 index, bytes32 newRoot) = harness.insert(uint256(keccak256("leaf")), hasher);
        assertEq(index, 0);
        assertTrue(newRoot != bytes32(0));
        assertEq(harness.root(), newRoot);
        assertEq(harness.nextIndex(), 1);

        (uint256 index2,) = harness.insert(uint256(keccak256("leaf-2")), hasher);
        assertEq(index2, 1);
        assertEq(harness.nextIndex(), 2);
    }

    function testEmptyRootIsHasherFoldedZeros() public {
        harness.init(16, hasher);
        uint256 z = 0;
        for (uint256 i; i < 16; ++i) {
            z = hasher.hashLeftRight(z, z);
        }
        assertEq(harness.root(), bytes32(z));
    }
}
