// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {MockVerifier} from "../src/zk/MockVerifier.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IL1TallyMirror} from "../src/interfaces/IL1TallyMirror.sol";

/// @notice Court-grade L1 copy of an L2 tally hash. No mainnet keys.
contract L1TallyMirrorTest is Test {
    L1TallyMirror internal mirror;
    RollupSettlement internal settlement;
    address internal admin;
    address internal publisher;
    address internal stranger;

    function setUp() public {
        admin = makeAddr("admin");
        publisher = makeAddr("publisher");
        stranger = makeAddr("stranger");
        vm.prank(admin);
        mirror = new L1TallyMirror(admin, address(0));
    }

    function _countsHash(uint256 a, uint256 b) internal pure returns (bytes32) {
        uint256[] memory counts = new uint256[](2);
        counts[0] = a;
        counts[1] = b;
        return keccak256(abi.encodePacked(counts));
    }

    function testPackedCountsHashIsStable() public pure {
        // Packed keccak of [2, 0] — JS `computeTallyHash([2,0])` must match.
        assertEq(
            _countsHash(2, 0), bytes32(0xabbb5caa7dda850e60932de0934eb1f9d0f59695050f761dc64e443e5030a569)
        );
    }

    function testAdminCanPostResult() public {
        bytes32 hash = _countsHash(2, 0);
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit IL1TallyMirror.ElectionCertified(1, hash, 2, bytes32(0));
        mirror.postResult(1, hash, 2, bytes32(0));
        assertEq(mirror.resultHashOf(1), hash);
        assertEq(mirror.totalBallotsOf(1), 2);
        assertEq(mirror.claimedStateRoot(1), bytes32(0));
    }

    function testPublisherCanPostAfterGrant() public {
        vm.prank(admin);
        mirror.setPublisher(publisher, true);
        bytes32 hash = _countsHash(1, 1);
        bytes32 root = keccak256("l2-state");
        vm.prank(publisher);
        mirror.postResult(9, hash, 2, root);
        assertEq(mirror.resultHashOf(9), hash);
        assertEq(mirror.claimedStateRoot(9), root);
    }

    function testStrangerCannotPost() public {
        bytes32 hash = _countsHash(3, 0);
        vm.prank(stranger);
        vm.expectRevert(IL1TallyMirror.NotAuthorized.selector);
        mirror.postResult(1, hash, 3, bytes32(0));
        assertEq(mirror.resultHashOf(1), bytes32(0));
    }

    function testAlreadyPostedReverts() public {
        bytes32 hash = _countsHash(2, 0);
        vm.prank(admin);
        mirror.postResult(1, hash, 2, bytes32(0));
        vm.prank(admin);
        vm.expectRevert(IL1TallyMirror.AlreadyPosted.selector);
        mirror.postResult(1, keccak256("other"), 2, bytes32(0));
    }

    function testStrangerCannotSetPublisher() public {
        vm.prank(stranger);
        vm.expectRevert(IL1TallyMirror.NotAuthorized.selector);
        mirror.setPublisher(publisher, true);
    }

    function testPostAttachesRollupStateRoot() public {
        MockVerifier verifier = new MockVerifier();
        address sequencer = makeAddr("sequencer");
        address prover = makeAddr("prover");
        // Test contract is the settlement admin so submitBatch needs no prank.
        settlement = new RollupSettlement(address(this), sequencer, prover, address(verifier), true);
        assertEq(settlement.admin(), address(this));
        bytes32 genesis = bytes32(0);
        bytes32 next = keccak256("state-1");
        uint64 index = 0;
        bytes32 dataHash = settlement.computeDataHash(index, genesis, next);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        settlement.submitBatch(index, genesis, next, dataHash, a, b, c);
        assertEq(settlement.stateRoot(), next);

        bytes32 hash = _countsHash(4, 1);
        bytes32 postedRoot = settlement.stateRoot();
        vm.prank(admin);
        mirror.postResult(3, hash, 5, postedRoot);
        assertEq(mirror.claimedStateRoot(3), next);
        assertEq(mirror.resultHashOf(3), hash);
        assertEq(mirror.totalBallotsOf(3), 5);
    }
}
