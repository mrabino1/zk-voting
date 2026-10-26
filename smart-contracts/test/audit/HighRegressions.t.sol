// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {BallotInbox} from "../../src/BallotInbox.sol";
import {ElectionFactory} from "../../src/ElectionFactory.sol";
import {ExternalPartyRegistry} from "../../src/ExternalPartyRegistry.sol";
import {ReasonCodes} from "../../src/ReasonCodes.sol";
import {Tally} from "../../src/Tally.sol";
import {IHasher} from "../../src/interfaces/IHasher.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {RollupSettlement} from "../../src/l2/RollupSettlement.sol";
import {EligibleSet} from "../../src/tree/EligibleSet.sol";
import {FrontierTree} from "../../src/tree/FrontierTree.sol";
import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {TallyPublicInputs} from "../../src/zk/TallyPublicInputs.sol";
import {VoteVerifier} from "../../src/zk/VoteVerifier.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @dev Emulates a snarkjs verifier's field check: rejects any public input >= r.
contract FieldStrictVerifier {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata input)
        external
        pure
        returns (bool)
    {
        for (uint256 i; i < input.length; ++i) {
            if (input[i] >= R) return false;
        }
        return true;
    }
}

/// @dev Field check on the ballot-hash word only (the dev keccak hasher's roots
///      are not field elements; production uses Poseidon).
contract BallotHashFieldVerifier {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[] calldata input)
        external
        pure
        returns (bool)
    {
        return input[3] < R;
    }
}

contract FrontierHarness {
    FrontierTree.Data internal t;
    IHasher internal immutable h;

    constructor(IHasher h_) {
        h = h_;
    }

    function build(uint256[] memory leaves, uint8 depth) external returns (uint256) {
        FrontierTree.reset(t, depth, h);
        for (uint256 i; i < leaves.length; ++i) {
            FrontierTree.append(t, leaves[i], h);
        }
        return FrontierTree.root(t, h);
    }
}

