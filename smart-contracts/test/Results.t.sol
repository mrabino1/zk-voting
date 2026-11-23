// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {BabyJub} from "../src/libraries/BabyJub.sol";
import {Guardians} from "../src/libraries/Guardians.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

/// @notice The outcome is enforced only as the sum: one decryption of the final accumulator,
///         by a threshold of guardians, above the anonymity floor.
contract ResultsTest is RollupTest {
    function _votes() internal pure returns (uint256[] memory v) {
        v = new uint256[](5);
        (v[0], v[1], v[2], v[3], v[4]) = (0, 2, 2, 1, 2);
    }

    function _expected() internal pure returns (uint256[] memory c) {
        c = new uint256[](3);
        (c[0], c[1], c[2]) = (1, 1, 3);
    }

    function _subset(uint8 a, uint8 b) internal pure returns (uint8[] memory s) {
        s = new uint8[](2);
        (s[0], s[1]) = (a, b);
    }

    function test_EndToEndFinalizesTheSum() public {
        uint32 id = runElection(_votes());
        IZkVotingRollup.ElectionInfo memory e = info(id);
        assertEq(uint8(e.status), uint8(IZkVotingRollup.Status.Closed));
        assertEq(e.ballotCount, 5);

        postShares(id, 1);
        postShares(id, 3);
        rollup.finalizeResult(id, _expected(), _subset(3, 1));

        (uint256[] memory counts, bytes32 resultHash) = rollup.result(id);
        assertEq(counts, _expected());
        assertEq(resultHash, keccak256(abi.encode(block.chainid, address(rollup), id, _expected())));
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Finalized));
    }

    function test_AnyThresholdSubsetOpensTheSameSum() public {
        uint32 id = runElection(_votes());
        postShares(id, 2);
        postShares(id, 3);
        rollup.finalizeResult(id, _expected(), _subset(2, 3));
        (uint256[] memory counts,) = rollup.result(id);
        assertEq(counts, _expected());
    }

    function test_WrongCountsRevertEvenWhenTheyAddUp() public {
        uint32 id = runElection(_votes());
        postShares(id, 1);
        postShares(id, 2);
        uint256[] memory wrong = new uint256[](3);
        (wrong[0], wrong[1], wrong[2]) = (2, 0, 3);
        vm.expectRevert(IZkVotingRollup.DecryptionMismatch.selector);
        rollup.finalizeResult(id, wrong, _subset(1, 2));
    }

    function test_CountsMustAddUpToTheBallotCount() public {
        uint32 id = runElection(_votes());
        uint256[] memory wrong = new uint256[](3);
        (wrong[0], wrong[1], wrong[2]) = (1, 1, 2);
        vm.expectRevert(IZkVotingRollup.CountMismatch.selector);
        rollup.finalizeResult(id, wrong, _subset(1, 2));
    }

    function test_BelowThresholdCannotDecrypt() public {
        uint32 id = runElection(_votes());
        postShares(id, 1);
        uint8[] memory one = new uint8[](1);
        one[0] = 1;
        vm.expectRevert(Guardians.BadSubset.selector);
        rollup.finalizeResult(id, _expected(), one);
        vm.expectRevert(Guardians.BadSubset.selector);
        rollup.finalizeResult(id, _expected(), _subset(1, 2));
    }

    function test_DuplicateGuardianInSubsetReverts() public {
        uint32 id = runElection(_votes());
        postShares(id, 1);
        vm.expectRevert(Guardians.BadSubset.selector);
        rollup.finalizeResult(id, _expected(), _subset(1, 1));
    }

    function test_ThereIsOnlyOneDecryption() public {
        uint32 id = runElection(_votes());
        postShares(id, 1);
        postShares(id, 2);
        rollup.finalizeResult(id, _expected(), _subset(1, 2));
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Finalized));
        rollup.finalizeResult(id, _expected(), _subset(1, 2));
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Finalized));
        rollup.postDecryptionShares(id, 3, new Guardians.Share[](0));
    }

    function test_SharesBeforeCloseAreRefused() public {
        uint32 id = scheduledElection();
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Scheduled));
        rollup.postDecryptionShares(id, 1, new Guardians.Share[](0));
    }

    function test_TurnoutBelowTheFloorIsWithheldForever() public {
        uint256[] memory two = new uint256[](2);
        (two[0], two[1]) = (0, 1);
        uint32 id = runElection(two);
        IZkVotingRollup.ElectionInfo memory e = info(id);
        assertEq(uint8(e.status), uint8(IZkVotingRollup.Status.Withheld));
        assertEq(e.ballotCount, 2);

        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Withheld));
        rollup.postDecryptionShares(id, 1, new Guardians.Share[](0));
        uint256[] memory counts = new uint256[](3);
        (counts[0], counts[1]) = (1, 1);
        vm.expectRevert(abi.encodeWithSelector(IZkVotingRollup.WrongStatus.selector, IZkVotingRollup.Status.Withheld));
        rollup.finalizeResult(id, counts, _subset(1, 2));
    }

    function test_ForgedShareIsRejected() public {
        uint32 id = runElection(_votes());
        Guardians.Share[] memory shares = decryptionShares(id, 1);
        shares[1].z = addmod(shares[1].z, 1, ORDER);
        vm.expectRevert(Guardians.BadShares.selector);
        rollup.postDecryptionShares(id, 1, shares);
    }

    function test_SharesCannotBeReplayedForAnotherGuardian() public {
        uint32 id = runElection(_votes());
        Guardians.Share[] memory shares = decryptionShares(id, 1);
        vm.expectRevert(Guardians.BadShares.selector);
        rollup.postDecryptionShares(id, 2, shares);
    }

    function test_SharesArePostedOnce() public {
        uint32 id = runElection(_votes());
        postShares(id, 1);
        Guardians.Share[] memory shares = decryptionShares(id, 1);
        vm.expectRevert(Guardians.SharesAlreadyPosted.selector);
        rollup.postDecryptionShares(id, 1, shares);
    }

    function test_UnknownGuardianIndexCannotPostShares() public {
        uint32 id = runElection(_votes());
        Guardians.Share[] memory shares = decryptionShares(id, 1);
        vm.expectRevert(Guardians.NotMember.selector);
        rollup.postDecryptionShares(id, 4, shares);
        vm.expectRevert(Guardians.NotMember.selector);
        rollup.postDecryptionShares(id, 0, shares);
    }

    function test_ZeroTurnoutElectionWithFloorOneIsWithheld() public {
        IZkVotingRollup.ElectionConfig memory c = defaultConfig();
        c.minBallots = 1;
        vm.recordLogs();
        uint32 id = createElection(c);
        commitAllGuardians(id);
        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        rollup.finalizeKey(id);
        vm.warp(c.cutoffTime);
        rollup.closeElection(id);
        recordRequests();
        processQueue("");
        assertEq(uint8(info(id).status), uint8(IZkVotingRollup.Status.Withheld));
    }

    function test_GuardianPublicShareMatchesTheSecretShare() public {
        uint32 id = runElection(_votes());
        for (uint8 j = 1; j <= 3; ++j) {
            (uint256 x, uint256 y) = rollup.guardianPublicShare(id, j);
            uint256 s = secretShare(id, j);
            (uint256 ex, uint256 ey) = BabyJub.mulBase(s);
            assertEq(x, ex);
            assertEq(y, ey);
        }
    }
}
