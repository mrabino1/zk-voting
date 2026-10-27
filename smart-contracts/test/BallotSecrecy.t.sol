// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Vm} from "forge-std/Vm.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {Tally} from "../src/Tally.sol";
import {ElectionParams, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {IElection} from "../src/interfaces/IElection.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Regressions for ballot-secrecy leaks: clearance calldata, self-submit,
///         per-ballot openings, and one-timestamp-per-voter submission.
contract BallotSecrecyTest is Deployer {
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
    }

    function testVoterAccountCannotSubmit() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(4));
        (uint256 id, address el) = prepareOpenElection(commitment);
        bytes memory enc = Fixtures.encryptedBallot(1);
        uint256[] memory inputs = voteInputs(id, el, 1, enc);
        address voter = makeAddr("voterWallet");
        vm.prank(voter);
        vm.expectRevert(BallotInbox.NotRelayer.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertFalse(factory.isRelayer(voter));
        assertTrue(factory.isRelayer(relayer));
    }

    function testRevokedRelayerCannotSubmit() public {
        uint256 commitment = Fixtures.identityCommitment(uint256(5));
        (uint256 id, address el) = prepareOpenElection(commitment);
        vm.prank(admin);
        factory.setRelayer(relayer, false);
        bytes memory enc = Fixtures.encryptedBallot(1);
        uint256[] memory inputs = voteInputs(id, el, 1, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.NotRelayer.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function testDisclosureIntervalRejectsSingleVote() public {
        vm.prank(admin);
        factory.setDisclosureInterval(1 hours);
        uint256 commitment = Fixtures.identityCommitment(uint256(6));
        (uint256 id, address el) = prepareOpenElection(commitment);
        bytes memory enc = Fixtures.encryptedBallot(1);
        uint256[] memory inputs = voteInputs(id, el, 1, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.UseVoteBatch.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    function testBatchRecordsNullifierOrderAfterInterval() public {
        vm.prank(admin);
        factory.setDisclosureInterval(1 hours);
        (uint256 id, address el) = createElection();
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        registerVoter(id, Fixtures.identityCommitment(uint256(2)));
        registerVoter(id, Fixtures.identityCommitment(uint256(3)));
        freezeRoll(el);
        warpOpen(el);

        uint256 nHi = 300;
        uint256 nLo = 100;
        uint256 nMid = 200;
        uint256[] memory submitted = new uint256[](3);
        submitted[0] = nHi;
        submitted[1] = nLo;
        submitted[2] = nMid;
        uint256[2][] memory proofA = _proofA(3);
        uint256[2][2][] memory proofB = _proofB(3);
        uint256[2][] memory proofC = _proofC(3);
        uint256[][] memory inputs = _inputs(id, el, submitted);
        bytes[] memory ballots = _ballots(submitted);

        vm.prank(relayer);
        vm.expectRevert(BallotInbox.BatchTooEarly.selector);
        inbox.submitVoteBatch(id, proofA, proofB, proofC, inputs, ballots);

        vm.warp(IElection(el).params().startTime + 1 hours);
        vm.recordLogs();
        vm.prank(relayer);
        inbox.submitVoteBatch(id, proofA, proofB, proofC, inputs, ballots);

        assertEq(inbox.acceptedBallots(id), 3);
        assertEq(inbox.ballotHashAt(id, 0), bytes32(Fixtures.ballotHash(Fixtures.encryptedBallot(nLo))));
        assertEq(inbox.ballotHashAt(id, 1), bytes32(Fixtures.ballotHash(Fixtures.encryptedBallot(nMid))));
        assertEq(inbox.ballotHashAt(id, 2), bytes32(Fixtures.ballotHash(Fixtures.encryptedBallot(nHi))));

        bytes32 sig = keccak256("VoteAccepted(uint256,uint256,bytes32,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256[3] memory seen;
        uint256 count;
        uint256 prev;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            uint256 nullifier = uint256(logs[i].topics[2]);
            if (count > 0) assertTrue(nullifier > prev, "events follow nullifier order");
            prev = nullifier;
            seen[count] = nullifier;
            count += 1;
            (bytes32 ballotHash_, address emittedRelayer) = abi.decode(logs[i].data, (bytes32, address));
            assertEq(emittedRelayer, relayer);
            assertTrue(ballotHash_ != bytes32(uint256(uint160(relayer))));
        }
        assertEq(count, 3);
        assertEq(seen[0], nLo);
        assertEq(seen[1], nMid);
        assertEq(seen[2], nHi);
    }

    function testAggregatePrefixBindsTagNotWholeCiphertext() public {
        uint256 tag = 123456789;
        bytes memory body = hex"00112233445566778899";
        bytes memory enc = abi.encodePacked(bytes2(0x4147), bytes32(tag), body);
        assertEq(inbox.ballotHashOfCiphertext(enc), tag);
        assertTrue(inbox.ballotHashOfCiphertext(enc) != uint256(keccak256(enc)) % inbox.SNARK_SCALAR_FIELD());

        uint256 commitment = Fixtures.identityCommitment(uint256(8));
        (uint256 id, address el) = prepareOpenElection(commitment);
        uint256[] memory inputs = voteInputs(id, el, 4, enc);
        inputs[3] = uint256(keccak256(enc));
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.BallotHashMismatch.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);

        inputs[3] = tag;
        vm.prank(relayer);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertEq(inbox.ballotHashOf(id, 4), bytes32(tag));
    }

    function testAggregateCalldataGrowsWithOptionsNotBallots() public {
        ElectionParams memory p = defaultParams();
        p.tallyScheme = TallyScheme.AGGREGATE;
        (uint256 id, address el) = createElection(p);
        for (uint256 i; i < 4; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i + 1));
        }
        freezeRoll(el);
        warpOpen(el);
        for (uint256 i; i < 4; ++i) {
            submitVote(id, el, 50 + i);
        }
        warpClosed(el);

        uint256[] memory counts = new uint256[](2);
        counts[0] = 3;
        counts[1] = 1;
        bytes32 aggregate = keccak256("aggregate-only");
        bytes memory payload = abi.encodeCall(Tally.submitAggregateTally, (id, counts, aggregate, a, b, c));
        // A per-ballot openings array of 4 words would add at least 4 * 32 bytes
        // plus an offset. The option vector is two words. Bound the payload so a
        // regression that puts one integer per ballot back into the call fails.
        assertLt(payload.length, 520);

        vm.prank(tallyOperator);
        tally.submitAggregateTally(id, counts, aggregate, a, b, c);
        assertEq(tally.aggregateHash(id), aggregate);
        assertEq(tally.tally(id).length, 2);
    }

    function _inputs(uint256 id, address el, uint256[] memory nullifiers)
        internal
        view
        returns (uint256[][] memory out)
    {
        out = new uint256[][](nullifiers.length);
        for (uint256 i; i < nullifiers.length; ++i) {
            out[i] = voteInputs(id, el, nullifiers[i], Fixtures.encryptedBallot(nullifiers[i]));
        }
    }

    function _ballots(uint256[] memory nullifiers) internal pure returns (bytes[] memory out) {
        out = new bytes[](nullifiers.length);
        for (uint256 i; i < nullifiers.length; ++i) {
            out[i] = Fixtures.encryptedBallot(nullifiers[i]);
        }
    }

    function _proofA(uint256 n) internal view returns (uint256[2][] memory out) {
        out = new uint256[2][](n);
        for (uint256 i; i < n; ++i) {
            out[i] = a;
        }
    }

    function _proofB(uint256 n) internal view returns (uint256[2][2][] memory out) {
        out = new uint256[2][2][](n);
        for (uint256 i; i < n; ++i) {
            out[i] = b;
        }
    }

    function _proofC(uint256 n) internal view returns (uint256[2][] memory out) {
        out = new uint256[2][](n);
        for (uint256 i; i < n; ++i) {
            out[i] = c;
        }
    }
}
