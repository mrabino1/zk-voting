// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {DisqualificationRegistry} from "../src/DisqualificationRegistry.sol";
import {ReasonCodes} from "../src/ReasonCodes.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Disqualification auth, unique-key, late-update, and isolation edges.
/// @dev Edge cases: already-used, pause-vs-suspend, per-instance halt.
contract DisqualificationEdgesTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256 internal commitment;
    bytes32 internal evidence;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        (electionId, election) = createElection();
        commitment = Fixtures.identityCommitment(uint256(9));
        registerVoter(electionId, commitment);
        evidence = keccak256("evidence");
    }

    function testStrangerCannotDisqualify() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DisqualificationRegistry.NotDisqualificationOfficer.selector);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);
    }

    function testClerkCannotDisqualify() public {
        vm.prank(clerk);
        vm.expectRevert(DisqualificationRegistry.NotDisqualificationOfficer.selector);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);
    }

    function testZeroCommitmentReverts() public {
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.ZeroCommitment.selector);
        disqualification.disqualify(electionId, 0, ReasonCodes.DECEASED, evidence);
    }

    function testUnknownElectionReverts() public {
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.UnknownElection.selector);
        disqualification.disqualify(99, commitment, ReasonCodes.DECEASED, evidence);
    }

    function testAlreadyDisqualifiedReverts() public {
        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.FRAUD_HOLD, evidence);
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.AlreadyDisqualified.selector);
        disqualification.disqualify(electionId, commitment, ReasonCodes.COURT_ORDER, evidence);
    }

    function testRevokeWhenNotDisqualifiedReverts() public {
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.NotDisqualified.selector);
        disqualification.revoke(electionId, commitment, evidence);
    }

    function testRevokeZeroCommitmentReverts() public {
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.ZeroCommitment.selector);
        disqualification.revoke(electionId, 0, evidence);
    }

    function testRevokeThenRedisqualifySucceeds() public {
        vm.startPrank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.MOVED_OUT, evidence);
        disqualification.revoke(electionId, commitment, evidence);
        assertFalse(disqualification.isDisqualified(electionId, commitment));
        assertEq(disqualification.reasonCodeOf(electionId, commitment), ReasonCodes.NONE);
        disqualification.disqualify(electionId, commitment, ReasonCodes.NOT_RESIDENT, evidence);
        vm.stopPrank();
        assertTrue(disqualification.isDisqualified(electionId, commitment));
        assertEq(disqualification.reasonCodeOf(electionId, commitment), ReasonCodes.NOT_RESIDENT);
    }

    function testTombstoneChangesRoot() public {
        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);
        bytes32 afterDisq = disqualification.merkleRoot(electionId);
        assertTrue(afterDisq != bytes32(0));

        vm.prank(officer);
        disqualification.revoke(electionId, commitment, evidence);
        bytes32 afterRevoke = disqualification.merkleRoot(electionId);
        assertTrue(afterRevoke != afterDisq);
        assertFalse(disqualification.isDisqualified(electionId, commitment));
    }

    function testFreezeBlocksUnlessLateUpdateAllowed() public {
        freezeRoll(election);
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.RollFrozen.selector);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);

        vm.prank(clerk);
        disqualification.setLateUpdateAllowed(electionId, true);

        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);
        assertTrue(disqualification.isDisqualified(electionId, commitment));
    }

    function testStrangerCannotSetLateUpdate() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DisqualificationRegistry.NotClerk.selector);
        disqualification.setLateUpdateAllowed(electionId, true);
    }

    function testOfficerCannotSetLateUpdate() public {
        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.NotClerk.selector);
        disqualification.setLateUpdateAllowed(electionId, true);
    }

    function testLateUpdateIsPerElection() public {
        (uint256 idB, address elB) = createElection();
        uint256 other = Fixtures.identityCommitment(uint256(10));
        registerVoter(idB, other);
        freezeRoll(election);
        freezeRoll(elB);

        vm.prank(clerk);
        disqualification.setLateUpdateAllowed(electionId, true);

        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);

        vm.prank(officer);
        vm.expectRevert(DisqualificationRegistry.RollFrozen.selector);
        disqualification.disqualify(idB, other, ReasonCodes.DECEASED, evidence);
    }

    function testDisqualifyUnregisteredCommitmentIsAllowed() public {
        uint256 ghost = Fixtures.identityCommitment(uint256(404));
        vm.prank(officer);
        disqualification.disqualify(electionId, ghost, ReasonCodes.FRAUD_HOLD, evidence);
        assertTrue(disqualification.isDisqualified(electionId, ghost));
        assertFalse(voterRegistry.isRegistered(electionId, ghost));
    }

    function testIsolationAcrossElections() public {
        (uint256 idB,) = createElection();
        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, evidence);
        assertFalse(disqualification.isDisqualified(idB, commitment));
    }

    function testCtorRejectsZeroAddresses() public {
        vm.expectRevert(DisqualificationRegistry.ZeroAddress.selector);
        new DisqualificationRegistry(address(0), address(factory));
        vm.expectRevert(DisqualificationRegistry.ZeroAddress.selector);
        new DisqualificationRegistry(address(hasher), address(0));
    }
}
