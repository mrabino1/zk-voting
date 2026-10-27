// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {ElectionParams} from "../../src/interfaces/ElectionParams.sol";
import {IElection} from "../../src/interfaces/IElection.sol";
import {Deployer} from "../helpers/Deployer.sol";
import {Fixtures} from "../helpers/Fixtures.sol";

/// @title FactoryFuzz
/// @notice Fuzz createElection: start < cutoff, depth 16–32, questionCount 1–32.
///         Zero role/verifier addresses revert; otherwise electionCount grows by 1.
contract FactoryFuzz is Deployer {
    function setUp() public {
        deployStack();
        vm.warp(Fixtures.TIME_ORIGIN);
        _forceAcceptAll();
    }

    function testFuzz_createElection(
        uint64 startTime,
        uint64 cutoffTime,
        uint8 treeDepth,
        uint8 questionCount,
        address clerk_,
        address registrar_,
        address officer_,
        address tallyOperator_,
        address verifier_
    ) public {
        vm.assume(startTime < cutoffTime);
        treeDepth = uint8(bound(treeDepth, 16, 32));
        questionCount = uint8(bound(questionCount, 1, 32));

        ElectionParams memory p = _base(startTime, cutoffTime, treeDepth, questionCount);
        p.clerk = clerk_;
        p.registrar = registrar_;
        p.disqualificationOfficer = officer_;
        p.tallyOperator = tallyOperator_;
        p.verifier = verifier_;

        uint256 before = factory.electionCount();
        bool zeros = _anyZero(p);

        vm.prank(admin);
        if (zeros) {
            vm.expectRevert();
            factory.createElection(p);
            assertEq(factory.electionCount(), before, "zero addresses must not mint an election");
        } else {
            (uint256 electionId, address election) = factory.createElection(p);
            assertEq(factory.electionCount(), before + 1);
            assertTrue(election != address(0));
            assertEq(factory.getElection(electionId), election);
            _assertParams(IElection(election).params(), p);
        }
    }

    function testFuzz_createElection_zeroAddressesRevert(uint64 startTime, uint64 cutoffTime, uint8 whichZero) public {
        vm.assume(startTime < cutoffTime);
        ElectionParams memory p = _base(startTime, cutoffTime, 16, 1);
        whichZero = uint8(bound(whichZero, 0, 4));
        if (whichZero == 0) p.clerk = address(0);
        else if (whichZero == 1) p.registrar = address(0);
        else if (whichZero == 2) p.disqualificationOfficer = address(0);
        else if (whichZero == 3) p.tallyOperator = address(0);
        else p.verifier = address(0);

        uint256 before = factory.electionCount();
        vm.prank(admin);
        vm.expectRevert();
        factory.createElection(p);
        assertEq(factory.electionCount(), before);
    }

    function testFuzz_manyCreations(uint8 n, uint64 startTime, uint64 cutoffTime, uint8 treeDepth, uint8 questionCount)
        public
    {
        n = uint8(bound(n, 1, 8));
        vm.assume(startTime < cutoffTime);
        treeDepth = uint8(bound(treeDepth, 16, 32));
        questionCount = uint8(bound(questionCount, 1, 32));

        uint256 before = factory.electionCount();
        address prev;
        for (uint256 i; i < n; ++i) {
            uint64 start = uint64(bound(uint256(startTime) + i, 1, type(uint64).max - 2));
            uint64 cutoff = uint64(bound(uint256(cutoffTime) + i + 1, uint256(start) + 1, type(uint64).max));
            vm.assume(start < cutoff);
            ElectionParams memory p = _base(start, cutoff, treeDepth, questionCount);
            p.title = string.concat("ZK-Voting election ", vm.toString(before + i));
            uint256 countBefore = factory.electionCount();
            vm.prank(admin);
            (uint256 electionId, address election) = factory.createElection(p);
            assertEq(factory.electionCount(), countBefore + 1);
            assertTrue(election != prev, "clones must not alias");
            assertEq(factory.getElection(electionId), election);
            prev = election;
        }
        assertEq(factory.electionCount(), before + n);
    }

    function testFuzz_createElection_orRevertOnZeros(
        uint64 startTime,
        uint64 cutoffTime,
        uint8 treeDepth,
        uint8 questionCount,
        bool zeroClerk
    ) public {
        vm.assume(startTime < cutoffTime);
        treeDepth = uint8(bound(treeDepth, 16, 32));
        questionCount = uint8(bound(questionCount, 1, 32));
        ElectionParams memory p = _base(startTime, cutoffTime, treeDepth, questionCount);
        if (zeroClerk) p.clerk = address(0);

        uint256 before = factory.electionCount();
        vm.prank(admin);
        if (_anyZero(p)) {
            vm.expectRevert();
            factory.createElection(p);
            assertEq(factory.electionCount(), before);
        } else {
            factory.createElection(p);
            assertEq(factory.electionCount(), before + 1);
        }
    }

    function _base(uint64 start, uint64 cutoff, uint8 depth, uint8 questions)
        internal
        view
        returns (ElectionParams memory p)
    {
        p = Fixtures.build(
            "ZK-Voting fuzz factory",
            "ipfs://factory-fuzz",
            start,
            cutoff,
            0,
            depth,
            clerk,
            registrar,
            officer,
            tallyOperator,
            address(verifier),
            questions,
            keccak256("zk-voting-fuzz-jurisdiction")
        );
    }

    function _anyZero(ElectionParams memory p) internal pure returns (bool) {
        return p.clerk == address(0) || p.registrar == address(0) || p.disqualificationOfficer == address(0)
            || p.tallyOperator == address(0) || p.verifier == address(0);
    }

    function _assertParams(ElectionParams memory got, ElectionParams memory expected) internal pure {
        assertEq(got.startTime, expected.startTime);
        assertEq(got.cutoffTime, expected.cutoffTime);
        assertEq(got.treeDepth, expected.treeDepth);
        assertEq(got.questionCount, expected.questionCount);
        assertEq(got.tallyScheme, expected.tallyScheme);
    }
}
