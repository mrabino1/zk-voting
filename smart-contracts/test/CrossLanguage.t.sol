// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {IZkVotingRollup} from "../src/interfaces/IZkVotingRollup.sol";
import {Guardians} from "../src/libraries/Guardians.sol";
import {Ops} from "../src/libraries/Ops.sol";
import {RollupTest} from "./helpers/RollupTest.sol";

/// @notice A whole election produced by `voting_node/apps/node/public/ballot-crypto.js`
///         (regenerate with `node l2/rollup/scripts/make-contract-fixture.mjs`) must pass
///         through the real contract: guardian commitments and signatures, the joint key,
///         the final sum, Chaum-Pedersen shares and the decrypted totals.
contract CrossLanguageTest is RollupTest {
    string internal json;

    function setUp() public override {
        super.setUp();
        json = vm.readFile("test/fixtures/js-election.json");
        assertEq(uint160(address(rollup)), vm.parseJsonUint(json, ".rollup"), "fixture was made for another address");
        assertEq(block.chainid, vm.parseJsonUint(json, ".chainId"));
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".guardians[", vm.toString(i), "].", field);
    }

    function test_JavaScriptElectionSettlesOnL1() public {
        // Guardians are the JS identity keys.
        delete guardianKeys;
        for (uint256 i; i < 3; ++i) {
            uint256[] memory id = vm.parseJsonUintArray(json, _key(i, "identity"));
            guardianKeys.push([id[0], id[1]]);
        }
        vm.recordLogs();
        uint32 electionId = createElection();
        assertEq(electionId, _u(".electionId"));

        // JS commitments, proofs of knowledge and identity signatures, relayed by anyone.
        for (uint256 i; i < 3; ++i) {
            Guardians.Schnorr memory pok =
                Guardians.Schnorr(_u(_key(i, "pok.rX")), _u(_key(i, "pok.rY")), _u(_key(i, "pok.z")));
            Guardians.Schnorr memory auth =
                Guardians.Schnorr(_u(_key(i, "auth.rX")), _u(_key(i, "auth.rY")), _u(_key(i, "auth.z")));
            vm.prank(relayer);
            rollup.commitGuardian(
                electionId,
                uint8(i + 1),
                vm.parseJsonUintArray(json, _key(i, "cx")),
                vm.parseJsonUintArray(json, _key(i, "cy")),
                pok,
                auth
            );
        }
        vm.warp(block.timestamp + Guardians.COMPLAINT_WINDOW);
        rollup.finalizeKey(electionId);
        uint256[] memory joint = vm.parseJsonUintArray(json, ".jointKey");
        assertEq(info(electionId).jointKeyX, joint[0], "joint key x");
        assertEq(info(electionId).jointKeyY, joint[1], "joint key y");
        recordRequests();
        processQueue("");

        // Ballots as the operator publishes them: nullifier and hiding commitment only.
        vm.warp(info(electionId).startTime);
        uint256 ballots = _u(".ballotCount");
        bytes memory pubdata;
        for (uint256 i; i < ballots; ++i) {
            string memory b = string.concat(".ballots[", vm.toString(i), "]");
            pubdata = bytes.concat(
                pubdata,
                abi.encodePacked(
                    Ops.BALLOT, electionId, _u(string.concat(b, ".nullifier")), _u(string.concat(b, ".commitment"))
                )
            );
        }
        commit(pubdata);
        settle();

        // CLOSE carries the JS accumulator back to L1.
        uint8 options = uint8(_u(".optionCount"));
        l2Ballots[electionId] = uint32(ballots);
        for (uint256 o; o < options; ++o) {
            uint256[] memory a = vm.parseJsonUintArray(json, string.concat(".accumulator[", vm.toString(o), "]"));
            l2Acc[electionId].push([a[0], a[1], a[2], a[3]]);
        }
        vm.warp(info(electionId).cutoffTime);
        vm.recordLogs();
        rollup.closeElection(electionId);
        recordRequests();
        processQueue("");
        assertEq(uint8(info(electionId).status), uint8(IZkVotingRollup.Status.Closed));

        // JS Chaum-Pedersen shares, relayed by anyone.
        uint256[] memory subsetRaw = vm.parseJsonUintArray(json, ".subset");
        uint8[] memory subset = new uint8[](subsetRaw.length);
        for (uint256 s; s < subsetRaw.length; ++s) {
            subset[s] = uint8(subsetRaw[s]);
            Guardians.Share[] memory shares = new Guardians.Share[](options);
            for (uint256 o; o < options; ++o) {
                string memory p = string.concat(".shares[", vm.toString(s), "][", vm.toString(o), "].");
                shares[o] = Guardians.Share(
                    _u(string.concat(p, "dX")),
                    _u(string.concat(p, "dY")),
                    _u(string.concat(p, "aX")),
                    _u(string.concat(p, "aY")),
                    _u(string.concat(p, "bX")),
                    _u(string.concat(p, "bY")),
                    _u(string.concat(p, "z"))
                );
            }
            rollup.postDecryptionShares(electionId, subset[s], shares);
        }

        uint256[] memory totals = vm.parseJsonUintArray(json, ".totals");
        rollup.finalizeResult(electionId, totals, subset);
        (uint256[] memory counts,) = rollup.result(electionId);
        assertEq(counts, totals);
        assertEq(uint8(info(electionId).status), uint8(IZkVotingRollup.Status.Finalized));
    }
}
