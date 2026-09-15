// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";
import {L1TallyMirror} from "../src/l2/L1TallyMirror.sol";
import {RollupSettlement} from "../src/l2/RollupSettlement.sol";

/// @notice Post `keccak256(abi.encodePacked(counts))` to L1TallyMirror.
///
/// Env (testnet-friendly; never commit keys):
///   TALLY_MIRROR or L1_TALLY_MIRROR_ADDRESS
///   ELECTION_ID
///   COUNTS              CSV of uints, e.g. `2,0` (preferred)
///   RESULT_HASH         bytes32 override if COUNTS unset
///   TOTAL_BALLOTS       optional; defaults to sum(COUNTS)
///   L2_STATE_ROOT       optional bytes32
///   SETTLEMENT          optional RollupSettlement; used when L2_STATE_ROOT unset
///
/// Broadcast with `--rpc-url $L1_RPC --private-key $L1_PUBLISHER_PRIVATE_KEY`.
/// The publisher must be `admin` or `setPublisher`'d on the mirror.
contract CertifyL1 is Script {
    error MissingMirror();
    error MissingResult();
    error HashMismatch();

    function run() external {
        address mirrorAddr = _mirror();
        if (mirrorAddr == address(0)) revert MissingMirror();

        uint256 electionId = vm.envUint("ELECTION_ID");
        (bytes32 resultHash, uint256 totalBallots) = _result();
        bytes32 l2StateRoot = _stateRoot();

        console2.log(string.concat("TALLY_MIRROR=", vm.toString(mirrorAddr)));
        console2.log(string.concat("ELECTION_ID=", vm.toString(electionId)));
        console2.log(string.concat("RESULT_HASH=", vm.toString(resultHash)));
        console2.log(string.concat("TOTAL_BALLOTS=", vm.toString(totalBallots)));
        console2.log(string.concat("L2_STATE_ROOT=", vm.toString(l2StateRoot)));

        vm.startBroadcast();
        L1TallyMirror(mirrorAddr).postResult(electionId, resultHash, totalBallots, l2StateRoot);
        vm.stopBroadcast();
    }

    function _mirror() internal view returns (address) {
        try vm.envAddress("TALLY_MIRROR") returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        try vm.envAddress("L1_TALLY_MIRROR_ADDRESS") returns (address b) {
            return b;
        } catch {}
        return address(0);
    }

    function _result() internal view returns (bytes32 resultHash, uint256 totalBallots) {
        string memory csv = vm.envOr("COUNTS", string(""));
        uint256[] memory counts;
        if (bytes(csv).length != 0) {
            counts = _parseCounts(csv);
            resultHash = keccak256(abi.encodePacked(counts));
            totalBallots = _sum(counts);
        }
        try vm.envBytes32("RESULT_HASH") returns (bytes32 given) {
            if (given != bytes32(0)) {
                if (resultHash != bytes32(0) && resultHash != given) revert HashMismatch();
                resultHash = given;
            }
        } catch {}
        if (resultHash == bytes32(0)) revert MissingResult();
        uint256 overrideTotal = vm.envOr("TOTAL_BALLOTS", uint256(0));
        if (overrideTotal != 0) totalBallots = overrideTotal;
    }

    function _stateRoot() internal view returns (bytes32) {
        try vm.envBytes32("L2_STATE_ROOT") returns (bytes32 given) {
            if (given != bytes32(0)) return given;
        } catch {}
        try vm.envAddress("SETTLEMENT") returns (address settlement) {
            if (settlement != address(0)) return RollupSettlement(settlement).stateRoot();
        } catch {}
        try vm.envAddress("L1_SETTLEMENT_ADDRESS") returns (address settlement2) {
            if (settlement2 != address(0)) return RollupSettlement(settlement2).stateRoot();
        } catch {}
        return bytes32(0);
    }

    function _parseCounts(string memory csv) internal pure returns (uint256[] memory counts) {
        bytes memory b = bytes(csv);
        uint256 n = 1;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == ",") n++;
        }
        counts = new uint256[](n);
        uint256 idx;
        uint256 acc;
        bool anyDigit;
        for (uint256 i; i <= b.length; ++i) {
            bytes1 c = i < b.length ? b[i] : bytes1(",");
            if (c == ",") {
                require(anyDigit, "COUNTS: empty slot");
                counts[idx] = acc;
                idx++;
                acc = 0;
                anyDigit = false;
            } else if (c >= "0" && c <= "9") {
                anyDigit = true;
                acc = acc * 10 + (uint8(c) - 48);
            } else if (c != " " && c != "\t") {
                revert("COUNTS: bad character");
            }
        }
        require(idx == n, "COUNTS: parse");
    }

    function _sum(uint256[] memory counts) internal pure returns (uint256 total) {
        for (uint256 i; i < counts.length; ++i) {
            total += counts[i];
        }
    }
}
