// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../src/BallotInbox.sol";
import {ExternalPartyRegistry} from "../src/ExternalPartyRegistry.sol";
import {ReasonCodes} from "../src/ReasonCodes.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Super admin / admin / election staff approvals and the per-election
///         external-party factory that can veto a registered voter at cast time.
contract ExternalPartyTest is Deployer {
    address internal platformAdmin;
    address internal staff;
    address internal deathRecords;
    address internal felonyRecords;
    address internal ageRecords;
    address internal stranger;

    uint8 internal constant MODE_VETO = 0;
    uint8 internal constant MODE_MUST_ATTEST = 1;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();

        platformAdmin = makeAddr("platformAdmin");
        staff = makeAddr("electionStaff");
        deathRecords = makeAddr("deathRecords");
        felonyRecords = makeAddr("felonyRecords");
        ageRecords = makeAddr("ageRecords");
        stranger = makeAddr("stranger");
    }

    function testCreateElectionClonesPartyRegistry() public {
        (uint256 id,) = createElection();
        address registry = factory.getPartyRegistry(id);
        assertTrue(registry != address(0), "party registry clone");
        assertEq(ExternalPartyRegistry(registry).electionId(), id);
        assertEq(address(ExternalPartyRegistry(registry).factory()), address(factory));
        assertEq(ExternalPartyRegistry(registry).partyCount(), 0);
        assertFalse(ExternalPartyRegistry(registry).hasActiveGates());
    }

    function testSuperAdminApprovesAdminWhoApprovesStaff() public {
        (uint256 id,) = createElection();

        vm.prank(platformAdmin);
        vm.expectRevert();
        factory.approveAdmin(platformAdmin);

        vm.prank(admin);
        factory.approveAdmin(platformAdmin);
        assertTrue(factory.isPlatformAdmin(platformAdmin));
        assertFalse(factory.isSuperAdmin(platformAdmin));
        assertTrue(factory.isSuperAdmin(admin));

        vm.prank(stranger);
        vm.expectRevert();
        factory.approveElectionStaff(id, staff);

        vm.prank(platformAdmin);
        factory.approveElectionStaff(id, staff);
        assertTrue(factory.isElectionStaff(id, staff));

        vm.prank(admin);
        factory.revokeAdmin(platformAdmin);
        assertFalse(factory.isPlatformAdmin(platformAdmin));

        vm.prank(admin);
        vm.expectRevert();
        factory.revokeAdmin(admin);
    }

    function testClerkIsElectionStaffForTheirElection() public {
        (uint256 id,) = createElection();
        assertTrue(factory.isElectionStaff(id, clerk));
        (uint256 idB,) = createElection();
        // Clerk is auto-staff on both elections they create in these fixtures.
        assertTrue(factory.isElectionStaff(idB, clerk));
        assertTrue(factory.getPartyRegistry(id) != factory.getPartyRegistry(idB));
    }

    function testStaffAddsUnboundedPartiesAndStrangerCannot() public {
        (uint256 id,) = createElection();
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));

        vm.prank(admin);
        factory.approveElectionStaff(id, staff);

        vm.prank(stranger);
        vm.expectRevert();
        registry.addParty(deathRecords, "Death records", "", MODE_VETO);

        vm.prank(staff);
        for (uint256 i; i < 24; ++i) {
            address op = makeAddr(string.concat("oracle-", vm.toString(i)));
            uint256 idx = registry.addParty(op, string.concat("Party ", vm.toString(i)), "ipfs://policy", MODE_VETO);
            assertEq(idx, i);
        }
        assertEq(registry.partyCount(), 24);
        assertTrue(registry.hasActiveGates());
        assertEq(registry.activePartyCount(), 24);
    }

    function testFelonyVetoBlocksVoteEvenAfterRegistration() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(77));
        uint256 other = Fixtures.identityCommitment(uint256(88));
        (uint256 id, address el) = createElection();
        registerVoter(id, commitment);
        registerVoter(id, other);
        freezeRoll(el);
        warpOpen(el);
        _forceAcceptAll();
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));

        vm.prank(clerk);
        uint256 felony = registry.addParty(felonyRecords, "Felony / INELIGIBLE_STATUS", "", MODE_VETO);
        vm.prank(clerk);
        uint256 death = registry.addParty(deathRecords, "Vital records / DECEASED", "", MODE_VETO);

        // Registered and not clerk-disqualified, but the felony oracle vetoes at cast time.
        vm.prank(felonyRecords);
        registry.reject(felony, commitment, ReasonCodes.INELIGIBLE_STATUS, keccak256("case-file"));

        assertTrue(registry.isRejected(commitment));
        _expectClearedRevert(id, el, 1, commitment);
        assertEq(inbox.acceptedBallots(id), 0);

        vm.prank(felonyRecords);
        registry.clearRejection(felony, commitment, keccak256("appeal"));
        assertFalse(registry.isRejected(commitment));

        _submitCleared(id, el, 1, commitment);
        assertEq(inbox.acceptedBallots(id), 1);

        // A second registered person: death records can still veto independently.
        vm.prank(deathRecords);
        registry.reject(death, other, ReasonCodes.DECEASED, keccak256("vital-stat"));
        _expectClearedRevert(id, el, 2, other);
    }

    function testPlainSubmitVoteRevertsOnceGatesAreActive() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(3));
        (uint256 id, address el) = prepareOpenElection(commitment);
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));

        submitVote(id, el, 11);
        assertEq(inbox.acceptedBallots(id), 1);

        vm.prank(clerk);
        registry.addParty(ageRecords, "Age verification", "", MODE_VETO);

        bytes memory enc = Fixtures.encryptedBallot(12);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, 12, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.ClearanceRequired.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function testMustAttestAgeOracleRequiredAtCast() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(9));
        (uint256 id, address el) = prepareOpenElection(commitment);
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));

        vm.prank(clerk);
        uint256 age = registry.addParty(ageRecords, "Age / NOT_OF_AGE", "", MODE_MUST_ATTEST);

        uint256[] memory ids = new uint256[](1);
        ids[0] = age;
        _expectClearedRevertWithIds(id, el, 1, commitment, ids);

        vm.prank(ageRecords);
        registry.attest(age, commitment, 0, keccak256("dmv-record"));

        _submitClearedWithIds(id, el, 1, commitment, ids);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testPausedPartyDoesNotGate() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(5));
        (uint256 id, address el) = prepareOpenElection(commitment);
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));

        vm.prank(clerk);
        uint256 idx = registry.addParty(felonyRecords, "Felony", "", MODE_VETO);
        vm.prank(felonyRecords);
        registry.reject(idx, commitment, ReasonCodes.INELIGIBLE_STATUS, bytes32(uint256(1)));

        vm.prank(clerk);
        registry.setPartyActive(idx, false);
        assertFalse(registry.hasActiveGates());
        // Rejection mapping still set, but the inbox allows plain submitVote
        // when no party is active. Live civic path still reads the mapping.
        submitVote(id, el, 99);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testPartyIsolationAcrossElections() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(42));
        (uint256 idA,) = createElection();
        (uint256 idB,) = createElection();
        ExternalPartyRegistry a = ExternalPartyRegistry(factory.getPartyRegistry(idA));
        ExternalPartyRegistry b = ExternalPartyRegistry(factory.getPartyRegistry(idB));

        vm.prank(clerk);
        uint256 idx = a.addParty(felonyRecords, "Felony A", "", MODE_VETO);
        vm.prank(felonyRecords);
        a.reject(idx, commitment, ReasonCodes.INELIGIBLE_STATUS, bytes32(uint256(2)));

        assertTrue(a.isRejected(commitment));
        assertFalse(b.isRejected(commitment));
        assertEq(b.partyCount(), 0);
    }

    function testAdminCannotWireModules() public {
        vm.prank(admin);
        factory.approveAdmin(platformAdmin);
        vm.prank(platformAdmin);
        vm.expectRevert();
        factory.setModules(address(voterRegistry), address(disqualification), address(inbox), address(tally));
    }

    function _submitCleared(uint256 electionId, address election, uint256 nullifier, uint256 commitment) internal {
        uint256[] memory ids;
        _submitClearedWithIds(electionId, election, nullifier, commitment, ids);
    }

    function _submitClearedWithIds(
        uint256 electionId,
        address election,
        uint256 nullifier,
        uint256 commitment,
        uint256[] memory ids
    ) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        inbox.submitVoteWithClearance(electionId, a, b, c, inputs, enc, commitment, ids);
    }

    function _expectClearedRevert(uint256 electionId, address election, uint256 nullifier, uint256 commitment)
        internal
    {
        uint256[] memory ids;
        _expectClearedRevertWithIds(electionId, election, nullifier, commitment, ids);
    }

    function _expectClearedRevertWithIds(
        uint256 electionId,
        address election,
        uint256 nullifier,
        uint256 commitment,
        uint256[] memory ids
    ) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert();
        inbox.submitVoteWithClearance(electionId, a, b, c, inputs, enc, commitment, ids);
    }
}
