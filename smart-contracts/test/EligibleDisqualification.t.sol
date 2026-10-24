// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IElection} from "../src/interfaces/IElection.sol";
import {ReasonCodes} from "../src/ReasonCodes.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {DisqualificationSet} from "../src/tree/DisqualificationSet.sol";
import {EligibleSet} from "../src/tree/EligibleSet.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Eligible root is registered ∩ ¬currently-disqualified.
///         A coded disqualification removes the commitment from that root, so
///         the vote-circuit inclusion witness fails under MockVerifier and the
///         inbox rejects a proof bound to the registration roll.
contract EligibleDisqualificationTest is Deployer {
    uint256 internal constant A = 0xa1;
    uint256 internal constant B = 0xb2;
    uint256 internal constant C = 0xc3;

    uint256 internal electionId;
    address internal election;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        verifier.setInclusionHasher(address(hasher));
        verifier.setWitnessTreeDepth(Fixtures.TREE_DEPTH);
        (electionId, election) = createElection();
    }

    function testCodedDqRebuildsEligibleRootExcludingCommitment() public {
        _registerTrio();
        bytes32 roll = voterRegistry.merkleRoot(electionId);
        assertEq(IElection(election).eligibleRoot(), roll, "full roll is eligible before DQ");
        assertEq(voterRegistry.eligibleCount(electionId), 3);
        assertTrue(voterRegistry.isEligible(electionId, B));

        bytes32 evidence = keccak256("court-order");
        vm.prank(officer);
        disqualification.disqualify(electionId, B, ReasonCodes.COURT_ORDER, evidence);

        bytes32 expected = _rootOf(A, C);
        assertEq(IElection(election).eligibleRoot(), expected);
        assertTrue(expected != roll, "eligible root must leave the registration roll");
        assertEq(voterRegistry.merkleRoot(electionId), roll, "registration roll keeps the DQ leaf");
        assertFalse(voterRegistry.isEligible(electionId, B));
        assertTrue(voterRegistry.isEligible(electionId, A));
        assertTrue(voterRegistry.isEligible(electionId, C));
        assertEq(voterRegistry.eligibleCount(electionId), 2);
        assertEq(voterRegistry.participantCount(electionId), 3);
        assertEq(disqualification.reasonCodeOf(electionId, B), ReasonCodes.COURT_ORDER);
        assertTrue(uint256(IElection(election).disqualificationRoot()) != 0);
    }

    function testRevokeRestoresEligibleRootInRegistrationOrder() public {
        registerVoter(electionId, A);
        registerVoter(electionId, B);
        bytes32 full = voterRegistry.merkleRoot(electionId);

        vm.prank(officer);
        disqualification.disqualify(electionId, A, ReasonCodes.MOVED_OUT, keccak256("moved"));
        assertEq(IElection(election).eligibleRoot(), _rootOf(B));
        assertFalse(voterRegistry.isEligible(electionId, A));

        vm.prank(officer);
        disqualification.revoke(electionId, A, keccak256("restored"));

        assertFalse(disqualification.isDisqualified(electionId, A));
        assertTrue(voterRegistry.isEligible(electionId, A));
        assertEq(IElection(election).eligibleRoot(), full, "revoke reinserts in registration order, not at the end");
        assertEq(voterRegistry.eligibleCount(electionId), 2);
    }

    function testRegisterAfterCodedDqStaysOutOfEligibleRoot() public {
        vm.prank(officer);
        disqualification.disqualify(electionId, A, ReasonCodes.NOT_RESIDENT, keccak256("residency"));

        registerVoter(electionId, A);
        registerVoter(electionId, B);

        assertTrue(voterRegistry.isRegistered(electionId, A));
        assertFalse(voterRegistry.isEligible(electionId, A));
        assertTrue(voterRegistry.isEligible(electionId, B));
        assertEq(IElection(election).eligibleRoot(), _rootOf(B));
        assertTrue(IElection(election).eligibleRoot() != voterRegistry.merkleRoot(electionId));
        assertEq(voterRegistry.eligibleCount(electionId), 1);
        assertEq(voterRegistry.participantCount(electionId), 2);
    }

    /// @notice The disqualified witness does not open under the published roots.
    ///         MockVerifier evaluates the same Merkle inclusion as vote.circom
    ///         once the witness is armed (CI has no Groth16 key).
    function testCodedDqVoteProofFailsUnderMockVerifier() public {
        registerVoter(electionId, A);
        registerVoter(electionId, B);
        bytes32 roll = voterRegistry.merkleRoot(electionId);

        vm.prank(officer);
        disqualification.disqualify(electionId, B, ReasonCodes.DECEASED, keccak256("coded-dq"));

        bytes32 eligible = IElection(election).eligibleRoot();
        bytes32 disq = IElection(election).disqualificationRoot();
        assertEq(eligible, _rootOf(A));
        assertTrue(eligible != roll);

        freezeRoll(election);
        warpOpen(election);

        uint256[] memory rollLeaves = new uint256[](2);
        rollLeaves[0] = A;
        rollLeaves[1] = B;
        EligibleSet.Proof memory dqProof = EligibleSet.inclusionProof(rollLeaves, 1, Fixtures.TREE_DEPTH, hasher);
        assertEq(bytes32(dqProof.root), roll, "DQ leaf still proves the registration roll");
        assertFalse(
            EligibleSet.verifyInclusion(
                B, dqProof.pathElements, dqProof.pathIndices, uint256(eligible), Fixtures.TREE_DEPTH, hasher
            ),
            "DQ inclusion witness must not meet the published eligible root"
        );

        uint256[] memory eligibleLeaves = new uint256[](1);
        eligibleLeaves[0] = A;
        EligibleSet.Proof memory okProof = EligibleSet.inclusionProof(eligibleLeaves, 0, Fixtures.TREE_DEPTH, hasher);
        assertEq(bytes32(okProof.root), eligible);
        assertTrue(
            EligibleSet.verifyInclusion(
                A, okProof.pathElements, okProof.pathIndices, uint256(eligible), Fixtures.TREE_DEPTH, hasher
            )
        );

        uint256 nullifierDq = uint256(keccak256("disqualified-voter"));
        uint256 nullifierOk = uint256(keccak256("still-eligible"));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();

        bytes memory encDq = Fixtures.encryptedBallot(nullifierDq);
        uint256[] memory staleRoll =
            Fixtures.publicInputs(roll, disq, nullifierDq, Fixtures.ballotHash(encDq), electionId);
        vm.expectRevert(BallotInbox.EligibleRootMismatch.selector);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, staleRoll, encDq);

        uint256[] memory staleDisq =
            Fixtures.publicInputs(eligible, bytes32(0), nullifierDq, Fixtures.ballotHash(encDq), electionId);
        vm.expectRevert(BallotInbox.DisqualificationRootMismatch.selector);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, staleDisq, encDq);

        verifier.armInclusionWitness(nullifierDq, B, dqProof.pathElements, dqProof.pathIndices);
        uint256[] memory publishedDq = voteInputs(electionId, election, nullifierDq, encDq);
        assertEq(publishedDq[0], uint256(eligible));
        assertEq(publishedDq[1], uint256(disq));
        assertFalse(verifier.verifyProof(a, b, c, publishedDq), "armed DQ witness fails inclusion");
        vm.expectRevert(BallotInbox.InvalidProof.selector);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, publishedDq, encDq);
        assertFalse(inbox.nullifierUsed(electionId, nullifierDq));
        assertEq(inbox.acceptedBallots(electionId), 0);

        bytes memory encOk = Fixtures.encryptedBallot(nullifierOk);
        verifier.armInclusionWitness(nullifierOk, A, okProof.pathElements, okProof.pathIndices);
        uint256[] memory publishedOk = voteInputs(electionId, election, nullifierOk, encOk);
        assertTrue(verifier.verifyProof(a, b, c, publishedOk), "still-eligible witness matches published root");
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, publishedOk, encOk);
        assertTrue(inbox.nullifierUsed(electionId, nullifierOk));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    /// @notice A disqualified commitment has no indexed-chain gap under disqRoot.
    ///         Arming that witness makes verifyProof return false, including when
    ///         the eligible root was stuffed back to the full registration roll.
    function testDisqualifiedVoterNonMembershipProofFails() public {
        registerVoter(electionId, A);
        registerVoter(electionId, B);

        bytes32 emptyDisq = bytes32(DisqualificationSet.rootOf(new uint256[](0), Fixtures.TREE_DEPTH, hasher));
        assertEq(IElection(election).disqualificationRoot(), emptyDisq, "empty set is the sentinel chain");

        vm.prank(officer);
        disqualification.disqualify(electionId, B, ReasonCodes.COURT_ORDER, keccak256("nm"));

        uint256[] memory sorted = new uint256[](1);
        sorted[0] = B;
        bytes32 disq = IElection(election).disqualificationRoot();
        assertEq(disq, bytes32(DisqualificationSet.rootOf(sorted, Fixtures.TREE_DEPTH, hasher)));

        uint256[] memory chain = DisqualificationSet.chainLeaves(sorted, hasher);
        DisqualificationSet.Gap memory gapA = DisqualificationSet.gapFor(sorted, A);
        EligibleSet.Proof memory gapProof = EligibleSet.inclusionProof(chain, gapA.index, Fixtures.TREE_DEPTH, hasher);
        assertTrue(
            DisqualificationSet.verifyNonMembership(
                A,
                gapA.low,
                gapA.next,
                gapProof.pathElements,
                gapProof.pathIndices,
                uint256(disq),
                Fixtures.TREE_DEPTH,
                hasher
            )
        );

        vm.expectRevert(DisqualificationSet.NotAGap.selector);
        this.gapForDisqualified(sorted, B);
        assertFalse(
            DisqualificationSet.verifyNonMembership(
                B,
                gapA.low,
                gapA.next,
                gapProof.pathElements,
                gapProof.pathIndices,
                uint256(disq),
                Fixtures.TREE_DEPTH,
                hasher
            ),
            "disqualified voter is not inside the published gap"
        );

        uint256[] memory rollLeaves = new uint256[](2);
        rollLeaves[0] = A;
        rollLeaves[1] = B;
        EligibleSet.Proof memory rollProof = EligibleSet.inclusionProof(rollLeaves, 1, Fixtures.TREE_DEPTH, hasher);

        freezeRoll(election);
        warpOpen(election);

        uint256 nullifier = uint256(keccak256("dq-nonmember"));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        bytes memory enc = Fixtures.encryptedBallot(nullifier);

        verifier.armInclusionWitness(nullifier, B, rollProof.pathElements, rollProof.pathIndices);
        verifier.armNonMembershipWitness(nullifier, B, gapA.low, gapA.next, gapProof.pathElements, gapProof.pathIndices);

        uint256[] memory forged =
            Fixtures.publicInputs(bytes32(rollProof.root), disq, nullifier, Fixtures.ballotHash(enc), electionId);
        assertFalse(verifier.verifyProof(a, b, c, forged), "disqualified voter's proof fails");

        uint256[] memory published = voteInputs(electionId, election, nullifier, enc);
        assertFalse(verifier.verifyProof(a, b, c, published));
        vm.expectRevert(BallotInbox.InvalidProof.selector);
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, published, enc);
        assertFalse(inbox.nullifierUsed(electionId, nullifier));

        uint256[] memory eligibleLeaves = new uint256[](1);
        eligibleLeaves[0] = A;
        EligibleSet.Proof memory okProof = EligibleSet.inclusionProof(eligibleLeaves, 0, Fixtures.TREE_DEPTH, hasher);
        uint256 nullifierOk = uint256(keccak256("still-eligible-gap"));
        bytes memory encOk = Fixtures.encryptedBallot(nullifierOk);
        verifier.armInclusionWitness(nullifierOk, A, okProof.pathElements, okProof.pathIndices);
        verifier.armNonMembershipWitness(
            nullifierOk, A, gapA.low, gapA.next, gapProof.pathElements, gapProof.pathIndices
        );
        uint256[] memory publishedOk = voteInputs(electionId, election, nullifierOk, encOk);
        assertTrue(verifier.verifyProof(a, b, c, publishedOk), "eligible voter proves the gap");
        vm.prank(relayer);
        inbox.submitVote(electionId, a, b, c, publishedOk, encOk);
        assertTrue(inbox.nullifierUsed(electionId, nullifierOk));
    }

    /// @dev External wrapper so `vm.expectRevert` can see the library revert.
    function gapForDisqualified(uint256[] calldata sorted, uint256 target) external pure {
        DisqualificationSet.gapFor(sorted, target);
    }

    /// @notice Remaining gap: MockVerifier does not see a leaf unless a test arms
    ///         the inclusion witness. Copying the published roots still verifies.
    function testUnarmedMockVerifierStillAcceptsCopiedPublishedRoots() public {
        registerVoter(electionId, A);
        vm.prank(officer);
        disqualification.disqualify(electionId, A, ReasonCodes.COURT_ORDER, keccak256("gap"));
        assertFalse(voterRegistry.isEligible(electionId, A));
        assertEq(voterRegistry.eligibleCount(electionId), 0);

        freezeRoll(election);
        warpOpen(election);

        uint256 nullifier = uint256(keccak256("copied-root-gap"));
        assertFalse(verifier.inclusionArmed(nullifier));
        submitVote(electionId, election, nullifier);
        assertTrue(inbox.nullifierUsed(electionId, nullifier));
        assertEq(inbox.acceptedBallots(electionId), 1);
    }

    function _registerTrio() internal {
        registerVoter(electionId, A);
        registerVoter(electionId, B);
        registerVoter(electionId, C);
    }

    function _rootOf(uint256 leaf) internal view returns (bytes32) {
        uint256[] memory leaves = new uint256[](1);
        leaves[0] = leaf;
        return bytes32(EligibleSet.rootOf(leaves, Fixtures.TREE_DEPTH, hasher));
    }

    function _rootOf(uint256 left, uint256 right) internal view returns (bytes32) {
        uint256[] memory leaves = new uint256[](2);
        leaves[0] = left;
        leaves[1] = right;
        return bytes32(EligibleSet.rootOf(leaves, Fixtures.TREE_DEPTH, hasher));
    }
}
