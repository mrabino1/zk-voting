// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ExternalPartyRegistry} from "../src/ExternalPartyRegistry.sol";
import {ReasonCodes} from "../src/ReasonCodes.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IExternalPartyRegistry} from "../src/interfaces/IExternalPartyRegistry.sol";

/// @notice Party zero-address, attestation expiry, duplicates, and isolation.
/// @dev Edge cases: pause/suspend, unique-key, and deadline.
contract ExternalPartyEdgesTest is Deployer {
    ExternalPartyRegistry internal parties;
    uint256 internal electionId;
    address internal operator;
    uint256 internal commitment;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        (electionId,) = createElection();
        parties = ExternalPartyRegistry(factory.getPartyRegistry(electionId));
        operator = makeAddr("partyOp");
        commitment = Fixtures.identityCommitment(uint256(8));
    }

    function testAddPartyZeroOperatorReverts() public {
        vm.prank(clerk);
        vm.expectRevert(IExternalPartyRegistry.ZeroAddress.selector);
        parties.addParty(address(0), "Oracle", "", 0);
    }

    function testAddPartyInvalidModeReverts() public {
        vm.prank(clerk);
        vm.expectRevert(IExternalPartyRegistry.InvalidMode.selector);
        parties.addParty(operator, "Oracle", "", 2);
    }

    function testStrangerCannotAddParty() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IExternalPartyRegistry.NotStaff.selector);
        parties.addParty(operator, "Oracle", "", 0);
    }

    function testSetPartyOperatorZeroReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Oracle", "", 0);
        vm.prank(clerk);
        vm.expectRevert(IExternalPartyRegistry.ZeroAddress.selector);
        parties.setPartyOperator(idx, address(0));
    }

    function testRejectZeroCommitmentReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.ZeroCommitment.selector);
        parties.reject(idx, 0, ReasonCodes.FRAUD_HOLD, bytes32(0));
    }

    function testRejectInvalidReasonReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.InvalidReasonCode.selector);
        parties.reject(idx, commitment, ReasonCodes.NONE, bytes32(0));
    }

    function testAlreadyRejectedReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.startPrank(operator);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
        vm.expectRevert(IExternalPartyRegistry.AlreadyRejected.selector);
        parties.reject(idx, commitment, ReasonCodes.COURT_ORDER, bytes32(0));
        vm.stopPrank();
    }

    function testClearRejectionWhenNotRejectedReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.NotRejected.selector);
        parties.clearRejection(idx, commitment, bytes32(0));
    }

    function testNonOperatorCannotReject() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(makeAddr("other"));
        vm.expectRevert(IExternalPartyRegistry.NotPartyOperator.selector);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
    }

    function testInactiveOperatorCannotReject() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(clerk);
        parties.setPartyActive(idx, false);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.PartyNotActive.selector);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
    }

    function testAttestOnVetoPartyReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.InvalidMode.selector);
        parties.attest(idx, commitment, 0, bytes32(0));
    }

    function testExpiredAttestationReverts() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Age", "", 1);
        uint64 exp = uint64(block.timestamp + 1 hours);
        vm.prank(operator);
        parties.attest(idx, commitment, exp, bytes32(0));

        uint256[] memory ids = new uint256[](1);
        ids[0] = idx;
        parties.assertCastAllowed(commitment, ids);

        vm.warp(exp);
        // exp < now is required; equal is still valid.
        parties.assertCastAllowed(commitment, ids);

        vm.warp(uint256(exp) + 1);
        vm.expectRevert(IExternalPartyRegistry.ExpiredAttestation.selector);
        parties.assertCastAllowed(commitment, ids);
    }

    function testZeroExpiresMeansNever() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Age", "", 1);
        vm.prank(operator);
        parties.attest(idx, commitment, 0, bytes32(0));
        uint256[] memory ids = new uint256[](1);
        ids[0] = idx;
        vm.warp(type(uint64).max);
        parties.assertCastAllowed(commitment, ids);
    }

    function testDuplicateAttestationIdsRevert() public {
        vm.prank(clerk);
        uint256 a = parties.addParty(operator, "Age", "", 1);
        vm.prank(clerk);
        parties.addParty(makeAddr("op2"), "Residency", "", 1);
        vm.prank(operator);
        parties.attest(a, commitment, 0, bytes32(0));

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = a;
        vm.expectRevert(IExternalPartyRegistry.DuplicateAttestationId.selector);
        parties.assertCastAllowed(commitment, ids);
    }

    function testUnexpectedAttestationIdsWhenNoneRequired() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 0;
        vm.expectRevert(IExternalPartyRegistry.UnexpectedAttestationIds.selector);
        parties.assertCastAllowed(commitment, ids);
    }

    function testMissingAttestationWhenRequired() public {
        vm.prank(clerk);
        parties.addParty(operator, "Age", "", 1);
        vm.expectRevert(IExternalPartyRegistry.MissingAttestation.selector);
        parties.assertCastAllowed(commitment);
    }

    function testUnknownPartyIdReverts() public {
        vm.prank(clerk);
        parties.addParty(operator, "Age", "", 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 99;
        vm.expectRevert(IExternalPartyRegistry.UnknownParty.selector);
        parties.assertCastAllowed(commitment, ids);
    }

    function testPartyIsolationAcrossElections() public {
        (uint256 idB,) = createElection();
        ExternalPartyRegistry other = ExternalPartyRegistry(factory.getPartyRegistry(idB));
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        vm.prank(operator);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
        assertTrue(parties.isRejected(commitment));
        assertFalse(other.isRejected(commitment));
        other.assertCastAllowed(commitment);
    }

    function testOldOperatorCannotRejectAfterTransfer() public {
        vm.prank(clerk);
        uint256 idx = parties.addParty(operator, "Veto", "", 0);
        address nextOp = makeAddr("nextOp");
        vm.prank(clerk);
        parties.setPartyOperator(idx, nextOp);
        vm.prank(operator);
        vm.expectRevert(IExternalPartyRegistry.NotPartyOperator.selector);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
        vm.prank(nextOp);
        parties.reject(idx, commitment, ReasonCodes.FRAUD_HOLD, bytes32(0));
    }
}
