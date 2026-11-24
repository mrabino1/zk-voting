// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../../src/interfaces/IZkVotingRollup.sol";
import {RollupTest} from "../helpers/RollupTest.sol";

/// @notice Any electorate above the floor decrypts to exactly its tally, and to nothing else.
contract ResultFuzz is RollupTest {
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_SumIsExactlyTheTally(uint256 seed, uint8 voters) public {
        uint256 n = bound(voters, 3, 9);
        uint256[] memory votes = new uint256[](n);
        uint256[] memory tally = new uint256[](3);
        for (uint256 i; i < n; ++i) {
            votes[i] = uint256(keccak256(abi.encode(seed, i))) % 3;
            tally[votes[i]] += 1;
        }
        uint32 id = runElection(votes);
        postShares(id, 1);
        postShares(id, 3);
        uint8[] memory subset = new uint8[](2);
        (subset[0], subset[1]) = (1, 3);

        // Moving one vote between options keeps the total but must not decrypt.
        uint256 from = tally[0] > 0 ? 0 : tally[1] > 0 ? 1 : 2;
        uint256[] memory shifted = new uint256[](3);
        (shifted[0], shifted[1], shifted[2]) = (tally[0], tally[1], tally[2]);
        shifted[from] -= 1;
        shifted[(from + 1) % 3] += 1;
        vm.expectRevert(IZkVotingRollup.DecryptionMismatch.selector);
        rollup.finalizeResult(id, shifted, subset);

        rollup.finalizeResult(id, tally, subset);
        (uint256[] memory counts,) = rollup.result(id);
        assertEq(counts, tally);
    }
}
