// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {Script, console2} from "forge-std/Script.sol";

/// @notice Print `NAME=0x...` lines from env for the Node app to ingest.
///         Unknown / unset keys are skipped. No broadcast.
contract PrintAddresses is Script {
    function run() external view {
        _addr("HASHER");
        _addr("VERIFIER");
        _addr("FACTORY");
        _addr("IMPLEMENTATION");
        _addr("VOTER_REGISTRY");
        _addr("DISQUALIFICATION_REGISTRY");
        _addr("INBOX");
        _addr("TALLY");
        _addr("ENTRY_POINT");
        _addr("ACCOUNT_FACTORY");
        _addr("PAYMASTER");
        _addr("SETTLEMENT");
        _addr("TALLY_MIRROR");
        _addr("MAILBOX");
        _addr("ELECTION");
        _addr("BATCH_VERIFIER");
        _uint("ELECTION_ID");
    }

    function _addr(string memory name) internal view {
        try vm.envAddress(name) returns (address a) {
            if (a != address(0)) {
                console2.log(string.concat(name, "=", vm.toString(a)));
            }
        } catch {}
    }

    function _uint(string memory name) internal view {
        try vm.envUint(name) returns (uint256 v) {
            console2.log(string.concat(name, "=", vm.toString(v)));
        } catch {}
    }
}
