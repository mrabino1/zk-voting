// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Election} from "../src/Election.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {ElectionState} from "../src/interfaces/ElectionParams.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice State machine, freeze auth, registry-only root writes, exact window.
contract ElectionLifecycleEdgesTest is Deployer {
    uint256 internal electionId;
    address internal election;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        (electionId, election) = createElection();
    }

    function testCreatedBeforeFreeze() public {
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.CREATED));
        assertFalse(IElection(election).rollFrozen());
    }

    function testFreezeByNonClerkReverts() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Election.NotClerk.selector);
        IElection(election).freezeRoll();
        vm.prank(admin);
        vm.expectRevert(Election.NotClerk.selector);
        IElection(election).freezeRoll();
        vm.prank(registrar);
        vm.expectRevert(Election.NotClerk.selector);
        IElection(election).freezeRoll();
    }

    function testFreezeIsSticky() public {
        freezeRoll(election);
        assertTrue(IElection(election).rollFrozen());
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.ROLL_FROZEN));
        freezeRoll(election);
        assertTrue(IElection(election).rollFrozen());
    }

    function testOpenOnlyWhenFrozenAndInWindow() public {
        vm.warp(IElection(election).params().startTime);
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.CREATED));
        freezeRoll(election);
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.OPEN));
    }

    function testClosedAtExactCutoffEvenIfFrozen() public {
        freezeRoll(election);
        vm.warp(IElection(election).params().cutoffTime);
        assertEq(uint256(IElection(election).state()), uint256(ElectionState.CLOSED));
    }

    function testSetRootsOnlyFromRegistries() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Election.NotRegistry.selector);
        IElection(election).setRoots(bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(address(voterRegistry));
        IElection(election).setRoots(bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(IElection(election).eligibleRoot(), bytes32(uint256(1)));
        assertEq(IElection(election).disqualificationRoot(), bytes32(uint256(2)));

        vm.prank(address(disqualification));
        IElection(election).setRoots(bytes32(uint256(3)), bytes32(uint256(4)));
        assertEq(IElection(election).eligibleRoot(), bytes32(uint256(3)));
    }

    function testBumpParticipantCountOnlyFromVoterRegistry() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Election.NotRegistry.selector);
        IElection(election).bumpParticipantCount();

        vm.prank(address(disqualification));
        vm.expectRevert(Election.NotRegistry.selector);
        IElection(election).bumpParticipantCount();

        vm.prank(address(voterRegistry));
        IElection(election).bumpParticipantCount();
        assertEq(IElection(election).participantCount(), 1);
    }

    function testInitializeZeroFactoryReverts() public {
        Election fresh = new Election();
        vm.expectRevert(Election.ZeroAddress.selector);
        fresh.initialize(1, defaultParams(), address(0), address(1), address(2), address(3));
    }

    function testVoteWithoutFreezeStillRevertsAtExactStart() public {
        vm.warp(IElection(election).params().startTime);
        bytes memory enc = Fixtures.encryptedBallot(1);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(electionId, election, 1, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.RollNotFrozen.selector);
        inbox.submitVote(electionId, a, b, c, inputs, enc);
    }
}
