// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Test} from "forge-std/Test.sol";
import {KeccakHasher} from "../src/hasher/KeccakHasher.sol";
import {IHasher} from "../src/interfaces/IHasher.sol";
import {DisqualificationSet} from "../src/tree/DisqualificationSet.sol";
import {EligibleSet} from "../src/tree/EligibleSet.sol";
import {MockVerifier} from "../src/zk/MockVerifier.sol";
import {IMockVerifier} from "../src/interfaces/IMockVerifier.sol";

/// @notice Regression: Merkle inclusion and chain non-membership checks must
///         bind the path length to the tree depth. Without that, an internal
///         node passes as a leaf (truncated path) and the root passes with an
///         empty path, which lets a disqualified commitment forge a "gap".
contract MerklePathDepthTest is Test {
    uint8 internal constant DEPTH = 16;

    IHasher internal hasher;

    function setUp() public {
        hasher = IHasher(address(new KeccakHasher()));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Replays a path with no length check (the pre-fix semantics), to
    ///      show each forged witness below really does hash to the root.
    function _replay(uint256 leaf, uint256[] memory els, uint8[] memory idx) internal view returns (uint256 h) {
        h = leaf;
        for (uint256 i; i < els.length; ++i) {
            h = idx[i] == 0 ? hasher.hashLeftRight(h, els[i]) : hasher.hashLeftRight(els[i], h);
        }
    }

    function _dropFirst(EligibleSet.Proof memory p) internal pure returns (uint256[] memory els, uint8[] memory idx) {
        uint256 n = p.pathElements.length - 1;
        els = new uint256[](n);
        idx = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            els[i] = p.pathElements[i + 1];
            idx[i] = p.pathIndices[i + 1];
        }
    }

    function _leaves() internal pure returns (uint256[] memory leaves) {
        leaves = new uint256[](3);
        leaves[0] = 0xa1;
        leaves[1] = 0xb2;
        leaves[2] = 0xc3;
    }

    // ------------------------------------------------------------- inclusion

    function testFullDepthPathStillVerifies() public view {
        uint256[] memory leaves = _leaves();
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(leaves, 1, DEPTH, hasher);
        assertTrue(EligibleSet.verifyInclusion(leaves[1], p.pathElements, p.pathIndices, p.root, DEPTH, hasher));
    }

    function testEmptyPathWithRootAsLeafIsRejected() public view {
        uint256 root = EligibleSet.rootOf(_leaves(), DEPTH, hasher);
        uint256[] memory els = new uint256[](0);
        uint8[] memory idx = new uint8[](0);
        assertEq(_replay(root, els, idx), root, "empty path replays to the root");
        assertFalse(EligibleSet.verifyInclusion(root, els, idx, root, DEPTH, hasher));
    }

    function testInternalNodeAsLeafIsRejected() public view {
        uint256[] memory leaves = _leaves();
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(leaves, 0, DEPTH, hasher);
        uint256 node = hasher.hashLeftRight(leaves[0], leaves[1]);
        (uint256[] memory els, uint8[] memory idx) = _dropFirst(p);
        assertEq(_replay(node, els, idx), p.root, "truncated path replays to the root");
        assertFalse(EligibleSet.verifyInclusion(node, els, idx, p.root, DEPTH, hasher));
        // Claiming the shorter depth is not a way around it: depth is 16–32.
        assertFalse(EligibleSet.verifyInclusion(node, els, idx, p.root, DEPTH - 1, hasher));
    }

    function testOverlongPathIsRejected() public view {
        uint256[] memory leaves = _leaves();
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(leaves, 2, DEPTH, hasher);
        assertFalse(EligibleSet.verifyInclusion(leaves[2], p.pathElements, p.pathIndices, p.root, DEPTH + 1, hasher));
    }

    function testIndicesLengthMustMatchDepth() public view {
        uint256[] memory leaves = _leaves();
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(leaves, 0, DEPTH, hasher);
        uint8[] memory shortIdx = new uint8[](DEPTH - 1);
        assertFalse(EligibleSet.verifyInclusion(leaves[0], p.pathElements, shortIdx, p.root, DEPTH, hasher));
    }

    // -------------------------------------------------------- non-membership

    /// @dev Disqualified set {x, target}. Chain links l0 = H(0,x), l1 = H(x,target).
    ///      Pick target = l0 + 1 and search x so that l0 < target < l1. Then the
    ///      internal node H(l0, l1) looks like a link whose open gap contains the
    ///      disqualified `target`.
    function testDisqualifiedCommitmentCannotForgeGapWithInternalNode() public view {
        uint256 x;
        uint256 target;
        uint256 l0;
        uint256 l1;
        bool found;
        for (uint256 i = 1; i < 64; ++i) {
            l0 = hasher.hashLeftRight(0, i);
            if (l0 == type(uint256).max || l0 + 1 <= i) continue;
            uint256 t = l0 + 1;
            uint256 cand = hasher.hashLeftRight(i, t);
            if (cand > t) {
                x = i;
                target = t;
                l1 = cand;
                found = true;
                break;
            }
        }
        assertTrue(found, "search for a forgeable layout");

        uint256[] memory sorted = new uint256[](2);
        sorted[0] = x;
        sorted[1] = target;
        uint256[] memory chain = DisqualificationSet.chainLeaves(sorted, hasher);
        assertEq(chain[0], l0);
        assertEq(chain[1], l1);
        uint256 disqRoot = DisqualificationSet.rootOf(sorted, DEPTH, hasher);

        EligibleSet.Proof memory p = EligibleSet.inclusionProof(chain, 0, DEPTH, hasher);
        (uint256[] memory els, uint8[] memory idx) = _dropFirst(p);
        // The forged "link" H(l0, l1) is a real internal node of the chain tree.
        assertEq(_replay(hasher.hashLeftRight(l0, l1), els, idx), disqRoot, "forged link replays to disqRoot");

        assertFalse(
            DisqualificationSet.verifyNonMembership(target, l0, l1, els, idx, disqRoot, DEPTH, hasher),
            "disqualified commitment must not prove non-membership"
        );
    }

    // ---------------------------------------------------------- MockVerifier

    function testMockVerifierRejectsTruncatedWitness() public {
        MockVerifier v = new MockVerifier();
        v.setInclusionHasher(address(hasher));
        v.setWitnessTreeDepth(DEPTH);

        uint256[] memory leaves = _leaves();
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(leaves, 0, DEPTH, hasher);
        (uint256[] memory els, uint8[] memory idx) = _dropFirst(p);
        uint256 node = hasher.hashLeftRight(leaves[0], leaves[1]);

        vm.expectRevert(IMockVerifier.InvalidWitnessDepth.selector);
        v.armInclusionWitness(1, node, els, idx);

        vm.expectRevert(IMockVerifier.InvalidWitnessDepth.selector);
        v.armNonMembershipWitness(1, node, 0, 0, els, idx);

        v.setAccept(true);
        v.armInclusionWitness(1, leaves[0], p.pathElements, p.pathIndices);
        uint256[] memory input = new uint256[](5);
        input[0] = p.root;
        input[2] = 1;
        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        assertTrue(v.verifyProof(a, b, c, input));
    }

    function testMockVerifierWitnessNeedsDepth() public {
        MockVerifier v = new MockVerifier();
        v.setInclusionHasher(address(hasher));
        EligibleSet.Proof memory p = EligibleSet.inclusionProof(_leaves(), 0, DEPTH, hasher);
        vm.expectRevert(IMockVerifier.InvalidWitnessDepth.selector);
        v.armInclusionWitness(1, 0xa1, p.pathElements, p.pathIndices);
    }

    function testMockVerifierDepthBounds() public {
        MockVerifier v = new MockVerifier();
        vm.expectRevert(IMockVerifier.InvalidWitnessDepth.selector);
        v.setWitnessTreeDepth(15);
        vm.expectRevert(IMockVerifier.InvalidWitnessDepth.selector);
        v.setWitnessTreeDepth(33);
        v.setWitnessTreeDepth(32);
        assertEq(v.witnessTreeDepth(), 32);
        vm.prank(address(0xBEEF));
        vm.expectRevert(IMockVerifier.NotOwner.selector);
        v.setWitnessTreeDepth(16);
    }
}
