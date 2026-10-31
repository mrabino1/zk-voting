// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {RollupSettlement} from "../src/l2/RollupSettlement.sol";
import {MockVerifier} from "../src/zk/MockVerifier.sol";
import {Deployer} from "./helpers/Deployer.sol";
import {Fixtures} from "./helpers/Fixtures.sol";
import {IRollupSettlement} from "../src/interfaces/IRollupSettlement.sol";

/// @notice Settlement auth, genesis lock, and fail-closed batch proof.
contract RollupSettlementEdgesTest is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testCtorRejectsZeroAdmin() public {
        vm.expectRevert(IRollupSettlement.ZeroAddress.selector);
        new RollupSettlement(address(0), sequencer, prover, address(verifier), true);
    }

    function testCtorRejectsZeroSequencer() public {
        vm.expectRevert(IRollupSettlement.ZeroAddress.selector);
        new RollupSettlement(admin, address(0), prover, address(verifier), true);
    }

    function testCtorRejectsZeroProver() public {
        vm.expectRevert(IRollupSettlement.ZeroAddress.selector);
        new RollupSettlement(admin, sequencer, address(0), address(verifier), true);
    }

    function testStrangerCannotSubmitBatch() public {
        bytes32 dataHash = settlement.computeDataHash(0, bytes32(0), bytes32(uint256(1)));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        settlement.submitBatch(0, bytes32(0), bytes32(uint256(1)), dataHash, a, b, c);
    }

    function testStrangerCannotSetGenesis() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        settlement.setGenesis(bytes32(uint256(1)));
    }

    function testSetGenesisThenSubmitUsesThatPrev() public {
        vm.prank(admin);
        settlement.setGenesis(bytes32(uint256(7)));
        bytes32 next = bytes32(uint256(8));
        bytes32 dataHash = settlement.computeDataHash(0, bytes32(uint256(7)), next);
        submitBatch(0, bytes32(uint256(7)), next, dataHash);
        assertEq(settlement.stateRoot(), next);
        assertEq(settlement.batchCount(), 1);
    }

    function testSetGenesisAfterBatchReverts() public {
        bytes32 next = bytes32(uint256(2));
        bytes32 dataHash = settlement.computeDataHash(0, bytes32(0), next);
        submitBatch(0, bytes32(0), next, dataHash);
        vm.prank(admin);
        vm.expectRevert(IRollupSettlement.GenesisAlreadySet.selector);
        settlement.setGenesis(bytes32(uint256(9)));
    }

    function testMockModeIsOffWithoutTheFlag() public {
        vm.expectRevert(IRollupSettlement.VerifierRequired.selector);
        new RollupSettlement(admin, sequencer, prover, address(0), false);
        RollupSettlement live = new RollupSettlement(admin, sequencer, prover, address(0), true);
        assertTrue(live.mockMode());
        bytes32 dataHash = live.computeDataHash(0, bytes32(0), bytes32(uint256(1)));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        live.submitBatch(0, bytes32(0), bytes32(uint256(1)), dataHash, a, b, c);
        assertEq(live.batchCount(), 1);
    }

    function testInvalidProofWhenNotMockMode() public {
        MockVerifier v = new MockVerifier();
        v.setAccept(false);
        RollupSettlement live = new RollupSettlement(admin, sequencer, prover, address(v), false);
        bytes32 dataHash = live.computeDataHash(0, bytes32(0), bytes32(uint256(1)));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        vm.prank(sequencer);
        vm.expectRevert(IRollupSettlement.InvalidProof.selector);
        live.submitBatch(0, bytes32(0), bytes32(uint256(1)), dataHash, a, b, c);
        assertEq(live.batchCount(), 0);
    }

    function testGrantRoleRotatesSequencerAndProverOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IRollupSettlement.NotAuthorized.selector);
        settlement.grantRole(bytes32(0), makeAddr("x"));
        vm.prank(admin);
        vm.expectRevert(IRollupSettlement.UnsupportedRole.selector);
        settlement.grantRole(bytes32(0), makeAddr("x"));
        bytes32 seqRole = settlement.SEQUENCER_ROLE();
        bytes32 proverRole = settlement.PROVER_ROLE();
        vm.prank(admin);
        settlement.grantRole(seqRole, makeAddr("seq2"));
        assertEq(settlement.sequencer(), makeAddr("seq2"));
        vm.prank(admin);
        settlement.grantRole(proverRole, makeAddr("prover2"));
        assertEq(settlement.prover(), makeAddr("prover2"));
    }

    function testGetBatchStoresSubmittedFields() public {
        bytes32 next = bytes32(uint256(3));
        bytes32 dataHash = settlement.computeDataHash(0, bytes32(0), next);
        uint256 blockBefore = block.number;
        submitBatch(0, bytes32(0), next, dataHash);
        IRollupSettlement.Batch memory got = settlement.getBatch(0);
        assertEq(got.prevStateRoot, bytes32(0));
        assertEq(got.newStateRoot, next);
        assertEq(got.dataHash, dataHash);
        assertEq(got.l1Block, blockBefore);
    }
}
