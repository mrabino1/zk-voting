// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../../src/BallotInbox.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @notice Fuzz factory bounds and inbox public-input length (edge-case fuzzing).
contract ValidationFuzz is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testFuzz_treeDepthOutOfRangeReverts(uint8 depth) public {
        vm.assume(depth < 16 || depth > 32);
        ElectionParams memory p = defaultParams();
        p.treeDepth = depth;
        vm.prank(admin);
        vm.expectRevert(ElectionFactory.InvalidTreeDepth.selector);
        factory.createElection(p);
    }

    function testFuzz_questionCountZeroReverts(uint8 unused) public {
        unused;
        ElectionParams memory p = defaultParams();
        p.questionCount = 0;
        vm.prank(admin);
        vm.expectRevert(ElectionFactory.InvalidQuestionCount.selector);
        factory.createElection(p);
    }

    function testFuzz_shortPublicInputsRevert(uint8 len) public {
        vm.assume(len < 5);
        (uint256 electionId, address election) = prepareOpenElection(Fixtures.identityCommitment(uint256(1)));
        uint256[] memory inputs = new uint256[](len);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.InvalidPublicInputs.selector);
        inbox.submitVote(electionId, a, b, c, inputs, Fixtures.encryptedBallot(1));
        election;
    }

    function testFuzz_voteBoundaryInclusiveStartExclusiveCutoff(uint64 delta) public {
        (uint256 electionId, address election) = createElection();
        registerVoter(electionId, Fixtures.identityCommitment(uint256(1)));
        freezeRoll(election);
        uint64 start = IElection(election).params().startTime;
        uint64 cutoff = IElection(election).params().cutoffTime;
        uint64 span = cutoff - start;
        uint64 offset = uint64(bound(delta, 0, uint256(span)));
        vm.warp(start + offset);
        if (start + offset >= cutoff) {
            expectSubmitVoteRevert(electionId, election, 1);
        } else {
            submitVote(electionId, election, uint256(offset) + 1);
            assertEq(inbox.acceptedBallots(electionId), 1);
        }
    }
}
