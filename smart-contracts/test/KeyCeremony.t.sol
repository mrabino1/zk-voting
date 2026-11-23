// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {BabyJub} from "../src/libraries/BabyJub.sol";
import {Guardians} from "../src/libraries/Guardians.sol";
import {Ops} from "../src/libraries/Ops.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

contract KeyCeremonyTest is RollupTest {
    function test_CreateElectionStartsTheCeremony() public {
        uint32 id = createElection();
        IZkVotingRollup.ElectionInfo memory e = info(id);
        assertEq(id, 1);
        assertEq(uint8(e.status), uint8(IZkVotingRollup.Status.KeyGen));
        assertEq(e.clerk, clerk);
        assertEq(e.guardianCount, 3);
        assertEq(e.threshold, 2);
        assertEq(rollup.guardianIndex(id, guardianAccounts[1]), 2);
        assertEq(rollup.totalPriorityRequests(), 0, "nothing reaches the L2 before the key is final");
    }

    function test_OnlyAClerkOfTheJurisdictionCreates() public {
        IZkVotingRollup.ElectionConfig memory c = defaultConfig();
        vm.expectRevert(IZkVotingRollup.NotClerk.selector);
        rollup.createElection(c);
    }

    function test_ElectionConfigIsValidated() public {
        IZkVotingRollup.ElectionConfig memory c = defaultConfig();
        c.optionCount = 1;
        _expectBadConfig(c);
        c = defaultConfig();
        c.optionCount = 9;
        _expectBadConfig(c);
        c = defaultConfig();
        c.minBallots = 0;
        _expectBadConfig(c);
        c = defaultConfig();
        c.startTime = uint64(block.timestamp);
        _expectBadConfig(c);
        c = defaultConfig();
        c.cutoffTime = c.startTime;
        _expectBadConfig(c);

        c = defaultConfig();
        c.threshold = 4;
        vm.expectRevert(Guardians.BadCommittee.selector);
        vm.prank(clerk);
        rollup.createElection(c);

        c = defaultConfig();
        c.guardians[2] = c.guardians[0];
        vm.expectRevert(Guardians.BadCommittee.selector);
        vm.prank(clerk);
        rollup.createElection(c);
    }

    function _expectBadConfig(IZkVotingRollup.ElectionConfig memory c) internal {
        vm.expectRevert(IZkVotingRollup.BadElectionConfig.selector);
        vm.prank(clerk);
        rollup.createElection(c);
    }

    function test_FinalizeKeyQueuesCreateElectionWithTheJointKey() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        vm.recordLogs();
        rollup.finalizeKey(id);
        recordRequests();

        IZkVotingRollup.ElectionInfo memory e = info(id);
        assertEq(uint8(e.status), uint8(IZkVotingRollup.Status.Scheduled));
        (uint256 jx, uint256 jy) = BabyJub.mulBase(addmod(addmod(coeff(1, 0), coeff(2, 0), ORDER), coeff(3, 0), ORDER));
        assertEq(e.jointKeyX, jx);
        assertEq(e.jointKeyY, jy);

        assertEq(rollup.totalPriorityRequests(), 1);
        assertEq(requestType[0], Ops.CREATE_ELECTION);
        assertEq(
            requestBytes[0],
            abi.encodePacked(Ops.CREATE_ELECTION, id, e.configHash, e.startTime, e.cutoffTime, e.optionCount, jx, jy)
        );
    }

    function test_FinalizeWaitsForTheComplaintWindow() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        vm.expectRevert(Guardians.TooEarly.selector);
        rollup.finalizeKey(id);
    }

    function test_FinalizeNeedsThresholdOrTimeout() public {
        uint32 id = createElection();
        commitGuardian(id, 1);
        vm.warp(block.timestamp + Guardians.KEYGEN_TIMEOUT);
        vm.expectRevert(Guardians.NotEnoughGuardians.selector);
        rollup.finalizeKey(id);

        commitGuardian(id, 2);
        rollup.finalizeKey(id);
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Scheduled), "timeout drops the absent guardian");
    }

    function test_CommitRejectsABadSchnorrProof() public {
        uint32 id = createElection();
        (uint256[] memory cx, uint256[] memory cy) = commitments(1, 2);
        (uint256 rX, uint256 rY) = BabyJub.mulBase(7);
        vm.expectRevert(Guardians.BadSchnorr.selector);
        vm.prank(guardianAccounts[0]);
        rollup.commitGuardian(id, cx, cy, rX, rY, 123);
    }

    function test_CommitRejectsWrongDegreeAndOffCurvePoints() public {
        uint32 id = createElection();
        (uint256[] memory cx, uint256[] memory cy) = commitments(1, 3);
        vm.expectRevert(Guardians.BadCommitments.selector);
        vm.prank(guardianAccounts[0]);
        rollup.commitGuardian(id, cx, cy, 0, 1, 0);

        (cx, cy) = commitments(1, 2);
        cy[1] = cy[1] + 1;
        vm.expectRevert(Guardians.BadPoint.selector);
        vm.prank(guardianAccounts[0]);
        rollup.commitGuardian(id, cx, cy, 0, 1, 0);
    }

    function test_CommitOnceAndOnlyMembers() public {
        uint32 id = createElection();
        commitGuardian(id, 1);
        (uint256[] memory cx, uint256[] memory cy) = commitments(1, 2);
        vm.expectRevert(Guardians.AlreadyCommitted.selector);
        vm.prank(guardianAccounts[0]);
        rollup.commitGuardian(id, cx, cy, 0, 1, 0);

        vm.expectRevert(Guardians.NotMember.selector);
        rollup.commitGuardian(id, cx, cy, 0, 1, 0);
    }

    function test_SignedBadShareExcludesTheDealer() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        uint256 bad = dealtShare(2, 1, 2) + 1;
        (uint256 rX, uint256 rY, uint256 z) = signShare(id, 2, 1, bad);
        vm.prank(guardianAccounts[0]);
        rollup.complainShare(id, 2, bad, rX, rY, z);

        (, bool committed, bool excluded,) = rollup.guardian(id, 2);
        assertTrue(committed);
        assertTrue(excluded);

        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        rollup.finalizeKey(id);
        (uint256 jx, uint256 jy) = BabyJub.mulBase(addmod(coeff(1, 0), coeff(3, 0), ORDER));
        assertEq(info(id).jointKeyX, jx);
        assertEq(info(id).jointKeyY, jy);
    }

    function test_ComplaintAboutAGoodShareFails() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        uint256 good = dealtShare(2, 1, 2);
        (uint256 rX, uint256 rY, uint256 z) = signShare(id, 2, 1, good);
        vm.expectRevert(Guardians.ComplaintUnfounded.selector);
        vm.prank(guardianAccounts[0]);
        rollup.complainShare(id, 2, good, rX, rY, z);
    }

    function test_ComplaintNeedsTheDealersSignature() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        uint256 bad = 42;
        (uint256 rX, uint256 rY, uint256 z) = signShare(id, 3, 1, bad);
        vm.expectRevert(Guardians.BadSchnorr.selector);
        vm.prank(guardianAccounts[0]);
        rollup.complainShare(id, 2, bad, rX, rY, z);
    }

    function test_DisputeRevealedCorrectlyKeepsTheDealer() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        vm.prank(guardianAccounts[0]);
        rollup.openShareDispute(id, 3);

        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        vm.expectRevert(Guardians.DisputeOpen.selector);
        rollup.finalizeKey(id);

        vm.prank(guardianAccounts[2]);
        rollup.revealShare(id, dealtShare(3, 1, 2));
        (,, bool excluded,) = rollup.guardian(id, 3);
        assertFalse(excluded);
        rollup.finalizeKey(id);
    }

    function test_DisputeRevealedWrongExcludesTheDealer() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        vm.prank(guardianAccounts[0]);
        rollup.openShareDispute(id, 3);
        vm.prank(guardianAccounts[2]);
        rollup.revealShare(id, 5);
        (,, bool excluded,) = rollup.guardian(id, 3);
        assertTrue(excluded);
    }

    function test_SilentDealerIsExcludedAfterTheRevealWindow() public {
        uint32 id = createElection();
        commitAllGuardians(id);
        vm.prank(guardianAccounts[0]);
        rollup.openShareDispute(id, 3);
        vm.expectRevert(Guardians.TooEarly.selector);
        rollup.expireShareDispute(id, 3);
        vm.warp(block.timestamp + Guardians.REVEAL_WINDOW);
        rollup.expireShareDispute(id, 3);
        (,, bool excluded,) = rollup.guardian(id, 3);
        assertTrue(excluded);
        vm.expectRevert(Guardians.NoDispute.selector);
        rollup.expireShareDispute(id, 3);
    }

    function test_CeremonyClosesAtStartTime() public {
        uint32 id = createElection();
        vm.warp(info(id).startTime);
        (uint256[] memory cx, uint256[] memory cy) = commitments(1, 2);
        vm.expectRevert(IZkVotingRollup.TooLate.selector);
        vm.prank(guardianAccounts[0]);
        rollup.commitGuardian(id, cx, cy, 0, 1, 0);
        vm.expectRevert(IZkVotingRollup.TooLate.selector);
        rollup.finalizeKey(id);
    }

    function test_ElectionWithoutAKeyByStartIsHalted() public {
        uint32 id = createElection();
        vm.expectRevert(IZkVotingRollup.TooEarly.selector);
        rollup.haltElection(id);
        vm.warp(info(id).startTime);
        rollup.haltElection(id);
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Halted));
    }

    function test_ScheduledElectionCannotBeHalted() public {
        uint32 id = scheduledElection();
        vm.warp(info(id).startTime);
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Scheduled));
        rollup.haltElection(id);
    }
}
