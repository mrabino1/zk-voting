// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {MockVerifier} from "../../src/zk/MockVerifier.sol";
import {VoteVerifier} from "../../src/zk/VoteVerifier.sol";
import {Groth16VerifierAdapter} from "../../src/zk/Groth16VerifierAdapter.sol";
import {IGroth16VerifierAdapter} from "../../src/interfaces/IGroth16VerifierAdapter.sol";
import {Fixtures} from "../helpers/Fixtures.sol";
import {IVoteVerifier} from "../../src/interfaces/IVoteVerifier.sol";

/// @notice Fake snarkjs-shaped verifier used only to test the adapter ABI bridge.
contract FakeSnarkVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata input)
        external
        pure
        returns (bool)
    {
        return input[4] == 1;
    }
}

/// @notice MockVerifier stays the unit-test default. Non-mock path fails closed.
contract VoteVerifierTest is Test {
    function testUnconfiguredDelegatesToMock() public {
        MockVerifier mock = new MockVerifier();
        assertFalse(mock.acceptAll());
        mock.setAccept(true);
        VoteVerifier v = new VoteVerifier(address(mock));
        assertFalse(v.hasKey());
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        input[2] = 9;
        assertTrue(v.verifyProof(a, b, c, input));
    }

    function testUnconfiguredWithoutMockReverts() public {
        VoteVerifier v = new VoteVerifier(address(0));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        vm.expectRevert(IVoteVerifier.VerifierNotConfigured.selector);
        v.verifyProof(a, b, c, input);
    }

    function testInstalledKeyHashDoesNotAcceptDummyProof() public {
        MockVerifier mock = new MockVerifier();
        VoteVerifier v = new VoteVerifier(address(mock));
        vm.store(address(v), bytes32(uint256(0)), bytes32(uint256(1)));
        assertTrue(v.hasKey());
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        assertFalse(v.verifyProof(a, b, c, input));
    }

    function testMockAcceptAllCanBeDisabled() public {
        MockVerifier mock = new MockVerifier();
        assertFalse(mock.acceptAll());
        mock.setAccept(true);
        assertTrue(mock.acceptAll());
        mock.setAccept(false);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        input[2] = 1;
        assertFalse(mock.verifyProof(a, b, c, input));
    }

    function testAdapterBridgesFixedPublicInputs() public {
        FakeSnarkVerifier inner = new FakeSnarkVerifier();
        Groth16VerifierAdapter adapter = new Groth16VerifierAdapter(address(inner), 5);
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        input[4] = 1;
        assertTrue(adapter.verifyProof(a, b, c, input));
        input[4] = 2;
        assertFalse(adapter.verifyProof(a, b, c, input));
        uint256[] memory shortInputs = new uint256[](4);
        assertFalse(adapter.verifyProof(a, b, c, shortInputs));
    }

    function testAdapterRejectsZeroImpl() public {
        vm.expectRevert(IGroth16VerifierAdapter.ZeroAddress.selector);
        new Groth16VerifierAdapter(address(0), 5);
    }

    function testProvingPathEnvIsDocumentedAndFailClosed() public {
        // Always asserts the non-mock contract behaviour. The env flag is for
        // DeployLocal / integration; unit tests must still pass with MockVerifier.
        string memory flag = vm.envOr("ZK_VOTING_PROVING_PATH", string("0"));
        bytes32 h = keccak256(bytes(flag));
        bool proving = h == keccak256("1") || h == keccak256("true");
        VoteVerifier v = new VoteVerifier(address(0));
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = Fixtures.dummyProof();
        uint256[] memory input = new uint256[](5);
        vm.expectRevert(IVoteVerifier.VerifierNotConfigured.selector);
        v.verifyProof(a, b, c, input);
        assertTrue(!proving || !v.hasKey());
    }
}
