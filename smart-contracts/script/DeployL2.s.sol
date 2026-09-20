// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.24;

// NOT FOR PROFIT — civic public good, not a commercial product.

import {RepublicStack, RepublicStackScript} from "./DeployLocal.s.sol";

/// @notice Deploy the election stack, EntryPoint, passkey factory, and paymaster
///         on the Republic L2 RPC (`--rpc-url`). Settlement stays on L1.
contract DeployL2 is RepublicStackScript {
    function run() external {
        vm.startBroadcast();
        address admin = msg.sender;
        RepublicStack memory s = _deployElectionStack(admin);
        s.jurisdictions.createJurisdiction(keccak256("CIVIC"), admin, "Civic");

        uint256 sponsor = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(10 ether));
        if (sponsor > 0) {
            s.paymaster.deposit{value: sponsor}();
        }
        vm.stopBroadcast();

        _logStack(s);
    }
}
