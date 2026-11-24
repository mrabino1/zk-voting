// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";

import {BabyJub} from "../src/libraries/BabyJub.sol";
import {Ops} from "../src/libraries/Ops.sol";
import {PoseidonT3} from "../src/libraries/PoseidonT3.sol";
import {StateTree} from "../src/libraries/StateTree.sol";
import {Groth16Verifier} from "../src/verifiers/Groth16Verifier.sol";

/// @notice Pins the hashes and encodings the L2 (`voting_node/l2/rollup`) must reproduce.
///         `voting_node/l2/rollup/test/vectors.test.mjs` checks the same numbers.
contract LibrariesTest is Test {
    function test_PoseidonMatchesCircomlib() public pure {
        assertEq(
            PoseidonT3.hashLeftRight(1, 2), 7853200120776062878684798364095072458815029376092732009249414926327459813530
        );
    }

    function test_FoldIsALeftChain() public pure {
        uint256[] memory w = new uint256[](3);
        (w[0], w[1], w[2]) = (1, 2, 3);
        assertEq(StateTree.fold(w), PoseidonT3.hashLeftRight(PoseidonT3.hashLeftRight(1, 2), 3));
        assertEq(StateTree.fold(new uint256[](0)), 0);
    }

    function test_StateVectors() public pure {
        assertEq(StateTree.emptyRoot(), EMPTY_STATE_ROOT);
        StateTree.ElectionLeaf memory leaf = StateTree.ElectionLeaf(1, 2, 3, 4, 5, 1);
        assertEq(StateTree.leafHash(leaf), LEAF_123451);
        uint256[] memory siblings = new uint256[](32);
        uint256 zero;
        for (uint256 i; i < 32; ++i) {
            siblings[i] = zero;
            zero = PoseidonT3.hashLeftRight(zero, zero);
        }
        assertEq(StateTree.rootFrom(7, LEAF_123451, siblings), ROOT_WITH_LEAF_AT_7);
    }

    uint256 internal constant EMPTY_STATE_ROOT =
        uint256(0x2f68a1c58e257e42a17a6c61dff5551ed560b9922ab119d5ac8e184c9734ead9);
    uint256 internal constant LEAF_123451 = uint256(0x22f6494107874b90eeb92cd9e7895770488fd988d89100a27b97b6eec3e261d1);
    uint256 internal constant ROOT_WITH_LEAF_AT_7 =
        uint256(0x2b12c3ee812dcc2b478ac596838067e137849d61e868de64b5cddcf63cc94ee1);

    // ---------------------------------------------------------------- BabyJub

    function test_GeneratorIsInTheSubgroup() public pure {
        assertTrue(BabyJub.onCurve(BabyJub.GX, BabyJub.GY));
        assertTrue(BabyJub.inSubgroup(BabyJub.GX, BabyJub.GY));
        (uint256 x, uint256 y) = BabyJub.mulBase(BabyJub.ORDER);
        assertTrue(BabyJub.isIdentity(x, y));
    }

    function test_IdentityAndTorsionAreNotKeys() public pure {
        assertTrue(BabyJub.onCurve(0, 1));
        assertFalse(BabyJub.inSubgroup(0, 1));
        // (0, -1) has order 2.
        assertTrue(BabyJub.onCurve(0, BabyJub.P - 1));
        assertFalse(BabyJub.inSubgroup(0, BabyJub.P - 1));
    }

    function testFuzz_AdditionIsHomomorphic(uint128 a, uint128 b) public pure {
        (uint256 ax, uint256 ay) = BabyJub.mulBase(a);
        (uint256 bx, uint256 by) = BabyJub.mulBase(b);
        (uint256 sx, uint256 sy) = BabyJub.add(ax, ay, bx, by);
        (uint256 ex, uint256 ey) = BabyJub.mulBase(uint256(a) + uint256(b));
        assertEq(sx, ex);
        assertEq(sy, ey);
        (uint256 dx, uint256 dy) = BabyJub.sub(sx, sy, bx, by);
        assertEq(dx, ax);
        assertEq(dy, ay);
    }

    function test_ElGamalSumDecryptsToTheCount() public pure {
        uint256 secret = 123456789;
        (uint256 pkx, uint256 pky) = BabyJub.mulBase(secret);
        uint256 c1x = 0;
        uint256 c1y = 1;
        uint256 c2x = 0;
        uint256 c2y = 1;
        uint8[5] memory bits = [1, 0, 1, 1, 0];
        for (uint256 i; i < bits.length; ++i) {
            uint256 r = uint256(keccak256(abi.encode(i))) % BabyJub.ORDER;
            (uint256 rx, uint256 ry) = BabyJub.mulBase(r);
            (uint256 kx, uint256 ky) = BabyJub.mul(pkx, pky, r);
            (uint256 mx, uint256 my) = BabyJub.mulBase(bits[i]);
            (uint256 ex, uint256 ey) = BabyJub.add(mx, my, kx, ky);
            (c1x, c1y) = BabyJub.add(c1x, c1y, rx, ry);
            (c2x, c2y) = BabyJub.add(c2x, c2y, ex, ey);
        }
        (uint256 sx, uint256 sy) = BabyJub.mul(c1x, c1y, secret);
        (uint256 mx2, uint256 my2) = BabyJub.sub(c2x, c2y, sx, sy);
        (uint256 three, uint256 threeY) = BabyJub.mulBase(3);
        assertEq(mx2, three);
        assertEq(my2, threeY);
    }

    // -------------------------------------------------------------------- Ops

    function test_OpSizes() public view {
        _assertSize(abi.encodePacked(Ops.CREATE_ELECTION, new bytes(117)), 118, 118);
        _assertSize(abi.encodePacked(Ops.REGISTER, uint32(1), uint8(3), new bytes(96)), 102, 102);
        _assertSize(abi.encodePacked(Ops.DISQUALIFY, new bytes(38)), 39, 39);
        _assertSize(abi.encodePacked(Ops.BALLOT, new bytes(68)), 69, 0);
        _assertSize(abi.encodePacked(Ops.FORCED_BALLOT, new bytes(101)), 102, 101);
        _assertSize(abi.encodePacked(Ops.CLOSE, uint32(1), uint32(9), uint8(2), new bytes(256)), 266, 5);
    }

    function _assertSize(bytes memory op, uint256 size, uint256 requestSize) internal view {
        (, uint256 s, uint256 r) = this.sizeAt(op, 0);
        assertEq(s, size);
        assertEq(r, requestSize);
        assertEq(op.length, size);
    }

    function sizeAt(bytes calldata data, uint256 offset) external pure returns (uint8, uint256, uint256) {
        return Ops.sizeAt(data, offset);
    }

    function testFuzz_TruncatedOpsAreMalformed(uint8 opType, uint8 cut) public {
        opType = uint8(bound(opType, 1, 6));
        bytes memory op = opType == Ops.CLOSE
            ? abi.encodePacked(Ops.CLOSE, uint32(1), uint32(0), uint8(2), new bytes(256))
            : opType == Ops.REGISTER
                ? abi.encodePacked(Ops.REGISTER, uint32(1), uint8(1), new bytes(32))
                : abi.encodePacked(opType, new bytes(200));
        (, uint256 size,) = this.sizeAt(op, 0);
        uint256 len = bound(cut, 1, size - 1);
        bytes memory truncated = new bytes(len);
        for (uint256 i; i < len; ++i) {
            truncated[i] = op[i];
        }
        vm.expectRevert(Ops.MalformedPubdata.selector);
        this.sizeAt(truncated, 0);
    }

    // ---------------------------------------------------------------- Groth16

    function test_Groth16RejectsAnEmptyKeyAndBadProofs() public {
        Groth16Verifier.VerifyingKey memory vk;
        vm.expectRevert(Groth16Verifier.EmptyVerifyingKey.selector);
        new Groth16Verifier(vk);

        vk.alpha = [uint256(1), 2];
        vk.ic0 = [uint256(1), 2];
        vk.ic1 = [uint256(1), 2];
        Groth16Verifier v = new Groth16Verifier(vk);
        assertFalse(v.isMock());
        assertEq(v.verifyingKeyHash(), keccak256(abi.encode(vk)));
        uint256[8] memory p;
        assertFalse(v.verifyProof(p, BabyJub.P), "public input outside the field");
        p[0] = type(uint256).max;
        assertFalse(v.verifyProof(p, 1), "coordinate outside the base field");
        p[0] = 1;
        p[1] = 2;
        assertFalse(v.verifyProof(p, 1), "pairing fails");
    }
}
