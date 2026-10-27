// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Vm} from "forge-std/Vm.sol";
import {BallotInbox} from "../src/BallotInbox.sol";
import {PasskeyAccount} from "../src/account/PasskeyAccount.sol";
import {Tally} from "../src/Tally.sol";
import {ZkVotingPaymaster} from "../src/account/ZkVotingPaymaster.sol";
import {ElectionParams, TallyScheme} from "../src/interfaces/ElectionParams.sol";
import {IBallotInbox} from "../src/interfaces/IBallotInbox.sol";
import {IElectionFactory} from "../src/interfaces/IElectionFactory.sol";
import {ITallyVerifier} from "../src/interfaces/ITallyVerifier.sol";
import {IZkVotingEntryPoint} from "../src/interfaces/IZkVotingEntryPoint.sol";
import {IZkVotingPaymaster} from "../src/interfaces/IZkVotingPaymaster.sol";
import {UserOp} from "../src/interfaces/UserOp.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";

/// @notice Verifier that returns a false word plus a long tail.
contract FalseWithTail {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata)
        external
        pure
        returns (uint256)
    {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0)
            return(ptr, 0x4000)
        }
    }
}

/// @notice Verifier that returns true, then extra bytes the caller must ignore.
contract TrueWithTail {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata)
        external
        pure
        returns (uint256)
    {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 1)
            return(ptr, 0x80)
        }
    }
}

/// @notice Reenters the entry point from the account's execute target.
contract ReenterHandleOps {
    bool public reached;

    function poke(address entryPoint) external {
        UserOp[] memory none = new UserOp[](0);
        IZkVotingEntryPoint(entryPoint).handleOps(none);
        reached = true;
    }
}

/// @notice Admin that tries to withdraw twice from the ETH transfer.
contract AdminDrainer {
    ZkVotingPaymaster public pm;

    function set(ZkVotingPaymaster pm_) external {
        pm = pm_;
    }

    function attack() external {
        pm.withdraw(payable(address(this)), 1 ether);
    }

    receive() external payable {
        if (address(pm).balance >= 1 ether) {
            pm.withdraw(payable(address(this)), 1 ether);
        }
    }
}