/// @notice Regression tests for audit findings H-01 … H-06 (2026-10-24).
///         `testH0x_*Exploit*` tests are the original PoCs and must now fail to exploit.
contract HighRegressionsTest is Deployer {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint8 internal constant MODE_VETO = 0;

    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    // ------------------------------------------------------------------ H-01

    function testH01_TallyFailsClosedWithoutTallyVerifier() public {
        Tally fresh = new Tally(address(factory));
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(1)));
        warpClosed(el);
        uint256[] memory counts = new uint256[](2);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(tallyOperator);
        vm.expectRevert(Tally.TallyVerifierNotSet.selector);
        fresh.submitTally(id, counts, a, b, c);
    }

    function testH01_TallyVerifierIsSuperAdminOnlyAndSetOnce() public {
        Tally fresh = new Tally(address(factory));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Tally.NotSuperAdmin.selector);
        fresh.setTallyProofVerifier(address(verifier));
        vm.prank(admin);
        vm.expectRevert(Tally.ZeroAddress.selector);
        fresh.setTallyProofVerifier(address(0));
        vm.prank(admin);
        fresh.setTallyProofVerifier(address(verifier));
        vm.prank(admin);
        vm.expectRevert(Tally.TallyVerifierAlreadySet.selector);
        fresh.setTallyProofVerifier(address(verifier));
    }

    function testH01_MockTallyVerifierRefusedOutsideDev() public {
        vm.prank(admin);
        factory.setAllowMockVerifiers(false);
        Tally fresh = new Tally(address(factory));
        vm.prank(admin);
        vm.expectRevert(Tally.MockVerifierNotAllowed.selector);
        fresh.setTallyProofVerifier(address(verifier));
        // A non-mock verifier is accepted.
        FieldStrictVerifier real = new FieldStrictVerifier();
        vm.prank(admin);
        fresh.setTallyProofVerifier(address(real));
        assertEq(fresh.tallyProofVerifier(), address(real));
    }

    function testH01_TallyIsNotVerifiedByVoteVerifier() public {
        // Exploit: an accept-all *vote* verifier used to accept any tally.
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(2)));
        submitVote(id, el, 11);
        warpClosed(el);
        MockVerifier tallyMock = MockVerifier(tally.tallyProofVerifier());
        // The vote verifier still accepts everything …
        verifier.setAccept(true);
        // … but the dedicated tally verifier is the one consulted.
        assertEq(address(tallyMock), address(verifier), "test stack wires the same dev mock");
        Tally fresh = new Tally(address(factory));
        FieldStrictVerifier strict = new FieldStrictVerifier();
        vm.prank(admin);
        fresh.setTallyProofVerifier(address(strict));
        uint256[] memory counts = new uint256[](2);
        counts[0] = 1;
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        // Inbox is `election.inbox()`, so the fresh Tally can read the count; strict verifier
        // accepts because every instance word is reduced (H-05 binding for tally).
        vm.prank(tallyOperator);
        fresh.submitTally(id, counts, a, b, c);
        assertTrue(fresh.isTallied(id));
    }

    function testH01_InstanceBindsBallotRootAndTallyKey() public pure {
        bytes32 root = bytes32(type(uint256).max);
        bytes32 keyHash = TallyPublicInputs.tallyKeyHashOf(bytes32(uint256(7)), bytes32(uint256(9)));
        uint256[] memory w =
            TallyPublicInputs.instance(5, 3, bytes32(type(uint256).max), root, bytes32(type(uint256).max), keyHash);
        assertEq(w.length, 7);
        assertEq(w[0], 2);
        assertEq(w[4], uint256(root) % R);
        assertEq(w[6], uint256(keyHash) % R);
        for (uint256 i; i < w.length; ++i) {
            assertLt(w[i], R);
        }
    }

    function testFuzzH01_InstanceWordsInField(uint256 eid, uint256 n, bytes32 ch, bytes32 br, bytes32 oh, bytes32 kh)
        public
        pure
    {
        uint256[] memory w = TallyPublicInputs.instance(eid, n, ch, br, oh, kh);
        for (uint256 i; i < w.length; ++i) {
            assertLt(w[i], R);
        }
    }

    // ------------------------------------------------------------------ H-02

    function testH02_FactoryDisallowsMockVerifierOffAnvil() public {
        vm.chainId(27427);
        ElectionFactory prod = new ElectionFactory(admin, address(0));
        assertFalse(prod.allowMockVerifiers());
    }

    function testH02_ExploitMockVerifierElectionNowRefused() public {
        vm.prank(admin);
        factory.setAllowMockVerifiers(false);
        ElectionParams memory p = defaultParams();
        vm.prank(admin);
        vm.expectRevert(ElectionFactory.MockVerifierNotAllowed.selector);
        factory.createElection(p);
    }

    function testH02_SetAllowMockVerifiersIsSuperAdminOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        factory.setAllowMockVerifiers(true);
    }

    function testH02_IsMockReporting() public {
        assertTrue(verifier.isMock());
        assertTrue(new VoteVerifier(address(verifier)).isMock(), "VoteVerifier delegating to a mock is a mock");
        assertFalse(new VoteVerifier(address(0)).isMock(), "fail-closed VoteVerifier is not a mock");
    }

    // ------------------------------------------------------------------ H-03

    function testH03_ExploitRegistrationGasNoLongerGrowsWithRoll() public {
        (uint256 id,) = createElection();
        for (uint256 i = 1; i <= 10; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i));
        }
        vm.prank(registrar);
        uint256 g0 = gasleft();
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(100_000)));
        uint256 small = g0 - gasleft();
        for (uint256 i = 11; i <= 300; ++i) {
            registerVoter(id, Fixtures.identityCommitment(i));
        }
        vm.prank(registrar);
        g0 = gasleft();
        voterRegistry.register(id, Fixtures.identityCommitment(uint256(200_000)));
        uint256 large = g0 - gasleft();
        // Before the fix: ~0.6M at 10 voters and ~8M at 300 (≈27k gas per voter).
        assertLt(large, 400_000, "O(depth) registration");
        assertLt(large, small + 60_000, "no per-voter growth");
        assertEq(voterRegistry.eligibleCount(id), 302);
    }

    function testFuzzH03_FrontierRootMatchesEligibleSet(uint8 nRaw, uint256 seed) public {
        uint256 n = bound(nRaw, 0, 70);
        uint256[] memory leaves = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = uint256(keccak256(abi.encode(seed, i))) % R;
        }
        FrontierHarness fh = new FrontierHarness(IHasher(address(hasher)));
        assertEq(fh.build(leaves, 16), EligibleSet.rootOf(leaves, 16, IHasher(address(hasher))));
    }

    function testH03_PagedRebuildBlocksVotesUntilComplete() public {
        (uint256 id, address el) = createElection();
        uint256 n = 150;
        uint256[] memory remaining = new uint256[](n - 1);
        uint256 k;
        for (uint256 i = 1; i <= n; ++i) {
            uint256 cm = Fixtures.identityCommitment(i);
            registerVoter(id, cm);
            if (i != 7) remaining[k++] = cm;
        }
        vm.prank(officer);
        disqualification.disqualify(id, Fixtures.identityCommitment(uint256(7)), ReasonCodes.COURT_ORDER, bytes32("x"));
        assertTrue(voterRegistry.eligibleRootPending(id), "150 > REBUILD_BATCH: paged");

        freezeRoll(el);
        warpOpen(el);
        bytes memory enc = Fixtures.encryptedBallot(5);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, 5, enc);
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.EligibleRootPending.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);

        // Anyone can finish the rebuild.
        vm.prank(makeAddr("anyone"));
        while (!voterRegistry.continueEligibleRebuild(id, 0)) {}
        assertFalse(voterRegistry.eligibleRootPending(id));
        assertEq(uint256(IElection(el).eligibleRoot()), EligibleSet.rootOf(remaining, Fixtures.TREE_DEPTH, IHasher(address(hasher))));
        assertEq(voterRegistry.eligibleCount(id), n - 1);

        submitVote(id, el, 5);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testH03_ContinueWithoutPendingReverts() public {
        (uint256 id,) = createElection();
        vm.expectRevert();
        voterRegistry.continueEligibleRebuild(id, 0);
    }

    // ------------------------------------------------------------------ H-04

    function testH04_ExploitVetoBypassWithFakeCommitmentNowFails() public {
        uint256 vetoed = Fixtures.identityCommitment(uint256(77));
        (uint256 id, address el) = prepareOpenElection(vetoed);
        ExternalPartyRegistry registry = ExternalPartyRegistry(factory.getPartyRegistry(id));
        address felony = makeAddr("felonyRecords");
        vm.prank(clerk);
        uint256 idx = registry.addParty(felony, "Felony", "", MODE_VETO);
        vm.prank(felony);
        registry.reject(idx, vetoed, ReasonCodes.INELIGIBLE_STATUS, keccak256("case"));

        bytes memory enc = Fixtures.encryptedBallot(1);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory inputs = voteInputs(id, el, 1, enc);
        uint256[] memory ids;
        // PoC: pass an arbitrary non-rejected commitment (1).
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.ClearanceCommitmentNotEligible.selector);
        inbox.submitVoteWithClearance(id, a, b, c, inputs, enc, 1, ids);
        assertEq(inbox.acceptedBallots(id), 0);
    }

    // ------------------------------------------------------------------ H-05

    function testH05_ExploitOutOfFieldBallotHashNowVerifies() public {
        BallotHashFieldVerifier strict = new BallotHashFieldVerifier();
        ElectionParams memory p = defaultParams();
        p.verifier = address(strict);
        (uint256 id, address el) = createElection(p);
        registerVoter(id, Fixtures.identityCommitment(uint256(3)));
        freezeRoll(el);
        warpOpen(el);
        // Find a ciphertext whose raw keccak is >= r (≈81% of ciphertexts).
        bytes memory enc;
        for (uint256 i;; ++i) {
            enc = abi.encodePacked("ciphertext-", i);
            if (uint256(keccak256(enc)) >= R) break;
        }
        assertEq(inbox.ballotHashOfCiphertext(enc), uint256(keccak256(enc)) % R);
        submitVoteWithBallot(id, el, 42, enc);
        assertEq(inbox.acceptedBallots(id), 1);
    }

    function testH05_RawKeccakBallotHashRejected() public {
        (uint256 id, address el) = prepareOpenElection(Fixtures.identityCommitment(uint256(4)));
        bytes memory enc;
        for (uint256 i;; ++i) {
            enc = abi.encodePacked("ciphertext-", i);
            if (uint256(keccak256(enc)) >= R) break;
        }
        uint256[] memory inputs = voteInputs(id, el, 9, enc);
        inputs[3] = uint256(keccak256(enc)); // old, unreduced binding
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(relayer);
        vm.expectRevert(BallotInbox.BallotHashMismatch.selector);
        inbox.submitVote(id, a, b, c, inputs, enc);
    }

    // ------------------------------------------------------------------ H-06

    function testH06_ExploitUnverifiedSettlementNowRefused() public {
        vm.expectRevert(RollupSettlement.VerifierRequired.selector);
        new RollupSettlement(admin, sequencer, prover, address(0), false);
    }

    function testH06_SettlementInputsReducedModR() public {
        FieldStrictVerifier strict = new FieldStrictVerifier();
        RollupSettlement live = new RollupSettlement(admin, sequencer, prover, address(strict), false);
        bytes32 next = bytes32(type(uint256).max);
        bytes32 dataHash = live.computeDataHash(0, bytes32(0), next);
        uint256[] memory w = live.batchPublicInputs(0, bytes32(0), next, dataHash);
        for (uint256 i; i < w.length; ++i) {
            assertLt(w[i], R);
        }
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        live.submitBatch(0, bytes32(0), next, dataHash, a, b, c);
        assertEq(live.batchCount(), 1);
    }

    function testH06_GrantRoleRotatesOrReverts() public {
        RollupSettlement live = new RollupSettlement(admin, sequencer, prover, address(verifier), false);
        bytes32 seqRole = live.SEQUENCER_ROLE();
        vm.prank(admin);
        live.grantRole(seqRole, makeAddr("newSeq"));
        assertEq(live.sequencer(), makeAddr("newSeq"));
        vm.prank(admin);
        vm.expectRevert(RollupSettlement.UnsupportedRole.selector);
        live.grantRole(keccak256("OTHER"), makeAddr("x"));
    }
}
