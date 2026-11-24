// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ZkVotingRollup} from "../src/ZkVotingRollup.sol";
import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {StateTree} from "../src/libraries/StateTree.sol";
import {MockBatchVerifier} from "../src/verifiers/MockBatchVerifier.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

contract GovernanceTest is RollupTest {
    function test_GenesisIsTheEmptyStateTree() public view {
        assertEq(uint256(rollup.executedStateRoot()), desert.emptyStateRoot());
        assertEq(rollup.totalBatchesCommitted(), 0);
        assertEq(rollup.storedBatchHashes(0), keccak256(abi.encode(lastBatch)));
    }

    function test_EmptyStateRootIsTheZeroTreeOfDepth32() public view {
        assertEq(desert.emptyStateRoot(), StateTree.emptyRoot());
    }

    function test_MockVerifierOnlyOnLocalChain() public {
        vm.chainId(1);
        MockBatchVerifier mock = new MockBatchVerifier();
        vm.expectRevert(IZkVotingRollup.MockVerifierOnLocalChainOnly.selector);
        new ZkVotingRollup(governor, mock, desert);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        MockBatchVerifier mock = new MockBatchVerifier();
        vm.expectRevert(IZkVotingRollup.ZeroAddress.selector);
        new ZkVotingRollup(address(0), mock, desert);
    }

    function test_GovernorHandoverIsTwoStep() public {
        address next = makeAddr("next");
        vm.prank(governor);
        rollup.transferGovernor(next);
        assertEq(rollup.governor(), governor);

        vm.expectRevert(IZkVotingRollup.NotPendingGovernor.selector);
        rollup.acceptGovernor();

        vm.prank(next);
        rollup.acceptGovernor();
        assertEq(rollup.governor(), next);
        assertEq(rollup.pendingGovernor(), address(0));

        vm.expectRevert(IZkVotingRollup.NotGovernor.selector);
        vm.prank(governor);
        rollup.setOperator(operator, false);
    }

    function test_OnlyGovernorManagesOperatorsAndJurisdictions() public {
        vm.expectRevert(IZkVotingRollup.NotGovernor.selector);
        rollup.setOperator(address(this), true);
        vm.expectRevert(IZkVotingRollup.NotGovernor.selector);
        rollup.createJurisdiction(keccak256("x"), address(this), "X");

        vm.prank(governor);
        rollup.setOperator(operator, false);
        assertFalse(rollup.isOperator(operator));
    }

    function test_JurisdictionsAreUnique() public {
        vm.expectRevert(IZkVotingRollup.JurisdictionExists.selector);
        vm.prank(governor);
        rollup.createJurisdiction(JURISDICTION, jurisdictionAdmin, "Again");

        (address admin, string memory name) = rollup.jurisdiction(JURISDICTION);
        assertEq(admin, jurisdictionAdmin);
        assertEq(name, "Springfield");
    }

    function test_OnlyTheJurisdictionAdminManagesClerks() public {
        vm.expectRevert(IZkVotingRollup.NotJurisdictionAdmin.selector);
        rollup.setClerk(JURISDICTION, address(this), true);

        vm.prank(jurisdictionAdmin);
        rollup.setClerk(JURISDICTION, clerk, false);
        assertFalse(rollup.isClerk(JURISDICTION, clerk));

        address newAdmin = makeAddr("newAdmin");
        vm.prank(governor);
        rollup.setJurisdictionAdmin(JURISDICTION, newAdmin);
        vm.expectRevert(IZkVotingRollup.NotJurisdictionAdmin.selector);
        vm.prank(jurisdictionAdmin);
        rollup.setClerk(JURISDICTION, clerk, true);
    }

    function test_UnknownJurisdictionReverts() public {
        vm.expectRevert(IZkVotingRollup.UnknownJurisdiction.selector);
        rollup.setClerk(keccak256("nowhere"), clerk, true);
    }

    function test_GovernorCannotTouchAnElection() public {
        uint32 id = scheduledElection();
        vm.startPrank(governor);
        vm.expectRevert(IZkVotingRollup.NotRegistrar.selector);
        rollup.registerVoters(id, new uint256[](1));
        vm.expectRevert(IZkVotingRollup.NotOfficer.selector);
        rollup.disqualify(id, 1, 1);
        vm.stopPrank();
    }
}