/// @notice Hardening for this inbox: zero-nullifier rejection, one spent
///         key per field residue, expiring pause, capped verifier returns,
///         batch atomicity, and a batch event that does not publish choices.
contract ContractHardeningTest is Deployer {
    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
        (a, b, c) = Fixtures.dummyProof();
    }

    function testSubmitVoteSelectorHasNoCommitmentArgument() public pure {
        assertEq(
            BallotInbox.submitVote.selector,
            bytes4(keccak256("submitVote(uint256,uint256[2],uint256[2][2],uint256[2],uint256[],bytes)"))
        );
        assertEq(
            Tally.submitAggregateTally.selector,
            bytes4(keccak256("submitAggregateTally(uint256,uint256[],bytes32,uint256[2],uint256[2][2],uint256[2])"))
        );
    }

    function testCanonicalZeroNullifierRejected() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(3)));
        uint256 field = inbox.SNARK_SCALAR_FIELD();
        _expectInvalidNullifier(id, el, 0);
        _expectInvalidNullifier(id, el, field);
        _expectInvalidNullifier(id, el, field * 2);
        assertEq(inbox.acceptedBallots(id), 0);
    }

    function testFuzz_fieldResidueIsOneSpentKey(uint256 residue, uint8 laps) public {
        uint256 field = inbox.SNARK_SCALAR_FIELD();
        residue = bound(residue, 1, field - 1);
        uint256 k = bound(uint256(laps), 1, 4);
        uint256 lifted = residue + field * k;

        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(residue));
        submitVote(id, el, lifted);
        assertTrue(inbox.nullifierUsed(id, residue), "residue shares the spent key");
        assertEq(inbox.acceptedBallots(id), 1);

        bytes memory enc = Fixtures.encryptedBallot(residue);
        uint256[] memory inputs = voteInputs(id, el, residue, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.NullifierUsed.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertEq(inbox.acceptedBallots(id), 1);
        assertEq(inbox.ballotHashOf(id, residue), bytes32(Fixtures.ballotHash(Fixtures.encryptedBallot(lifted))));
    }

    function testBallotOverCapRevertsAndDoesNotSpend() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(4)));
        bytes memory enc = new bytes(inbox.MAX_BALLOT_BYTES() + 1);
        enc[0] = 0x01;
        uint256[] memory inputs = voteInputs(id, el, 5, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.BallotTooLarge.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertFalse(inbox.nullifierUsed(id, 5));
    }

    function testFalseVerifierTailIsInvalidProof() public {
        FalseWithTail fat = new FalseWithTail();
        ElectionParams memory p = defaultParams();
        p.verifier = address(fat);
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(6)));
        freezeRoll(el);
        warpOpen(el);
        bytes memory enc = Fixtures.encryptedBallot(8);
        uint256[] memory inputs = voteInputs(id, el, 8, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.InvalidProof.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertEq(inbox.acceptedBallots(id), 0);
    }

    function testTrueVerifierTailStillAccepts() public {
        TrueWithTail tail = new TrueWithTail();
        ElectionParams memory p = defaultParams();
        p.verifier = address(tail);
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(7)));
        freezeRoll(el);
        warpOpen(el);
        submitVote(id, el, 11);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testVoteAcceptedDataIsHashAndRelayerOnly() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(8)));
        bytes memory enc = Fixtures.encryptedBallot(13);
        vm.recordLogs();
        submitVoteWithBallot(id, el, 13, enc);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("VoteAccepted(uint256,uint256,bytes32,address)");
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            assertEq(logs[i].data.length, 64);
            (bytes32 ballotHash_, address emittedRelayer) = abi.decode(logs[i].data, (bytes32, address));
            assertEq(ballotHash_, bytes32(Fixtures.ballotHash(enc)));
            assertEq(emittedRelayer, relayer);
            assertTrue(keccak256(logs[i].data) != keccak256(enc));
            seen += 1;
        }
        assertEq(seen, 1);
    }

    function testBatchEventOmitsChoiceTotalsAndFailedBatchSpendsNothing() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(9)));
        uint256 honest = 21;
        uint256[] memory badNullifiers = new uint256[](2);
        badNullifiers[0] = honest;
        badNullifiers[1] = 0;
        uint256[2][] memory proofA = _proofA(2);
        uint256[2][2][] memory proofB = _proofB(2);
        uint256[2][] memory proofC = _proofC(2);
        uint256[][] memory badInputs = _inputs(id, el, badNullifiers);
        bytes[] memory badBallots = _ballots(badNullifiers);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.InvalidNullifier.selector);
        inbox.submitVoteBatch(id, proofA, proofB, proofC, badInputs, badBallots);
        assertEq(inbox.acceptedBallots(id), 0);
        assertFalse(inbox.nullifierUsed(id, honest));

        uint256[] memory okNullifiers = new uint256[](2);
        okNullifiers[0] = 40;
        okNullifiers[1] = 30;
        uint256[][] memory okInputs = _inputs(id, el, okNullifiers);
        bytes[] memory okBallots = _ballots(okNullifiers);
        vm.recordLogs();
        vm.prank(relayer);
        inbox.submitVoteBatch(id, proofA, proofB, proofC, okInputs, okBallots);
        assertEq(inbox.acceptedBallots(id), 2);

        bytes32 sig = keccak256("VoteBatchAccepted(uint256,uint256,address)");
        uint256 seen;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != sig) continue;
            assertEq(logs[i].data.length, 64, "count and relayer only");
            (uint256 count, address emittedRelayer) = abi.decode(logs[i].data, (uint256, address));
            assertEq(count, 2);
            assertEq(emittedRelayer, relayer);
            seen += 1;
        }
        assertEq(seen, 1);
    }

    function testPauseExpiresAndBlocksTally() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IElectionFactory.NotAdmin.selector);
        factory.pause();

        ElectionParams memory params = defaultParams();
        params.startTime = uint64(block.timestamp + 1 hours);
        params.cutoffTime = uint64(block.timestamp + 30 days);
        (uint256 id, address el) = createElection(params);
        registerVoter(id, Fixtures.identityCommitment(uint256(12)));
        freezeRoll(el);
        warpOpen(el);

        vm.prank(admin);
        factory.pause();
        assertTrue(factory.isPaused());

        bytes memory enc = Fixtures.encryptedBallot(15);
        uint256[] memory inputs = voteInputs(id, el, 15, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.ContractPaused.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
        assertEq(inbox.nullifierUsed(id, 15), false);
        assertEq(inbox.acceptedBallots(id), 0);

        vm.prank(admin);
        vm.expectRevert(IElectionFactory.AlreadyPaused.selector);
        factory.pause();

        vm.warp(block.timestamp + factory.MAX_PAUSE_DURATION());
        assertFalse(factory.isPaused());
        submitVote(id, el, 15);
        assertEq(inbox.acceptedBallots(id), 1);

        warpClosed(el);
        vm.prank(admin);
        factory.pause();
        uint256[] memory counts = new uint256[](1);
        counts[0] = 1;
        vm.prank(tallyOperator);
        vm.expectRevert(ITallyVerifier.ContractPaused.selector);
        tally.submitTally(id, counts, a, b, c);

        vm.prank(admin);
        factory.unpause();
        assertFalse(factory.isPaused());
        vm.prank(tallyOperator);
        tally.submitTally(id, counts, a, b, c);
        assertTrue(tally.isTallied(id));
        assertEq(tally.tally(id).length, 1);
    }

    function testCountsVectorCap() public {
        uint256[] memory counts = new uint256[](tally.MAX_TALLY_OPTIONS() + 1);
        vm.expectRevert(ITallyVerifier.CountsTooLong.selector);
        tally.submitTally(1, counts, a, b, c);
        vm.expectRevert(ITallyVerifier.CountsTooLong.selector);
        tally.submitAggregateTally(1, counts, bytes32(uint256(1)), a, b, c);
    }

    function testHandleOpsCannotReenter() public {
        ReenterHandleOps dest = new ReenterHandleOps();
        uint256 pk = 0xA11CE;
        address voter = vm.addr(pk);
        address account =
            accountFactory.createAccountWithBackupSigner(keccak256("reenter-cred"), 1, 2, voter, bytes32(uint256(9)));
        UserOp[] memory ops = new UserOp[](1);
        ops[0] = signedExecuteOp(
            account, address(dest), abi.encodeCall(ReenterHandleOps.poke, (address(entryPoint))), pk, 0
        );
        vm.prank(relayer);
        entryPoint.handleOps(ops);
        assertFalse(dest.reached());
        assertEq(PasskeyAccount(payable(account)).nonce(), 1);
    }

    function testWithdrawCannotReenter() public {
        AdminDrainer d = new AdminDrainer();
        ZkVotingPaymaster pm = new ZkVotingPaymaster(address(entryPoint), address(d));
        d.set(pm);
        vm.deal(address(pm), 3 ether);
        vm.expectRevert(IZkVotingPaymaster.WithdrawFailed.selector);
        d.attack();
        assertEq(address(pm).balance, 3 ether);
    }

    function testAggregateSchemeStillHasNoOpeningsArray() public {
        ElectionParams memory p = defaultParams();
        p.tallyScheme = TallyScheme.AGGREGATE;
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(1)));
        registerVoter(id, Fixtures.identityCommitment(uint256(2)));
        freezeRoll(el);
        warpOpen(el);
        submitVote(id, el, 70);
        submitVote(id, el, 71);
        warpClosed(el);
        uint256[] memory counts = new uint256[](1);
        counts[0] = 2;
        bytes32 aggregate = keccak256("one-aggregate");
        vm.prank(tallyOperator);
        tally.submitAggregateTally(id, counts, aggregate, a, b, c);
        assertEq(tally.aggregateHash(id), aggregate);
        assertEq(tally.tally(id).length, 1);
        assertTrue(tally.tally(id).length != inbox.acceptedBallots(id));
    }

    function _expectInvalidNullifier(uint256 id, address el, uint256 nullifier) internal {
        bytes memory enc = Fixtures.encryptedBallot(nullifier);
        uint256[] memory inputs = voteInputs(id, el, nullifier, enc);
        vm.prank(relayer);
        vm.expectRevert(IBallotInbox.InvalidNullifier.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
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
