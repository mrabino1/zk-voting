// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ReasonCodes} from "../src/ReasonCodes.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Disqualification reason codes, events, revoke, frozen roll.
contract DisqualificationTest is Deployer {
    uint256 internal electionId;
    address internal election;
    uint256 internal commitment;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (electionId, election) = createElection();
        commitment = Fixtures.identityCommitment(uint256(77));
        registerVoter(electionId, commitment);
    }

    function testInvalidReasonCodesRevert() public {
        bytes32 evidence = keccak256("evidence-invalid");

        vm.prank(officer);
        vm.expectRevert();
        disqualification.disqualify(electionId, commitment, ReasonCodes.NONE, evidence);

        vm.prank(officer);
        vm.expectRevert();
        disqualification.disqualify(electionId, commitment, uint16(ReasonCodes.MAX_CODE + 1), evidence);

        vm.prank(officer);
        vm.expectRevert();
        disqualification.disqualify(electionId, commitment, 99, evidence);

        vm.prank(officer);
        vm.expectRevert();
        disqualification.disqualify(electionId, commitment, type(uint16).max, evidence);

        assertFalse(disqualification.isDisqualified(electionId, commitment));
    }

    function testValidReasonCodesEmitDisqualified() public {
        bytes32 evidence = keccak256("evidence-valid");
        uint16[5] memory codes = [
            ReasonCodes.NOT_OF_AGE,
            ReasonCodes.NOT_RESIDENT,
            ReasonCodes.COURT_ORDER,
            ReasonCodes.FRAUD_HOLD,
            ReasonCodes.OTHER
        ];

        for (uint256 i; i < codes.length; ++i) {
            uint256 leaf = Fixtures.identityCommitment(200 + i);
            registerVoter(electionId, leaf);
            vm.expectEmit(true, true, false, true, address(disqualification));
            emit Disqualified(electionId, leaf, codes[i], evidence);
            vm.prank(officer);
            disqualification.disqualify(electionId, leaf, codes[i], evidence);
            assertTrue(disqualification.isDisqualified(electionId, leaf));
            assertEq(disqualification.reasonCodeOf(electionId, leaf), codes[i]);
        }
    }

    function testAllCatalogCodesOneThroughFourteen() public {
        bytes32 evidence = keccak256("catalog");
        for (uint16 code = ReasonCodes.NOT_OF_AGE; code <= ReasonCodes.MAX_CODE; ++code) {
            uint256 leaf = Fixtures.identityCommitment(uint256(3000) + uint256(code));
            registerVoter(electionId, leaf);
            vm.expectEmit(true, true, false, true, address(disqualification));
            emit Disqualified(electionId, leaf, code, evidence);
            vm.prank(officer);
            disqualification.disqualify(electionId, leaf, code, evidence);
            assertTrue(ReasonCodes.isValid(code));
            assertTrue(disqualification.isDisqualified(electionId, leaf));
        }
    }

    function testRevokeClearsDisqualification() public {
        bytes32 evidence = keccak256("revoke-evidence");
        vm.prank(officer);
        disqualification.disqualify(electionId, commitment, ReasonCodes.MOVED_OUT, evidence);
        assertTrue(disqualification.isDisqualified(electionId, commitment));

        vm.expectEmit(true, true, false, true, address(disqualification));
        emit DisqualificationRevoked(electionId, commitment, evidence);
        vm.prank(officer);
        disqualification.revoke(electionId, commitment, evidence);

        assertFalse(disqualification.isDisqualified(electionId, commitment));
    }

    function testFreezeBlocksNewDisqualifications() public {
        freezeRoll(election);
        vm.prank(officer);
        vm.expectRevert();
        disqualification.disqualify(electionId, commitment, ReasonCodes.DECEASED, keccak256("late"));
        assertFalse(disqualification.isDisqualified(electionId, commitment));
    }
}
